/**
 * Off-stream reader for agy's real-time thinking text, compaction state, and
 * step progress in SQLite + CLI logs.
 *
 * `agy --output-format stream-json` never emits `thinking` text on stdout (only
 * `usage.thinking_tokens` when an `agent_response` step reaches DONE), emits
 * zero bytes on stdout for the entire duration of a `PLANNER_RESPONSE` step's
 * thinking phase and tool-call argument generation, and emits zero bytes on
 * stdout while `NewContextSummaryHook` runs context compaction (emitting only a
 * single `step_type: "checkpoint", state: "DONE"` update once finished).
 *
 * Combining `<conversationId>.db` (`steps` table) with incremental tailing of
 * `~/.gemini/antigravity-cli/log/cli-*.log` lets Pi:
 * - stream native thinking blocks live (`step_type = 15`, `PlannerResponse.thinking`),
 * - detect live in-flight context compaction (`isCompacting`) so Pi renders
 *   native compaction status and extends stall budgets instead of killing agy,
 * - extract exact pre-compaction context tokens (`f5.f9`) and the generated
 *   markdown summary (`f30.f5`) from completed `CHECKPOINT` steps (`step_type = 23`).
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanAgyCheckpointSummary } from "./agy-compaction.ts";
import type { AgyActivity, AgyUsage } from "./reducer.ts";

const STEP_TYPE_USER_INPUT = 14;
const STEP_TYPE_PLANNER_RESPONSE = 15;
const STEP_TYPE_CHECKPOINT = 23;
const STEP_TYPE_SYSTEM_MESSAGE = 101;

const STEP_STATUS_PENDING = 1;
const STEP_STATUS_RUNNING = 2;
const STEP_STATUS_DONE = 3;
const STEP_STATUS_CANCELED = 5;
const STEP_STATUS_GENERATING = 8;

/** Minimum context tokens before an unindexed streamGenerateContent call can be compaction. */
const MIN_COMPACTION_CONTEXT_TOKENS = 100_000;

/** Default total attempts in agy's internal model retry loop (`ModelRequestStatus.max_attempts = 10`). */
export const AGY_DEFAULT_MAX_RETRY_ATTEMPTS = 10;

export function resolveAgyRetryLabel(apiError?: string): string {
  const isModelUnavailable =
    !apiError ||
    /\bUNAVAILABLE\b|\b503\b|\b502\b|\b504\b|\bNo capacity\b|\boverloaded\b|\bRESOURCE_EXHAUSTED\b|\b429\b|\bDEADLINE_EXCEEDED\b|\btimeout\b|\bEOF\b|\bconnection\b/i.test(
      apiError,
    );
  return isModelUnavailable ? "Model unavailable" : "API error";
}

export interface AgyRetryCountdownState {
  label: string;
  attempt: number;
  maxAttempts: number;
  retryAtMs?: number;
  activeSuffix?: string;
}

export function formatAgyLiveRetryLine(
  state: AgyRetryCountdownState,
  nowMs = Date.now(),
): { text: string; countingDown: boolean } {
  const base = `${state.label} (attempt ${state.attempt}/${Math.max(state.attempt, state.maxAttempts)})`;
  const remainingSec =
    state.retryAtMs !== undefined ? Math.ceil((state.retryAtMs - nowMs) / 1000) : 0;
  if (remainingSec > 0) {
    return {
      text: `${base}, retrying in ${remainingSec}s`,
      countingDown: true,
    };
  }
  const suffix = state.activeSuffix ?? "retrying...";
  return {
    text: suffix ? `${base}, ${suffix}` : base,
    countingDown: false,
  };
}

export function formatAgyRetryStatus(
  attempt: number,
  maxAttempts: number,
  remainingSeconds?: number,
  apiError?: string,
): string {
  const prefix = resolveAgyRetryLabel(apiError);
  const base = `${prefix} (attempt ${attempt}/${Math.max(attempt, maxAttempts)})`;
  if (remainingSeconds !== undefined && remainingSeconds > 0) {
    return `${base}, retrying in ${Math.max(1, Math.round(remainingSeconds))}s`;
  }
  return `${base}, retrying...`;
}
/** Grace delay after HTTP response headers so normal PLANNER_RESPONSE steps have landed in SQLite. */
const COMPACTION_STREAM_GRACE_MS = 1_500;

export interface AgyThinkingDeltaActivity {
  type: "thinking_delta";
  delta: string;
  stepId: number;
}

export interface AgyCheckpointSummaryInfo {
  stepId: number;
  beforeTokens?: number;
  summary?: string;
}

export interface AgyThoughtPollResult {
  deltas: AgyThinkingDeltaActivity[];
  /** Newly completed checkpoint steps (`step_type = 23, status = 3`) observed in SQLite. */
  checkpoints: AgyCheckpointSummaryInfo[];
  /** Newly completed planner response usages (`step_type = 15, status = 3`) in this turn. */
  stepUsages: Array<{ stepId: number; usage: AgyUsage }>;
  /** True when new rows, status transitions, or growing step_payload bytes were observed. */
  dbProgressed: boolean;
  /** True when non-input/system agent steps (planner, tool, checkpoint) progressed in SQLite. */
  agentProgressed: boolean;
  /** True when the turn has a step actively generating (status 8) or pending (status 1). */
  isGenerating: boolean;
  /** True when agy is actively generating a context compaction summary. */
  isCompacting: boolean;
  /** True when agy logged an in-process API/model retry backoff (`Retry-After` / `retrying in ...`) still in progress. */
  isRetrying: boolean;
  /** True when a new in-process retry attempt was logged since the previous poll. */
  retryAttempted: boolean;
  /** Latest known `input_tokens + cache_read_tokens` from SQLite step metadata. */
  lastContextTokens?: number;
  /** True when the newest step in SQLite is waiting on the next planner/checkpoint step. */
  awaitingPlannerAfterStep: boolean;
}

export interface AgyThoughtTrackerOptions {
  /** Override `~/.gemini/antigravity-cli/log` (used in tests). */
  logDir?: string;
  /** Spawned `agy acp` / `agy` PID for direct `acp-server-*-<pid>.log` binding. */
  pid?: number;
  /** Clock override for deterministic compaction-grace tests. */
  now?: () => number;
  /**
   * When false (e.g. ACP mode where `agent_thought_chunk` streams directly on
   * JSON-RPC), suppress SQLite `thinking_delta` emissions while still tracking
   * compaction, checkpoints, retries, and DB liveness. Defaults to true.
   */
  emitThinkingDeltas?: boolean;
  /**
   * When true (ACP mode, where JSON-RPC `PromptResponse.usage` only reports a
   * turn-end sum across all internal sub-calls), emit per-step `{ type: "usage" }`
   * activities directly from completed SQLite `PLANNER_RESPONSE` rows so Pi
   * observes accurate single-step context window tokens. Defaults to false.
   */
  emitStepUsage?: boolean;
}

