import type { AgyUsage } from "./events.ts";

export const AGY_COMPACTION_ENTRY = "pi-agy-compaction";

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
