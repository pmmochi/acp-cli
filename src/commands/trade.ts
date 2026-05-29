// `acp trade swap` — thin HTTP client for the trading-agent server.
//
// All trade logic (routing, factory dispatch, quotes, tax math,
// FoT cap, balance reads, etc.) lives in the trading-agent server.
// The CLI's only job is:
//   1. Send the user's intent to /api/trade/plan
//   2. Run the action state-machine loop:
//        - "send"  → sign+broadcast via provider.sendTransaction, POST /next
//        - "wait"  → sleep, POST /next
//        - "done"  → print result, exit 0
//        - "error" → print error+recovery, exit non-zero
//
// LLM agents driving this command should know: it self-paces from server
// responses. Every server response carries one `action` whose `kind` is
// the next instruction. No local routing logic exists here on purpose.
//
// Env:
//   TRADING_AGENT_URL  — base URL of the trading-agent server
//                        (e.g. https://trading-agent.up.railway.app)
//   ACP_TRADE_API_KEY  — shared API key the server expects in
//                        `x-acp-cli-key` header

import type { Command } from "commander";
import type { Address } from "viem";
import { isJson, isTTY, outputError, outputResult } from "../lib/output";
import { CliError } from "../lib/errors";
import {
  createProviderAdapter,
  getWalletAddress,
} from "../lib/agentFactory";

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
  direction: string;
  route: string;
  totalTaxBps: number;
  appliedSlippageBps: number;
  recipient: string;
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
    .description("Trade tokens via the trading-agent server (auto-routes BondingV5 / LiFi)");

  trade
    .command("swap")
    .description("Swap tokenIn → tokenOut. Server auto-detects route.")
    .requiredOption("--token-in <token>", "Input token (address or symbol)")
    .requiredOption("--chain-in <id>", "Input chain ID")
    .requiredOption("--amount-in <amount>", "Input amount in human units")
    .requiredOption("--token-out <token>", "Output token (address or symbol)")
    .requiredOption("--chain-out <id>", "Output chain ID")
    .option("--recipient <addr>", "Output recipient (default: active wallet)")
    .option("--slippage-bps <bps>", "Slippage in basis points")
    .option("--deadline-secs <secs>", "BondingV5 deadline in seconds")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const url = requireEnv("TRADING_AGENT_URL");
        const apiKey = requireEnv("ACP_TRADE_API_KEY");
        const owner = getWalletAddress() as Address;
        const provider = await createProviderAdapter();

        const planBody = {
          tokenIn: String(opts.tokenIn),
          chainIn: Number(opts.chainIn),
          amountIn: String(opts.amountIn),
          tokenOut: String(opts.tokenOut),
          chainOut: Number(opts.chainOut),
          slippageBps: opts.slippageBps !== undefined ? Number(opts.slippageBps) : undefined,
          deadlineSecs:
            opts.deadlineSecs !== undefined ? Number(opts.deadlineSecs) : undefined,
          recipient: opts.recipient as string | undefined,
          walletAddress: owner,
        };

        // -- Kick off ----------------------------------------------------
        const plan: PlanResponse = await post(url, apiKey, "/api/trade/plan", planBody);
        progress(json, `Trade ${plan.tradeId.slice(0, 8)} (${plan.direction} via ${plan.route})`);
        let action = plan.action;
        let step = plan.step;

        // -- State-machine loop -----------------------------------------
        while (true) {
          if (action.kind === "done") {
            outputResult(json, action.result);
            return;
          }
          if (action.kind === "error") {
            const err = new CliError(
              action.message,
              isKnownCode(action.code) ? action.code : "API_ERROR",
              action.recovery
            );
            if (action.partialResult && !json && isTTY()) {
              process.stderr.write(
                "Partial state:\n" + JSON.stringify(action.partialResult, null, 2) + "\n"
              );
            }
            outputError(json, err);
            return;
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
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}

// ---------- HTTP helper ----------

async function post<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  body: unknown
): Promise<T> {
  const res = await fetch(baseUrl.replace(/\/$/, "") + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-acp-cli-key": apiKey,
    },
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
      `${name} env var is required for 'acp trade swap'.`,
      "VALIDATION_ERROR",
      name === "TRADING_AGENT_URL"
        ? "export TRADING_AGENT_URL=https://your-trading-agent.up.railway.app"
        : "export ACP_TRADE_API_KEY=<key> (ask the trading-agent operator for one)"
    );
  }
  return v;
}

function progress(json: boolean, msg: string): void {
  if (json || !isTTY()) return;
  process.stderr.write(`${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const KNOWN_CODES = new Set([
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

function isKnownCode(s: string): s is import("../lib/errors").ErrorCode {
  return KNOWN_CODES.has(s);
}
