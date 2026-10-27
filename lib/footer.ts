import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AGY_COMPACTION_ENTRY } from "./agy-compaction.ts";
import { AGY_CONVERSATION_STATE_ENTRY } from "./conversation-state.ts";

/**
 * Effective native compaction ceiling in agy (~300k tokens for Gemini models;
 * 1M total context window for Claude Sonnet/Opus 4.6 & 5.5 models).
 * Pi's model registry receives 1M (`AGY_PI_SCHEDULING_CONTEXT_WINDOW`) so
 * Pi never triggers client-side compaction ahead of agy's own native compaction.
 */
export const AGY_EFFECTIVE_CONTEXT_LIMIT = 300_000;
export const AGY_CLAUDE_CONTEXT_LIMIT = 1_000_000;
export const DEFAULT_CONTEXT_BAR_WIDTH = 16;
export const MIN_CONTEXT_BAR_WIDTH = 6;

const AGY_1M_CLAUDE_MODEL_RE = /^claude-(?:opus|sonnet)-(?:4-6|4-8|5-5)(?:$|[-@])/i;

export function resolveAgyEffectiveContextLimit(modelId?: string): number {
  if (typeof modelId === "string" && AGY_1M_CLAUDE_MODEL_RE.test(modelId.trim())) {
    return AGY_CLAUDE_CONTEXT_LIMIT;
  }
  return AGY_EFFECTIVE_CONTEXT_LIMIT;
}

export type AgyFooterMode = "on" | "off";

/** No argument toggles; explicit on/off commands are idempotent. */
export function resolveAgyFooterModeCommand(
  args: string,
  current: AgyFooterMode,
): AgyFooterMode | "status" | undefined {
  switch (args.trim().toLowerCase()) {
    case "":
      return current === "on" ? "off" : "on";
    case "on":
      return "on";
    case "off":
      return "off";
    case "status":
      return "status";
    default:
      return undefined;
  }
}

function parseFooterModeValue(raw: unknown): AgyFooterMode | undefined {
  if (typeof raw === "boolean") return raw ? "on" : "off";
  if (typeof raw !== "string") return undefined;
  switch (raw.trim().toLowerCase()) {
    case "on":
    case "1":
    case "true":
      return "on";
    case "off":
    case "0":
    case "false":
      return "off";
    default:
      return undefined;
  }
}

/** CLI and environment overrides take precedence over the saved user preference (default: "on"). */
export function readAgyFooterMode(
  flag: unknown = undefined,
  env: NodeJS.ProcessEnv = process.env,
  savedMode: AgyFooterMode | undefined = undefined,
): AgyFooterMode {
  const raw =
    flag ??
    env.PI_ANTIGRAVITY_FOOTER ??
    env.PI_ANTIGRAVITY_CUSTOM_FOOTER ??
    savedMode ??
    "on";
  const parsed = parseFooterModeValue(raw);
  if (!parsed) {
    throw new Error('--agy-footer / PI_ANTIGRAVITY_FOOTER must be "on" or "off".');
  }
  return parsed;
}

export interface FooterThemeLike {
  fg(color: string, text: string): string;
}

export interface FooterUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface FooterRenderInput {
  width: number;
  cwd: string;
  home?: string;
  gitBranch?: string | null;
  sessionName?: string;
  provider?: string;
  modelId?: string;
  reasoning?: boolean;
  thinkingLevel?: string;
  routedModel?: { id: string; thinkingLevel?: string };
  availableProviderCount?: number;
  /** Live or branch-derived agy context tokens (uncached input + cacheRead). */
  agyContextTokens?: number;
  /** Active model's context window (fallback when contextUsage is unavailable or stale). */
  modelContextWindow?: number;
  /** Standard Pi context usage for non-antigravity providers. */
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  usageTotals: FooterUsageTotals;
  latestCacheHitRate?: number;
  usingSubscription?: boolean;
  extensionStatuses?: ReadonlyMap<string, string>;
  theme: FooterThemeLike;
}

export function sanitizeFooterStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export function formatFooterTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  if (count < 1_000) return Math.round(count).toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function formatFooterCwd(cwd: string, home = process.env.HOME || process.env.USERPROFILE): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Derive the latest known agy context footprint from the active Pi branch when
 * no live in-memory `observedContextTokens` sample is present yet.
 */
export interface BranchContextFootprint {
  /** Latest Antigravity context token footprint on the active branch. */
  agyTokens?: number;
  /** Fallback context tokens when a non-agy provider is active right after an agy turn/consult. */
  nonAgyFallbackTokens?: number;
  /** True when the branch was compacted and no post-compaction assistant turn has completed yet. */
  awaitingPostCompactionTurn?: boolean;
}

