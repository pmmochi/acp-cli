// `acp trade` — one command for moving and trading value. The chains you pass
// decide the venue: Hyperliquid is chain 1337, so swaps, HL deposits, HL spot,
// and HL withdrawals all share the same --token-in/--chain-in/--amount-in/
// --token-out/--chain-out shape. Only perps are different (a leveraged position,
// not a token conversion), so they use --side long|short.
//
// ── Intent routing (for LLM agents and humans) ──────────────────────────────
//   --side long|short                         → Hyperliquid PERP (leveraged)
//   --chain-in 1337  --chain-out 1337         → Hyperliquid SPOT (order book)
//   --chain-in <evm> --chain-out 1337         → DEPOSIT USDC into Hyperliquid
//   --chain-in 1337  --chain-out <evm>        → WITHDRAW USDC from Hyperliquid
//   --chain-in <evm> --chain-out <evm>        → SWAP (DEX: BondingV5 / LiFi)
//   (no flags, in a terminal)                 → interactive picker (humans only)
//
// `acp trade status` shows HL positions/margin/balances (read-only).
//
// Spot amount semantics mirror a swap: a BUY (--token-in usdc) spends --amount-in
// USDC (size derived from price, never overspends); a SELL (--token-out usdc)
// sells --amount-in token units.
//
// How signing works: the CLI is a thin signer. Swaps/deposits run through the
// trading-agent server's /api/trade/plan + /next state machine — the server
// builds calldata, the CLI signs+broadcasts each leg with the keystore-backed
// signer (no human prompt). HL spot/perp/withdraw are EIP-712 actions signed by
// the same signer and POSTed to HL's API. Private keys never leave the keystore.
//
// Env (swap + deposit only):
//   TRADING_AGENT_URL  — base URL of the trading-agent server
//   ACP_TRADE_API_KEY  — shared API key sent in the `x-acp-cli-key` header

import type { Command } from "commander";
import type { Address } from "viem";
import * as readline from "readline";
import { isJson, isTTY, outputError, outputResult } from "../lib/output";
import { CliError, type ErrorCode } from "../lib/errors";
import {
  createProviderAdapter,
  getWalletAddress,
} from "../lib/agentFactory";
import type { IEvmProviderAdapter } from "@virtuals-protocol/acp-node-v2";
import { prompt, selectOption } from "../lib/prompt";
import {
  createHlClients,
  createHlInfoClient,
  formatSize,
  formatPrice,
  isTestnet,
  marketPrice,
  resolvePerpAsset,
  resolveSpotAsset,
} from "../lib/hl/client";

// LiFi's chain id for Hyperliquid Core (the perps/spot collateral ledger).
// Any leg whose chain is this is "on Hyperliquid".
const HL_CHAIN_ID = 1337;
// Default source chain for a deposit's USDC.
const DEFAULT_FROM_CHAIN = 8453; // Base
// Minimum deposit. Bridge fees are ~flat (~$1.2), so small deposits lose a
// large % (≈25% at $5, ≈5% at $25). $5 floor is for testing; raise for prod.
const MIN_DEPOSIT_USDC = 5;

// ---------- Wire types (mirror trading-agent/src/services/trade/types.ts) ----------

interface SendAction {
  kind: "send";
  label: string;
  to: string;
  data: string;
  value: string;
  chainId: number;
  expectedTxKind?: string;
  timeoutMs?: number;
}
interface WaitAction {
  kind: "wait";
  label: string;
  delaySec: number;
  maxDelaySec?: number;
}
interface DoneAction {
  kind: "done";
  status: "success" | "partial";
  result: Record<string, unknown>;
}
interface ErrorAction {
  kind: "error";
  code: string;
  message: string;
  recovery?: string;
  retryable: boolean;
  partialResult?: Record<string, unknown>;
}
type Action = SendAction | WaitAction | DoneAction | ErrorAction;

interface PlanResponse {
  tradeId: string;
  step: number;
  direction?: string;
  route?: string;
  totalTaxBps?: number;
  appliedSlippageBps?: number;
  recipient?: string;
  action: Action;
}
interface NextResponse {
  tradeId: string;
  step: number;
  action: Action;
}

