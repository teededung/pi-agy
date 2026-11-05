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
import type { AgyActivity } from "./reducer.ts";

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
  /** True when new rows, status transitions, or growing step_payload bytes were observed. */
  dbProgressed: boolean;
  /** True when non-input/system agent steps (planner, tool, checkpoint) progressed in SQLite. */
  agentProgressed: boolean;
  /** True when the turn has a step actively generating (status 8) or pending (status 1). */
  isGenerating: boolean;
  /** True when agy is actively generating a context compaction summary. */
  isCompacting: boolean;
  /** Latest known `input_tokens + cache_read_tokens` from SQLite step metadata. */
  lastContextTokens?: number;
  /** True when the newest step in SQLite is waiting on the next planner/checkpoint step. */
  awaitingPlannerAfterStep: boolean;
}

export interface AgyThoughtTrackerOptions {
  /** Override `~/.gemini/antigravity-cli/log` (used in tests). */
  logDir?: string;
  /** Clock override for deterministic compaction-grace tests. */
  now?: () => number;
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
 * Extract `input_tokens + cache_read_tokens` from `CortexStep.metadata` (field 5)
 * -> `generator_metadata` (field 9: field 2 = `input_tokens`, field 5 = `cache_read_tokens`).
 */
export function extractContextTokensFromStepPayload(
  payload: Uint8Array | Buffer,
): number | undefined {
  const buf = toBuffer(payload);
  let pos = 0;
  let latestTotal: number | undefined;
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
      const metaTokens = extractTokensFromStepMetadata(buf.subarray(start, end));
      if (metaTokens !== undefined) latestTotal = metaTokens;
      pos = end;
      continue;
    }
    const next = skipWireValue(buf, pos, wireType);
    if (next === undefined) break;
    pos = next;
  }
  return latestTotal;
}

function extractTokensFromStepMetadata(buf: Buffer): number | undefined {
  let pos = 0;
  let latestTotal: number | undefined;
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
      const genTokens = extractTokensFromGeneratorMetadata(buf.subarray(start, end));
      if (genTokens !== undefined) latestTotal = genTokens;
      pos = end;
      continue;
    }
    const next = skipWireValue(buf, pos, wireType);
    if (next === undefined) break;
    pos = next;
  }
  return latestTotal;
}

