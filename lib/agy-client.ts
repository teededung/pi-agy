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
import { agyToolStepKey, trackActiveToolStep } from "./tool-steps.ts";
import {
  applyEvent,
  createSlidingDeadline,
  isAgyProgressActivity,
  newTurnOutcome,
  type AgyActivity,
  type AgyTurnOutcome,
} from "./reducer.ts";
import { AgyThoughtTracker } from "./agy-thoughts.ts";

/** agy reasoning effort, as accepted by `agy --effort`. */
export type AgyEffort = "low" | "medium" | "high";

export interface AgyPromptImage {
  data: string;
  mimeType: string;
}

export interface AgyTurnRequest {
  prompt: string;
  /** Raw system instructions for executors supporting native system-prompt delivery (ACP). */
  systemPrompt?: string;
  /** Formatted text relay fallback when native system-prompt delivery is unavailable. */
  systemPromptRelay?: string;
  /** Multimodal user image blocks for executors supporting native image blocks (ACP). */
  images?: AgyPromptImage[];
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
  /**
   * Maximum time without forward step/stream progress before Pi terminates the
   * turn. Renewed on genuine agent progress (steps, tool transitions, deltas).
   */
  timeoutMs?: number;
  /**
   * Renewal window applied on forward progress when `timeoutMs` was clamped to
   * a shorter remaining retry budget before progress resumed.
   */
  progressTimeoutMs?: number;
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
  /**
   * Enforce strict read-only permissions at the agy runtime boundary (used for
   * compaction summarization and read-only `/btw:ask` aside turns): omits
   * `--dangerously-skip-permissions` and overrides session settings so edits,
   * writes, and shell commands are automatically denied in headless mode.
   */
  readOnlyPermissions?: boolean;
  /** Non-argv bridge/catalog fingerprint used by persistent executors. */
  bridgeRevision?: string;
  /** Preflight-selected absolute binary. Normally resolved lazily. */
  binary?: string;
  /** Called with each structured activity event as tool steps stream in. */
  onActivity?: (activity: AgyActivity) => void;
  /** Called whenever forward agent progress is observed on stdout or SQLite. */
  onProgress?: () => void;
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
  /** Last agy-side API error (e.g. `UNAVAILABLE (code 503): No capacity ...`) seen before the stall. */
  readonly apiError?: string;

  constructor(stalledMs: number, toolActive: boolean, apiError?: string) {
    super(
      `agy stream stalled: no events for ${Math.round(stalledMs / 1000)}s${
        toolActive ? " while a tool step was active" : ""
      }${apiError ? ` (agy: ${apiError})` : ""}`,
    );
    this.name = "AgyStallError";
    this.stalledMs = stalledMs;
    this.toolActive = toolActive;
    if (apiError) this.apiError = apiError;
  }

