import type { AgyUsage } from "./events.ts";
import type { AgyActivity } from "./reducer.ts";

export const AGY_COMPACTION_ENTRY = "pi-agy-compaction";
export const AGY_STALL_ENTRY = "pi-agy-stall";

export interface AgyStallMarker {
  version: 1;
  summary: string;
  retry: number;
  maxRetries: number;
  stalledMs: number;
  toolActive: boolean;
  backoffMs?: number;
  apiError?: string;
  detectedAt: string;
}

export function formatAgyStallSummary(
  activity: Pick<
    Extract<AgyActivity, { type: "stall" }>,
    "retry" | "maxRetries" | "stalledMs" | "toolActive" | "backoffMs" | "apiError"
  >,
): string {
  const seconds = Math.max(1, Math.round(activity.stalledMs / 1000));
  const attempt = activity.retry + 1;
  const maxAttempts = Math.max(attempt, activity.maxRetries + 1);
  const delaySeconds =
    activity.backoffMs !== undefined && activity.backoffMs >= 1_000
      ? Math.max(1, Math.round(activity.backoffMs / 1000))
      : undefined;
  const retrySuffix = delaySeconds !== undefined ? `, retrying in ${delaySeconds}s` : "";
  return (
    `agy stream stalled for ${seconds}s with no events` +
    `${activity.toolActive ? " while a tool step was active" : ""}` +
    ` — restarting the turn (attempt ${attempt}/${maxAttempts})${retrySuffix}` +
    `${activity.apiError ? ` · agy: ${activity.apiError}` : ""}`
  );
}

/** Conservative inference thresholds; stream-json has no compaction event. */
export const AGY_COMPACTION_MIN_BEFORE_TOKENS = 120_000;
export const AGY_COMPACTION_MIN_FREED_TOKENS = 50_000;
export const AGY_COMPACTION_MAX_REMAINING_RATIO = 0.65;

export interface AgyCompactionMarker {
  version: 1;
  beforeTokens: number;
  /** Post-compaction context tokens once reported; optional when recorded immediately on checkpoint completion. */
  afterTokens?: number;
  /** Native compaction summary markdown extracted from agy's checkpoint step when available. */
  summary?: string;
  /** Native agy step_index of the checkpoint step when observed directly. */
  stepId?: number;
  /** Compaction duration in seconds reported by agy when available. */
  durationSeconds?: number;
  detectedAt: string;
}

/** Strip agy's outer `<summary>...</summary>` wrapper while preserving markdown content. */
export function cleanAgyCheckpointSummary(raw: string): string {
  const trimmed = raw.trim();
  const stripped = trimmed
    .replace(/^<summary>\s*/i, "")
    .replace(/\s*<\/summary>$/i, "")
    .trim();
  return stripped;
}

/** Approximate live model context: uncached input plus cache-read input. */
export function agyContextTokens(usage: AgyUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_tokens ?? 0;
  const total = input + cacheRead;
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

/**
 * Infer agy's private compaction boundary from a large context-footprint drop.
 * Native agy renders an exact marker, but its documented stream-json protocol
 * exposes only step usage. These deliberately strict thresholds avoid treating
 * ordinary cache churn or adjacent agent phases as compaction.
 */
export function detectAgyCompaction(
  beforeTokens: number | undefined,
  afterTokens: number | undefined,
): { beforeTokens: number; afterTokens: number } | undefined {
  if (beforeTokens === undefined || afterTokens === undefined) return undefined;
  if (beforeTokens < AGY_COMPACTION_MIN_BEFORE_TOKENS) return undefined;
  if (beforeTokens - afterTokens < AGY_COMPACTION_MIN_FREED_TOKENS) return undefined;
  if (afterTokens / beforeTokens > AGY_COMPACTION_MAX_REMAINING_RATIO) return undefined;
  return { beforeTokens, afterTokens };
}

export function formatAgyContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.round(tokens));
}

export interface CompactionFileOpsLike {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export interface MutableCompactionPreparationLike {
  firstKeptEntryId: string;
  messagesToSummarize: unknown[];
  turnPrefixMessages: unknown[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  fileOps: CompactionFileOpsLike;
}

export interface ImmediateCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: {
    readFiles: string[];
    modifiedFiles: string[];
  };
}

export function isAgyCompactionBranchEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as { type?: unknown; customType?: unknown };
  return record.type === "custom" && record.customType === AGY_COMPACTION_ENTRY;
}