// ---------- Command registration ----------

export function registerTradeCommands(program: Command): void {
  const trade = program
    .command("trade")
    .description(
      "Trade value: same/cross-chain swaps, and — via Hyperliquid (chain 1337) — " +
        "deposits, spot orders, withdrawals, and perps. Routes by the chains/params " +
        "you pass. See `acp trade --help`."
    )
    .addHelpText(
      "after",
      "\nHyperliquid is chain 1337. The chains decide the venue:\n" +
        "  --chain-in <evm>  --chain-out <evm>   → DEX swap (same/cross-chain)\n" +
        "  --chain-in <evm>  --chain-out 1337    → deposit USDC into Hyperliquid\n" +
        "  --chain-in 1337   --chain-out 1337    → Hyperliquid spot order\n" +
        "  --chain-in 1337   --chain-out <evm>   → withdraw USDC from Hyperliquid\n" +
        "  --side long|short                     → Hyperliquid perp (leveraged)\n" +
        "  (no flags, in a terminal)             → interactive picker\n" +
        "\nExamples:\n" +
        "  acp trade --token-in usdc --chain-in 8453 --amount-in 50 --token-out virtual --chain-out 8453\n" +
        "  acp trade --token-in usdc --chain-in 1 --amount-in 100 --token-out usdc --chain-out 8453\n" +
        "  acp trade --token-in usdc --chain-in 8453 --amount-in 25 --token-out usdc --chain-out 1337   # deposit\n" +
        "  acp trade --token-in usdc --chain-in 1337 --amount-in 100 --token-out PURR --chain-out 1337  # spot buy\n" +
        "  acp trade --token-in PURR --chain-in 1337 --amount-in 50 --token-out usdc --chain-out 1337   # spot sell\n" +
        "  acp trade --token-in usdc --chain-in 1337 --amount-in 25 --token-out usdc --chain-out 42161  # withdraw\n" +
        "  acp trade --side long --token BTC --size 0.01 --leverage 5\n" +
        "  acp trade status\n"
    )
    // -- Swap / deposit / HL spot / HL withdraw (token-pair shape) --------
    .option("--token-in <token>", "Input token (address or symbol)")
    .option("--chain-in <id>", "Input chain ID (1337 = Hyperliquid)")
    .option("--amount-in <amount>", "Input amount in human units (USDC for an HL spot buy)")
    .option("--token-out <token>", "Output token (address or symbol)")
    .option("--chain-out <id>", "Output chain ID (1337 = Hyperliquid)")
    .option("--recipient <addr>", "Output recipient (default: active wallet)")
    .option("--slippage-bps <bps>", "Swap/bridge slippage in basis points")
    .option("--deadline-secs <secs>", "BondingV5 deadline in seconds")
    .option("--price <price>", "HL spot limit price (omit for a market order)")
    .option("--post-only", "HL post-only (Alo) limit order; rejects if it crosses", false)
    .option("--slippage <pct>", "HL market-order slippage as a percent (default 5)", "5")
    // -- Hyperliquid perp (position shape) -------------------------------
    .option("--side <side>", "Perp side: long or short")
    .option("--token <symbol>", "Perp token symbol, e.g. BTC, ETH, SOL")
    .option("--size <size>", "Perp order size in token units")
    .option("--leverage <n>", "Set leverage for this token before a perp order")
    .option("--isolated", "Use isolated margin when setting leverage", false)
    .option("--reduce-only", "Only reduce an existing perp position", false)
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const intent = detectIntent(opts, json);
        switch (intent) {
          case "perp":
            await runPerp(opts, json);
            return;
          case "spot":
            await runHlSpot(opts, json);
            return;
          case "deposit":
          case "swap":
            await runSwap(opts, json);
            return;
          case "withdraw":
            await runWithdraw(String(opts.amountIn), opts.recipient as string | undefined, json);
            return;
          case "interactive":
            await runInteractive(json);
            return;
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // ── status ────────────────────────────────────────────────────────────────
  trade
    .command("status")
    .description("Show HL account: perp positions, margin, and spot balances")
    .action(async (_opts, cmd) => {
      const json = isJson(cmd);
      try {
        await runStatus(json);
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // ── withdraw ──────────────────────────────────────────────────────────────
  // Convenience form. (Equivalent to: --token-in usdc --chain-in 1337
  // --amount-in <n> --token-out usdc --chain-out <evm>.)
  trade
    .command("withdraw")
    .description("Withdraw USDC from Hyperliquid L1 to Arbitrum (signed action)")
    .requiredOption("--amount <usdc>", "USDC amount to withdraw")
    .option("--destination <addr>", "Destination address (default: active wallet)")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        await runWithdraw(String(opts.amount), opts.destination, json);
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}

// ---------- Intent routing ----------

type Intent = "perp" | "spot" | "deposit" | "withdraw" | "swap" | "interactive";

function detectIntent(opts: Record<string, unknown>, json: boolean): Intent {
  const side = typeof opts.side === "string" ? opts.side.toLowerCase() : undefined;
  if (side === "long" || side === "short" || opts.token !== undefined) return "perp";

  const hasTokenParams =
    opts.tokenIn !== undefined ||
    opts.tokenOut !== undefined ||
    opts.chainIn !== undefined ||
    opts.chainOut !== undefined ||
    opts.amountIn !== undefined;

  if (hasTokenParams) {
    const inHL = opts.chainIn !== undefined && Number(opts.chainIn) === HL_CHAIN_ID;
    const outHL = opts.chainOut !== undefined && Number(opts.chainOut) === HL_CHAIN_ID;
    if (inHL && outHL) return "spot";
    if (inHL) return "withdraw";
    if (outHL) return "deposit";
    return "swap";
  }

  if (!json && isTTY()) return "interactive";

  throw new CliError(
    "No trade intent in the flags provided.",
    "VALIDATION_ERROR",
    "Run `acp trade --help` for the chain→venue routing and examples."
  );
}

// ---------- Swap / deposit (trading-agent state machine) ----------

async function runSwap(opts: Record<string, unknown>, json: boolean): Promise<void> {
  const url = requireEnv("TRADING_AGENT_URL");
  const apiKey = requireEnv("ACP_TRADE_API_KEY");
  const owner = getWalletAddress() as Address;
  const provider = await createProviderAdapter();

  const chainOut = opts.chainOut !== undefined ? Number(opts.chainOut) : undefined;
  const isDeposit = chainOut === HL_CHAIN_ID;

  // Deposit conveniences: default the source chain + tokens to USDC and enforce
  // the bridge-fee floor so tiny deposits don't get eaten by fees.
  const tokenIn = (opts.tokenIn as string | undefined) ?? (isDeposit ? "USDC" : undefined);
  const tokenOut = (opts.tokenOut as string | undefined) ?? (isDeposit ? "USDC" : undefined);
  const chainIn =
    opts.chainIn !== undefined
      ? Number(opts.chainIn)
      : isDeposit
        ? DEFAULT_FROM_CHAIN
        : undefined;

  const missing: string[] = [];
  if (!tokenIn) missing.push("--token-in");
  if (chainIn === undefined) missing.push("--chain-in");
  if (opts.amountIn === undefined) missing.push("--amount-in");
  if (!tokenOut) missing.push("--token-out");
  if (chainOut === undefined) missing.push("--chain-out");
  if (missing.length) {
    throw new CliError(
      `Missing required option(s): ${missing.join(", ")}`,
      "VALIDATION_ERROR",
      isDeposit
        ? "For a deposit: `acp trade --amount-in 25 --chain-out 1337`."
        : "e.g. `acp trade --token-in usdc --chain-in 8453 --amount-in 50 --token-out virtual --chain-out 8453`."
    );
  }

  if (isDeposit) {
    const amount = Number(opts.amountIn);
    if (!Number.isFinite(amount) || amount < MIN_DEPOSIT_USDC) {
      throw new CliError(
        `Minimum Hyperliquid deposit is ${MIN_DEPOSIT_USDC} USDC.`,
        "VALIDATION_ERROR",
        `Pass --amount-in ${MIN_DEPOSIT_USDC} or more.`
      );
    }
  }

  const planBody = {
    tokenIn,
    chainIn,
    amountIn: String(opts.amountIn),
    tokenOut,
    chainOut,
    slippageBps: opts.slippageBps !== undefined ? Number(opts.slippageBps) : undefined,
    deadlineSecs: opts.deadlineSecs !== undefined ? Number(opts.deadlineSecs) : undefined,
    recipient: (opts.recipient as string | undefined) ?? (isDeposit ? owner : undefined),
    walletAddress: owner,
  };

  const plan: PlanResponse = await post(url, apiKey, "/api/trade/plan", planBody);
  if (isDeposit) {
    progress(
      json,
      `HL deposit ${plan.tradeId.slice(0, 8)} — ${opts.amountIn} ${tokenIn} ` +
        `(chain ${chainIn}) → Hyperliquid`
    );
  } else {
    progress(
      json,
      `Trade ${plan.tradeId.slice(0, 8)}` +
        (plan.direction && plan.route ? ` (${plan.direction} via ${plan.route})` : "")
    );
  }
  const result = await runTradeLoop(url, apiKey, provider, plan, json);
  outputResult(json, result);
}

async function runTradeLoop(
  url: string,
  apiKey: string,
  provider: IEvmProviderAdapter,
  plan: PlanResponse,
  json: boolean
): Promise<Record<string, unknown>> {
  let action = plan.action;
  let step = plan.step;

  while (true) {
    if (action.kind === "done") return action.result;
    if (action.kind === "error") {
      if (action.partialResult && !json && isTTY()) {
        process.stderr.write(
          "Partial state:\n" + JSON.stringify(action.partialResult, null, 2) + "\n"
        );
      }
      throw new CliError(
        action.message,
        isKnownCode(action.code) ? action.code : "API_ERROR",
        action.recovery
      );
    }

    let nextBody: Record<string, unknown>;
    if (action.kind === "send") {
      progress(json, `[step ${step + 1}] ${action.label}`);
      try {
        const txHash = await provider.sendTransaction(action.chainId, {
          to: action.to as `0x${string}`,
          data: action.data as `0x${string}`,
          ...(action.value && action.value !== "0"
            ? { value: BigInt(action.value) }
            : {}),
        });
        nextBody = { tradeId: plan.tradeId, step, txHash };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        nextBody = {
          tradeId: plan.tradeId,
          step,
          error: { code: "TX_FAILED", message },
        };
      }
    } else if (action.kind === "wait") {
      progress(json, `[step ${step + 1}] ${action.label} (waiting ${action.delaySec}s)`);
      await sleep(action.delaySec * 1000);
      nextBody = { tradeId: plan.tradeId, step };
    } else {
      throw new CliError(
        `Unknown action kind: ${(action as { kind: string }).kind}`,
        "API_ERROR"
      );
    }

    const next: NextResponse = await post(url, apiKey, "/api/trade/next", nextBody);
    action = next.action;
    step = next.step;
  }
}

// ---------- Hyperliquid spot (token-pair shape on chain 1337) ----------

function isUsdcSymbol(token: string): boolean {
  return token.trim().toLowerCase() === "usdc";
}

async function runHlSpot(opts: Record<string, unknown>, json: boolean): Promise<void> {
  const tokenIn = opts.tokenIn !== undefined ? String(opts.tokenIn) : undefined;
  const tokenOut = opts.tokenOut !== undefined ? String(opts.tokenOut) : undefined;
  if (!tokenIn || !tokenOut || opts.amountIn === undefined) {
    throw new CliError(
      "HL spot needs --token-in, --token-out, and --amount-in (both chains 1337).",
      "VALIDATION_ERROR",
      "e.g. `acp trade --token-in usdc --chain-in 1337 --amount-in 100 --token-out PURR --chain-out 1337`."
    );
  }
  const inUsdc = isUsdcSymbol(tokenIn);
  const outUsdc = isUsdcSymbol(tokenOut);
  if (inUsdc === outUsdc) {
    throw new CliError(
      "HL spot pairs are USDC-quoted: exactly one of --token-in / --token-out must be USDC.",
      "VALIDATION_ERROR",
      "Buy: `--token-in usdc --token-out PURR`. Sell: `--token-in PURR --token-out usdc`."
    );
  }
  // Buy when the output is the coin (spending USDC); sell when the input is the coin.
  const isBuy = !outUsdc ? true : false;
  const coin = isBuy ? tokenOut : tokenIn;

  const { info, exchange } = await createHlClients();
  const asset = await resolveSpotAsset(info, coin);

  const isMarket = opts.price === undefined;
  const orderPrice = isMarket
    ? await marketPrice(
        info,
        asset.name,
        isBuy,
        asset.szDecimals,
        true,
        parseSlippage(String(opts.slippage ?? "5"))
      )
    : formatPrice(Number(opts.price), asset.szDecimals, true);

  // Size: a sell spends coin units directly; a buy spends USDC, so size is the
  // USDC amount divided by the order price (so the order never overspends).
  const amountIn = Number(opts.amountIn);
  if (!Number.isFinite(amountIn) || amountIn <= 0) {
    throw new CliError(`Invalid --amount-in: ${opts.amountIn}`, "VALIDATION_ERROR");
  }
  const sizeNum = isBuy ? amountIn / Number(orderPrice) : amountIn;
  const size = formatSize(sizeNum, asset.szDecimals);

  progress(
    json,
    `${isMarket ? "Market" : "Limit"} ${isBuy ? "buy" : "sell"} ${size} ${asset.name} @ ${orderPrice}`
  );

  const res = await exchange.order({
    orders: [
      {
        a: asset.assetIndex,
        b: isBuy,
        p: orderPrice,
        s: size,
        r: false,
        t: { limit: { tif: isMarket ? "Ioc" : opts.postOnly ? "Alo" : "Gtc" } },
      },
    ],
    grouping: "na",
  });
  outputResult(json, summarizeOrder(res));
}

// ---------- Hyperliquid perp (position shape) ----------

async function runPerp(opts: Record<string, unknown>, json: boolean): Promise<void> {
  if (opts.token === undefined) {
    throw new CliError("--token is required for a perp.", "VALIDATION_ERROR", "e.g. `--token BTC`.");
  }
  if (opts.side === undefined) {
    throw new CliError(
      "--side long|short is required for a perp.",
      "VALIDATION_ERROR",
      "e.g. `--token BTC --side long --size 0.01`."
    );
  }
  if (opts.size === undefined) {
    throw new CliError("--size is required for a perp.", "VALIDATION_ERROR");
  }
  const isBuy = parsePerpSide(String(opts.side));
  const { info, exchange } = await createHlClients();
  const asset = await resolvePerpAsset(info, String(opts.token));

  if (opts.leverage !== undefined) {
    await exchange.updateLeverage({
      asset: asset.assetIndex,
      isCross: !opts.isolated,
      leverage: Number(opts.leverage),
    });
    progress(json, `Set ${asset.name} leverage to ${opts.leverage}x`);
  }

  const size = formatSize(Number(opts.size), asset.szDecimals);
  const isMarket = opts.price === undefined;
  const price = isMarket
    ? await marketPrice(
        info,
        asset.name,
        isBuy,
        asset.szDecimals,
        false,
        parseSlippage(String(opts.slippage ?? "5"))
      )
    : formatPrice(Number(opts.price), asset.szDecimals, false);

  progress(
    json,
    `${isMarket ? "Market" : "Limit"} ${opts.side} ${size} ${asset.name} @ ${price}`
  );

  const res = await exchange.order({
    orders: [
      {
        a: asset.assetIndex,
        b: isBuy,
        p: price,
        s: size,
        r: Boolean(opts.reduceOnly),
        t: { limit: { tif: isMarket ? "Ioc" : opts.postOnly ? "Alo" : "Gtc" } },
      },
    ],
    grouping: "na",
  });
  outputResult(json, summarizeOrder(res));
}

// ---------- Hyperliquid account ----------

async function runStatus(json: boolean): Promise<void> {
  // Read-only: needs the wallet address, not the signer.
  const info = createHlInfoClient();
  const address = getWalletAddress() as Address;
  const [perp, spot] = await Promise.all([
    info.clearinghouseState({ user: address }),
    info.spotClearinghouseState({ user: address }),
  ]);

  const positions = perp.assetPositions.map((p) => ({
    coin: p.position.coin,
    size: p.position.szi,
    entryPx: p.position.entryPx,
    unrealizedPnl: p.position.unrealizedPnl,
    leverage: p.position.leverage,
  }));
  const balances = spot.balances.map((b) => ({
    coin: b.coin,
    total: b.total,
    hold: b.hold,
  }));

  outputResult(json, {
    address,
    network: isTestnet() ? "testnet" : "mainnet",
    accountValue: perp.marginSummary.accountValue,
    withdrawable: perp.withdrawable,
    positions,
    spotBalances: balances,
  });
}

async function runWithdraw(
  amount: string,
  destination: string | undefined,
  json: boolean
): Promise<void> {
  if (amount === undefined || amount === "undefined" || amount === "") {
    throw new CliError(
      "--amount-in is required to withdraw from Hyperliquid.",
      "VALIDATION_ERROR",
      "e.g. `acp trade --token-in usdc --chain-in 1337 --amount-in 25 --token-out usdc --chain-out 42161`."
    );
  }
  const { exchange, address } = await createHlClients();
  const dest = (destination ?? address) as Address;
  progress(json, `Withdrawing ${amount} USDC → ${dest}`);
  const res = await exchange.withdraw3({ destination: dest, amount: String(amount) });
  outputResult(json, { status: res.status, destination: dest, amount: String(amount) });
}

// ---------- Interactive picker (humans only) ----------

interface PickerAction {
  key: "swap" | "deposit" | "spot" | "perp" | "status" | "withdraw";
  label: string;
}

async function runInteractive(json: boolean): Promise<void> {
  const actions: PickerAction[] = [
    { key: "swap", label: "Swap tokens (same-chain or cross-chain)" },
    { key: "deposit", label: "Deposit USDC into Hyperliquid" },
    { key: "spot", label: "Hyperliquid spot order" },
    { key: "perp", label: "Hyperliquid perp (long/short)" },
    { key: "status", label: "Check Hyperliquid account status" },
    { key: "withdraw", label: "Withdraw USDC from Hyperliquid" },
  ];
  const choice = await selectOption("What would you like to do?", actions, (a) => a.label);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    switch (choice.key) {
      case "status":
        await runStatus(json);
        return;
      case "withdraw": {
        const amountIn = await ask(rl, "USDC amount to withdraw: ");
        const recipient = await ask(rl, "Destination (blank = your wallet): ");
        await runWithdraw(amountIn, recipient || undefined, json);
        return;
      }
      case "perp": {
        const token = await ask(rl, "Token (e.g. BTC): ");
        const side = await ask(rl, "Side (long/short): ");
        const size = await ask(rl, "Size (token units): ");
        const price = await ask(rl, "Limit price (blank = market): ");
        const leverage = await ask(rl, "Leverage (blank = leave as-is): ");
        await runPerp(
          { token, side, size, price: price || undefined, leverage: leverage || undefined },
          json
        );
        return;
      }
      case "spot": {
        const dir = await ask(rl, "Buy or sell? ");
        const token = await ask(rl, "Token (e.g. PURR): ");
        const buying = dir.trim().toLowerCase().startsWith("b");
        const amountIn = await ask(
          rl,
          buying ? "USDC to spend: " : `${token} amount to sell: `
        );
        const price = await ask(rl, "Limit price (blank = market): ");
        await runHlSpot(
          {
            tokenIn: buying ? "usdc" : token,
            tokenOut: buying ? token : "usdc",
            amountIn,
            price: price || undefined,
          },
          json
        );
        return;
      }
      case "deposit": {
        const amountIn = await ask(rl, `USDC amount to deposit (min ${MIN_DEPOSIT_USDC}): `);
        const chainIn = await ask(rl, `Source chain ID (blank = ${DEFAULT_FROM_CHAIN}): `);
        await runSwap(
          { amountIn, chainIn: chainIn || undefined, chainOut: HL_CHAIN_ID },
          json
        );
        return;
      }
      case "swap": {
        const tokenIn = await ask(rl, "Token in (symbol or address): ");
        const chainIn = await ask(rl, "Chain in (ID): ");
        const amountIn = await ask(rl, "Amount in (human units): ");
        const tokenOut = await ask(rl, "Token out (symbol or address): ");
        const chainOut = await ask(rl, "Chain out (ID): ");
        await runSwap({ tokenIn, chainIn, amountIn, tokenOut, chainOut }, json);
        return;
      }
    }
  } finally {
    rl.close();
  }
}

function ask(rl: readline.Interface, q: string): Promise<string> {
  return prompt(rl, q).then((s) => s.trim());
}

// ---------- HTTP + shared helpers ----------

async function post<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  body: unknown
): Promise<T> {
  const res = await fetch(baseUrl.replace(/\/$/, "") + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-acp-cli-key": apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let parsed: { error?: string; code?: string; recovery?: string } | string;
    try {
      parsed = (await res.json()) as { error?: string; code?: string; recovery?: string };
    } catch {
      parsed = await res.text();
    }
    const message =
      typeof parsed === "string"
        ? `${res.status} ${res.statusText}: ${parsed}`
        : `${res.status} ${res.statusText}: ${parsed.error ?? "unknown"}`;
    const code =
      typeof parsed === "object" && parsed.code ? parsed.code : `HTTP_${res.status}`;
    const recovery = typeof parsed === "object" ? parsed.recovery : undefined;
    throw new CliError(message, isKnownCode(code) ? code : "API_ERROR", recovery);
  }
  return (await res.json()) as T;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new CliError(
      `${name} env var is required for swaps and Hyperliquid deposits.`,
      "VALIDATION_ERROR",
      name === "TRADING_AGENT_URL"
        ? "export TRADING_AGENT_URL=https://your-trading-agent.up.railway.app"
        : "export ACP_TRADE_API_KEY=<key> (ask the trading-agent operator for one)"
    );
  }
  return v;
}

function parsePerpSide(side: string): boolean {
  const s = side.toLowerCase();
  if (s === "long" || s === "buy" || s === "b") return true;
  if (s === "short" || s === "sell" || s === "s") return false;
  throw new CliError(
    `Invalid --side: ${side || "(empty)"}`,
    "VALIDATION_ERROR",
    "Use long or short for a perp."
  );
}

function parseSlippage(pct: string): number {
  const n = Number(pct);
  if (!Number.isFinite(n) || n < 0 || n >= 100) {
    throw new CliError(
      `Invalid --slippage: ${pct}`,
      "VALIDATION_ERROR",
      "Pass a percent between 0 and 100, e.g. 5."
    );
  }
  return n / 100;
}

function summarizeOrder(res: {
  response: { data: { statuses: unknown[] } };
}): Record<string, unknown> {
  const statuses = res.response?.data?.statuses ?? [];
  return { status: "ok", statuses };
}

const KNOWN_CODES = new Set<string>([
  "NOT_AUTHENTICATED",
  "NO_ACTIVE_AGENT",
  "NO_SIGNER",
  "SESSION_NOT_FOUND",
  "VALIDATION_ERROR",
  "API_ERROR",
  "ALREADY_EXISTS",
  "ALREADY_TOKENIZED",
  "TIMEOUT",
  "SLIPPAGE_TOO_LOW",
  "INSUFFICIENT_GAS",
]);

function isKnownCode(s: string): s is ErrorCode {
  return KNOWN_CODES.has(s);
}

function progress(json: boolean, msg: string): void {
  if (json || !isTTY()) return;
  process.stderr.write(`${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
