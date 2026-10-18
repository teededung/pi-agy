/**
 * agy model discovery. Effort variants are presented as one Pi model while
 * retaining the launch constraints agy requires for the normalized base id.
 */

import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { AgyEffort } from "./agy-client.ts";

export interface AgyModelInfo {
  id: string;
  name: string;
  supportedEfforts: AgyEffort[];
  defaultEffort?: AgyEffort;
}

/**
 * Build Pi's `thinkingLevelMap` from a model's discovered `agy` effort variants
 * so `/thinking` and thinking-level cycling only expose levels `agy` actually
 * supports for that model (e.g. `low`, `medium`, `high` — never `off` or `minimal`).
 */
export function thinkingLevelMapForModel(
  model: Pick<AgyModelInfo, "supportedEfforts"> | undefined,
): ThinkingLevelMap | undefined {
  if (!model || model.supportedEfforts.length === 0) return undefined;
  const supported = new Set(model.supportedEfforts);
  return {
    off: null,
    minimal: null,
    low: supported.has("low") ? "low" : null,
    medium: supported.has("medium") ? "medium" : null,
    high: supported.has("high") ? "high" : null,
    xhigh: null,
    max: null,
  };
}

const EFFORT_SUFFIX = /-(low|medium|high)$/i;
const EFFORT_NAME_SUFFIX = /\s*\((?:low|medium|high)\)$/i;

function effortFromId(id: string): AgyEffort | undefined {
  const match = id.match(EFFORT_SUFFIX);
  const effort = match?.[1]?.toLowerCase();
  return effort === "low" || effort === "medium" || effort === "high" ? effort : undefined;
}

/** Collapse one effort variant while retaining its discovered effort. */
export function normalizeAgyModelId(id: string, name: string): AgyModelInfo {
  const effort = effortFromId(id);
  const baseId = effort ? id.replace(EFFORT_SUFFIX, "") : id;
  const baseName = effort ? name.replace(EFFORT_NAME_SUFFIX, "").trim() : name.trim();
  return {
    id: baseId || id,
    name: baseName || name,
    supportedEfforts: effort ? [effort] : [],
    defaultEffort: effort,
  };
}

/** Default patterns for models hidden from Pi's picker and listings. */
export const DEFAULT_HIDDEN_MODEL_PATTERNS: readonly RegExp[] = [
  /^gemini-3\.6(?:-|$)/i,
  /^gemini-3\.7(?:-|$)/i,
  /^gp[ts]-oss(?:-|$)/i,
];

/**
 * Check if a model should be hidden.
 * Honors PI_ANTIGRAVITY_HIDDEN_MODELS if set (comma/space-separated list of IDs or prefixes),
 * otherwise defaults to hiding gemini-3.6 and gemini-3.7.
 */
