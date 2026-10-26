/**
 * agy CLI request contract plus the one-shot `agy --print` rollback client.
 * The default persistent implementation lives in agy-driver.ts; both paths
 * parse NDJSON into the same AgyTurnOutcome contract.
 *
 * Every invocation hard-codes --dangerously-skip-permissions: headless agy
 * turns auto-deny any tool that needs a permission prompt, so skipping is
 * required for agy's own tools (run_command, file edits, browser) to work.
 */

import { spawn } from "node:child_process";
import { killAgyTree, trackAgyChild, untrackAgyChild } from "./agy-children.ts";
import { getAgyBinary } from "./agy-diagnostics.ts";
import type { AgyExecutionMode } from "./agy-profile.ts";
import {
  detachAgyConversationBridgeMetadata,
  prepareAgyConversationBridgeMetadata,
} from "./conversation-metadata.ts";
import { parseAgyLine } from "./events.ts";
import { trackActiveToolStep } from "./tool-steps.ts";
import { applyEvent, newTurnOutcome, type AgyActivity, type AgyTurnOutcome } from "./reducer.ts";
import { AgyThoughtTracker } from "./agy-thoughts.ts";

/** agy reasoning effort, as accepted by `agy --effort`. */
export type AgyEffort = "low" | "medium" | "high";

export interface AgyTurnRequest {
  prompt: string;
  /** Resume a prior conversation; omit to start a new one. */
  conversationId?: string;
  /** agy model id, e.g. "gemini-3.8-flash". */
  model?: string;
  /** Reasoning effort for this turn (agy --effort). */
  effort?: AgyEffort;
  /**
   * Fallback for older agy builds or catalog entries that only accept effort
   * folded into the model ID (`<model>-<effort>`) instead of `--model <base> --effort <level>`.
   */
  legacyEffortSuffix?: boolean;
  /** Working directory for the agy process. */
  cwd?: string;
  /** Session-owned MCP discovery directory, added without changing cwd. */
  mcpDirectory?: string;
  /** Overall turn timeout owned by Pi. One-shot mode also passes --print-timeout. */
  timeoutMs?: number;
  /**
   * Kill the turn when the stream produces no bytes for this long (stall
   * watchdog). 0 disables it; the overall timeoutMs still applies.
   */
  inactivityTimeoutMs?: number;
  /**
   * Stall budget while a tool step is ACTIVE — a quiet foreground tool is
   * legitimate, so silence inside a tool gets a longer leash than silence
   * between steps. Defaults to max(inactivityTimeoutMs, 300_000).
   */
  toolInactivityTimeoutMs?: number;
  /**
   * How often to poll the off-stream transcript for a final answer agy is
   * withholding while a tool step is ACTIVE. 0 disables the early watch, so a
   * parked turn is only detected when the tool stall budget expires.
   */
  parkedWatchMs?: number;
  signal?: AbortSignal;
  /** Optional custom agy agent selected for this process. */
  agent?: string;
  /** Stable agy execution mode. */
  mode?: AgyExecutionMode;
  /** Non-argv bridge/catalog fingerprint used by persistent executors. */
  bridgeRevision?: string;
  /** Preflight-selected absolute binary. Normally resolved lazily. */
  binary?: string;
  /** Called with each structured activity event as tool steps stream in. */
  onActivity?: (activity: AgyActivity) => void;
  /**
   * Called once the stream reveals the agy conversation id — before the turn
   * resolves, so callers can track it even when a turn hangs on background
   * tasks and ends in an error.
   */
  onConversation?: (conversationId: string) => void;
  /** Test seam: replaces the spawned binary. */
  spawnOverride?: typeof spawn;
}

export class AgySpawnError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.name = "AgySpawnError";
    this.stderr = stderr;
  }
}

/**
 * The stream went silent: the process is alive but produced no bytes within
 * the inactivity budget. Retryable — the runtime resumes the conversation
 * with a continuation prompt instead of failing the whole pi turn.
 */
export class AgyStallError extends Error {
  readonly stalledMs: number;
  readonly toolActive: boolean;

  constructor(stalledMs: number, toolActive: boolean) {
    super(
      `agy stream stalled: no events for ${Math.round(stalledMs / 1000)}s${
        toolActive ? " while a tool step was active" : ""
      }`,
    );
    this.name = "AgyStallError";
    this.stalledMs = stalledMs;
    this.toolActive = toolActive;
  }
}