/**
 * Single-pass scan of the active Pi branch for Antigravity context tokens and
 * cross-provider switch/consult fallback tokens.
 */
export function resolveBranchContextFootprint(branch: readonly unknown[]): BranchContextFootprint {
  let agyTokens: number | undefined;
  let nonAgyTokens: number | undefined;
  let latestIsAgy = false;
  let awaitingPostCompactionTurn = false;

  for (const raw of branch) {
    const entry = raw as {
      type?: string;
      customType?: string;
      data?: Record<string, unknown>;
      message?: {
        role?: string;
        provider?: string;
        stopReason?: string;
        usage?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          totalTokens?: number;
        };
      };
    };
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      agyTokens = undefined;
      nonAgyTokens = undefined;
      latestIsAgy = false;
      awaitingPostCompactionTurn = true;
      continue;
    }
    if (entry.type === "custom") {
      if (entry.customType === AGY_CONVERSATION_STATE_ENTRY && entry.data) {
        if (entry.data.kind === "reset") {
          agyTokens = undefined;
          latestIsAgy = false;
        } else if (
          !awaitingPostCompactionTurn &&
          entry.data.kind === "conversation" &&
          typeof entry.data.contextTokens === "number" &&
          Number.isFinite(entry.data.contextTokens) &&
          entry.data.contextTokens > 0
        ) {
          agyTokens = entry.data.contextTokens;
          latestIsAgy = true;
        }
      } else if (
        entry.customType === AGY_COMPACTION_ENTRY &&
        entry.data &&
        typeof entry.data.afterTokens === "number" &&
        Number.isFinite(entry.data.afterTokens) &&
        entry.data.afterTokens > 0
      ) {
        agyTokens = entry.data.afterTokens;
        latestIsAgy = true;
        awaitingPostCompactionTurn = false;
      }
      continue;
    }
    if (entry.type === "message" && entry.message?.role === "assistant") {
      if (entry.message.stopReason === "aborted" || entry.message.stopReason === "error") {
        continue;
      }
      awaitingPostCompactionTurn = false;
      const u = entry.message.usage;
      if (entry.message.provider === "antigravity") {
        const input = u?.input ?? 0;
        const cacheRead = u?.cacheRead ?? 0;
        const total = input + cacheRead;
        if (!Number.isFinite(total) || total <= 0) continue;
        latestIsAgy = true;
        // Final step of a multi-step turn has its cumulative cacheRead subtracted by
        // claimUsage(); ignore a synthetic cacheRead=0 drop when a fuller step was just seen.
        if (cacheRead === 0 && agyTokens !== undefined && agyTokens >= 50_000 && total < agyTokens * 0.2) {
          continue;
        }
        agyTokens = total;
      } else {
        const total =
          (typeof u?.totalTokens === "number" && u.totalTokens > 0 ? u.totalTokens : 0) ||
          (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
        if (Number.isFinite(total) && total > 0) {
          nonAgyTokens = total;
          latestIsAgy = false;
        }
      }
    }
  }

  const maxFallback = Math.max(agyTokens ?? 0, nonAgyTokens ?? 0);
  return {
    agyTokens,
    nonAgyFallbackTokens: latestIsAgy && maxFallback > 0 ? maxFallback : undefined,
    ...(awaitingPostCompactionTurn ? { awaitingPostCompactionTurn: true } : {}),
  };
}

/**
 * Derive the latest known agy context footprint from the active Pi branch when
 * no live in-memory `observedContextTokens` sample is present yet.
 */
export function resolveAgyBranchContextTokens(branch: readonly unknown[]): number | undefined {
  return resolveBranchContextFootprint(branch).agyTokens;
}

export interface SessionUsageSnapshot {
  usageTotals: FooterUsageTotals;
  latestCacheHitRate?: number;
}

/** Accumulate token and cost totals across session entries (same semantics as Pi's built-in footer). */
export function computeSessionUsageSnapshot(entries: readonly unknown[]): SessionUsageSnapshot {
  const usageTotals: FooterUsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  let latestCacheHitRate: number | undefined;

  const addUsage = (u: Record<string, unknown> | undefined) => {
    if (!u) return;
    usageTotals.input += typeof u.input === "number" ? u.input : 0;
    usageTotals.output += typeof u.output === "number" ? u.output : 0;
    usageTotals.cacheRead += typeof u.cacheRead === "number" ? u.cacheRead : 0;
    usageTotals.cacheWrite += typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
    const costObj = u.cost as { total?: number } | number | undefined;
    if (typeof costObj === "number") {
      usageTotals.cost += costObj;
    } else if (costObj && typeof costObj.total === "number") {
      usageTotals.cost += costObj.total;
    }
  };

  for (const raw of entries) {
    const entry = raw as {
      type?: string;
      usage?: Record<string, unknown>;
      message?: { role?: string; usage?: Record<string, unknown> };
    };
    if (entry.type === "usage") {
      addUsage(entry.usage);
    } else if (entry.type === "message" && entry.message?.role === "assistant") {
      const u = entry.message.usage;
      addUsage(u);
      if (u) {
        const input = typeof u.input === "number" ? u.input : 0;
        const cacheRead = typeof u.cacheRead === "number" ? u.cacheRead : 0;
        const cacheWrite = typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
        const promptTokens = input + cacheRead + cacheWrite;
        latestCacheHitRate = promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined;
      }
    } else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
      addUsage(entry.message.usage);
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      addUsage(entry.usage);
    }
  }

  return { usageTotals, latestCacheHitRate };
}

