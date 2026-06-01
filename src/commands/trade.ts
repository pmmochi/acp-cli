// `acp trade` — one command for moving and trading value, routed by the
// params you pass. No subcommand to memorize: the flags decide the intent.
//
// ── Intent routing (for LLM agents and humans) ──────────────────────────────
//   • `--side long|short`              → Hyperliquid PERP order (leveraged)
//   • `--spot --coin <sym> --side …`   → Hyperliquid SPOT order (USDC-quoted)
//   • `--chain-out 1337`               → DEPOSIT into Hyperliquid (USDC bridge)
//   • `--token-in/--token-out/--chain-*`→ cross-chain / same-chain SWAP (DEX)
//   • no flags in a terminal           → interactive picker (humans only)
//
// Plus two explicit sub-actions that aren't "place a trade":
//   • `acp trade status`               → HL account: positions, margin, balances
//   • `acp trade withdraw`             → withdraw USDC from HL L1 to Arbitrum
//
// How signing works: the CLI is a thin signer. Swaps/deposits are driven by the
// trading-agent server's /api/trade/plan + /next state machine — the server
// builds calldata, the CLI signs+broadcasts each leg with the keystore-backed
// signer (no human prompt). HL orders/withdrawals are EIP-712 actions signed by
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
// A swap whose destination is this chain is a Hyperliquid deposit.
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
      "Trade value: cross-chain/spot swaps, Hyperliquid deposits, and HL " +
        "perps/spot. The command routes by the params you pass — see `acp trade --help`."
    )
    .addHelpText(
      "after",
      "\nIntent is chosen from your flags:\n" +
        "  --side long|short             → HL perp (leveraged)\n" +
        "  --spot --coin X --side buy    → HL spot order\n" +
        "  --chain-out 1337              → deposit USDC into Hyperliquid\n" +
        "  --token-in/--token-out/...    → cross-chain or same-chain swap\n" +
        "  (no flags, in a terminal)     → interactive picker\n" +
        "\nExamples:\n" +
        "  acp trade --token-in usdc --chain-in 8453 --amount-in 50 --token-out virtual --chain-out 8453\n" +
        "  acp trade --token-in usdc --chain-in 1 --amount-in 100 --token-out usdc --chain-out 8453\n" +
        "  acp trade --amount-in 25 --chain-out 1337            # deposit 25 USDC into Hyperliquid\n" +
        "  acp trade --coin BTC --side long --size 0.01 --leverage 5\n" +
        "  acp trade --spot --coin PURR --side buy --size 100\n" +
        "  acp trade status\n" +
        "  acp trade withdraw --amount 25\n"
    )
    // -- Swap / deposit options ------------------------------------------
    .option("--token-in <token>", "Input token (address or symbol)")
    .option("--chain-in <id>", "Input chain ID")
    .option("--amount-in <amount>", "Input amount in human units")
    .option("--token-out <token>", "Output token (address or symbol)")
    .option("--chain-out <id>", "Output chain ID (1337 = deposit into Hyperliquid)")
    .option("--recipient <addr>", "Output recipient (default: active wallet)")
    .option("--slippage-bps <bps>", "Swap/bridge slippage in basis points")
    .option("--deadline-secs <secs>", "BondingV5 deadline in seconds")
    // -- Hyperliquid order options ---------------------------------------
    .option("--coin <symbol>", "HL coin symbol, e.g. BTC, ETH, SOL, PURR")
    .option("--side <side>", "long/short (perp) or buy/sell (spot)")
    .option("--size <size>", "Order size in coin units")
    .option("--price <price>", "Limit price (omit for a market order)")
    .option("--leverage <n>", "Set leverage for this coin before a perp order")
    .option("--isolated", "Use isolated margin when setting leverage", false)
    .option("--reduce-only", "Only reduce an existing perp position", false)
    .option("--post-only", "Post-only (Alo) limit order; rejects if it crosses", false)
    .option("--spot", "Route a buy/sell as an HL spot order (not a DEX swap)", false)
    .option("--slippage <pct>", "HL market-order slippage as a percent (default 5)", "5")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const intent = detectIntent(opts, json);
        switch (intent) {
          case "perp":
            await runHlOrder(opts, false, json);
            return;
          case "spot":
            await runHlOrder(opts, true, json);
            return;
          case "swap":
            await runSwap(opts, json);
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

  // ── withdraw ────────────────────────────────────────────────────────────────
  trade
    .command("withdraw")
    .description("Withdraw USDC from Hyperliquid L1 to Arbitrum (signed action)")
    .requiredOption("--amount <usdc>", "USDC amount to withdraw")
    .option("--destination <addr>", "Destination address (default: active wallet)")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        await runWithdraw(opts.amount, opts.destination, json);
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}

// ---------- Intent routing ----------

type Intent = "perp" | "spot" | "swap" | "interactive";