const MODEL_EFFORT_SUFFIX_RE = /^(.+)-(low|medium|high)$/i;
const MODEL_EFFORT_FALLBACK_ERROR_RE =
  /invalid model selection|--effort(?:=\S+)? is not supported|effort isn't adjustable|conflicts with --effort|unrecognized effort|unknown model|doesn't support thinking level|unsupported thinking level|flag provided but not defined: --?effort|no such flag -+-?effort/i;

/** Base model IDs (or "*" when `--effort` flag itself is unrecognized) that rejected `--model <base> --effort <level>`. */
const legacyEffortSuffixModels = new Set<string>();

export function resetLegacyEffortSuffixCache(): void {
  legacyEffortSuffixModels.clear();
}

export function splitAgyModelEffort(
  model: string | undefined,
  effort: AgyEffort | undefined,
): { baseModel?: string; effort?: AgyEffort } {
  if (!model) return { effort };
  const match = model.match(MODEL_EFFORT_SUFFIX_RE);
  if (!match) return { baseModel: model, effort };
  return {
    baseModel: match[1]!,
    effort: effort ?? (match[2]!.toLowerCase() as AgyEffort),
  };
}

export function shouldUseLegacyEffortSuffix(
  request: Pick<AgyTurnRequest, "model" | "effort" | "legacyEffortSuffix">,
): boolean {
  if (request.legacyEffortSuffix !== undefined) return request.legacyEffortSuffix;
  const { baseModel, effort } = splitAgyModelEffort(request.model, request.effort);
  if (!baseModel || !effort) return false;
  return (
    legacyEffortSuffixModels.has("*") ||
    legacyEffortSuffixModels.has(baseModel.toLowerCase())
  );
}

export function canFallbackToLegacyEffortSuffix(
  request: Pick<AgyTurnRequest, "model" | "effort" | "legacyEffortSuffix">,
): boolean {
  if (shouldUseLegacyEffortSuffix(request)) return false;
  const { baseModel, effort } = splitAgyModelEffort(request.model, request.effort);
  return Boolean(baseModel && effort);
}

export function isAgyModelEffortFallbackError(value: unknown): boolean {
  const text =
    value instanceof AgySpawnError
      ? `${value.message}\n${value.stderr}`
      : value instanceof Error
        ? value.message
        : typeof value === "string"
          ? value
          : "";
  return Boolean(text && MODEL_EFFORT_FALLBACK_ERROR_RE.test(text));
}

export function rememberLegacyEffortSuffixModel(
  model: string | undefined,
  error?: unknown,
): void {
  const text =
    error instanceof AgySpawnError
      ? `${error.message}\n${error.stderr}`
      : valueToErrorText(error);
  if (/flag provided but not defined: --?effort|no such flag -+-?effort/i.test(text)) {
    legacyEffortSuffixModels.add("*");
  }
  const { baseModel } = splitAgyModelEffort(model, undefined);
  if (baseModel) legacyEffortSuffixModels.add(baseModel.toLowerCase());
}

function valueToErrorText(value: unknown): string {
  return value instanceof Error ? value.message : typeof value === "string" ? value : "";
}

export class AgyModelEffortFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgyModelEffortFallbackError";
  }
}

function appendProcessArgs(args: string[], request: AgyTurnRequest): string[] {
  if (request.cwd) args.push("--add-dir", request.cwd);
  if (request.mcpDirectory) args.push("--add-dir", request.mcpDirectory);
  if (request.conversationId) args.push("--conversation", request.conversationId);
  const { baseModel, effort } = splitAgyModelEffort(request.model, request.effort);
  const useLegacySuffix = shouldUseLegacyEffortSuffix(request);
  if (baseModel) {
    if (useLegacySuffix && effort) {
      args.push("--model", `${baseModel}-${effort}`);
    } else {
      args.push("--model", baseModel);
      if (effort) args.push("--effort", effort);
    }
  } else if (effort) {
    args.push("--effort", effort);
  }
  if (request.agent) args.push("--agent", request.agent);
  if (request.mode) args.push("--mode", request.mode);
  return args;
}

export function buildOneShotAgyArgs(request: AgyTurnRequest): string[] {
  const timeout = Math.ceil((request.timeoutMs ?? 1_800_000) / 1000);
  // --print consumes the next token, so the prompt must remain adjacent.
  return appendProcessArgs(
    [
      "--print",
      request.prompt,
      "--dangerously-skip-permissions",
      "--disable-slash-commands",
      "--output-format",
      "stream-json",
      "--print-timeout",
      `${timeout}s`,
    ],
    request,
  );
}