export function extractAgyCompactionEntrySummary(entry: unknown): string | undefined {
  if (!isAgyCompactionBranchEntry(entry)) return undefined;
  const data = (entry as { data?: { summary?: unknown } }).data;
  return typeof data?.summary === "string" && data.summary.trim().length > 0
    ? data.summary.trim()
    : undefined;
}

function addMessageFileOp(
  toolName: unknown,
  args: unknown,
  fileOps: CompactionFileOpsLike,
): void {
  if (typeof toolName !== "string" || !args || typeof args !== "object") return;
  const filePath = (args as { path?: unknown }).path;
  if (typeof filePath !== "string" || !filePath) return;
  if (toolName === "read") {
    fileOps.read.add(filePath);
  } else if (toolName === "write") {
    fileOps.written.add(filePath);
  } else if (toolName === "edit") {
    fileOps.edited.add(filePath);
  }
}

function collectFileOpsFromMessage(message: unknown, fileOps: CompactionFileOpsLike): void {
  if (!message || typeof message !== "object") return;
  const record = message as {
    role?: unknown;
    content?: unknown;
    nestedCalls?: { calls?: Array<{ name?: unknown; arguments?: unknown }> };
  };
  if (record.role === "toolResult") {
    for (const call of record.nestedCalls?.calls ?? []) {
      addMessageFileOp(call?.name, call?.arguments, fileOps);
    }
    return;
  }
  if (record.role !== "assistant" || !Array.isArray(record.content)) return;
  for (const block of record.content) {
    if (!block || typeof block !== "object") continue;
    const item = block as { type?: unknown; name?: unknown; arguments?: unknown };
    if (item.type !== "toolCall") continue;
    addMessageFileOp(item.name, item.arguments, fileOps);
  }
}

function computeCompactionFileLists(fileOps: CompactionFileOpsLike): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles, modifiedFiles };
}

/**
 * Scope a Pi `CompactionPreparation` to the latest `pi-agy-compaction` checkpoint
 * with a native summary so manual/overflow compaction (or post-agy compaction after
 * switching to another provider) never re-summarizes multi-day history from before
 * agy's checkpoint or accumulates tens of KB of stale `<read-files>` / `<modified-files>`.
 *
 * Leaves sessions without a post-compaction `pi-agy-compaction` summary untouched.
 */