function detectIntent(opts: Record<string, unknown>, json: boolean): Intent {
  const side = typeof opts.side === "string" ? opts.side.toLowerCase() : undefined;
  const isLeveraged = side === "long" || side === "short";
  if (isLeveraged) return "perp";
  if (opts.spot) return "spot";

  const hasSwapParams =
    opts.tokenIn !== undefined ||
    opts.tokenOut !== undefined ||
    opts.chainOut !== undefined ||
    opts.amountIn !== undefined;
  if (hasSwapParams) return "swap";

  // A coin with a buy/sell side but no --spot is ambiguous (HL spot vs swap).
  if (opts.coin !== undefined) {
    throw new CliError(
      "Ambiguous order: pass --side long|short for a perp, or add --spot for an HL spot order.",
      "VALIDATION_ERROR",
      "e.g. `acp trade --coin BTC --side long --size 0.01` or `acp trade --spot --coin PURR --side buy --size 100`."
    );
  }

  if (!json && isTTY()) return "interactive";

  throw new CliError(
    "No trade intent in the flags provided.",
    "VALIDATION_ERROR",
    "Run `acp trade --help` for the flag→intent routing and examples."
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

  // Validate required swap params (after applying deposit defaults).
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
        (plan.direction && plan.route
          ? ` (${plan.direction} via ${plan.route})`
          : "")
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

// ---------- Hyperliquid orders (perp + spot) ----------

async function runHlOrder(
  opts: Record<string, unknown>,
  isSpot: boolean,
  json: boolean
): Promise<void> {
  if (opts.coin === undefined) {
    throw new CliError(
      "--coin is required for a Hyperliquid order.",
      "VALIDATION_ERROR",
      "e.g. `--coin BTC` (perp) or `--coin PURR --spot` (spot)."
    );
  }
  if (opts.size === undefined) {
    throw new CliError("--size is required for a Hyperliquid order.", "VALIDATION_ERROR");
  }
  const isBuy = parseSide(String(opts.side ?? ""));
  const { info, exchange } = await createHlClients();
  const asset = isSpot
    ? await resolveSpotAsset(info, String(opts.coin))
    : await resolvePerpAsset(info, String(opts.coin));

  if (!isSpot && opts.leverage !== undefined) {
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
        isSpot,
        parseSlippage(String(opts.slippage ?? "5"))
      )
    : formatPrice(Number(opts.price), asset.szDecimals, isSpot);

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
        r: !isSpot && Boolean(opts.reduceOnly),
        t: { limit: { tif: isMarket ? "Ioc" : opts.postOnly ? "Alo" : "Gtc" } },
      },
    ],
    grouping: "na",
  });
  outputResult(json, summarizeOrder(res));
}

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
  const { exchange, address } = await createHlClients();
  const dest = (destination ?? address) as Address;
  progress(json, `Withdrawing ${amount} USDC → ${dest}`);
  const res = await exchange.withdraw3({ destination: dest, amount: String(amount) });
  outputResult(json, { status: res.status, destination: dest, amount: String(amount) });
}

// ---------- Interactive picker (humans only) ----------

interface PickerAction {
  key: "swap" | "deposit" | "perp" | "spot" | "status" | "withdraw";
  label: string;
}

async function runInteractive(json: boolean): Promise<void> {
  const actions: PickerAction[] = [
    { key: "swap", label: "Swap tokens (same-chain or cross-chain)" },
    { key: "deposit", label: "Deposit USDC into Hyperliquid" },
    { key: "perp", label: "Open a Hyperliquid perp (long/short)" },
    { key: "spot", label: "Place a Hyperliquid spot order" },
    { key: "status", label: "Check Hyperliquid account status" },
    { key: "withdraw", label: "Withdraw USDC from Hyperliquid" },
  ];
  const choice = await selectOption(
    "What would you like to do?",
    actions,
    (a) => a.label
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    switch (choice.key) {
      case "status":
        await runStatus(json);
        return;
      case "withdraw": {
        const amount = await ask(rl, "USDC amount to withdraw: ");
        const destination = await ask(rl, "Destination (blank = your wallet): ");
        await runWithdraw(amount, destination || undefined, json);
        return;
      }
      case "perp":
      case "spot": {
        const coin = await ask(rl, "Coin symbol (e.g. BTC, PURR): ");
        const side = await ask(
          rl,
          choice.key === "perp" ? "Side (long/short): " : "Side (buy/sell): "
        );
        const size = await ask(rl, "Size (in coin units): ");
        const price = await ask(rl, "Limit price (blank = market): ");
        await runHlOrder(
          { coin, side, size, price: price || undefined },
          choice.key === "spot",
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

function parseSide(side: string): boolean {
  const s = side.toLowerCase();
  if (s === "buy" || s === "long" || s === "b") return true;
  if (s === "sell" || s === "short" || s === "s") return false;
  throw new CliError(
    `Invalid --side: ${side || "(empty)"}`,
    "VALIDATION_ERROR",
    "Use long/short for a perp, or buy/sell for spot."
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
