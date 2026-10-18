/**
 * Off-stream reader for agy's real-time thinking text and step progress in SQLite.
 *
 * `agy --output-format stream-json` never emits `thinking` text on stdout (only
 * `usage.thinking_tokens` when an `agent_response` step reaches DONE), and emits
 * zero bytes on stdout for the entire duration of a `PLANNER_RESPONSE` step's
 * thinking phase and tool-call argument generation.
 *
 * However, agy writes every streaming chunk in real time into
 * `~/.gemini/antigravity-cli/conversations/<conversationId>.db` in table `steps`:
 * - `step_type = 14`: `CORTEX_STEP_TYPE_USER_INPUT`
 * - `step_type = 15`: `CORTEX_STEP_TYPE_PLANNER_RESPONSE`
 * - `status = 8`: `CORTEX_STEP_STATUS_GENERATING`
 *
 * Inside `step_payload` (protobuf `CortexStep`), field 20 (`PlannerResponse`)
 * holds field 3 (`thinking` UTF-8 string). Polling this table in read-only mode
 * lets Pi stream native thinking blocks live and prevents the stall watchdog
 * from counting active thinking / tool-argument generation as stream silence.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const STEP_TYPE_USER_INPUT = 14;
const STEP_TYPE_PLANNER_RESPONSE = 15;
const STEP_STATUS_PENDING = 1;
const STEP_STATUS_GENERATING = 8;

export interface AgyThinkingDeltaActivity {
  type: "thinking_delta";
  delta: string;
  stepId: number;
}

export interface AgyThoughtPollResult {
  deltas: AgyThinkingDeltaActivity[];
  /** True when new rows, status transitions, or growing step_payload bytes were observed. */
  dbProgressed: boolean;
  /** True when the turn has a step actively generating (status 8) or pending (status 1). */
  isGenerating: boolean;
}

function defaultConversationsDir(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "conversations");
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

/**
 * Extract `PlannerResponse.thinking` (top-level field 20 -> sub-field 3) from a
 * raw `CortexStep` protobuf payload (`step_payload` column in `steps`).
 */
export function extractThinkingFromStepPayload(payload: Uint8Array | Buffer): string {
  const buf =
    payload instanceof Buffer
      ? payload
      : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
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

interface StepRow {
  idx: number;
  step_type: number;
  status: number;
  payload_len: number;
  step_payload: Uint8Array | null;
}

/**
 * Per-turn tracker that polls `<conversationId>.db` for new thinking deltas and
 * step progress. Safe to call when the DB file does not exist (e.g. unit tests
 * with mocked streams).
 */
export class AgyThoughtTracker {
  #conversationsDir: string;
  #conversationId: string | undefined;
  #db: DatabaseSync | undefined;
  #dbPath: string | undefined;
  /** Minimum step index considered part of this turn. */
  #minStepIndex = 0;
  #baselineCaptured = false;
  /** Emitted thinking character length per step_index. */
  #emittedLengths = new Map<number, number>();
  /** Fingerprint of the last seen DB state for progress detection. */
  #lastMaxIdx = -1;
  #lastTotalBytes = 0;
  #lastStatusSignature = "";

  constructor(conversationId?: string, conversationsDir = defaultConversationsDir()) {
    this.#conversationsDir = conversationsDir;
    if (conversationId) {
      this.#conversationId = conversationId;
      this.#captureBaseline();
    }
  }

  /** Bind or update the conversation ID once discovered from the stream. */
  setConversationId(conversationId: string | undefined): void {
    if (!conversationId || conversationId === this.#conversationId) return;
    this.close();
    this.#conversationId = conversationId;
    if (!this.#baselineCaptured) {
      // If the conversation already existed before this turn, anchor at the
      // newest USER_INPUT step so earlier turns are never replayed.
      this.#captureBaselineFromLatestUserInput();
    }
  }

  /**
   * Poll SQLite for new thinking text deltas and DB liveness signals.
   * Never throws; returns empty deltas if the DB is absent or locked.
   */
  poll(): AgyThoughtPollResult {
    const empty: AgyThoughtPollResult = {
      deltas: [],
      dbProgressed: false,
      isGenerating: false,
    };
    const db = this.#ensureDb();
    if (!db) return empty;

    let rows: StepRow[];
    try {
      const stmt = db.prepare(
        `SELECT idx, step_type, status, length(step_payload) AS payload_len,
                CASE WHEN step_type = 15 THEN step_payload ELSE NULL END AS step_payload
           FROM steps
          WHERE idx >= ?
          ORDER BY idx ASC`,
      );
      rows = stmt.all(this.#minStepIndex) as unknown as StepRow[];
    } catch {
      return empty;
    }

    if (rows.length === 0) return empty;

    // Advance minStepIndex if a new USER_INPUT step appeared at the start of this turn
    // (e.g. before any planner response for this turn was emitted).
    for (const row of rows) {
      if (row.step_type === STEP_TYPE_USER_INPUT && row.idx > this.#minStepIndex) {
        // Only advance past steps we haven't emitted thinking for yet
        if (this.#emittedLengths.size === 0) {
          this.#minStepIndex = row.idx;
        }
      }
    }

    let maxIdx = this.#lastMaxIdx;
    let totalBytes = 0;
    const statusParts: string[] = [];
    let isGenerating = false;
    const deltas: AgyThinkingDeltaActivity[] = [];

    for (const row of rows) {
      if (row.idx < this.#minStepIndex) continue;
      if (row.idx > maxIdx) maxIdx = row.idx;
      totalBytes += row.payload_len ?? 0;
      statusParts.push(`${row.idx}:${row.status}:${row.payload_len}`);
      if (row.status === STEP_STATUS_GENERATING || row.status === STEP_STATUS_PENDING) {
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
      }
    }

    const statusSignature = statusParts.join(",");
    const dbProgressed =
      maxIdx > this.#lastMaxIdx ||
      totalBytes > this.#lastTotalBytes ||
      statusSignature !== this.#lastStatusSignature;

    this.#lastMaxIdx = maxIdx;
    this.#lastTotalBytes = totalBytes;
    this.#lastStatusSignature = statusSignature;

    return {
      deltas,
      dbProgressed,
      isGenerating,
    };
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