function defaultConversationsDir(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "conversations");
}

function defaultLogDirFromConversationsDir(conversationsDir: string): string {
  return join(dirname(conversationsDir), "log");
}

function readVarint(buf: Uint8Array, pos: number): [number, number] | undefined {
  let result = 0;
  let shift = 0;
  let i = pos;
  while (i < buf.length) {
    const byte = buf[i++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7;
    if (shift > 53) return undefined;
  }
  return undefined;
}

function skipWireValue(buf: Uint8Array, pos: number, wireType: number): number | undefined {
  switch (wireType) {
    case 0: {
      const v = readVarint(buf, pos);
      return v ? v[1] : undefined;
    }
    case 1:
      return pos + 8 <= buf.length ? pos + 8 : undefined;
    case 2: {
      const len = readVarint(buf, pos);
      if (!len) return undefined;
      const end = len[1] + len[0];
      return end <= buf.length ? end : undefined;
    }
    case 5:
      return pos + 4 <= buf.length ? pos + 4 : undefined;
    default:
      return undefined;
  }
}

function toBuffer(payload: Uint8Array | Buffer): Buffer {
  return payload instanceof Buffer
    ? payload
    : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
}

/**
 * Extract `PlannerResponse.thinking` (top-level field 20 -> sub-field 3) from a
 * raw `CortexStep` protobuf payload (`step_payload` column in `steps`).
 */
export function extractThinkingFromStepPayload(payload: Uint8Array | Buffer): string {
  const buf = toBuffer(payload);
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag[1];
    const fieldNumber = Math.floor(tag[0] / 8);
    const wireType = tag[0] & 7;
    if (fieldNumber === 20 && wireType === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      const start = len[1];
      const end = Math.min(buf.length, start + len[0]);
      return extractThinkingFromPlannerResponse(buf.subarray(start, end));
    }
    const next = skipWireValue(buf, pos, wireType);
    if (next === undefined) break;
    pos = next;
  }
  return "";
}

function extractThinkingFromPlannerResponse(buf: Buffer): string {
  const chunks: string[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag[1];
    const fieldNumber = Math.floor(tag[0] / 8);
    const wireType = tag[0] & 7;
    if (fieldNumber === 3 && wireType === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      const start = len[1];
      const end = Math.min(buf.length, start + len[0]);
      if (end > start) {
        chunks.push(buf.subarray(start, end).toString("utf8"));
      }
      pos = end;
      continue;
    }
    const next = skipWireValue(buf, pos, wireType);
    if (next === undefined) break;
    pos = next;
  }
  return chunks.join("");
}

/**
 * Extract full single-step `AgyUsage` from `CortexStep.metadata` (field 5) ->
 * `generator_metadata` (field 9: field 2 = `input_tokens`, field 3 =
 * `output_tokens`, field 5 = `cache_read_tokens`, field 9 = `thinking_tokens`).
 */
export function extractUsageFromStepPayload(
  payload: Uint8Array | Buffer,
): AgyUsage | undefined {
  const buf = toBuffer(payload);
  let pos = 0;
  let latestUsage: AgyUsage | undefined;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag[1];
    const fieldNumber = Math.floor(tag[0] / 8);
    const wireType = tag[0] & 7;
    if (fieldNumber === 5 && wireType === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      const start = len[1];
      const end = Math.min(buf.length, start + len[0]);
      const metaUsage = extractUsageFromStepMetadata(buf.subarray(start, end));
      if (metaUsage !== undefined) latestUsage = metaUsage;
      pos = end;
      continue;
    }
    const next = skipWireValue(buf, pos, wireType);
    if (next === undefined) break;
    pos = next;
  }
  return latestUsage;
}

/**
 * Extract `input_tokens + cache_read_tokens` from `CortexStep.metadata` (field 5)
 * -> `generator_metadata` (field 9: field 2 = `input_tokens`, field 5 = `cache_read_tokens`).
 */
export function extractContextTokensFromStepPayload(
  payload: Uint8Array | Buffer,
): number | undefined {
  const usage = extractUsageFromStepPayload(payload);
  if (!usage) return undefined;
  const total = (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

function extractUsageFromStepMetadata(buf: Buffer): AgyUsage | undefined {
  let pos = 0;
  let latestUsage: AgyUsage | undefined;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag[1];
    const fieldNumber = Math.floor(tag[0] / 8);
    const wireType = tag[0] & 7;
    if (fieldNumber === 9 && wireType === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      const start = len[1];
      const end = Math.min(buf.length, start + len[0]);
      const genUsage = extractUsageFromGeneratorMetadata(buf.subarray(start, end));
      if (genUsage !== undefined) latestUsage = genUsage;
      pos = end;
      continue;
    }
    const next = skipWireValue(buf, pos, wireType);
    if (next === undefined) break;
    pos = next;
  }
  return latestUsage;
}

function extractUsageFromGeneratorMetadata(buf: Buffer): AgyUsage | undefined {
  let pos = 0;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let thinkingTokens: number | undefined;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag[1];
    const fieldNumber = Math.floor(tag[0] / 8);
    const wireType = tag[0] & 7;
    if ((fieldNumber === 2 || fieldNumber === 3 || fieldNumber === 5 || fieldNumber === 9) && wireType === 0) {
      const v = readVarint(buf, pos);
      if (!v) break;
      if (fieldNumber === 2) inputTokens = v[0];
      else if (fieldNumber === 3) outputTokens = v[0];
      else if (fieldNumber === 5) cacheReadTokens = v[0];
      else if (fieldNumber === 9) thinkingTokens = v[0];
      pos = v[1];
      continue;
    }
    const next = skipWireValue(buf, pos, wireType);
    if (next === undefined) break;
    pos = next;
  }
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    thinkingTokens === undefined
  ) {
    return undefined;
  }
  const totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheReadTokens ?? 0);
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return undefined;
  return {
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(thinkingTokens !== undefined ? { thinking_tokens: thinkingTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cache_read_tokens: cacheReadTokens } : {}),
    total_tokens: totalTokens,
  };
}

