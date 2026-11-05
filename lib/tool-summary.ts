/**
 * Correlate Antigravity's per-call `toolSummary` captions (emitted on ACP /
 * stream-json `tool_start` events before `agy` strips `toolSummary` from the
 * HTTP MCP `tools/call` payload) with bridged Pi `toolCallId`s, and render
 * them as a compact muted title line above Pi's native tool cards via
 * `pi.registerToolRenderer(...)` without mutating `toolCall.arguments`.
 */

import type { JsonObject } from "@earendil-works/pi-ai";
import type {
  Theme,
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { BRIDGE_TOOL_PREFIX, canonicalJson } from "./bridge.ts";
import { WRAPPER_TOOL_NAME } from "./prompt.ts";

export const AGY_TOOL_SUMMARIES_ENTRY = "pi-agy-tool-summaries";

export interface PersistedAgyToolSummaries {
  version: 1;
  summaries: Record<string, string>;
}

const AGY_META_ARG_KEYS = new Set(["toolSummary", "toolAction", "waitForPreviousTools"]);
const COLLAPSED_ARGS_CHARS = 100;

export function cleanToolSummaryText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function stripAgyMetaArgs(args: Record<string, unknown>): JsonObject {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (AGY_META_ARG_KEYS.has(key) || value === undefined) continue;
    out[key] = value;
  }
  return out as JsonObject;
}

function fingerprintBridgedCall(tool: string, args: Record<string, unknown>): string {
  return canonicalJson({ tool, args: stripAgyMetaArgs(args) });
}

/**
 * Extract `{ tool, args, summary }` when an `agy` `tool_start` activity targets
 * our loopback Pi MCP bridge (`mcp_<serverName>_pi__*` or `call_mcp_tool`).
 */
export function extractBridgedToolSummary(
  activity: { name: string; args: Record<string, unknown> },
  serverName: string,
): { tool: string; fingerprint: string; summary: string } | undefined {
  if (!serverName) return undefined;
  const cleanName = activity.name.replace(/^Run\s+/i, "").trim();
  const topArgs = activity.args ?? {};

  if (cleanName === "call_mcp_tool" && topArgs.ServerName === serverName) {
    const rawToolName = typeof topArgs.ToolName === "string" ? topArgs.ToolName.trim() : "";
    const tool = rawToolName.startsWith(BRIDGE_TOOL_PREFIX)
      ? rawToolName.slice(BRIDGE_TOOL_PREFIX.length)
      : rawToolName;
    if (!tool) return undefined;
    const nestedArgs =
      topArgs.Arguments && typeof topArgs.Arguments === "object" && !Array.isArray(topArgs.Arguments)
        ? (topArgs.Arguments as Record<string, unknown>)
        : {};
    const summary =
      cleanToolSummaryText(topArgs.toolSummary) ??
      cleanToolSummaryText(nestedArgs.toolSummary) ??
      cleanToolSummaryText(topArgs.toolAction) ??
      cleanToolSummaryText(nestedArgs.toolAction);
    if (!summary) return undefined;
    return {
      tool,
      fingerprint: fingerprintBridgedCall(tool, nestedArgs),
      summary,
    };
  }

  let tool: string | undefined;
  const prefixes = [
    `mcp_${serverName}_${BRIDGE_TOOL_PREFIX}`,
    `${serverName}/${BRIDGE_TOOL_PREFIX}`,
    `${serverName}:${BRIDGE_TOOL_PREFIX}`,
    `${serverName}: ${BRIDGE_TOOL_PREFIX}`,
    BRIDGE_TOOL_PREFIX,
  ];
  for (const prefix of prefixes) {
    if (cleanName.startsWith(prefix)) {
      tool = cleanName.slice(prefix.length);
      break;
    }
  }
  if (!tool) return undefined;

  const summary =
    cleanToolSummaryText(topArgs.toolSummary) ?? cleanToolSummaryText(topArgs.toolAction);
  if (!summary) return undefined;

  return {
    tool,
    fingerprint: fingerprintBridgedCall(tool, topArgs),
    summary,
  };
}

interface PendingStartEntry {
  tool: string;
  fingerprint: string;
  summary: string;
}

interface UnmatchedCallEntry {
  callId: string;
  tool: string;
  fingerprint: string;
}

