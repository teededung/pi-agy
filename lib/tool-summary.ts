/**
 * Correlate Antigravity's per-call `toolSummary` captions (emitted on ACP /
 * stream-json `tool_start` events before `agy` strips `toolSummary` from the
 * HTTP MCP `tools/call` payload) with bridged Pi `toolCallId`s, and render
 * them outside the tool card box in Codex style (`thinkingText` + italic + 1
 * blank row above the tool box) via `pi.registerToolRenderer(...)` without
 * mutating `toolCall.arguments`.
 */

import type { JsonObject } from "@earendil-works/pi-ai";
import type {
  Theme,
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
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

function schemaDeclaresProperty(schema: unknown, key: string): boolean {
  if (!schema || typeof schema !== "object") return false;
  const rec = schema as Record<string, unknown>;
  if (rec.properties && typeof rec.properties === "object" && !Array.isArray(rec.properties)) {
    if (Object.prototype.hasOwnProperty.call(rec.properties, key)) return true;
  }
  for (const compositeKey of ["allOf", "anyOf", "oneOf"] as const) {
    const items = rec[compositeKey];
    if (Array.isArray(items) && items.some((item) => schemaDeclaresProperty(item, key))) {
      return true;
    }
  }
  return false;
}

function stripAgyMetaArgs(args: Record<string, unknown>, toolParameters?: unknown): JsonObject {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (AGY_META_ARG_KEYS.has(key) && !schemaDeclaresProperty(toolParameters, key)) continue;
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
   * sanitized arguments (with any accidental `agy` meta keys removed unless the
   * bridged tool's own JSON schema declares them, matching `agy 1.5.2+`).
   */
  recordBridgeCall(
    call: { id: string; tool: string; args: JsonObject },
    toolParameters?: unknown,
  ): JsonObject {
    const rawArgs = (call.args ?? {}) as Record<string, unknown>;
    const inlineSummary =
      cleanToolSummaryText(rawArgs.toolSummary) ?? cleanToolSummaryText(rawArgs.toolAction);
    const cleanedArgs = stripAgyMetaArgs(rawArgs, toolParameters);
    const fingerprint = fingerprintBridgedCall(call.tool, rawArgs);

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

const FALLBACK_RESULT_PREVIEW_LINES = 10;
const SUMMARY_SHELL_STATE = Symbol("piAgySummaryShell");

type ToolBgToken = "toolPendingBg" | "toolErrorBg" | "toolSuccessBg";

function resolveToolBoxBgFn(
  theme: Theme,
  isPartial: boolean,
  isError: boolean,
): ((text: string) => string) | undefined {
  if (typeof (theme as { bg?: unknown }).bg !== "function") return undefined;
  const token: ToolBgToken = isPartial
    ? "toolPendingBg"
    : isError
      ? "toolErrorBg"
      : "toolSuccessBg";
  return (text: string) => theme.bg(token, text);
}

function formatCodexStyleSummary(theme: Theme, summary: string): string {
  const colored = theme.fg("thinkingText", summary).replace(/\x1b\[2m/g, "");
  const italicized =
    typeof (theme as { italic?: unknown }).italic === "function"
      ? theme.italic(colored)
      : colored;
  return typeof (theme as { bold?: unknown }).bold === "function"
    ? theme.bold(italicized)
    : italicized;
}

function extractWrapperInputSummary(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const input = (args as { input?: unknown }).input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  return cleanToolSummaryText(rec.toolSummary) ?? cleanToolSummaryText(rec.toolAction);
}

class SummaryShellContainer extends Container {
  readonly summaryText = new Text("", 1, 0);
  readonly summarySpacer = new Spacer(1);
  readonly sharedBox = new Box(1, 1);
  inner: Component | undefined;
  hasSummary = false;

  update(
    styledSummary: string | undefined,
    outputPad: number,
    bgFn: ((text: string) => string) | undefined,
    nextInner: Component,
  ): void {
    this.sharedBox.clear();
    this.sharedBox.setPaddingX(outputPad);
    this.sharedBox.setBgFn(bgFn);
    this.sharedBox.addChild(nextInner);
    this.inner = nextInner;

    if (styledSummary) {
      this.summaryText.setPaddingX(outputPad);
      this.summaryText.setText(styledSummary);
      if (!this.hasSummary || this.children.length !== 3) {
        this.clear();
        this.addChild(this.summaryText);
        this.addChild(this.summarySpacer);
        this.addChild(this.sharedBox);
        this.hasSummary = true;
      }
    } else if (this.hasSummary || this.children.length !== 1) {
      this.clear();
      this.addChild(this.sharedBox);
      this.hasSummary = false;
    }
  }
}

class SharedBoxResultCarrier implements Component {
  inner: Component | undefined;
  sharedBox: Box | undefined;

  get children(): Component[] | undefined {
    return (this.inner as { children?: Component[] } | undefined)?.children;
  }

  render(_width: number): string[] {
    return [];
  }

  invalidate(): void {
    this.inner?.invalidate?.();
    this.sharedBox?.invalidate();
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

function formatFallbackToolResult(
  result: { content: Array<{ type: string; text?: string; mimeType?: string }> },
  expanded: boolean,
  theme: Theme,
  keyHint: (id: string, description: string) => string,
): string | undefined {
  const textBlocks = result.content.filter((c) => c.type === "text");
  const output = textBlocks
    .map((c) => (c.text || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, ""))
    .join("\n");
  if (!output) return undefined;
  const lines = output.split("\n");
  const displayLines = expanded ? lines : lines.slice(0, FALLBACK_RESULT_PREVIEW_LINES);
  const remaining = lines.length - displayLines.length;
  let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
  if (remaining > 0) {
    const hint = keyHint("app.tools.expand", "to expand") || "ctrl+o to expand";
    text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${hint}${theme.fg("muted", ")")}`;
  }
  return text;
}

/**
 * Create a Pi `ToolRendererResolver` that renders Antigravity's `toolSummary`
 * outside the tool card box in Codex style (`thinkingText` + italic + 1 blank
 * row above the tool box), while keeping `innerCall` + `innerResult` inside a
 * single native `Box` and leaving Codex / summary-less calls 100% untouched.
 */
export function createSummaryToolRendererResolver(
  tracker: ToolSummaryTracker,
): ToolRendererResolver {
  return (toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined => {
    const base = next();
    if (base?.renderShell === "self") {
      return base;
    }
    return {
      renderShell: "self",
      renderCall(args, theme, context) {
        tracker.trackInvalidate(context.toolCallId, context.isPartial, context.invalidate);
        const prevShell =
          context.lastComponent instanceof SummaryShellContainer
            ? context.lastComponent
            : undefined;
        const innerLast = prevShell ? prevShell.inner : context.lastComponent;

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

        const summary =
          tracker.get(context.toolCallId) ??
          (toolName === WRAPPER_TOOL_NAME ? extractWrapperInputSummary(args) : undefined);
        const styledSummary = summary ? formatCodexStyleSummary(theme, summary) : undefined;
        const outputPad = context.outputPad ?? 1;
        const bgFn = resolveToolBoxBgFn(theme, context.isPartial, context.isError);

        const shell = prevShell ?? new SummaryShellContainer();
        shell.update(styledSummary, outputPad, bgFn, inner);
        if (context.state && typeof context.state === "object") {
          (context.state as Record<symbol, unknown>)[SUMMARY_SHELL_STATE] = shell;
        }
        return shell;
      },
      renderResult(result, options, theme, context) {
        const prevCarrier =
          context.lastComponent instanceof SharedBoxResultCarrier
            ? context.lastComponent
            : undefined;
        const innerLast = prevCarrier ? prevCarrier.inner : context.lastComponent;

        let innerResult: Component | undefined;
        if (base?.renderResult) {
          innerResult = base.renderResult(result, options, theme, {
            ...context,
            lastComponent: innerLast,
          });
        } else {
          const fallback = formatFallbackToolResult(
            result as { content: Array<{ type: string; text?: string; mimeType?: string }> },
            options.expanded,
            theme,
            (id, desc) =>
              typeof (context as { keyHint?: unknown }).keyHint === "function"
                ? (context as { keyHint: (k: string, d: string) => string }).keyHint(id, desc)
                : "",
          );
          if (fallback) {
            const fallbackText = innerLast instanceof Text ? innerLast : new Text("", 0, 0);
            fallbackText.setText(fallback);
            innerResult = fallbackText;
          }
        }

        const shell =
          context.state && typeof context.state === "object"
            ? ((context.state as Record<symbol, SummaryShellContainer | undefined>)[
                SUMMARY_SHELL_STATE
              ] ?? undefined)
            : undefined;

        if (shell) {
          shell.sharedBox.setBgFn(resolveToolBoxBgFn(theme, options.isPartial, context.isError));
          if (innerResult) {
            shell.sharedBox.addChild(innerResult);
          }
          const carrier = prevCarrier ?? new SharedBoxResultCarrier();
          carrier.inner = innerResult;
          carrier.sharedBox = shell.sharedBox;
          return carrier;
        }

        return innerResult ?? new Container();
      },
    };
  };
}