/**
 * Extract `CortexStepCheckpoint.session_summary` (top-level field 30 -> sub-field 5)
 * from a completed `CHECKPOINT` (`step_type = 23`) payload.
 */
export function extractCheckpointSummaryFromStepPayload(
  payload: Uint8Array | Buffer,
): string | undefined {
  const buf = toBuffer(payload);
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag[1];
    const fieldNumber = Math.floor(tag[0] / 8);
    const wireType = tag[0] & 7;
    if (fieldNumber === 30 && wireType === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      const start = len[1];
      const end = Math.min(buf.length, start + len[0]);
      return extractSummaryFromCheckpointProto(buf.subarray(start, end));
    }
    const next = skipWireValue(buf, pos, wireType);
    if (next === undefined) break;
    pos = next;
  }
  return undefined;
}

function extractSummaryFromCheckpointProto(buf: Buffer): string | undefined {
  let pos = 0;
  const parts: string[] = [];
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag[1];
    const fieldNumber = Math.floor(tag[0] / 8);
    const wireType = tag[0] & 7;
    if (fieldNumber === 5 && wireType === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      const start = len[1];
      const end = Math.min(buf.length, start + len[0]);
      if (end > start) {
        parts.push(buf.subarray(start, end).toString("utf8"));
      }
      pos = end;
      continue;
    }
    const next = skipWireValue(buf, pos, wireType);
    if (next === undefined) break;
    pos = next;
  }
  if (parts.length === 0) return undefined;
  const cleaned = cleanAgyCheckpointSummary(parts.join("\n"));
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Parse glog prefix `I1105 07:38:08.577324` against a reference epoch for initial tail binds. */
function parseGlogTimestampMs(line: string, refNowMs: number): number | undefined {
  const m = /^[IWEF](\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{1,6})\b/.exec(line);
  if (!m) return undefined;
  const ref = new Date(refNowMs);
  const month = Number(m[1]) - 1;
  const day = Number(m[2]);
  const hour = Number(m[3]);
  const minute = Number(m[4]);
  const second = Number(m[5]);
  const ms = Math.floor(Number(m[6].padEnd(6, "0")) / 1000);
  let year = ref.getFullYear();
  if (ref.getMonth() === 0 && month === 11) year -= 1;
  else if (ref.getMonth() === 11 && month === 0) year += 1;
  const ts = new Date(year, month, day, hour, minute, second, ms).getTime();
  return Number.isFinite(ts) ? ts : undefined;
}

/** Parse Go `time.Duration` text (e.g. `500ms`, `12s`, `1m30s`) into milliseconds. */
export function parseGoDurationMs(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const tokenRe = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
  let totalMs = 0;
  let consumed = 0;
  for (const m of trimmed.matchAll(tokenRe)) {
    if (m.index !== consumed) return undefined;
    consumed += m[0].length;
    const val = Number(m[1]);
    if (!Number.isFinite(val)) return undefined;
    switch (m[2]) {
      case "ns":
        totalMs += val / 1_000_000;
        break;
      case "us":
      case "µs":
        totalMs += val / 1_000;
        break;
      case "ms":
        totalMs += val;
        break;
      case "s":
        totalMs += val * 1_000;
        break;
      case "m":
        totalMs += val * 60_000;
        break;
      case "h":
        totalMs += val * 3_600_000;
        break;
    }
  }
  return consumed === trimmed.length && totalMs > 0 ? Math.round(totalMs) : undefined;
}

function readFileSlice(filePath: string, offset: number, maxBytes: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, offset);
    return bytesRead > 0 ? buf.subarray(0, bytesRead) : Buffer.alloc(0);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

interface StepRow {
  idx: number;
  step_type: number;
  status: number;
  payload_len: number;
  step_payload: Uint8Array | null;
}

interface MaxStepSummaryRow {
  idx: number;
  step_type: number;
  status: number;
}

/**
 * Per-turn tracker that polls `<conversationId>.db` (and incrementally tails
 * the active `cli-*.log` when available) for new thinking deltas, live
 * compaction status, completed checkpoint summaries, and step liveness.
 * Safe to call when the DB or log directory does not exist (e.g. unit tests).
 */
export class AgyThoughtTracker {
  #conversationsDir: string;
  #logDir: string;
  #now: () => number;
  #createdAtMs: number;
  #conversationId: string | undefined;
  #db: DatabaseSync | undefined;
  #dbPath: string | undefined;
  /** Minimum step index considered part of this turn. */
  #minStepIndex = 0;
  #baselineCaptured = false;
  /** Emitted thinking character length per step_index. */
  #emittedLengths = new Map<number, number>();
  /** Completed checkpoint step_indexes already returned from poll(). */
  #emittedCheckpoints = new Set<number>();
  /** Fingerprint of the last seen DB state for progress detection. */
  #lastMaxIdx = -1;
  #lastTotalBytes = 0;
  #lastStatusSignature = "";
  #lastAgentStatusSignature = "";

  /** Cached context footprint across completed planner/checkpoint steps. */
  #lastUsageIdx = -1;
  #lastContextTokens: number | undefined;
  #lastTurnStepUsage: AgyUsage | undefined;
  #emittedStepUsages = new Set<number>();
  #compactedAfterIdx = -1;

  /** Incremental CLI log tail state for live compaction detection. */
  #pid: number | undefined;
  #boundByPid = false;
  #cliLogPath: string | undefined;
  #cliLogOffset = 0;
  #cliLogRemainder = "";
  #lastCliLogScanAtMs = 0;
  #pendingMonitorCalls = 0;
  #activeStreamStartedAtMs: number | undefined;
  #activeStreamResponseId: string | undefined;
  #streamStartMaxIdx = -1;
  #retryUntilMs = 0;
  #retryStreak = 0;
  #retrySeq = 0;
  #emittedRetrySeq = 0;
  #activeRetryInfo:
    | {
        seq: number;
        label: string;
        attempt: number;
        maxAttempts: number;
        delaySeconds: number;
        retryAtMs: number;
        message: string;
        apiError?: string;
      }
    | undefined;
  #lastApiError: string | undefined;
  #sawRetrySinceLastPoll = false;

  /** Turn-level stream synchronization state shared by AgyDriver and runAgyTurn. */
  #lastIsGenerating = false;
  #lastIsRetrying = false;
  #lastAgentProgressed = false;
  #lastAwaitingPlannerAfterStep = false;
  #emittedCompacting = false;
  #emittedRetrying = false;
  #emitThinkingDeltas = true;
  #emitStepUsage = false;
  #checkpointDetailsByStepId = new Map<number, AgyCheckpointSummaryInfo>();
  #streamEmittedCheckpoints = new Set<number>();