function extractTokensFromGeneratorMetadata(buf: Buffer): number | undefined {
  let pos = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag[1];
    const fieldNumber = Math.floor(tag[0] / 8);
    const wireType = tag[0] & 7;
    if ((fieldNumber === 2 || fieldNumber === 5) && wireType === 0) {
      const v = readVarint(buf, pos);
      if (!v) break;
      if (fieldNumber === 2) inputTokens = v[0];
      else cacheReadTokens = v[0];
      pos = v[1];
      continue;
    }
    const next = skipWireValue(buf, pos, wireType);
    if (next === undefined) break;
    pos = next;
  }
  const total = inputTokens + cacheReadTokens;
  return Number.isFinite(total) && total > 0 ? total : undefined;
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
  #compactedAfterIdx = -1;

  /** Incremental CLI log tail state for live compaction detection. */
  #cliLogPath: string | undefined;
  #cliLogOffset = 0;
  #cliLogRemainder = "";
  #lastCliLogScanAtMs = 0;
  #pendingMonitorCalls = 0;
  #activeStreamStartedAtMs: number | undefined;
  #streamStartMaxIdx = -1;

  /** Turn-level stream synchronization state shared by AgyDriver and runAgyTurn. */
  #lastIsGenerating = false;
  #lastAgentProgressed = false;
  #lastAwaitingPlannerAfterStep = false;
  #emittedCompacting = false;
  #checkpointDetailsByStepId = new Map<number, AgyCheckpointSummaryInfo>();
  #streamEmittedCheckpoints = new Set<number>();

  constructor(
    conversationId?: string,
    conversationsDir = defaultConversationsDir(),
    options?: AgyThoughtTrackerOptions,
  ) {
    this.#conversationsDir = conversationsDir;
    this.#logDir = options?.logDir ?? defaultLogDirFromConversationsDir(conversationsDir);
    this.#now = options?.now ?? Date.now;
    this.#createdAtMs = this.#now();
    if (conversationId) {
      this.#conversationId = conversationId;
      this.#captureBaseline();
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
    this.#cliLogPath = undefined;
    this.#cliLogOffset = 0;
    this.#cliLogRemainder = "";
    this.#pendingMonitorCalls = 0;
    this.#activeStreamStartedAtMs = undefined;
    this.#streamStartMaxIdx = -1;
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
    const empty: AgyThoughtPollResult = {
      deltas: [],
      checkpoints: [],
      dbProgressed: false,
      agentProgressed: false,
      isGenerating: false,
      isCompacting: false,
      lastContextTokens: this.#lastContextTokens,
      awaitingPlannerAfterStep: false,
    };
    const db = this.#ensureDb();
    if (!db) return empty;

    const nowMs = this.#now();
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
      return empty;
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
        if (row.status === STEP_STATUS_DONE && row.idx > this.#lastUsageIdx) {
          const tokens = extractContextTokensFromStepPayload(row.step_payload);
          if (tokens !== undefined) this.#lastContextTokens = tokens;
          this.#lastUsageIdx = row.idx;
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

    const cliCompacting = this.#pollCliCompacting(overallMaxIdx, hasRunningStep, isGenerating, nowMs);
    const isCompacting = sqlCheckpointActive || cliCompacting;

    const statusSignature = statusParts.join(",");
    const agentStatusSignature = agentStatusParts.join(",");
    const dbProgressed =
      rows.length > 0 &&
      (maxIdx > this.#lastMaxIdx ||
        totalBytes > this.#lastTotalBytes ||
        statusSignature !== this.#lastStatusSignature);
    const agentProgressed =
      agentStatusParts.length > 0 && agentStatusSignature !== this.#lastAgentStatusSignature;

    if (rows.length > 0) {
      this.#lastMaxIdx = maxIdx;
      this.#lastTotalBytes = totalBytes;
      this.#lastStatusSignature = statusSignature;
      this.#lastAgentStatusSignature = agentStatusSignature;
    }

    return {
      deltas,
      checkpoints,
      dbProgressed,
      agentProgressed,
      isGenerating,
      isCompacting,
      lastContextTokens: this.#lastContextTokens,
      awaitingPlannerAfterStep,
    };
  }

  /** Latest SQLite step-generating state observed by sync(). */
  get isGenerating(): boolean {
    return this.#lastIsGenerating;
  }

  /** True when the most recent sync() observed genuine agent/model/compaction progress. */
  get agentProgressed(): boolean {
    return this.#lastAgentProgressed;
  }

  /** True when compaction is actively in flight or likely starting on a large trajectory. */
  isLikelyCompacting(hasActiveTools: boolean): boolean {
    return (
      this.#emittedCompacting ||
      (!hasActiveTools &&
        this.#lastAwaitingPlannerAfterStep &&
        (this.#lastContextTokens ?? 0) >= 180_000)
    );
  }

  /** Emit `{ type: "compacting", active: false }` if a compaction indicator is still active. */
  finishCompacting(emitSideActivity: (activity: AgyActivity) => void): void {
    if (!this.#emittedCompacting) return;
    this.#emittedCompacting = false;
    emitSideActivity({ type: "compacting", active: false });
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
    this.#lastAwaitingPlannerAfterStep = res.awaitingPlannerAfterStep;
    for (const cp of res.checkpoints) {
      this.#checkpointDetailsByStepId.set(cp.stepId, cp);
    }
    const compactingFlipped = res.isCompacting !== this.#emittedCompacting;
    this.#lastAgentProgressed =
      res.agentProgressed ||
      res.deltas.length > 0 ||
      res.checkpoints.length > 0 ||
      (compactingFlipped && res.isCompacting);
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
      emitSideActivity(delta);
    }
    return res.deltas.length > 0 || res.dbProgressed || compactingFlipped;
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
            WHERE step_type IN (?, ?) AND status = ?
            ORDER BY idx DESC
            LIMIT 1`,
        )
        .get(STEP_TYPE_PLANNER_RESPONSE, STEP_TYPE_CHECKPOINT, STEP_STATUS_DONE) as
        | { idx: number; step_type: number; step_payload: Uint8Array | null }
        | undefined;
      if (!row) {
        this.#lastUsageIdx = 0;
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
    if (this.#cliLogPath || !this.#conversationId) return;
    if (nowMs - this.#lastCliLogScanAtMs < 1_000 && this.#lastCliLogScanAtMs > 0) return;
    this.#lastCliLogScanAtMs = nowMs;
    try {
      if (!existsSync(this.#logDir)) return;
      const names = readdirSync(this.#logDir).filter(
        (name) => name.startsWith("cli-") && name.endsWith(".log"),
      );
      if (names.length === 0) return;
      const candidates: Array<{ path: string; size: number; mtimeMs: number }> = [];
      for (const name of names) {
        const p = join(this.#logDir, name);
        try {
          const st = statSync(p);
          if (st.isFile() && st.size > 0) {
            candidates.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
          }
        } catch {}
      }
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const cid = this.#conversationId;
      for (const candidate of candidates.slice(0, 4)) {
        const tailBytes = Math.min(candidate.size, 131_072);
        const startOffset = candidate.size - tailBytes;
        const buf = readFileSlice(candidate.path, startOffset, tailBytes);
        if (!buf) continue;
        const text = buf.toString("utf8");
        if (!text.includes(cid)) continue;

        this.#cliLogPath = candidate.path;
        if (atTurnStart) {
          // Bound before writing this turn's user message: only tail newly appended bytes.
          this.#cliLogOffset = candidate.size;
          this.#cliLogRemainder = "";
          return;
        }
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
        return;
      }
    } catch {}
  }

  #pollCliCompacting(
    overallMaxIdx: number,
    hasRunningStep: boolean,
    isGenerating: boolean,
    nowMs: number,
  ): boolean {
    if (!this.#cliLogPath) {
      this.#tryBindCliLog(nowMs, false);
    }
    if (this.#cliLogPath) {
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

    if (this.#activeStreamStartedAtMs === undefined) return false;

    if (hasRunningStep || isGenerating || overallMaxIdx > this.#streamStartMaxIdx) {
      this.#activeStreamStartedAtMs = undefined;
      this.#streamStartMaxIdx = -1;
      return false;
    }

    if (this.#streamStartMaxIdx < 0) {
      this.#streamStartMaxIdx = overallMaxIdx;
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
          line.includes(`Sending user message to conversation ${cid}`))
      ) {
        this.#pendingMonitorCalls = 0;
        this.#activeStreamStartedAtMs = undefined;
        this.#streamStartMaxIdx = -1;
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
        this.#activeStreamStartedAtMs = parsedMs ?? nowMs;
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