export function buildDriverAgyArgs(request: Omit<AgyTurnRequest, "prompt">): string[] {
  // stream-json input still uses agy's print wait (default: 5 minutes).
  // Expiry can report SUCCESS with an empty/partial response while the agent
  // keeps running. Zero expires immediately, so keep this wait above Node's
  // maximum setTimeout budget; Pi's per-turn deadline/abort owns termination.
  // A fixed process argument also avoids recycling when remaining budgets vary.
  return appendProcessArgs(
    [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "2147484s",
      "--dangerously-skip-permissions",
      "--disable-slash-commands",
    ],
    { ...request, prompt: "" },
  );
}

/** Kept as the public one-shot argument builder used by existing callers. */
export const buildAgyArgs = buildOneShotAgyArgs;

/**
 * Run one agy turn. Resolves with the reduced outcome once the process exits
 * or the result event arrives. Rejects with AgySpawnError when the process
 * fails before producing any result event (missing binary, auth failure, …).
 */
export async function runAgyTurn(request: AgyTurnRequest): Promise<AgyTurnOutcome> {
  try {
    return await runSingleAgyTurn(request);
  } catch (error) {
    if (
      canFallbackToLegacyEffortSuffix(request) &&
      (error instanceof AgyModelEffortFallbackError ||
        (error instanceof AgySpawnError && isAgyModelEffortFallbackError(error)))
    ) {
      rememberLegacyEffortSuffixModel(request.model, error);
      return await runSingleAgyTurn({ ...request, legacyEffortSuffix: true });
    }
    throw error;
  }
}