  constructor(
    conversationId?: string,
    conversationsDir = defaultConversationsDir(),
    options?: AgyThoughtTrackerOptions,
  ) {
    this.#conversationsDir = conversationsDir;
    this.#logDir = options?.logDir ?? defaultLogDirFromConversationsDir(conversationsDir);
    this.#pid = options?.pid;
    this.#now = options?.now ?? Date.now;
    this.#emitThinkingDeltas = options?.emitThinkingDeltas ?? true;
    this.#emitStepUsage = options?.emitStepUsage ?? false;
    this.#createdAtMs = this.#now();
    if (conversationId) {
      this.#conversationId = conversationId;
      this.#captureBaseline();
    }
    if (conversationId || this.#pid !== undefined) {
      this.#tryBindCliLog(this.#createdAtMs, true);
    }
  }

  /** Bind or update the conversation ID once discovered from the stream. */
  setConversationId(conversationId: string | undefined): void {
    if (!conversationId || conversationId === this.#conversationId) return;
    this.close();
    this.#conversationId = conversationId;
    this.#lastUsageIdx = -1;
    this.#lastContextTokens = undefined;
    if (!this.#boundByPid) {
      this.#cliLogPath = undefined;
      this.#cliLogOffset = 0;
      this.#cliLogRemainder = "";
      this.#lastCliLogScanAtMs = 0;
      this.#pendingMonitorCalls = 0;
      this.#activeStreamStartedAtMs = undefined;
      this.#activeStreamResponseId = undefined;
      this.#streamStartMaxIdx = -1;
      this.#retryUntilMs = 0;
      this.#retryStreak = 0;
      this.#activeRetryInfo = undefined;
      this.#lastApiError = undefined;
      this.#sawRetrySinceLastPoll = false;
    }
    if (!this.#baselineCaptured) {
      // If the conversation already existed before this turn, anchor at the
      // newest USER_INPUT step so earlier turns are never replayed.
      this.#captureBaselineFromLatestUserInput();
    }
    this.#tryBindCliLog(this.#now(), false);
  }

  /**
   * Poll SQLite (and tail CLI log when bound) for thinking deltas, checkpoint
   * completions, live compaction status, and DB liveness signals.
   * Never throws; returns empty state if the DB is absent or locked.
   */
  poll(): AgyThoughtPollResult {
    const nowMs = this.#now();
    const db = this.#ensureDb();
    if (!db) {
      this.#tailCliLog(-1, nowMs);
      const retryAttempted = this.#sawRetrySinceLastPoll;
      this.#sawRetrySinceLastPoll = false;
      const isRetrying = nowMs < this.#retryUntilMs;
      if (!isRetrying) this.#activeRetryInfo = undefined;
      return {
        deltas: [],
        checkpoints: [],
        stepUsages: [],
        dbProgressed: false,
        agentProgressed: retryAttempted,
        isGenerating: false,
        isCompacting: false,
        isRetrying,
        retryAttempted,
        lastContextTokens: this.#lastContextTokens,
        awaitingPlannerAfterStep: false,
      };
    }

    this.#refreshContextTokensBaseline(db);

    let overallMaxRow: MaxStepSummaryRow | undefined;
    let rows: StepRow[];
    try {
      overallMaxRow = db
        .prepare("SELECT idx, step_type, status FROM steps ORDER BY idx DESC LIMIT 1")
        .get() as MaxStepSummaryRow | undefined;
      const stmt = db.prepare(
        `SELECT idx, step_type, status, length(step_payload) AS payload_len,
                CASE
                  WHEN step_type = 15 THEN step_payload
                  WHEN step_type = 23 AND status = 3 THEN step_payload
                  ELSE NULL
                END AS step_payload
           FROM steps
          WHERE idx >= ?
          ORDER BY idx ASC`,
      );
      rows = stmt.all(this.#minStepIndex) as unknown as StepRow[];
    } catch {
      this.#tailCliLog(-1, nowMs);
      const retryAttempted = this.#sawRetrySinceLastPoll;
      this.#sawRetrySinceLastPoll = false;
      return {
        deltas: [],
        checkpoints: [],
        stepUsages: [],
        dbProgressed: false,
        agentProgressed: retryAttempted,
        isGenerating: false,
        isCompacting: false,
        isRetrying: nowMs < this.#retryUntilMs,
        retryAttempted,
        lastContextTokens: this.#lastContextTokens,
        awaitingPlannerAfterStep: false,
      };
    }

    const overallMaxIdx = overallMaxRow?.idx ?? -1;
    const awaitingPlannerAfterStep =
      overallMaxRow !== undefined &&
      (overallMaxRow.step_type !== STEP_TYPE_PLANNER_RESPONSE ||
        overallMaxRow.status === STEP_STATUS_CANCELED);

    // Advance minStepIndex if a new USER_INPUT step appeared at the start of this turn
    // (e.g. before any planner response for this turn was emitted).
    for (const row of rows) {
      if (row.step_type === STEP_TYPE_USER_INPUT && row.idx > this.#minStepIndex) {
        if (this.#emittedLengths.size === 0 && this.#emittedCheckpoints.size === 0) {
          this.#minStepIndex = row.idx;
        }
      }
    }

    const prePollMaxIdx = this.#lastMaxIdx >= 0 ? this.#lastMaxIdx : overallMaxIdx;
    let maxIdx = this.#lastMaxIdx;
    let totalBytes = 0;
    const statusParts: string[] = [];
    const agentStatusParts: string[] = [];
    let isGenerating = false;
    let hasRunningStep =
      overallMaxRow !== undefined &&
      (overallMaxRow.status === STEP_STATUS_PENDING ||
        overallMaxRow.status === STEP_STATUS_RUNNING ||
        overallMaxRow.status === STEP_STATUS_GENERATING);
    let sqlCheckpointActive = false;
    const deltas: AgyThinkingDeltaActivity[] = [];
    const checkpoints: AgyCheckpointSummaryInfo[] = [];
    const stepUsages: Array<{ stepId: number; usage: AgyUsage }> = [];

    for (const row of rows) {
      if (row.idx < this.#minStepIndex) continue;
      if (row.idx > maxIdx) maxIdx = row.idx;
      totalBytes += row.payload_len ?? 0;
      const part = `${row.idx}:${row.status}:${row.payload_len}`;
      statusParts.push(part);
      if (row.step_type !== STEP_TYPE_USER_INPUT && row.step_type !== STEP_TYPE_SYSTEM_MESSAGE) {
        agentStatusParts.push(part);
      }
      if (
        row.status === STEP_STATUS_GENERATING ||
        row.status === STEP_STATUS_PENDING ||
        row.status === STEP_STATUS_RUNNING
      ) {
        hasRunningStep = true;
      }
      if (row.status === STEP_STATUS_GENERATING || row.status === STEP_STATUS_PENDING) {
        isGenerating = true;
      }
      if (
        row.step_type === STEP_TYPE_CHECKPOINT &&
        (row.status === STEP_STATUS_PENDING ||
          row.status === STEP_STATUS_RUNNING ||
          row.status === STEP_STATUS_GENERATING)
      ) {
        sqlCheckpointActive = true;
        isGenerating = true;
      }
      if (row.step_type === STEP_TYPE_PLANNER_RESPONSE && row.step_payload) {
        const fullThinking = extractThinkingFromStepPayload(row.step_payload);
        if (fullThinking) {
          const prevLen = this.#emittedLengths.get(row.idx) ?? 0;
          if (fullThinking.length > prevLen) {
            const delta = fullThinking.slice(prevLen);
            this.#emittedLengths.set(row.idx, fullThinking.length);
            deltas.push({
              type: "thinking_delta",
              delta,
              stepId: row.idx,
            });
          }
        }
        if (row.status === STEP_STATUS_DONE) {
          const stepUsage = extractUsageFromStepPayload(row.step_payload);
          if (stepUsage) {
            const ctxTokens = (stepUsage.input_tokens ?? 0) + (stepUsage.cache_read_tokens ?? 0);
            if (row.idx > this.#lastUsageIdx && ctxTokens > 0) {
              this.#lastContextTokens = ctxTokens;
            }
            if (!this.#emittedStepUsages.has(row.idx)) {
              this.#emittedStepUsages.add(row.idx);
              this.#lastTurnStepUsage = stepUsage;
              stepUsages.push({ stepId: row.idx, usage: stepUsage });
            }
          }
          if (row.idx > this.#lastUsageIdx) {
            this.#lastUsageIdx = row.idx;
          }
        }
      } else if (
        row.step_type === STEP_TYPE_CHECKPOINT &&
        row.status === STEP_STATUS_DONE &&
        row.step_payload
      ) {
        const ownBeforeTokens = extractContextTokensFromStepPayload(row.step_payload);
        const beforeTokens = ownBeforeTokens ?? this.#lastContextTokens;
        if (!this.#emittedCheckpoints.has(row.idx)) {
          this.#emittedCheckpoints.add(row.idx);
          const summary = extractCheckpointSummaryFromStepPayload(row.step_payload);
          checkpoints.push({
            stepId: row.idx,
            ...(beforeTokens !== undefined ? { beforeTokens } : {}),
            ...(summary !== undefined ? { summary } : {}),
          });
        }
        if (row.idx > this.#compactedAfterIdx) {
          this.#compactedAfterIdx = row.idx;
        }
        if (row.idx > this.#lastUsageIdx) {
          this.#lastUsageIdx = row.idx;
        }
      }
    }

    const cliCompacting = this.#pollCliCompacting(
      overallMaxIdx,
      prePollMaxIdx,
      rows,
      hasRunningStep,
      isGenerating,
      nowMs,
    );
    const isCompacting = sqlCheckpointActive || cliCompacting;
    if (hasRunningStep || isGenerating) {
      this.#retryUntilMs = 0;
      this.#retryStreak = 0;
      this.#activeRetryInfo = undefined;
    }
    const retryAttempted = this.#sawRetrySinceLastPoll;
    this.#sawRetrySinceLastPoll = false;
    const isRetrying = nowMs < this.#retryUntilMs;
    if (!isRetrying) this.#activeRetryInfo = undefined;

    const statusSignature = statusParts.join(",");
    const agentStatusSignature = agentStatusParts.join(",");
    const dbProgressed =
      rows.length > 0 &&
      (maxIdx > this.#lastMaxIdx ||
        totalBytes > this.#lastTotalBytes ||
        statusSignature !== this.#lastStatusSignature);
    const agentProgressed =
      retryAttempted ||
      (agentStatusParts.length > 0 && agentStatusSignature !== this.#lastAgentStatusSignature);

    if (rows.length > 0) {
      this.#lastMaxIdx = maxIdx;
      this.#lastTotalBytes = totalBytes;
      this.#lastStatusSignature = statusSignature;
      this.#lastAgentStatusSignature = agentStatusSignature;
    }

    return {
      deltas,
      checkpoints,
      stepUsages,
      dbProgressed,
      agentProgressed,
      isGenerating,
      isCompacting,
      isRetrying,
      retryAttempted,
      lastContextTokens: this.#lastContextTokens,
      awaitingPlannerAfterStep,
    };
  }

  /** Latest single-step `AgyUsage` observed on a completed `PLANNER_RESPONSE` in this turn. */
  get lastTurnStepUsage(): AgyUsage | undefined {
    return this.#lastTurnStepUsage;
  }

  /** Latest SQLite step-generating state observed by sync(). */
  get isGenerating(): boolean {
    return this.#lastIsGenerating;
  }

  /** Last agy API error this turn (`UNAVAILABLE (code 503): No capacity ...`), if agy logged one. */
  get lastApiError(): string | undefined {
    return this.#lastApiError;
  }

  /** True when agy logged an active in-process API/model retry (`Retry-After` / backoff). */
  get isRetrying(): boolean {
    return this.#lastIsRetrying;
  }

  /** True when the most recent sync() observed genuine agent/model/compaction progress. */
  get agentProgressed(): boolean {
    return this.#lastAgentProgressed;
  }

  /** True when compaction is actively in flight in SQLite or CLI/ACP logs. */
  isLikelyCompacting(_hasActiveTools?: boolean): boolean {
    return this.#emittedCompacting;
  }

  /** Emit `{ type: "compacting", active: false }` if a compaction indicator is still active. */
  finishCompacting(emitSideActivity: (activity: AgyActivity) => void): void {
    if (!this.#emittedCompacting) return;
    this.#emittedCompacting = false;
    emitSideActivity({ type: "compacting", active: false });
  }

  /** Emit `{ type: "retrying", active: false }` if a retry indicator is still active. */
  finishRetrying(emitSideActivity: (activity: AgyActivity) => void): void {
    this.#activeRetryInfo = undefined;
    if (!this.#emittedRetrying) return;
    this.#emittedRetrying = false;
    emitSideActivity({ type: "retrying", active: false });
  }

  /** Flush any SQLite-completed checkpoints whose stepId precedes `beforeStepId`. */
  flushUnemittedCheckpoints(
    conversationId: string | undefined,
    emitSideActivity: (activity: AgyActivity) => void,
    beforeStepId?: number,
  ): void {
    const cid = conversationId ?? this.#conversationId;
    for (const [stepId, cp] of this.#checkpointDetailsByStepId) {
      if (this.#streamEmittedCheckpoints.has(stepId)) continue;
      if (beforeStepId !== undefined && stepId >= beforeStepId) continue;
      this.#streamEmittedCheckpoints.add(stepId);
      this.finishCompacting(emitSideActivity);
      emitSideActivity({
        type: "checkpoint",
        stepId,
        conversationId: cid,
        ...(cp.beforeTokens !== undefined ? { beforeTokens: cp.beforeTokens } : {}),
        ...(cp.summary !== undefined ? { summary: cp.summary } : {}),
      });
    }
  }

  /**
   * Poll SQLite/CLI logs, emit any `compacting` transitions or `thinking_delta`
   * events (flushing prior checkpoints in step order), and report whether
   * stream liveness progressed.
   */
  sync(
    conversationId: string | undefined,
    emitSideActivity: (activity: AgyActivity) => void,
  ): boolean {
    if (conversationId) this.setConversationId(conversationId);
    const res = this.poll();
    this.#lastIsGenerating = res.isGenerating;
    this.#lastIsRetrying = res.isRetrying;
    this.#lastAwaitingPlannerAfterStep = res.awaitingPlannerAfterStep;
    for (const cp of res.checkpoints) {
      this.#checkpointDetailsByStepId.set(cp.stepId, cp);
    }
    const compactingFlipped = res.isCompacting !== this.#emittedCompacting;
    this.#lastAgentProgressed =
      res.agentProgressed ||
      res.retryAttempted ||
      res.deltas.length > 0 ||
      res.checkpoints.length > 0 ||
      (compactingFlipped && res.isCompacting);
    if (res.isCompacting || !res.isRetrying || res.deltas.length > 0) {
      this.finishRetrying(emitSideActivity);
    } else if (this.#activeRetryInfo && this.#activeRetryInfo.seq !== this.#emittedRetrySeq) {
      const info = this.#activeRetryInfo;
      this.#emittedRetrySeq = info.seq;
      this.#emittedRetrying = true;
      emitSideActivity({
        type: "retrying",
        active: true,
        label: info.label,
        attempt: info.attempt,
        maxAttempts: info.maxAttempts,
        delaySeconds: info.delaySeconds,
        retryAtMs: info.retryAtMs,
        message: info.message,
        ...(info.apiError ? { apiError: info.apiError } : {}),
      });
    }
    if (compactingFlipped) {
      this.#emittedCompacting = res.isCompacting;
      emitSideActivity({
        type: "compacting",
        active: res.isCompacting,
        ...(res.lastContextTokens !== undefined ? { beforeTokens: res.lastContextTokens } : {}),
      });
    }
    for (const delta of res.deltas) {
      this.flushUnemittedCheckpoints(conversationId, emitSideActivity, delta.stepId);
      if (this.#emitThinkingDeltas) {
        emitSideActivity(delta);
      }
    }
    if (this.#emitStepUsage) {
      for (const item of res.stepUsages) {
        this.flushUnemittedCheckpoints(conversationId, emitSideActivity, item.stepId);
        emitSideActivity({ type: "usage", usage: item.usage });
      }
    }
    return (
      res.deltas.length > 0 ||
      res.stepUsages.length > 0 ||
      res.dbProgressed ||
      res.retryAttempted ||
      compactingFlipped
    );
  }

  /**
   * Reconcile a stream-json `activity` with SQLite checkpoint state before
   * forwarding it to `onActivity`. Returns `false` if `activity` is a
   * duplicate checkpoint that was already flushed from SQLite.
   */
  prepareStreamActivity(
    activity: AgyActivity,
    conversationId: string | undefined,
    emitSideActivity: (activity: AgyActivity) => void,
  ): boolean {
    if (activity.type === "checkpoint") {
      this.finishCompacting(emitSideActivity);
      if (activity.stepId !== undefined) {
        if (this.#streamEmittedCheckpoints.has(activity.stepId)) {
          return false;
        }
        this.#streamEmittedCheckpoints.add(activity.stepId);
        const dbCp = this.#checkpointDetailsByStepId.get(activity.stepId);
        if (activity.beforeTokens === undefined && dbCp?.beforeTokens !== undefined) {
          activity.beforeTokens = dbCp.beforeTokens;
        }
        if (activity.summary === undefined && dbCp?.summary !== undefined) {
          activity.summary = dbCp.summary;
        }
      }
      return true;
    }
    if (
      activity.type === "text" ||
      activity.type === "tool_start" ||
      activity.type === "usage" ||
      activity.type === "result"
    ) {
      this.flushUnemittedCheckpoints(
        conversationId,
        emitSideActivity,
        "stepId" in activity ? activity.stepId : undefined,
      );
    }
    return true;
  }

  close(): void {
    if (this.#db) {
      try {
        this.#db.close();
      } catch {}
      this.#db = undefined;
    }
    this.#dbPath = undefined;
  }

  #refreshContextTokensBaseline(db: DatabaseSync): void {
    if (this.#lastUsageIdx >= 0) return;
    try {
      const checkpointRow = db
        .prepare(
          "SELECT MAX(idx) AS max_cp_idx FROM steps WHERE step_type = ? AND status = ?",
        )
        .get(STEP_TYPE_CHECKPOINT, STEP_STATUS_DONE) as { max_cp_idx?: number | null } | undefined;
      if (typeof checkpointRow?.max_cp_idx === "number" && checkpointRow.max_cp_idx >= 0) {
        this.#compactedAfterIdx = checkpointRow.max_cp_idx;
      }
      const row = db
        .prepare(
          `SELECT idx, step_type, step_payload
             FROM steps
            WHERE step_type IN (?, ?) AND status = ? AND idx < ?
            ORDER BY idx DESC
            LIMIT 1`,
        )
        .get(
          STEP_TYPE_PLANNER_RESPONSE,
          STEP_TYPE_CHECKPOINT,
          STEP_STATUS_DONE,
          this.#minStepIndex,
        ) as { idx: number; step_type: number; step_payload: Uint8Array | null } | undefined;
      if (!row) {
        this.#lastUsageIdx = this.#minStepIndex - 1;
        return;
      }
      this.#lastUsageIdx = row.idx;
      if (row.step_type === STEP_TYPE_PLANNER_RESPONSE && row.step_payload) {
        const tokens = extractContextTokensFromStepPayload(row.step_payload);
        if (tokens !== undefined) this.#lastContextTokens = tokens;
      }
    } catch {}
  }

  #tryBindCliLog(nowMs: number, atTurnStart: boolean): void {
    if (this.#cliLogPath || (!this.#conversationId && this.#pid === undefined)) return;
    if (nowMs - this.#lastCliLogScanAtMs < 1_000 && this.#lastCliLogScanAtMs > 0) return;
    this.#lastCliLogScanAtMs = nowMs;
    try {
      if (!existsSync(this.#logDir)) return;
      const names = readdirSync(this.#logDir).filter(
        (name) =>
          (name.startsWith("cli-") || name.startsWith("acp-server-")) &&
          name.endsWith(".log"),
      );
      if (names.length === 0) return;
      const pidSuffix = this.#pid !== undefined ? `-${this.#pid}.log` : undefined;

      const bindCandidate = (
        candidate: { path: string; size: number },
        byPid: boolean,
        tailText?: string,
      ): void => {
        this.#cliLogPath = candidate.path;
        this.#boundByPid = byPid;
        if (atTurnStart || !this.#conversationId) {
          // Bound before writing this turn's user message: only tail newly appended bytes.
          this.#cliLogOffset = candidate.size;
          this.#cliLogRemainder = "";
          return;
        }
        const cid = this.#conversationId;
        const text =
          tailText ??
          readFileSlice(
            candidate.path,
            candidate.size - Math.min(candidate.size, 131_072),
            Math.min(candidate.size, 131_072),
          )?.toString("utf8") ??
          "";
        // Bound mid-turn: anchor at the latest user-message forwarding marker for this conversation.
        const forwardMarker = `Forwarding user message to conversation ${cid}`;
        const sendMarker = `Sending user message to conversation ${cid}`;
        const lastForward = text.lastIndexOf(forwardMarker);
        const lastSend = text.lastIndexOf(sendMarker);
        const anchorIdx = Math.max(lastForward, lastSend);
        if (anchorIdx >= 0) {
          const lineStart = Math.max(0, text.lastIndexOf("\n", anchorIdx) + 1);
          const replaySlice = text.slice(lineStart);
          this.#cliLogOffset = candidate.size;
          this.#cliLogRemainder = "";
          this.#consumeCliLogChunk(replaySlice, -1, nowMs, true);
        } else {
          this.#cliLogOffset = candidate.size;
          this.#cliLogRemainder = "";
        }
      };

      if (pidSuffix) {
        for (const name of names) {
          if (!name.startsWith("acp-server-") || !name.endsWith(pidSuffix)) continue;
          const p = join(this.#logDir, name);
          try {
            const st = statSync(p);
            if (st.isFile()) {
              bindCandidate({ path: p, size: st.size }, true);
              return;
            }
          } catch {}
        }
        // Known ACP child PID: never bind an older/dead process's log that
        // happens to mention the same resumed conversationId. Reset scan
        // throttle so the next 250ms poll binds `acp-server-*-<pid>.log` as
        // soon as the Go runtime opens it.
        this.#lastCliLogScanAtMs = 0;
        return;
      }

      const cid = this.#conversationId;
      if (!cid) return;
      const candidates: Array<{ path: string; name: string; size: number; mtimeMs: number }> = [];
      for (const name of names) {
        const p = join(this.#logDir, name);
        try {
          const st = statSync(p);
          if (st.isFile() && st.size > 0) {
            candidates.push({ path: p, name, size: st.size, mtimeMs: st.mtimeMs });
          }
        } catch {}
      }
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const candidate of candidates.slice(0, 4)) {
        const tailBytes = Math.min(candidate.size, 131_072);
        const startOffset = candidate.size - tailBytes;
        const buf = readFileSlice(candidate.path, startOffset, tailBytes);
        if (!buf) continue;
        const text = buf.toString("utf8");
        if (!text.includes(cid)) continue;
        bindCandidate(candidate, false, text);
        return;
      }
    } catch {}
  }

  #tailCliLog(overallMaxIdx: number, nowMs: number): void {
    if (!this.#cliLogPath) {
      this.#tryBindCliLog(nowMs, false);
    }
    if (!this.#cliLogPath) return;
    try {
      const st = statSync(this.#cliLogPath);
      if (st.size < this.#cliLogOffset) {
        this.#cliLogOffset = 0;
        this.#cliLogRemainder = "";
      }
      if (st.size > this.#cliLogOffset) {
        const toRead = Math.min(st.size - this.#cliLogOffset, 262_144);
        const chunk = readFileSlice(this.#cliLogPath, this.#cliLogOffset, toRead);
        if (chunk && chunk.length > 0) {
          this.#cliLogOffset += chunk.length;
          this.#consumeCliLogChunk(chunk.toString("utf8"), overallMaxIdx, nowMs, false);
        }
      }
    } catch {}
  }

  #pollCliCompacting(
    overallMaxIdx: number,
    prePollMaxIdx: number,
    rows: StepRow[],
    hasRunningStep: boolean,
    isGenerating: boolean,
    nowMs: number,
  ): boolean {
    this.#tailCliLog(prePollMaxIdx, nowMs);

    if (this.#activeStreamStartedAtMs === undefined) return false;

    if (this.#streamStartMaxIdx < 0) {
      this.#streamStartMaxIdx = prePollMaxIdx;
    }

    const matchedStepPayload =
      this.#activeStreamResponseId !== undefined &&
      rows.some(
        (row) =>
          row.step_payload != null &&
          toBuffer(row.step_payload).includes(this.#activeStreamResponseId!),
      );

    if (
      hasRunningStep ||
      isGenerating ||
      overallMaxIdx > this.#streamStartMaxIdx ||
      matchedStepPayload
    ) {
      this.#activeStreamStartedAtMs = undefined;
      this.#activeStreamResponseId = undefined;
      this.#streamStartMaxIdx = -1;
      return false;
    }

    return (
      (this.#lastContextTokens ?? 0) >= MIN_COMPACTION_CONTEXT_TOKENS &&
      overallMaxIdx >= 2 &&
      this.#compactedAfterIdx < overallMaxIdx &&
      nowMs - this.#activeStreamStartedAtMs >= COMPACTION_STREAM_GRACE_MS
    );
  }

  #consumeCliLogChunk(
    chunkText: string,
    overallMaxIdx: number,
    nowMs: number,
    isInitialReplay: boolean,
  ): void {
    const combined = this.#cliLogRemainder + chunkText;
    const lines = combined.split("\n");
    this.#cliLogRemainder = lines.pop() ?? "";
    const cid = this.#conversationId;

    for (const line of lines) {
      if (!line) continue;
      if (
        cid &&
        (line.includes(`Forwarding user message to conversation ${cid}`) ||
          line.includes(`Sending user message to conversation ${cid}`) ||
          line.includes(`Stream goroutine exited for ${cid}`))
      ) {
        this.#pendingMonitorCalls = 0;
        this.#activeStreamStartedAtMs = undefined;
        this.#activeStreamResponseId = undefined;
        this.#streamStartMaxIdx = -1;
        this.#retryUntilMs = 0;
        this.#retryStreak = 0;
        this.#activeRetryInfo = undefined;
        this.#lastApiError = undefined;
        this.#sawRetrySinceLastPoll = false;
        continue;
      }
      const retryMatch = /\bretrying in (\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h)(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))*)/i.exec(
        line,
      );
      if (retryMatch) {
        this.#activeStreamStartedAtMs = undefined;
        this.#activeStreamResponseId = undefined;
        this.#streamStartMaxIdx = -1;
        const parsedMs = parseGlogTimestampMs(line, nowMs);
        if (isInitialReplay && parsedMs !== undefined && nowMs - parsedMs > 120_000) {
          continue;
        }
        const attemptFailure = /\battempt (\d+) failed \((.+)\), retrying in/.exec(line);
        if (attemptFailure) {
          const failedNum = Number(attemptFailure[1]);
          this.#retryStreak =
            Number.isFinite(failedNum) && failedNum > 0 ? failedNum : this.#retryStreak + 1;
          this.#lastApiError = attemptFailure[2];
        } else {
          this.#retryStreak += 1;
        }
        const delayMs = Math.min(parseGoDurationMs(retryMatch[1]!) ?? 30_000, 120_000);
        const sleepEndsAtMs = (parsedMs ?? nowMs) + delayMs;
        const untilMs = sleepEndsAtMs + 15_000;
        if (untilMs > nowMs) {
          this.#retryUntilMs = Math.max(this.#retryUntilMs, untilMs);
          if (!isInitialReplay) this.#sawRetrySinceLastPoll = true;
          const attempt = this.#retryStreak + 1;
          const maxAttempts = Math.max(AGY_DEFAULT_MAX_RETRY_ATTEMPTS, attempt);
          const remainingMs = Math.max(0, sleepEndsAtMs - nowMs);
          const delaySeconds =
            remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / 1000)) : 0;
          const retryAtMs = Date.now() + remainingMs;
          const label = resolveAgyRetryLabel(this.#lastApiError);
          const seq = ++this.#retrySeq;
          this.#activeRetryInfo = {
            seq,
            label,
            attempt,
            maxAttempts,
            delaySeconds,
            retryAtMs,
            message: formatAgyRetryStatus(attempt, maxAttempts, delaySeconds, this.#lastApiError),
            ...(this.#lastApiError ? { apiError: this.#lastApiError } : {}),
          };
        }
        continue;
      }
      if (line.includes("llm_monitor.go:") && line.includes("Calling LLM")) {
        this.#pendingMonitorCalls += 1;
        continue;
      }
      if (line.includes("Monitor sir_flash_lite FINISHED")) {
        this.#pendingMonitorCalls = 0;
        continue;
      }
      if (
        line.includes("http_helpers.go:") &&
        (line.includes(":streamGenerateContent") || line.includes(":generateContent"))
      ) {
        if (this.#pendingMonitorCalls > 0) {
          this.#pendingMonitorCalls -= 1;
          continue;
        }
        const parsedMs = isInitialReplay ? parseGlogTimestampMs(line, nowMs) : undefined;
        if (isInitialReplay && parsedMs !== undefined && nowMs - parsedMs > 180_000) {
          continue;
        }
        // A response arrived, so any earlier API error was recovered by agy's own retry.
        this.#retryUntilMs = 0;
        this.#retryStreak = 0;
        this.#activeRetryInfo = undefined;
        this.#lastApiError = undefined;
        const respIdMatch = /\bResponseID:\s*([A-Za-z0-9_-]+)/.exec(line);
        this.#activeStreamStartedAtMs = parsedMs ?? nowMs;
        this.#activeStreamResponseId = respIdMatch?.[1];
        this.#streamStartMaxIdx = overallMaxIdx;
      }
    }
  }

  #ensureDb(): DatabaseSync | undefined {
    if (!this.#conversationId) return undefined;
    const dbPath = join(this.#conversationsDir, `${this.#conversationId}.db`);
    if (this.#db && this.#dbPath === dbPath) return this.#db;
    try {
      if (!existsSync(dbPath)) return undefined;
      const stat = statSync(dbPath);
      if (!stat.isFile() || stat.size === 0) return undefined;
      this.#db = new DatabaseSync(dbPath, { readOnly: true });
      this.#dbPath = dbPath;
      return this.#db;
    } catch {
      this.#db = undefined;
      this.#dbPath = undefined;
      return undefined;
    }
  }

  /**
   * Called before the turn's user prompt is written to agy so any existing
   * steps in a resumed conversation are excluded.
   */
  #captureBaseline(): void {
    const db = this.#ensureDb();
    if (!db) return;
    try {
      const row = db
        .prepare("SELECT COALESCE(MAX(idx) + 1, 0) AS next_idx FROM steps")
        .get() as { next_idx?: number } | undefined;
      if (typeof row?.next_idx === "number" && row.next_idx >= 0) {
        this.#minStepIndex = row.next_idx;
        this.#baselineCaptured = true;
      }
    } catch {}
  }

  /**
   * Called when conversationId is discovered mid-turn (e.g. from `init`).
   * Anchors at the latest USER_INPUT step so prior turns are never replayed.
   */
  #captureBaselineFromLatestUserInput(): void {
    const db = this.#ensureDb();
    if (!db) return;
    try {
      const row = db
        .prepare("SELECT MAX(idx) AS max_user_idx FROM steps WHERE step_type = ?")
        .get(STEP_TYPE_USER_INPUT) as { max_user_idx?: number | null } | undefined;
      if (typeof row?.max_user_idx === "number" && row.max_user_idx >= 0) {
        this.#minStepIndex = row.max_user_idx;
      } else {
        this.#minStepIndex = 0;
      }
      this.#baselineCaptured = true;
    } catch {}
  }
}