export function isAgyModelHidden(
  id: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const configured = env.PI_ANTIGRAVITY_HIDDEN_MODELS;
  if (configured !== undefined) {
    const patterns = configured
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (patterns.length === 0) return false;
    return patterns.some((p) => {
      const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^${escaped}(?:-|$)|${escaped}$`, "i").test(id);
    });
  }
  return DEFAULT_HIDDEN_MODEL_PATTERNS.some((pattern) => pattern.test(id));
}

/** Merge normalized/cache records without losing effort variants or discovery order. */
export function mergeAgyModels(models: readonly AgyModelInfo[]): AgyModelInfo[] {
  const merged: AgyModelInfo[] = [];
  for (const raw of models) {
    if (isAgyModelHidden(raw.id)) continue;
    const normalized = normalizeAgyModelId(raw.id, raw.name);
    const efforts = raw.supportedEfforts?.length
      ? raw.supportedEfforts.filter(
          (effort): effort is AgyEffort =>
            effort === "low" || effort === "medium" || effort === "high",
        )
      : normalized.supportedEfforts;
    const existing = merged.find((model) => model.id === normalized.id);
    if (!existing) {
      merged.push({
        id: normalized.id,
        name: normalized.name,
        supportedEfforts: [...new Set(efforts)],
        defaultEffort: raw.defaultEffort ?? normalized.defaultEffort ?? efforts[0],
      });
      continue;
    }
    for (const effort of efforts) {
      if (!existing.supportedEfforts.includes(effort)) existing.supportedEfforts.push(effort);
    }
    existing.defaultEffort ??= raw.defaultEffort ?? normalized.defaultEffort ?? efforts[0];
  }
  return merged;
}

/** Parse `agy models` output: header/noise lines without a tab are ignored. */
export function parseAgyModels(text: string): AgyModelInfo[] {
  const rows: AgyModelInfo[] = [];
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const rawId = line.slice(0, tab).trim();
    const rawName = line.slice(tab + 1).trim();
    if (!rawId || !rawName) continue;
    if (!/^[a-z0-9][a-z0-9.-]*$/i.test(rawId)) continue;
    if (isAgyModelHidden(rawId)) continue;
    rows.push(normalizeAgyModelId(rawId, rawName));
  }
  return mergeAgyModels(rows);
}

/** Resolve a valid effort for a normalized agy model. */
export function resolveAgyModelEffort(
  model: AgyModelInfo | undefined,
  requested: AgyEffort | undefined,
): AgyEffort | undefined {
  if (!model || model.supportedEfforts.length === 0) return undefined;
  if (requested && model.supportedEfforts.includes(requested)) return requested;
  return model.defaultEffort ?? model.supportedEfforts[0];
}

/** Complete fallback catalog from `agy models`, including effort constraints. */
export const ALL_FALLBACK_MODELS: AgyModelInfo[] = [
  {
    id: "gemini-4-argon",
    name: "Gemini 4 Argon",
    supportedEfforts: ["medium", "high", "low"],
    defaultEffort: "medium",
  },
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    supportedEfforts: ["high", "medium", "low"],
    defaultEffort: "high",
  },
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "low",
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "low",
  },
];

/** Visible fallback snapshot with hidden models filtered out. */
export const FALLBACK_MODELS: AgyModelInfo[] = ALL_FALLBACK_MODELS.filter(
  (model) => !isAgyModelHidden(model.id),
);

export interface ModelCapabilities {
  contextWindow: number;
  maxTokens: number;
}

/** USD per million tokens. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const ZERO_PRICING: ModelPricing = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Public API list prices, used only as a display estimate because agy itself
 * is subscription-billed. Unknown models deliberately stay at zero rather
 * than inheriting an unrelated vendor's rate.
 */
export function pricingForModel(modelId: string): ModelPricing {
  if (/^gemini-3\.(?:8|7|6)-flash$/i.test(modelId)) {
    return { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 };
  }
  if (/^gemini-3\.5-flash$/i.test(modelId)) {
    return { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.5 };
  }
  if (/^gemini-3\.1-pro/i.test(modelId)) {
    return { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 };
  }
  if (/^claude-sonnet-5-5/i.test(modelId)) {
    return { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
  }
  if (/^claude-opus-5-5/i.test(modelId)) {
    return { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
  }
  if (/^claude-sonnet-4-6/i.test(modelId)) {
    return { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  }
  if (/^claude-opus-4-6/i.test(modelId)) {
    return { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
  }
  return { ...ZERO_PRICING };
}

/**
 * Pi scheduling window, deliberately larger than agy's private ~185k working
 * window. agy owns and persists its native context compaction.
 */
export const AGY_PI_SCHEDULING_CONTEXT_WINDOW = 1_000_000;

export function capabilitiesForModel(modelId: string): ModelCapabilities {
  let maxTokens: number;
  if (/^gpt-oss-120b/i.test(modelId)) {
    maxTokens = 131_072;
  } else if (/^claude-(?:opus-(?:4-6|5-5)|sonnet-5-5)/i.test(modelId)) {
    maxTokens = 128_000;
  } else if (/^claude-sonnet-4-6/i.test(modelId)) {
    maxTokens = 64_000;
  } else if (/^gemini-/i.test(modelId)) {
    maxTokens = 65_536;
  } else {
    maxTokens = 32_768;
  }
  return { contextWindow: AGY_PI_SCHEDULING_CONTEXT_WINDOW, maxTokens };
}

export const LIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;

export function modelCacheTtlMs(source: "live" | "fallback" | undefined): number {
  return source === "fallback" ? FALLBACK_CACHE_TTL_MS : LIVE_CACHE_TTL_MS;
}

/** Whether a cached model list is still usable without a fresh `agy models` probe. */
export function modelCacheIsFresh(
  cache: { fetchedAt?: number; source?: "live" | "fallback" },
  now = Date.now(),
): boolean {
  return Boolean(cache.fetchedAt && now - cache.fetchedAt < modelCacheTtlMs(cache.source));
}

export const CONSULT_MODEL_ALIASES: Readonly<Record<string, string>> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  argon: "gemini-4-argon",
  flash: "gemini-3.8-flash",
};

export function parseConsultEffortToken(token: string | undefined): AgyEffort | undefined {
  if (!token) return undefined;
  switch (token.trim().toLowerCase()) {
    case "1":
    case "low":
      return "low";
    case "2":
    case "mid":
    case "medium":
      return "medium";
    case "3":
    case "high":
      return "high";
    default:
      return undefined;
  }
}

export function findAgyConsultModel(
  token: string,
  models: readonly AgyModelInfo[] = ALL_FALLBACK_MODELS,
): AgyModelInfo | undefined {
  const key = token.trim().toLowerCase();
  if (!key) return undefined;
  const catalog: AgyModelInfo[] = [...models];
  for (const fallback of ALL_FALLBACK_MODELS) {
    if (!catalog.some((m) => m.id === fallback.id)) {
      catalog.push(fallback);
    }
  }
  const canonicalId = CONSULT_MODEL_ALIASES[key];
  if (canonicalId) {
    return (
      catalog.find((m) => m.id.toLowerCase() === canonicalId) ??
      catalog.find((m) => m.id.toLowerCase().includes(key))
    );
  }
  return (
    catalog.find((m) => m.id.toLowerCase() === key) ??
    catalog.find((m) => m.id.toLowerCase().startsWith(key)) ??
    catalog.find(
      (m) => m.id.toLowerCase().includes(key) || m.name.toLowerCase().includes(key),
    )
  );
}

export type ResolvedAgyConsultSpec =
  | {
      ok: true;
      model: AgyModelInfo;
      /** Explicit effort override (`1`=low, `2`=medium, `3`=high), or `undefined` to inherit session thinking. */
      effort?: AgyEffort;
      prompt: string;
    }
  | {
      ok: false;
      error: string;
    };

export const CONSULT_USAGE_MESSAGE =
  'Usage: /m <opus|sonnet|argon|flash>[1|2|3] <prompt> (thinking: 1=low, 2=mid, 3=high, omit=session current)';

/**
 * Parse `/m <spec> <prompt>` arguments.
 * Supports:
 * - `/m argon <prompt>` (uses session's current thinking level)
 * - `/m argon3 <prompt>`, `/m opus2 <prompt>`, `/m sonnet1 <prompt>`, `/m flash3 <prompt>`
 * - `/m argon 3 <prompt>`, `/m opus:2 <prompt>`, `/m argon-1 <prompt>`
 * - Full/partial model IDs (`gemini-4-argon`, `claude-opus-5-5`, etc.)
 */
export function resolveAgyConsultSpec(
  args: string,
  models: readonly AgyModelInfo[] = ALL_FALLBACK_MODELS,
): ResolvedAgyConsultSpec {
  const trimmed = args.trim();
  if (!trimmed) {
    return { ok: false, error: CONSULT_USAGE_MESSAGE };
  }
  const firstMatch = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!firstMatch) {
    return { ok: false, error: CONSULT_USAGE_MESSAGE };
  }
  const rawSpec = firstMatch[1]!;
  let rest = (firstMatch[2] ?? "").trim();

  let modelToken = rawSpec;
  let explicitEffort: AgyEffort | undefined;

  const aliasMatch = rawSpec.match(
    /^(opus|sonnet|argon|flash)(?:[-:]?(1|2|3|low|mid|medium|high))?$/i,
  );
  if (aliasMatch) {
    modelToken = aliasMatch[1]!;
    explicitEffort = parseConsultEffortToken(aliasMatch[2]);
  } else {
    const colonMatch = rawSpec.match(/^([a-z0-9][a-z0-9._-]*?):(1|2|3|low|mid|medium|high)$/i);
    if (colonMatch) {
      modelToken = colonMatch[1]!;
      explicitEffort = parseConsultEffortToken(colonMatch[2]);
    }
  }

  const model = findAgyConsultModel(modelToken, models);
  if (!model) {
    return {
      ok: false,
      error: `Unknown model "${rawSpec}". Supported aliases: opus, sonnet, argon, flash (with optional 1=low, 2=mid, 3=high).`,
    };
  }

  if (explicitEffort === undefined && rest) {
    const secondMatch = rest.match(/^(1|2|3|low|mid|medium|high)(?:\s+([\s\S]*))?$/i);
    if (secondMatch) {
      explicitEffort = parseConsultEffortToken(secondMatch[1]);
      rest = (secondMatch[2] ?? "").trim();
    }
  }

  if (!rest) {
    return { ok: false, error: `Missing prompt for ${model.id}. ${CONSULT_USAGE_MESSAGE}` };
  }

  const effort =
    explicitEffort !== undefined ? resolveAgyModelEffort(model, explicitEffort) : undefined;

  return {
    ok: true,
    model,
    effort,
    prompt: rest,
  };
}

export function getAgyConsultCompletions(
  argumentPrefix: string,
  models: readonly AgyModelInfo[] = ALL_FALLBACK_MODELS,
  currentModelId?: string,
): Array<{ value: string; label: string; description: string }> | null {
  if (argumentPrefix.includes(" ")) return null;
  const prefix = argumentPrefix.trim().toLowerCase();
  const activeId = currentModelId?.trim().toLowerCase();
  const aliases = ["argon", "opus", "sonnet", "flash"] as const;
  const items: Array<{ value: string; label: string; description: string }> = [];

  for (const alias of aliases) {
    const model = findAgyConsultModel(alias, models);
    if (activeId && model?.id.toLowerCase() === activeId) continue;
    const modelLabel = model ? `${model.name} (${model.id})` : alias;
    items.push({
      value: `${alias} `,
      label: alias,
      description: `${modelLabel} · session thinking`,
    });
    for (const [digit, level] of [
      ["1", "low"],
      ["2", "mid"],
      ["3", "high"],
    ] as const) {
      items.push({
        value: `${alias}${digit} `,
        label: `${alias}${digit}`,
        description: `${modelLabel} · thinking ${level}`,
      });
    }
  }

  const filtered = prefix
    ? items.filter(
        (item) =>
          item.label.toLowerCase().startsWith(prefix) ||
          item.description.toLowerCase().includes(prefix),
      )
    : items;
  return filtered.length > 0 ? filtered : null;
}

export function formatAgyConsultLabel(
  model: Pick<AgyModelInfo, "id" | "name">,
  effort?: AgyEffort,
): string {
  const modelLabel = model.name || model.id;
  const effortPart = effort ? ` (${effort})` : "";
  return `Consulted ${modelLabel}${effortPart}`;
}

export function extractAgyConsultFooter(
  text: string,
  models: readonly AgyModelInfo[] = ALL_FALLBACK_MODELS,
): { prompt: string; model?: AgyModelInfo; effort?: AgyEffort } {
  const match = text.match(
    /^([\s\S]+?)\nConsulted ([^\n]+?)(?: \((low|medium|high|xhigh|max)\))?$/,
  );
  if (!match) return { prompt: text };
  const prompt = match[1]!;
  const rawLabel = match[2]!.trim().toLowerCase();
  const rawEffort = match[3]?.toLowerCase() as AgyEffort | undefined;
  const pool = [...models, ...ALL_FALLBACK_MODELS];
  const model = pool.find(
    (m) => m.name.toLowerCase() === rawLabel || m.id.toLowerCase() === rawLabel,
  );
  const effort = model && rawEffort ? resolveAgyModelEffort(model, rawEffort) : rawEffort;
  return { prompt, model, effort };
}