async function runSingleAgyTurn(request: AgyTurnRequest): Promise<AgyTurnOutcome> {
  const binary = request.binary ?? (request.spawnOverride ? "agy" : await getAgyBinary());
  return new Promise((resolve, reject) => {
    if (request.signal?.aborted) {
      const outcome = newTurnOutcome();
      outcome.status = "ERROR";
      outcome.error = "agy turn was aborted.";
      outcome.finished = true;
      resolve(outcome);
      return;
    }
    const thoughtTracker = new AgyThoughtTracker(request.conversationId);
    if (request.conversationId) {
      prepareAgyConversationBridgeMetadata(
        request.conversationId,
        request.agent,
        request.mcpDirectory,
      );
    }
    const doSpawn = request.spawnOverride ?? spawn;
    const child = doSpawn(binary, buildOneShotAgyArgs(request), {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so one negative-pid SIGKILL reaps agy's whole
      // tree on timeout/abort instead of leaving grandchildren running.
      detached: true,
      windowsHide: true,
    });
    trackAgyChild(child);
    const outcome = newTurnOutcome();
    let stdoutBuf = "";
    let stderrBuf = "";
    const activeTools = new Set<string>();

    let settled = false;
    let untracked = false;
    let stallTimer: NodeJS.Timeout | undefined;
    let thoughtPollTimer: NodeJS.Timeout | undefined;

    const untrack = () => {
      if (untracked) return;
      untracked = true;
      untrackAgyChild(child);
    };

    let abortHandler: (() => void) | undefined;
    const finishLogical = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (stallTimer !== undefined) {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      }
      if (thoughtPollTimer !== undefined) {
        clearInterval(thoughtPollTimer);
        thoughtPollTimer = undefined;
      }
      thoughtTracker.close();
      if (abortHandler) request.signal?.removeEventListener("abort", abortHandler);
      const settledCid = outcome.conversationId ?? request.conversationId;
      if (settledCid) detachAgyConversationBridgeMetadata(settledCid);
      fn();
    };

    const killTimer = setTimeout(() => {
      killAgyTree(child);
      untrack();
      finishLogical(() => {
        reject(
          new AgySpawnError(
            `agy turn timed out after ${Math.round((request.timeoutMs ?? 1_800_000) / 1000)}s`,
            stderrBuf,
          ),
        );
      });
    }, request.timeoutMs ?? 1_800_000);

    // Stall watchdog: any stdout/stderr bytes count as liveness (chunk level,
    // not parsed events — unknown shapes must still reset the timer). A tool
    // step that is legitimately quiet gets the longer tool budget.
    const stallBaseMs = request.inactivityTimeoutMs ?? 45_000;
    const stallToolMs = request.toolInactivityTimeoutMs ?? Math.max(stallBaseMs, 300_000);
    let rearmStall: () => void = () => {};
    if (stallBaseMs > 0) {
      const armStall = () => {
        if (settled || outcome.finished) return;
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        const budgetMs = activeTools.size > 0 ? stallToolMs : stallBaseMs;
        stallTimer = setTimeout(() => {
          const pollRes = thoughtTracker.poll();
          for (const delta of pollRes.deltas) {
            outcome.activities.push(delta);
            request.onActivity?.(delta);
          }
          if (pollRes.deltas.length > 0 || pollRes.dbProgressed || pollRes.isGenerating) {
            armStall();
            return;
          }
          killAgyTree(child);
          untrack();
          finishLogical(() => {
            reject(new AgyStallError(budgetMs, activeTools.size > 0));
          });
        }, budgetMs);
      };
      rearmStall = armStall;
      armStall();
      child.stdout?.on("data", armStall);
      child.stderr?.on("data", armStall);
    }

    const pollThoughts = () => {
      if (settled || outcome.finished) return;
      if (outcome.conversationId) thoughtTracker.setConversationId(outcome.conversationId);
      const res = thoughtTracker.poll();
      for (const delta of res.deltas) {
        outcome.activities.push(delta);
        request.onActivity?.(delta);
      }
      if (res.deltas.length > 0 || res.dbProgressed) {
        rearmStall();
      }
    };
    thoughtPollTimer = setInterval(pollThoughts, 250);
    thoughtPollTimer.unref?.();

    abortHandler = () => {
      killAgyTree(child);
      untrack();
      finishLogical(() => {
        outcome.status = "ERROR";
        outcome.error = "agy turn was aborted.";
        outcome.finished = true;
        resolve(outcome);
      });
    };
    request.signal?.addEventListener("abort", abortHandler, { once: true });

    let conversationReported = false;
    const handleParsed = (parsed: ReturnType<typeof parseAgyLine>) => {
      if (settled) return;
      if (
        parsed.kind === "result" &&
        parsed.result.status === "ERROR" &&
        outcome.activities.length === 0 &&
        canFallbackToLegacyEffortSuffix(request) &&
        isAgyModelEffortFallbackError(parsed.result.error)
      ) {
        killAgyTree(child);
        untrack();
        finishLogical(() =>
          reject(
            new AgyModelEffortFallbackError(parsed.result.error ?? "invalid model/effort selection"),
          ),
        );
        return;
      }
      if (!conversationReported) {
        const id =
          parsed.kind === "init"
            ? parsed.conversationId
            : parsed.kind === "step"
              ? parsed.step.conversation_id
              : parsed.kind === "result"
                ? parsed.result.conversation_id
                : undefined;
        if (id) {
          conversationReported = true;
          thoughtTracker.setConversationId(id);
          request.onConversation?.(id);
        }
      }
      pollThoughts();
      for (const activity of applyEvent(outcome, parsed)) {
        trackActiveToolStep(activeTools, activity);
        request.onActivity?.(activity);
      }
      if (outcome.finished) {
        // Resolve the logical turn immediately so callers are not blocked on
        // grandchildren holding stdio pipes. The child process remains tracked
        // in the global death hook registry until actual close/error/sweep.
        stdoutBuf = "";
        finishLogical(() => resolve(outcome));
        return;
      }
      // A tool-start/done flip changes the stall budget (the liveness
      // listener re-armed before this parse ran), so re-arm with the new
      // active-tool state.
      rearmStall();
    };

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      if (settled || outcome.finished) {
        stdoutBuf = "";
        return;
      }
      stdoutBuf += chunk;
      for (;;) {
        const nl = stdoutBuf.indexOf("\n");
        if (nl < 0) break;
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        handleParsed(parseAgyLine(line));
      }
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      if (settled || outcome.finished) {
        stderrBuf = "";
        return;
      }
      stderrBuf += chunk;
      if (stderrBuf.length > 8_192) stderrBuf = stderrBuf.slice(-8_192);
    });

    child.on("error", (err) => {
      untrack();
      finishLogical(() =>
        reject(
          new AgySpawnError(
            `failed to start agy (${err.message}). Install agy 1.1.22+ or set AGY_BINARY.`,
            stderrBuf,
          ),
        ),
      );
    });

    child.on("close", (code) => {
      // Flush any trailing line without a newline.
      if (!settled && stdoutBuf.trim()) {
        handleParsed(parseAgyLine(stdoutBuf));
      }
      untrack();
      const settledCid = outcome.conversationId ?? request.conversationId;
      if (settledCid) detachAgyConversationBridgeMetadata(settledCid);
      finishLogical(() => {
        if (outcome.finished) {
          resolve(outcome);
          return;
        }
        const tail = stderrBuf.trim().split("\n").slice(-3).join("\n");
        reject(
          new AgySpawnError(
            `agy exited with code ${code ?? "signal"} before producing a result${
              tail ? `: ${tail}` : ""
            }`,
            stderrBuf,
          ),
        );
      });
    });
    // Abort can happen during spawn, before the listener above is installed.
    // Attach child error/close handlers first so the killed child remains observed.
    if (request.signal?.aborted) abortHandler();
  });
}