  /** Server has no capacity for the model: restarting only re-queues the request, so callers should not retry. */
  get isCapacity(): boolean {
    return /\bNo capacity available\b/i.test(this.apiError ?? "");
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

export const READ_ONLY_AGY_SETTINGS_JSON = JSON.stringify({
  agentMode: "default",
  toolPermission: "strict",
  permissions: { allow: [] },
});

/**
 * Extract a concise, structured failure reason from agy stderr when the process
 * exits early (e.g. exit code 3 with `AGY_ERROR: {...}` or `[agy] print timeout after ...`).
 */
export function extractAgyStderrSummary(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const timeoutLine = [...lines]
    .reverse()
    .find((line) => /^(?:\[agy\]|Print mode:)\s+print timeout after\b/i.test(line));
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const agyErrMatch = /^AGY_ERROR:\s*(\{.+\})\s*$/.exec(line);
    if (!agyErrMatch) continue;
    try {
      const parsed = JSON.parse(agyErrMatch[1]!) as Record<string, unknown>;
      const primary =
        (typeof parsed.short_error === "string" && parsed.short_error.trim()) ||
        (typeof parsed.message === "string" && parsed.message.trim()) ||
        (typeof parsed.error === "string" && parsed.error.trim()) ||
        (typeof parsed.details === "string" && parsed.details.trim()) ||
        "";
      const status =
        (typeof parsed.canonical_status === "string" && parsed.canonical_status.trim()) ||
        (typeof parsed.status === "string" && parsed.status.trim()) ||
        "";
      const code =
        typeof parsed.error_code === "number" || typeof parsed.error_code === "string"
          ? String(parsed.error_code)
          : typeof parsed.code === "number" || typeof parsed.code === "string"
            ? String(parsed.code)
            : "";
      const tasksRaw = Array.isArray(parsed.abandoned_tasks)
        ? parsed.abandoned_tasks
        : Array.isArray(parsed.abandonedTasks)
          ? parsed.abandonedTasks
          : undefined;
      const taskNames = tasksRaw
        ?.map((t) => {
          if (typeof t === "string") return t.trim();
          if (t && typeof t === "object") {
            const rec = t as Record<string, unknown>;
            return String(rec.name ?? rec.id ?? rec.command ?? "").trim();
          }
          return "";
        })
        .filter(Boolean);
      const headParts: string[] = [];
      if (status || code) {
        const badge = [status, code].filter(Boolean).join(" ");
        if (!primary.includes(badge)) headParts.push(`[${badge}]`);
      }
      if (primary) headParts.push(primary);
      const sections: string[] = [];
      if (headParts.length > 0) sections.push(headParts.join(" "));
      if (taskNames && taskNames.length > 0) {
        sections.push(`terminated tasks: ${taskNames.join(", ")}`);
      }
      if (timeoutLine && !primary.toLowerCase().includes("print timeout")) {
        sections.push(timeoutLine);
      }
      if (sections.length > 0) return sections.join(" · ");
    } catch {
      // Malformed JSON after AGY_ERROR: fall through to line tail.
    }
  }
  if (timeoutLine) return timeoutLine;
  return lines.slice(-3).join("\n");
}

function permissionArgsForRequest(
  request: Pick<AgyTurnRequest, "readOnlyPermissions">,
): string[] {
  return request.readOnlyPermissions
    ? ["--settings", READ_ONLY_AGY_SETTINGS_JSON]
    : ["--dangerously-skip-permissions"];
}

export function buildOneShotAgyArgs(request: AgyTurnRequest): string[] {
  // Delegate termination to Pi's progress-sliding deadline rather than agy's
  // static --print-timeout, which cuts active multi-step turns at a fixed wall clock.
  // --print consumes the next token, so the prompt must remain adjacent.
  return appendProcessArgs(
    [
      "--print",
      request.prompt,
      ...permissionArgsForRequest(request),
      "--disable-slash-commands",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "2147484s",
    ],
    request,
  );
}

export function buildDriverAgyArgs(request: Omit<AgyTurnRequest, "prompt">): string[] {
  // agy < 1.5.0 defaulted stream-json print wait to 5m (plus a hidden 30m cap on
  // background tasks) and treated 0s as immediate expiry; agy 1.5.0+ waits until
  // completion on 0s and exits with code 3 + AGY_ERROR on --print-timeout expiry.
  // Keep 2147484s for MIN_AGY_VERSION compatibility while Pi's sliding deadline owns termination.
  return appendProcessArgs(
    [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "2147484s",
      ...permissionArgsForRequest(request),
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
    let stallGraces = 0;

    const emitSideActivity = (activity: AgyActivity) => {
      outcome.activities.push(activity);
      request.onActivity?.(activity);
    };

    const untrack = () => {
      if (untracked) return;
      untracked = true;
      untrackAgyChild(child);
    };

    let abortHandler: (() => void) | undefined;
    const initialTimeoutMs = request.timeoutMs ?? 1_800_000;
    const renewTimeoutMs = request.progressTimeoutMs ?? initialTimeoutMs;
    const finishLogical = (fn: () => void) => {
      if (settled) return;
      settled = true;
      thoughtTracker.finishCompacting(emitSideActivity);
      killDeadline.clear();
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

    const killDeadline = createSlidingDeadline(
      initialTimeoutMs,
      () => {
        killAgyTree(child);
        untrack();
        finishLogical(() => {
          reject(
            new AgySpawnError(
              `agy turn timed out after ${Math.round(renewTimeoutMs / 1000)}s`,
              stderrBuf,
            ),
          );
        });
      },
      renewTimeoutMs,
    );

    const recordProgress = () => {
      killDeadline.touch();
      request.onProgress?.();
    };

    const syncThoughtTracker = () => {
      const progressed = thoughtTracker.sync(
        outcome.conversationId ?? request.conversationId,
        emitSideActivity,
      );
      if (thoughtTracker.agentProgressed) recordProgress();
      return progressed;
    };

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
          if (syncThoughtTracker()) {
            stallGraces = 0;
            armStall();
            return;
          }
          const likelyCompacting = thoughtTracker.isLikelyCompacting(activeTools.size > 0);
          if (
            (thoughtTracker.isGenerating || likelyCompacting || thoughtTracker.isRetrying) &&
            stallGraces < 3
          ) {
            stallGraces += 1;
            armStall();
            return;
          }
          killAgyTree(child);
          untrack();
          finishLogical(() => {
            reject(new AgyStallError(budgetMs, activeTools.size > 0, thoughtTracker.lastApiError));
          });
        }, budgetMs);
      };
      rearmStall = () => {
        stallGraces = 0;
        armStall();
      };
      armStall();
      child.stdout?.on("data", rearmStall);
      child.stderr?.on("data", rearmStall);
    }

    const pollThoughts = () => {
      if (settled || outcome.finished) return;
      if (syncThoughtTracker()) {
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
        if (
          !thoughtTracker.prepareStreamActivity(
            activity,
            outcome.conversationId ?? request.conversationId,
            emitSideActivity,
          )
        ) {
          continue;
        }
        const repeatedToolStart =
          activity.type === "tool_start" && activeTools.has(agyToolStepKey(activity));
        trackActiveToolStep(activeTools, activity);
        if (isAgyProgressActivity(activity, repeatedToolStart)) {
          recordProgress();
        }
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
        const tail = extractAgyStderrSummary(stderrBuf);
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