export function scopeCompactionPreparationToAgyCheckpoint(
  preparation: MutableCompactionPreparationLike,
  branchEntries: readonly unknown[],
  options?: {
    isAntigravityProvider?: boolean;
    agyContextTokens?: number;
  },
): { scoped: boolean; immediateCompaction?: ImmediateCompactionResult } {
  if (
    options?.isAntigravityProvider &&
    typeof options.agyContextTokens === "number" &&
    Number.isFinite(options.agyContextTokens) &&
    options.agyContextTokens > 0
  ) {
    preparation.tokensBefore = Math.round(options.agyContextTokens);
  }

  let lastNativeCompactionIdx = -1;
  for (let i = 0; i < branchEntries.length; i++) {
    const entry = branchEntries[i];
    if (entry && typeof entry === "object" && (entry as { type?: unknown }).type === "compaction") {
      lastNativeCompactionIdx = i;
    }
  }

  let checkpointIdx = -1;
  let checkpointSummary: string | undefined;
  for (let i = branchEntries.length - 1; i > lastNativeCompactionIdx; i--) {
    const summary = extractAgyCompactionEntrySummary(branchEntries[i]);
    if (summary) {
      checkpointIdx = i;
      checkpointSummary = summary;
      break;
    }
  }

  if (checkpointIdx < 0 || !checkpointSummary) {
    return { scoped: false };
  }

  const preCheckpointMessages = new Set<unknown>();
  const postCheckpointMessages = new Set<unknown>();
  let maxPreMessageTs: number | undefined;

  for (let i = 0; i < checkpointIdx; i++) {
    const entry = branchEntries[i] as { type?: unknown; message?: { timestamp?: unknown } } | undefined;
    if (entry && typeof entry === "object" && entry.type === "message" && entry.message) {
      preCheckpointMessages.add(entry.message);
      if (typeof entry.message.timestamp === "number" && Number.isFinite(entry.message.timestamp)) {
        maxPreMessageTs =
          maxPreMessageTs === undefined
            ? entry.message.timestamp
            : Math.max(maxPreMessageTs, entry.message.timestamp);
      }
    }
  }

  for (let i = checkpointIdx + 1; i < branchEntries.length; i++) {
    const entry = branchEntries[i] as { type?: unknown; message?: unknown } | undefined;
    if (entry && typeof entry === "object" && entry.type === "message" && entry.message) {
      postCheckpointMessages.add(entry.message);
    }
  }

  const checkpointRecord = branchEntries[checkpointIdx] as {
    timestamp?: unknown;
    data?: { detectedAt?: unknown };
  };
  const parsedEntryTs =
    typeof checkpointRecord.timestamp === "string"
      ? Date.parse(checkpointRecord.timestamp)
      : Number.NaN;
  const parsedDetectedTs =
    typeof checkpointRecord.data?.detectedAt === "string"
      ? Date.parse(checkpointRecord.data.detectedAt)
      : Number.NaN;
  const checkpointTs = Number.isFinite(parsedEntryTs)
    ? parsedEntryTs
    : Number.isFinite(parsedDetectedTs)
      ? parsedDetectedTs
      : maxPreMessageTs;

  const isPostCheckpointMessage = (msg: unknown): boolean => {
    if (postCheckpointMessages.has(msg)) return true;
    if (preCheckpointMessages.has(msg)) return false;
    if (msg && typeof msg === "object") {
      const ts = (msg as { timestamp?: unknown }).timestamp;
      if (typeof ts === "number" && Number.isFinite(ts) && checkpointTs !== undefined) {
        return ts > checkpointTs;
      }
    }
    return true;
  };

  const filteredMessages = preparation.messagesToSummarize.filter(isPostCheckpointMessage);
  const filteredTurnPrefix = preparation.turnPrefixMessages.filter(isPostCheckpointMessage);

  preparation.previousSummary = checkpointSummary;
  preparation.messagesToSummarize = filteredMessages;
  preparation.turnPrefixMessages = filteredTurnPrefix;
  if (filteredTurnPrefix.length === 0) {
    preparation.isSplitTurn = false;
  }

  preparation.fileOps.read.clear();
  preparation.fileOps.written.clear();
  preparation.fileOps.edited.clear();
  for (const msg of filteredMessages) {
    collectFileOpsFromMessage(msg, preparation.fileOps);
  }
  for (const msg of filteredTurnPrefix) {
    collectFileOpsFromMessage(msg, preparation.fileOps);
  }

  if (filteredMessages.length === 0 && filteredTurnPrefix.length === 0) {
    return {
      scoped: true,
      immediateCompaction: {
        summary: checkpointSummary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: computeCompactionFileLists(preparation.fileOps),
      },
    };
  }

  return { scoped: true };
}

function trimXmlPathBlock(tag: "read-files" | "modified-files", body: string, maxChars: number): string {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (used + cost > maxChars && kept.length > 0) {
      const omitted = i + 1;
      kept.push(`... [${omitted} earlier paths omitted]`);
      break;
    }
    kept.push(line);
    used += cost;
  }
  kept.reverse();
  return `<${tag}>\n${kept.join("\n")}\n</${tag}>`;
}

/**
 * Cap `<read-files>` and `<modified-files>` appendices inside compaction summaries
 * so multi-day path lists never crowd out prose summaries during history bootstrap.
 */
export function boundCompactionSummaryFileLists(
  text: string,
  maxFileListChars = 4_000,
): string {
  const readMatch = /<read-files>\n?([\s\S]*?)\n?<\/read-files>/.exec(text);
  const modMatch = /<modified-files>\n?([\s\S]*?)\n?<\/modified-files>/.exec(text);
  const readLen = readMatch ? readMatch[0].length : 0;
  const modLen = modMatch ? modMatch[0].length : 0;
  if (readLen + modLen <= maxFileListChars) return text;

  let result = text;
  const halfBudget = Math.max(400, Math.floor(maxFileListChars / (readMatch && modMatch ? 2 : 1)));
  if (readMatch) {
    result = result.replace(readMatch[0], () =>
      trimXmlPathBlock("read-files", readMatch[1]!, halfBudget),
    );
  }
  if (modMatch) {
    result = result.replace(modMatch[0], () =>
      trimXmlPathBlock("modified-files", modMatch[1]!, halfBudget),
    );
  }
  return result;
}