export class ToolSummaryTracker {
  #summaries = new Map<string, string>();
  #dirty = new Map<string, string>();
  #pendingStarts: PendingStartEntry[] = [];
  #unmatchedCalls: UnmatchedCallEntry[] = [];
  #liveInvalidates = new Map<string, () => void>();
  #seenActivities = new WeakSet<object>();

  get(toolCallId: string | undefined): string | undefined {
    if (!toolCallId) return undefined;
    return this.#summaries.get(toolCallId);
  }

  set(toolCallId: string, summary: string, markDirty = true): void {
    const cleaned = cleanToolSummaryText(summary);
    if (!toolCallId || !cleaned) return;
    if (this.#summaries.get(toolCallId) === cleaned) return;
    this.#summaries.set(toolCallId, cleaned);
    if (markDirty) this.#dirty.set(toolCallId, cleaned);
    this.#liveInvalidates.get(toolCallId)?.();
  }

  /** Record a live `tool_start` activity emitted by `agy`. */
  recordToolStart(
    activity: { name: string; args: Record<string, unknown> },
    serverName: string,
  ): void {
    if (this.#seenActivities.has(activity)) return;
    this.#seenActivities.add(activity);

    const extracted = extractBridgedToolSummary(activity, serverName);
    if (!extracted) return;

    // Pair immediately if the HTTP bridge call arrived slightly ahead of stdout.
    let matchIdx = this.#unmatchedCalls.findIndex((c) => c.fingerprint === extracted.fingerprint);
    if (matchIdx < 0) {
      const sameToolIndices = this.#unmatchedCalls
        .map((c, idx) => (c.tool === extracted.tool ? idx : -1))
        .filter((idx) => idx >= 0);
      if (sameToolIndices.length === 1) matchIdx = sameToolIndices[0]!;
    }
    if (matchIdx >= 0) {
      const [matched] = this.#unmatchedCalls.splice(matchIdx, 1);
      if (matched) this.set(matched.callId, extracted.summary, true);
      return;
    }

    this.#pendingStarts.push(extracted);
    if (this.#pendingStarts.length > 64) {
      this.#pendingStarts.shift();
    }
  }

  /**
   * Record an incoming `AgyPiBridge` HTTP `tools/call` invocation and return
   * sanitized arguments (with any accidental `agy` meta keys removed so strict
   * tool schemas never reject unknown `toolSummary` properties).
   */
  recordBridgeCall(call: { id: string; tool: string; args: JsonObject }): JsonObject {
    const rawArgs = (call.args ?? {}) as Record<string, unknown>;
    const inlineSummary =
      cleanToolSummaryText(rawArgs.toolSummary) ?? cleanToolSummaryText(rawArgs.toolAction);
    const cleanedArgs = stripAgyMetaArgs(rawArgs);
    const fingerprint = fingerprintBridgedCall(call.tool, cleanedArgs);

    let matchIdx = this.#pendingStarts.findIndex((s) => s.fingerprint === fingerprint);
    if (matchIdx < 0 && !inlineSummary) {
      const sameToolIndices = this.#pendingStarts
        .map((s, idx) => (s.tool === call.tool ? idx : -1))
        .filter((idx) => idx >= 0);
      if (sameToolIndices.length === 1) matchIdx = sameToolIndices[0]!;
    }

    if (matchIdx >= 0) {
      const [matched] = this.#pendingStarts.splice(matchIdx, 1);
      if (matched) this.set(call.id, inlineSummary ?? matched.summary, true);
      return cleanedArgs;
    }

    if (inlineSummary) {
      this.set(call.id, inlineSummary, true);
      return cleanedArgs;
    }

    this.#unmatchedCalls.push({ callId: call.id, tool: call.tool, fingerprint });
    if (this.#unmatchedCalls.length > 64) {
      this.#unmatchedCalls.shift();
    }
    return cleanedArgs;
  }

  trackInvalidate(toolCallId: string | undefined, isPartial: boolean, invalidate: () => void): void {
    if (!toolCallId) return;
    if (isPartial) {
      this.#liveInvalidates.set(toolCallId, invalidate);
    } else {
      this.#liveInvalidates.delete(toolCallId);
    }
  }

  /** Clear transient per-turn correlation queues without dropping known summaries. */
  clearTransient(): void {
    this.#pendingStarts = [];
    this.#unmatchedCalls = [];
    this.#liveInvalidates.clear();
  }

  /** Drain newly bound summaries for durable session-entry persistence. */
  flushDirty(): Record<string, string> | undefined {
    if (this.#dirty.size === 0) return undefined;
    const out: Record<string, string> = {};
    for (const [id, summary] of this.#dirty) {
      out[id] = summary;
    }
    this.#dirty.clear();
    return out;
  }

  /** Hydrate `toolCallId -> summary` mappings from persisted session entries. */
  restoreFromEntries(entries: readonly unknown[]): void {
    this.#summaries.clear();
    this.#dirty.clear();
    this.clearTransient();
    for (const raw of entries) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
      if (entry.type !== "custom" || entry.customType !== AGY_TOOL_SUMMARIES_ENTRY) continue;
      if (!entry.data || typeof entry.data !== "object") continue;
      const summaries = (entry.data as { summaries?: unknown }).summaries;
      if (!summaries || typeof summaries !== "object" || Array.isArray(summaries)) continue;
      for (const [callId, value] of Object.entries(summaries as Record<string, unknown>)) {
        const cleaned = cleanToolSummaryText(value);
        if (callId && cleaned) {
          this.#summaries.set(callId, cleaned);
        }
      }
    }
  }
}

class SummaryCallContainer extends Container {
  readonly summaryText = new Text("", 0, 0);
  inner: Component | undefined;

  update(styledSummary: string, nextInner: Component): void {
    this.summaryText.setText(styledSummary);
    if (this.inner !== nextInner || this.children.length !== 2) {
      this.clear();
      this.addChild(this.summaryText);
      this.addChild(nextInner);
      this.inner = nextInner;
    }
  }
}

function formatFallbackToolCall(
  title: string,
  args: unknown,
  theme: Theme,
  expanded: boolean,
): string {
  const header = theme.fg("toolTitle", theme.bold(title));
  if (args == null) return header;
  const entries =
    typeof args === "object" && !Array.isArray(args)
      ? Object.entries(args as Record<string, unknown>)
      : [["args", args]];
  if (entries.length === 0) return header;
  if (expanded) {
    const lines = entries.map(([key, value]) => {
      const text =
        typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
      return `  ${key}: ${text.replace(/\t/g, "   ").replace(/\r/g, "").split("\n").join("\n    ")}`;
    });
    return `${header}\n${theme.fg("muted", lines.join("\n"))}`;
  }
  const pairs = entries
    .map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`)
    .join(" ");
  const preview =
    pairs.length > COLLAPSED_ARGS_CHARS
      ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...`
      : pairs;
  return `${header} ${theme.fg("muted", preview)}`;
}

/**
 * Create a Pi `ToolRendererResolver` that prepends a muted `toolSummary` title
 * line above Pi's built-in / MCP / extension `renderCall` output whenever the
 * call originated from Antigravity with a `toolSummary`, while leaving Codex
 * and summary-less calls 100% untouched.
 */
export function createSummaryToolRendererResolver(
  tracker: ToolSummaryTracker,
): ToolRendererResolver {
  return (toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined => {
    const base = next();
    if (toolName === WRAPPER_TOOL_NAME || base?.renderShell === "self") {
      return base;
    }
    return {
      renderShell: base?.renderShell,
      renderCall(args, theme, context) {
        tracker.trackInvalidate(context.toolCallId, context.isPartial, context.invalidate);
        const prevWrapper =
          context.lastComponent instanceof SummaryCallContainer
            ? context.lastComponent
            : undefined;
        const innerLast = prevWrapper ? prevWrapper.inner : context.lastComponent;

        let inner: Component;
        if (base?.renderCall) {
          inner = base.renderCall(args, theme, {
            ...context,
            lastComponent: innerLast,
          });
        } else {
          const fallbackText = innerLast instanceof Text ? innerLast : new Text("", 0, 0);
          fallbackText.setText(formatFallbackToolCall(toolName, args, theme, context.expanded));
          inner = fallbackText;
        }

        const summary = tracker.get(context.toolCallId);
        if (!summary) {
          return inner;
        }

        const container = prevWrapper ?? new SummaryCallContainer();
        container.update(theme.fg("muted", summary), inner);
        return container;
      },
      renderResult: base?.renderResult,
    };
  };
}