function joinLeftRight(left: string, right: string, width: number, minPadding = 2): string {
  const leftW = visibleWidth(left);
  if (!right) {
    return leftW > width ? truncateToWidth(left, width, "...") : left;
  }
  const rightW = visibleWidth(right);
  if (leftW + minPadding + rightW <= width) {
    return left + " ".repeat(width - leftW - rightW) + right;
  }
  const availableForRight = width - leftW - minPadding;
  if (availableForRight > 4) {
    const truncatedRight = truncateToWidth(right, availableForRight, "...");
    const truncatedRightW = visibleWidth(truncatedRight);
    return left + " ".repeat(Math.max(0, width - leftW - truncatedRightW)) + truncatedRight;
  }
  return leftW > width ? truncateToWidth(left, width, "...") : left;
}

/**
 * Render the 2-row footer:
 * Row 1: Path + Git branch + Session name (left)  ───  Provider/Model + Thinking level (right)
 * Row 2: Context bar + Token/Cost stats (left)    ───  Extension statuses (right)
 */
export function renderFooterLines(input: FooterRenderInput): string[] {
  const { width, theme } = input;
  const minPadding = 2;

  // --- Row 1: Path + Branch + Session (left) & Model + Thinking (right) ---
  const pwd = formatFooterCwd(input.cwd, input.home);
  let row1Left = theme.fg("dim", pwd);
  if (input.gitBranch) {
    row1Left +=
      theme.fg("dim", " (") + theme.fg("mdLink", `⎇ ${input.gitBranch}`) + theme.fg("dim", ")");
  }
  if (input.sessionName) {
    row1Left += theme.fg("dim", " • ") + theme.fg("muted", input.sessionName);
  }

  const modelName = input.modelId || "no-model";
  let rightWithoutProvider = theme.fg("accent", modelName);
  if (input.reasoning) {
    const level = input.thinkingLevel || "off";
    rightWithoutProvider +=
      theme.fg("dim", " • ") +
      theme.fg("muted", level === "off" ? "thinking off" : level);
  }
  if (input.routedModel) {
    const routedLevel = input.routedModel.thinkingLevel
      ? ` • ${input.routedModel.thinkingLevel}`
      : "";
    rightWithoutProvider += theme.fg("dim", ` → ${input.routedModel.id}${routedLevel}`);
  }

  let row1Right = rightWithoutProvider;
  if ((input.availableProviderCount ?? 0) > 1 && input.provider) {
    const withProvider = theme.fg("dim", `(${input.provider}) `) + rightWithoutProvider;
    if (visibleWidth(row1Left) + minPadding + visibleWidth(withProvider) <= width) {
      row1Right = withProvider;
    }
  }
  const row1 = joinLeftRight(row1Left, row1Right, width, minPadding);

  // --- Row 2: Context Bar + Stats (left) & Extension Statuses (right) ---
  const isAntigravity = input.provider === "antigravity";
  const contextTokens =
    typeof input.contextUsage?.tokens === "number" && Number.isFinite(input.contextUsage.tokens)
      ? input.contextUsage.tokens
      : undefined;
  const usedTokens = isAntigravity
    ? input.agyContextTokens
    : contextTokens !== undefined && input.agyContextTokens !== undefined
      ? Math.max(contextTokens, input.agyContextTokens)
      : (contextTokens ?? input.agyContextTokens);
  const limitTokens = isAntigravity
    ? resolveAgyEffectiveContextLimit(input.routedModel?.id ?? input.modelId)
    : (input.contextUsage?.contextWindow || input.modelContextWindow || 0);

  const hasUsed = typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
  const rawPct =
    hasUsed && limitTokens > 0
      ? (usedTokens / limitTokens) * 100
      : !isAntigravity && typeof input.contextUsage?.percent === "number"
        ? input.contextUsage.percent
        : 0;
  const pctUsed = Math.min(100, Math.max(0, rawPct));
  const barColor = !hasUsed
    ? "dim"
    : pctUsed >= 80
      ? "error"
      : pctUsed >= 50
        ? "warning"
        : "success";

  const renderContextSegment = (barSize: number): string => {
    const filled = hasUsed ? Math.min(barSize, Math.round((pctUsed / 100) * barSize)) : 0;
    const bar =
      theme.fg(barColor, "█".repeat(filled)) +
      theme.fg("dim", "░".repeat(Math.max(0, barSize - filled)));
    const prefix = isAntigravity && hasUsed ? "~" : "";
    const label =
      hasUsed && limitTokens > 0
        ? theme.fg("mdCode", `${prefix}${formatFooterTokens(usedTokens)}/${formatFooterTokens(limitTokens)}`) +
          theme.fg(barColor, ` (${pctUsed.toFixed(0)}%)`)
        : limitTokens > 0
          ? theme.fg("dim", `—/${formatFooterTokens(limitTokens)}`)
          : theme.fg("dim", "—");
    return theme.fg("muted", "[") + bar + theme.fg("muted", "] ") + label;
  };

  const { usageTotals, latestCacheHitRate, usingSubscription } = input;
  const tokenStatParts: string[] = [];
  if (usageTotals.input > 0) tokenStatParts.push(`↑${formatFooterTokens(usageTotals.input)}`);
  if (usageTotals.output > 0) tokenStatParts.push(`↓${formatFooterTokens(usageTotals.output)}`);
  if (usageTotals.cacheRead > 0) tokenStatParts.push(`R${formatFooterTokens(usageTotals.cacheRead)}`);
  if (usageTotals.cacheWrite > 0) tokenStatParts.push(`W${formatFooterTokens(usageTotals.cacheWrite)}`);

  const cacheHitPart =
    (usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined
      ? `CH${latestCacheHitRate.toFixed(1)}%`
      : undefined;

  const costPart =
    usageTotals.cost > 0 || usingSubscription
      ? theme.fg(
          "success",
          `$${usageTotals.cost >= 10 ? usageTotals.cost.toFixed(2) : usageTotals.cost.toFixed(3)}`,
        ) + (usingSubscription ? theme.fg("dim", " (sub)") : "")
      : undefined;

  const buildStatsSegment = (tier: "full" | "compact" | "cost-only" | "none"): string => {
    if (tier === "none") return "";
    const parts: string[] = [];
    if (tier === "full" && tokenStatParts.length > 0) {
      parts.push(theme.fg("dim", tokenStatParts.join(" ")));
    }
    if ((tier === "full" || tier === "compact") && cacheHitPart) {
      parts.push(theme.fg("dim", cacheHitPart));
    }
    if (costPart) {
      parts.push(costPart);
    }
    return parts.join(" ");
  };

  const sep = theme.fg("dim", " │ ");
  const buildRow2Left = (barSize: number, tier: "full" | "compact" | "cost-only" | "none"): string => {
    const ctxSeg = renderContextSegment(barSize);
    const statsSeg = buildStatsSegment(tier);
    return statsSeg ? `${ctxSeg}${sep}${statsSeg}` : ctxSeg;
  };

  const statusEntries = input.extensionStatuses
    ? Array.from(input.extensionStatuses.entries())
        .filter(([key]) => key !== "agy-context")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => sanitizeFooterStatusText(text))
        .filter(Boolean)
    : [];
  const row2Right = statusEntries.join(" ");
  const rightBudget = row2Right ? minPadding + visibleWidth(row2Right) : 0;

  // 1) Shrink bar from DEFAULT_CONTEXT_BAR_WIDTH down to MIN_CONTEXT_BAR_WIDTH first.
  const fullDefaultWidth = visibleWidth(buildRow2Left(DEFAULT_CONTEXT_BAR_WIDTH, "full")) + rightBudget;
  const overflow = Math.max(0, fullDefaultWidth - width);
  const barSize = Math.max(MIN_CONTEXT_BAR_WIDTH, DEFAULT_CONTEXT_BAR_WIDTH - overflow);

  // 2) If still wider than terminal at MIN_CONTEXT_BAR_WIDTH, step down stats tier gracefully.
  let chosenLeft = buildRow2Left(barSize, "full");
  for (const tier of ["full", "compact", "cost-only", "none"] as const) {
    const candidate = buildRow2Left(barSize, tier);
    chosenLeft = candidate;
    if (visibleWidth(candidate) + rightBudget <= width) {
      break;
    }
  }

  const row2 = joinLeftRight(chosenLeft, row2Right, width, minPadding);
  return [row1, row2];
}
