/**
 * streamSimple adapter — runs one agy turn per pi request and translates the
 * reduced outcome into pi AssistantMessageEvents.
 *
 * agy streams response text — the visible answer only — as text_delta
 * continuation chunks on agent_response steps; these stream live into pi's
 * text channel. Thought text is never exposed by agy's print-mode
 * stream-json protocol (thinking_tokens counts in usage are the only
 * reasoning trace), so each answer is preceded by a synthesized summary
 * thinking block. agy tool steps render as native pi tool cards: display-only
 * steps emit a pending card on ACTIVE, then the provider records their result
 * on completion and ends the assistant message
 * with stopReason "toolUse". pi executes the replay-only `agy` wrapper and
 * re-invokes this adapter, which re-attaches to the still-running agy turn via
 * the runtime's turn controller. Native read-only steps still wait for DONE
 * so failed reads are never re-executed as successful pi tools.
 */

import {
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonObject,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AgyEffort } from "../lib/agy-client.ts";
import { type AgyPiBridge, resolveBridgeResultsFromContext } from "../lib/bridge.ts";
import {
  ALL_FALLBACK_MODELS,
  extractAgyConsultFooter,
  pricingForModel,
  resolveAgyConsultSpec,
  resolveAgyModelEffort,
  type AgyModelInfo,
} from "../lib/models.ts";
import { readAgyProcessProfile, type AgyProcessProfile } from "../lib/agy-profile.ts";
import type { AgyActivity, AgyUsage } from "../lib/reducer.ts";
import type { AgyReplayStore } from "../lib/replay.ts";
import { mapAgyToolToNative } from "../lib/native-tools.ts";
import { inspectAgyCommandResult } from "../lib/command-result.ts";
import { agyToolStepKey } from "../lib/tool-steps.ts";
import {
  agyIncompleteToolError,
  BOOST_DEACTIVATED_PROMPT,
  BOOST_ORCHESTRATOR_PROMPT,
  BRIDGE_PENDING_TOOL_MESSAGE,
  omittedImagesPrompt,
  restoredPiContextPrompt,
  WRAPPER_TOOL_NAME,
} from "../lib/prompt.ts";
import {
  AntigravityRuntime,
  createAntigravityRuntime,
  type AntigravityRuntimeInstance,
  type AntigravityRuntimeShape,
} from "./runtime.ts";

interface TextPart {
  type: "text";
  text: string;
}

interface ImagePart {
  type: "image";
  [k: string]: unknown;
}

/**
 * Pi Context has no caller/extension provenance. Preserve the latest contiguous
 * user-message batch in order, rather than letting its last message replace
 * the caller's request. Trailing assistant/tool messages are tool-loop re-entry.
 * Skip wholly empty batches, using the same boundary for history restoration.
 */
function latestUserBatch(context: TranscriptContext): {
  start: number;
  prompt: string;
  images: number;
} {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    if (context.messages[i].role !== "user") continue;
    const end = i + 1;
    while (i > 0 && context.messages[i - 1].role === "user") i--;
    const texts: string[] = [];
    let images = 0;
    for (const message of context.messages.slice(i, end)) {
      if (typeof message.content === "string") {
        if (message.content.trim()) texts.push(message.content);
        continue;
      }
      const parts = Array.isArray(message.content) ? message.content : [];
      for (const part of parts as (TextPart | ImagePart)[]) {
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          texts.push(part.text);
        } else if (part?.type === "image") {
          images += 1;
        }
      }
    }
    if (texts.length === 0 && images === 0) continue;
    const prompt = texts.join("\n");
    return {
      start: i,
      prompt: prompt + (images ? `\n${omittedImagesPrompt(images)}` : ""),
      images,
    };
  }
  return { start: -1, prompt: "", images: 0 };
}

/** Extract all text in the latest user batch (plus an image-omitted note). */
export function latestUserPrompt(context: TranscriptContext): { prompt: string; images: number } {
  const { prompt, images } = latestUserBatch(context);
  return { prompt, images };
}

// A fresh fallback conversation can safely receive roughly 60k characters of
// transcript history while staying well below agy's stdin line / pipe buffer
// limit (~160KB-177KB). Normal reloads resume the persisted native conversation;
// this bootstrap tail is for forks, stale/missing conversations, and branch moves.
const MAX_RESTORED_HISTORY_CHARS = 60_000;
const MAX_TOOL_RESULT_RESTORE_CHARS = 1_500;

/** Serialize the active pi branch before its latest user request. */
export function piHistoryBootstrap(
  context: TranscriptContext,
  promptReserveChars = 0,
): string | undefined {
  const { start: latestUser } = latestUserBatch(context);
  if (latestUser <= 0) return undefined;

  const entries: string[] = [];
  for (const raw of context.messages.slice(0, latestUser)) {
    if (raw.role === "system") continue;
    const message = raw as {
      role?: string;
      toolName?: string;
      content?: unknown;
    };
    const parts = Array.isArray(message.content) ? message.content : [];
    const rendered: string[] = [];
    if (typeof message.content === "string" && message.content.trim()) {
      let text = message.content;
      if (message.role === "toolResult" && text.length > MAX_TOOL_RESULT_RESTORE_CHARS) {
        text = `${text.slice(0, MAX_TOOL_RESULT_RESTORE_CHARS)}\n... [tool output truncated for history restore]`;
      }
      rendered.push(text);
    }
    for (const part of parts as Array<Record<string, unknown>>) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        let text = part.text;
        if (message.role === "toolResult" && text.length > MAX_TOOL_RESULT_RESTORE_CHARS) {
          text = `${text.slice(0, MAX_TOOL_RESULT_RESTORE_CHARS)}\n... [tool output truncated for history restore]`;
        }
        rendered.push(text);
      } else if (part?.type === "toolCall" && typeof part.name === "string") {
        const args = JSON.stringify(part.arguments ?? {});
        rendered.push(`[tool call: ${part.name}${args === "{}" ? "" : ` ${args}`}]`);
      }
    }
    if (rendered.length === 0) continue;
    const role =
      message.role === "toolResult"
        ? `tool ${message.toolName ?? "result"}`
        : (message.role ?? "message");
    entries.push(`${role}:\n${rendered.join("\n")}`);
  }
  if (entries.length === 0) return undefined;
  const transcript = entries.join("\n\n");
  const maxHistoryChars = Math.max(10_000, MAX_RESTORED_HISTORY_CHARS - promptReserveChars);
  const bounded =
    transcript.length <= maxHistoryChars
      ? transcript
      : `[Earlier history omitted]\n${transcript.slice(-maxHistoryChars)}`;
  return restoredPiContextPrompt(bounded);
}

/** Map agy usage fields to pi usage fields. */
export function mapUsage(u: AgyUsage | undefined): AssistantMessage["usage"] {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    // agy never streams thought text (print mode exposes counts only);
    // report thinking_tokens as the reasoning subset of output regardless.
    reasoning: u?.thinking_tokens,
    cacheRead: u?.cache_read_tokens ?? 0,
    cacheWrite: 0,
    totalTokens: u?.total_tokens ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * pi's compaction and branch summarization arrive as standalone requests
 * whose only user message is `<conversation>\n…` plus instructions, or
 * `# Conversation\n…` when splitting a turn, or accompanied by Pi's
 * summarization system prompt. They run in disposable agy conversations so
 * internal summary prompts never become fake user input in the real conversation.
 * Their cached transcript re-reads also produce fictional per-token costs (agy is
 * subscription-billed), so these requests report no usage.
 */
export function isSummarizationRequest(prompt: string, systemPrompt?: string): boolean {
  if (
    prompt.startsWith("<conversation>\n") ||
    prompt.startsWith("<conversation>\r\n") ||
    prompt.startsWith("# Conversation\n") ||
    prompt.startsWith("# Conversation\r\n")
  ) {
    return true;
  }
  if (
    systemPrompt &&
    (systemPrompt.includes("You are a context summarization assistant") ||
      systemPrompt.includes("helping a user file a bug report about pi"))
  ) {
    return true;
  }
  return false;
}

/**
 * Detect side-conversation requests, including `/btw` and child session turns.
 * These requests must run in an isolated agy runtime so they do not interrupt
 * an active in-flight main turn or pollute the main agy conversation history.
 */
export function isSideConversationRequest(prompt: string, systemPrompt?: string): boolean {
  if (
    prompt.includes("[The following is a separate side conversation") ||
    prompt.includes("<btw_capabilities>") ||
    prompt.includes("Summarize the side conversation concisely")
  ) {
    return true;
  }
  if (systemPrompt) {
    if (
      systemPrompt.includes("You are having an aside conversation with the user") ||
      systemPrompt.includes("separate from their main working session") ||
      systemPrompt.includes("<btw_capabilities>") ||
      systemPrompt.includes("Summarize the side conversation concisely") ||
      systemPrompt.includes("side conversation") ||
      systemPrompt.includes("aside conversation") ||
      systemPrompt.includes("side-question") ||
      systemPrompt.includes("tangent thread")
    ) {
      return true;
    }
  }
  return false;
}

const BTW_ASIDE_INSTRUCTION =
  "You are having an aside conversation with the user, separate from their main working session. Answer the side question directly and concisely, using the session context when helpful without derailing or continuing the main task unless asked.";

function buildSideConversationSystemPrompt(
  rawSystemPrompt: string | undefined,
  relayedSystemPrompt: string | undefined,
): string {
  if (rawSystemPrompt?.includes("Summarize the side conversation concisely")) {
    return rawSystemPrompt;
  }
  const isReadOnlyAside =
    rawSystemPrompt?.includes("Available tools in this BTW session: read, grep, find, ls.") ||
    rawSystemPrompt?.includes("No tools are available in this BTW session.");
  const asideInstruction = isReadOnlyAside
    ? `${BTW_ASIDE_INSTRUCTION}\nThis is a read-only aside turn: do not modify files or run mutating commands.`
    : BTW_ASIDE_INSTRUCTION;
  const baseRelay = relayedSystemPrompt?.trim();
  if (baseRelay) {
    return `${baseRelay}\n\n${asideInstruction}`;
  }
  if (!rawSystemPrompt) {
    return asideInstruction;
  }
  const stripped = rawSystemPrompt.replace(/<btw_capabilities>[\s\S]*?<\/btw_capabilities>/g, "").trim();
  return stripped || asideInstruction;
}

const OVERFLOW_PATTERN = /context (length|window|size).*(exceed|limit)|exceeds.*context/i;

/**
 * Transient stream/transport errors reported by agy or Google Cloud backend
 * at the tail end of a turn (e.g. stream interruption, EOF, connection reset,
 * or transient server drop). When the model has already generated a complete
 * response (hasResponse = true), downgrade the ERROR result to success instead
 * of printing a spurious red error notice in Pi.
 */
const RECOVERED_INTERRUPTION_PATTERN =
  /stream was interrupted|network issue connecting to the server|connection reset|unexpected EOF|model request failed|API error|UNAVAILABLE|No capacity available|RESOURCE_EXHAUSTED|rate limit|overloaded|attempt \d+ failed|code (?:429|500|502|503|504)/i;

/** Map an explicit pi thinking level to agy's `--effort` (low|medium|high). */
export function mapThinkingToEffort(level: ThinkingLevel | undefined): AgyEffort | undefined {
  if (level === undefined) return undefined;
  if (level === "low" || level === "minimal") return "low";
  if (level === "medium") return "medium";
  return "high"; // high, xhigh, and max
}

let replayCallSeq = 0;

/** Terminal message for a turn whose controller closed without a result. */
function turnEndedMessage(closeReason: string | undefined): string {
  return closeReason
    ? `agy turn ended without a result event (${closeReason}).`
    : "agy turn ended without a result event.";
}

/**
 * True for agy `call_mcp_tool` steps that target our own bridge server.
 * Those calls surface as synthetic bridge_call activities (emitted as the
 * real pi tool), so the raw call_mcp_tool step must not render a duplicate
 * display-only card. MCP calls against OTHER servers render normally.
 */
function isBridgedMcpStep(
  activity: {
    name: string;
    args: Record<string, unknown>;
  },
  serverName: string,
): boolean {
  return activity.name === "call_mcp_tool" && activity.args?.ServerName === serverName;
}

export interface OneShotConsultOverride {
  modelId: string;
  effort?: AgyEffort;
}

const SUBAGENT_TOOL_NAMES = new Set([
  "invoke_subagent",
  "send_message",
  "manage_subagents",
]);

function contextHasPriorBoostActivity(messages: TranscriptContext["messages"]): boolean {
  for (const msg of messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .map((p) =>
                  p && typeof p === "object" && "text" in p && typeof p.text === "string"
                    ? p.text
                    : "",
                )
                .join("\n")
            : "";
      if (/^\/(?:agy-)?boost\b/i.test(text.trim()) || text.includes("Delegation Routine")) {
        return true;
      }
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!part || typeof part !== "object") continue;
        if ("type" in part && part.type === "toolCall") {
          const toolName = "name" in part && typeof part.name === "string" ? part.name : "";
          const args =
            "arguments" in part && part.arguments && typeof part.arguments === "object"
              ? (part.arguments as Record<string, unknown>)
              : undefined;
          const innerTool = typeof args?.tool === "string" ? args.tool : "";
          if (SUBAGENT_TOOL_NAMES.has(toolName) || SUBAGENT_TOOL_NAMES.has(innerTool)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/** Build the streamSimple implementation bound to the runtime service. */
export function streamAntigravity(
  runtime: AntigravityRuntimeInstance,
  service: AntigravityRuntimeShape,
  replay: AgyReplayStore,
  /** Pi-tool bridge; pass a detached AgyPiBridge when the bridge is off. */
  bridge: AgyPiBridge,
  /** Called when a turn fully settles (stop or error) — the moment an agy
   * background task may have been created. */
  onSettled?: () => void,
  /**
   * Extra prompt text for bootstrap sends (fresh agy conversation). Bridge
   * mode returns nothing; direct mode (bridge off) injects skill file paths.
   */
  getBootstrapSuffix?: () => string | undefined,
  /** Whether a pi tool name is currently active — native re-execution
   * toolCalls are only emitted for active tools (else the wrapper). */
  isActiveTool: (name: string) => boolean = () => true,
  /** Live activity side channel for task/artifact UI that must not wait for
   * the provider message to settle. */
  onActivity?: (activity: AgyActivity) => void,
  /** Test seam for disposable compaction/branch-summary conversations. */
  createIsolatedRuntime: () => AntigravityRuntimeInstance = createAntigravityRuntime,
  /** Current discovery metadata used to resolve a valid required effort. */
  getModelInfo: (modelId: string) => AgyModelInfo | undefined = () => undefined,
  /** Validated process profile; read per turn so env changes recycle safely. */
  getProcessProfile: () => AgyProcessProfile = readAgyProcessProfile,
  /** Combined bridge registration/catalog revision. */
  getBridgeRevision: () => string | undefined = () => undefined,
  /**
   * The instruction block relayed to agy on fresh conversations, composed
   * from pi's structured systemPromptOptions — only what agy cannot reach
   * itself (pi docs paths, user custom prompt, out-of-workspace context
   * files). Falls back to pi's rendered systemPrompt when absent (tests).
   */
  getSystemPromptRelay?: () => string | undefined,
  /** Whether Boost multi-agent orchestration mode is currently active. */
  isBoostActive?: () => boolean,
  /** Active one-shot model consult (`/m <model>[1|2|3] <prompt>`) for the current turn. */
  getOneShotConsult?: () => OneShotConsultOverride | undefined,
  /** Current discovered model catalog for inline `/m` resolution in queued follow-ups. */
  getAllModels?: () => readonly AgyModelInfo[],
  /** Notifies the extension when a turn executes under a `/m` one-shot consult override. */
  onConsultUsed?: (consult: OneShotConsultOverride) => void,
) {
  let hadBoostInConversation = false;
  let currentTurnBatchStart = -1;
  let currentTurnHadBoostBefore = false;

  return (
    model: Model<string>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();

    (async () => {
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: mapUsage(undefined),
        stopReason: "pending",
        timestamp: Date.now(),
      };

      let turnRuntime = runtime;
      let turnService = service;
      let isolatedRuntime: AntigravityRuntimeInstance | undefined;
      let isDisposableTurn = false;
      let turnCleared = false;

      const clearTurn = () => {
        if (turnCleared) return;
        turnCleared = true;
        const finished = turnRuntime.runPromise(turnService.finishTurn).catch(() => {});
        if (!isolatedRuntime) {
          onSettled?.();
          return;
        }
        // A summarizer or disposable side-conversation (/btw) has no main-thread
        // continuity to preserve in `agy -c`. Abort any unfinished child, then
        // dispose its private Effect runtime and remove the disposable agy
        // conversation so `/compact` and `/btw` never hijack `agy -c`.
        const shouldDeleteDisposableConv = isDisposableTurn;
        void finished
          .then(async () => {
            const snap = shouldDeleteDisposableConv
              ? await turnRuntime.runPromise(turnService.snapshot).catch(() => undefined)
              : undefined;
            await turnRuntime.runPromise(turnService.close).catch(() => {});
            if (snap?.conversationId) {
              const { deleteDisposableAgyConversation } = await import(
                "../lib/conversation-metadata.ts"
              );
              await deleteDisposableAgyConversation(snap.conversationId).catch(() => {});
            }
          })
          .finally(() => isolatedRuntime?.dispose().catch(() => {}));
      };

      const fail = (message: string) => {
        const hint = message.includes("permission check failed for command")
          ? " — add an allow-rule (e.g. command(*)) to permissions.allow in ~/.gemini/antigravity-cli/settings.json for autonomous agy turns"
          : "";
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = `${message}${hint}`;
        clearTurn();
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      };

      try {
        const userBatch = latestUserBatch(context);
        const rawUserPrompt = userBatch.prompt;
        const systemPrompt = context.messages.some((message) => message.role === "system")
          ? getCurrentSystemPrompt(context.messages)
          : undefined;
        const summaryRequest = rawUserPrompt
          ? isSummarizationRequest(rawUserPrompt, systemPrompt)
          : false;
        const sideRequest = rawUserPrompt
          ? isSideConversationRequest(rawUserPrompt, systemPrompt)
          : false;
        const isolatedRequest = summaryRequest || sideRequest;
        isDisposableTurn = isolatedRequest;
        let prompt = rawUserPrompt;
        let consultOverride: OneShotConsultOverride | undefined;
        if (!isolatedRequest && prompt) {
          const allModels = getAllModels?.() ?? ALL_FALLBACK_MODELS;
          const inlineConsult = prompt.match(/^\/(?:m|consult|agy-consult)\s+([\s\S]+)$/i);
          if (inlineConsult) {
            const parsed = resolveAgyConsultSpec(inlineConsult[1]!, allModels);
            if (parsed.ok) {
              consultOverride = { modelId: parsed.model.id, effort: parsed.effort };
              prompt = parsed.prompt;
            }
          }
          const footerParsed = extractAgyConsultFooter(prompt, allModels);
          if (footerParsed.prompt !== prompt) {
            prompt = footerParsed.prompt;
            if (!consultOverride && footerParsed.model) {
              consultOverride = {
                modelId: footerParsed.model.id,
                effort: footerParsed.effort,
              };
            }
          }
          if (!consultOverride) {
            consultOverride = getOneShotConsult?.();
          }
        }
        const effectiveModelId = consultOverride?.modelId ?? model.id;
        output.model = effectiveModelId;
        const effectiveModel: Model<string> =
          effectiveModelId === model.id
            ? model
            : { ...model, id: effectiveModelId, cost: pricingForModel(effectiveModelId) };

        stream.push({ type: "start", partial: output });

        if (!rawUserPrompt) {
          throw new Error("antigravity: no user text found in the request context.");
        }
        let isBoost = false;
        if (!isolatedRequest) {
          if (userBatch.start !== currentTurnBatchStart) {
            if (userBatch.start <= 0) {
              hadBoostInConversation = false;
            }
            currentTurnBatchStart = userBatch.start;
            currentTurnHadBoostBefore =
              hadBoostInConversation ||
              (userBatch.start > 0 &&
                contextHasPriorBoostActivity(context.messages.slice(0, userBatch.start)));
          }
          if (/^\/(?:agy-)?boost\b/i.test(prompt)) {
            isBoost = true;
            prompt = prompt.replace(/^\/(?:agy-)?boost\s*/i, "").trim();
            if (!prompt) {
              prompt =
                "Boost mode is ready. What coding or investigation task would you like to tackle? Please share the details or requirements, and I will orchestrate the work.";
            }
          } else if (isBoostActive?.()) {
            isBoost = true;
          }
          if (isBoost) {
            hadBoostInConversation = true;
          }
        }
        const turnPrompt = isBoost
          ? `${BOOST_ORCHESTRATOR_PROMPT}\n\n${prompt}`
          : !isolatedRequest && currentTurnHadBoostBefore
            ? `${BOOST_DEACTIVATED_PROMPT}\n\n${prompt}`
            : prompt;

        if (isolatedRequest) {
          // Pi invokes compaction, branch summarization, and side conversations (/btw)
          // as separate provider calls. Resuming the user's main agy conversation would
          // record them as fake USER_INPUT in the main thread, or abort an active in-flight
          // turn. Run in a disposable conversation so `agy --conversation <id>` stays clean
          // and concurrent turns do not collide.
          const snapshot = await runtime.runPromise(service.snapshot);
          isolatedRuntime = createIsolatedRuntime();
          turnRuntime = isolatedRuntime;
          turnService = isolatedRuntime.runSync(AntigravityRuntime);
          await turnRuntime.runPromise(
            turnService.setSession(snapshot.cwd ?? process.cwd(), effectiveModelId, false),
          );
        }

        let bridgeRevision: string | undefined;
        const processProfile: AgyProcessProfile = getProcessProfile();
        if (!isolatedRequest) {
          // Refresh and resolve before the driver fingerprint is evaluated.
          // Re-entry into a pending bridge turn returns the existing controller,
          // so a changed revision is deferred safely to the next user turn.
          bridge.refreshTools();
          resolveBridgeResultsFromContext(bridge, context.messages);
          bridgeRevision = getBridgeRevision();
        }
        const requestedEffort =
          consultOverride?.effort ?? mapThinkingToEffort(options?.reasoning);
        const effort = resolveAgyModelEffort(getModelInfo(effectiveModelId), requestedEffort);
        if (consultOverride) {
          onConsultUsed?.({ modelId: effectiveModelId, effort });
        }

        const sideSummaryRequest =
          sideRequest &&
          (rawUserPrompt.includes("Summarize the side conversation concisely") ||
            Boolean(systemPrompt?.includes("Summarize the side conversation concisely")));
        const effectiveSystemPrompt = summaryRequest
          ? systemPrompt
          : sideRequest
            ? buildSideConversationSystemPrompt(systemPrompt, getSystemPromptRelay?.())
            : (getSystemPromptRelay?.() ?? systemPrompt);

        const controller = await turnRuntime.runPromise(
          turnService.beginStreamTurn({
            prompt: turnPrompt,
            // Summary requests keep their summarization prompt; side conversations
            // combine the slimmed Pi instruction relay with the aside directive
            // (stripping conflicting <btw_capabilities> tool claims).
            systemPrompt: effectiveSystemPrompt,
            historyBootstrap:
              summaryRequest || sideSummaryRequest
                ? undefined
                : piHistoryBootstrap(context, turnPrompt.length),
            bootstrapSuffix: isolatedRequest ? undefined : getBootstrapSuffix?.(),
            modelId: effectiveModelId,
            effort: requestedEffort ? effort : undefined,
            // Custom lean agents (like agy-lean) restrict tools to 4 workspace primitives
            // and strip invoke_subagent/send_message/manage_subagents. Bypass custom agent
            // when Boost orchestration is active so subagent tools are available.
            agent: isBoost ? undefined : processProfile.agent,
            mode: processProfile.mode,
            bridgeRevision,
            signal: options?.signal,
            timeoutMs: isBoost ? 1_800_000 : undefined,
          }),
        );

        let usage: AgyUsage | undefined;
        let textIndex: number | null = null;
        let textBuffer = "";
        /**
         * Live thinking block populated from SQLite `thinking_delta` events.
         */
        let thinkingIndex: number | null = null;
        let thinkingBuffer = "";
        let thinkingStepId: number | undefined;
        let hasRealThinking = false;
        const realThinkingSteps = new Set<number>();
        /**
         * Thinking slot reserved ahead of the current text run, still awaiting
         * its token count. `contentIndex` is announced once and never moves:
         * pi's delta-only consumers (`--mode json`, streamProxy, extensions
         * reading `assistantMessageEvent`) rebuild content from indices alone,
         * so a block can never be spliced in after the fact.
         */
        let thoughtIndex: number | null = null;
        type PendingReplayTool = {
          id: string;
          index: number;
          toolCall: {
            type: "toolCall";
            id: string;
            name: string;
            arguments: { tool: string; input: JsonObject };
          };
        };
        const pendingReplayTools = new Map<string, PendingReplayTool>();

        /**
         * Close a reserved thinking slot that never received a token count
         * (non-thinking models report `thinking_tokens: 0`). The empty block
         * stays in `content` because announced indices are immutable; pi's
         * renderer trims and skips blank thinking blocks, so it shows nothing.
         */
        const closeUnfilledThought = () => {
          if (thoughtIndex === null) return;
          stream.push({
            type: "thinking_end",
            contentIndex: thoughtIndex,
            content: "",
            partial: output,
          });
          thoughtIndex = null;
        };

        const closeThinking = () => {
          if (thinkingIndex === null) return;
          stream.push({
            type: "thinking_end",
            contentIndex: thinkingIndex,
            content: thinkingBuffer,
            partial: output,
          });
          thinkingIndex = null;
          thinkingBuffer = "";
          thinkingStepId = undefined;
        };

        const closeText = () => {
          closeThinking();
          closeUnfilledThought();
          if (textIndex === null) return;
          stream.push({
            type: "text_end",
            contentIndex: textIndex,
            content: textBuffer,
            partial: output,
          });
          textIndex = null;
          textBuffer = "";
        };

        const attachUsage = (u: AgyUsage | undefined, final: boolean) => {
          if (summaryRequest) return; // summarization turns carry no billable usage
          output.usage = mapUsage(controller.claimUsage(u, final));
          calculateCost(effectiveModel, output.usage);
        };

        const endWithToolUse = () => {
          closeText();
          attachUsage(usage, false);
          output.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message: output });
          stream.end();
        };

        /**
         * Start display-only tools as soon as agy reports ACTIVE. This makes
         * `run_command` render as a pending bash card before a `sleep`, test,
         * or server command finishes. Native read-only calls still wait for
         * DONE because a failed agy read must replay its error, not re-run.
         */
        const emitStartedReplayTool = (
          activity: Extract<AgyActivity, { type: "tool_start" }>,
        ): void => {
          const key = agyToolStepKey(activity);
          if (pendingReplayTools.has(key)) return;
          const native = mapAgyToolToNative(activity.name, activity.args);
          if (native && isActiveTool(native.tool)) return;
          const id = `agy-replay-${++replayCallSeq}`;
          const toolCall = {
            type: "toolCall" as const,
            id,
            name: WRAPPER_TOOL_NAME,
            arguments: { tool: activity.name, input: activity.args },
          };
          output.content.push(toolCall);
          const index = output.content.length - 1;
          pendingReplayTools.set(key, { id, index, toolCall });
          stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
          stream.push({
            type: "toolcall_delta",
            contentIndex: index,
            delta: JSON.stringify(toolCall.arguments ?? {}),
            partial: output,
          });
        };

        const recordReplayResult = (
          id: string,
          activity:
            | Extract<AgyActivity, { type: "tool_done" }>
            | Extract<AgyActivity, { type: "tool_error" }>,
        ) => {
          if (activity.type === "tool_error") {
            replay.record(id, {
              agyTool: activity.name,
              error: activity.message,
              isError: true,
              stepId: activity.stepId,
              conversationId: activity.conversationId,
              args: activity.args,
            });
            return;
          }

          const commandCheck =
            activity.name === "run_command"
              ? inspectAgyCommandResult(
                  activity.conversationId,
                  activity.stepId,
                  activity.output,
                )
              : undefined;

          replay.record(id, {
            agyTool: activity.name,
            output: activity.output,
            durationSeconds: activity.durationSeconds,
            isError: commandCheck?.isError,
            exitCode: commandCheck?.exitCode,
            stepId: activity.stepId,
            conversationId: activity.conversationId,
            args: activity.args,
          });
        };

        const emitFinishedTool = (
          activity:
            | Extract<Awaited<ReturnType<typeof controller.next>>, { type: "tool_done" }>
            | Extract<Awaited<ReturnType<typeof controller.next>>, { type: "tool_error" }>,
        ) => {
          closeText();
          const key = agyToolStepKey(activity);
          const pending = pendingReplayTools.get(key);
          if (pending) {
            pending.toolCall.arguments = { tool: activity.name, input: activity.args };
            recordReplayResult(pending.id, activity);
            stream.push({
              type: "toolcall_end",
              contentIndex: pending.index,
              toolCall: pending.toolCall,
              partial: output,
            });
            pendingReplayTools.delete(key);
            return;
          }

          // The tool name cannot change after toolcall_start. Wait for the
          // terminal event before choosing native execution so agy failures
          // always replay their real error instead of being re-executed.
          const native =
            activity.type === "tool_done"
              ? mapAgyToolToNative(activity.name, activity.args)
              : undefined;
          const effective = native && isActiveTool(native.tool) ? native : undefined;
          const id = `agy-${effective ? "native" : "replay"}-${++replayCallSeq}`;
          const toolCall = {
            type: "toolCall" as const,
            id,
            name: effective ? effective.tool : WRAPPER_TOOL_NAME,
            arguments: effective ? effective.args : { tool: activity.name, input: activity.args },
          };
          if (!effective) recordReplayResult(id, activity);
          output.content.push(toolCall);
          const index = output.content.length - 1;
          stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
          stream.push({
            type: "toolcall_delta",
            contentIndex: index,
            delta: JSON.stringify(toolCall.arguments ?? {}),
            partial: output,
          });
          stream.push({
            type: "toolcall_end",
            contentIndex: index,
            toolCall,
            partial: output,
          });
        };

        const emitIncompleteTools = (resultError?: string): number => {
          const incomplete = controller
            .takeIncompleteTools()
            .filter((activity) => !isBridgedMcpStep(activity, bridge.serverName));
          for (const activity of incomplete) {
            const key = agyToolStepKey(activity);
            const pending = pendingReplayTools.get(key);
            const id = pending?.id ?? `agy-replay-${++replayCallSeq}`;
            replay.record(id, {
              agyTool: activity.name,
              error: agyIncompleteToolError(activity.name, resultError),
            });
            const toolCall = pending?.toolCall ?? {
              type: "toolCall" as const,
              id,
              name: WRAPPER_TOOL_NAME,
              arguments: { tool: activity.name, input: activity.args },
            };
            toolCall.arguments = { tool: activity.name, input: activity.args };
            const index = pending?.index ?? output.content.length;
            if (!pending) {
              output.content.push(toolCall);
              stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
            }
            stream.push({
              type: "toolcall_end",
              contentIndex: index,
              toolCall,
              partial: output,
            });
            pendingReplayTools.delete(key);
          }
          return incomplete.length;
        };

        /**
         * A bridged pi tool must execute immediately or agy blocks waiting for
         * its result. If another agy command is still ACTIVE, close its live
         * card as "running" before yielding to pi; its eventual terminal event
         * will render a separate completion card after re-attachment.
         */
        const closePendingForBridge = () => {
          for (const [key, pending] of pendingReplayTools) {
            const tool = pending.toolCall.arguments.tool;
            replay.record(pending.id, {
              agyTool: tool,
              output: BRIDGE_PENDING_TOOL_MESSAGE,
            });
            stream.push({
              type: "toolcall_end",
              contentIndex: pending.index,
              toolCall: pending.toolCall,
              partial: output,
            });
            pendingReplayTools.delete(key);
          }
        };

        /**
         * Reserve the thinking slot that precedes a text run, returning its
         * index.
         *
         * agy only reports `thinking_tokens` on the response step's DONE event
         * — after that step's text deltas — so the summary cannot be emitted in
         * document order. Claiming the index up front keeps the marker above
         * the answer it introduces (like agy's own collapsed line) while the
         * event stream stays append-only.
         */
        const reserveThought = (): number => {
          if (thoughtIndex !== null) return thoughtIndex;
          output.content.push({ type: "thinking", thinking: "" });
          thoughtIndex = output.content.length - 1;
          stream.push({ type: "thinking_start", contentIndex: thoughtIndex, partial: output });
          return thoughtIndex;
        };

        /**
         * agy's interactive TUI collapses hidden reasoning into one line
         * ("Thought for 3s, 289 tokens"). Print mode never streams thought
         * text, so synthesize the same summary into the reserved slot once the
         * response step reports its token count. The step duration covers
         * thinking plus writing — the closest signal agy exposes to its own
         * thought timer. Only the first substantive response step in a logical
         * agy turn gets a marker, avoiding a repeated row before every tool
         * phase. A thought-only segment has no reservation, so it appends one.
         */
        const emitThoughtMarker = (activity: Extract<AgyActivity, { type: "thought" }>): void => {
          const seconds =
            activity.durationSeconds === undefined
              ? undefined
              : Math.max(1, Math.round(activity.durationSeconds));
          const summary =
            seconds === undefined
              ? `Thought ${activity.tokens} tokens`
              : `Thought for ${seconds}s, ${activity.tokens} tokens`;
          const index = reserveThought();
          const block = output.content[index];
          if (block.type === "thinking") block.thinking = summary;
          stream.push({
            type: "thinking_delta",
            contentIndex: index,
            delta: summary,
            partial: output,
          });
          stream.push({
            type: "thinking_end",
            contentIndex: index,
            content: summary,
            partial: output,
          });
          thoughtIndex = null;
        };

        /**
         * Render a runtime stall/retry as a collapsed thinking line so the
         * user sees why a turn restarted instead of a silent multi-minute
         * spinner. Uses the same reserved-slot mechanism as thought markers
         * so the event stream stays delta-replay legal.
         */
        const emitStallMarker = (activity: Extract<AgyActivity, { type: "stall" }>): void => {
          closeText();
          const seconds = Math.max(1, Math.round(activity.stalledMs / 1000));
          const summary =
            `agy stream stalled for ${seconds}s with no events` +
            `${activity.toolActive ? " while a tool step was active" : ""}` +
            ` — restarting the turn (retry ${activity.retry} of ${activity.maxRetries})`;
          const index = reserveThought();
          const block = output.content[index];
          if (block.type === "thinking") block.thinking = summary;
          stream.push({
            type: "thinking_delta",
            contentIndex: index,
            delta: summary,
            partial: output,
          });
          stream.push({
            type: "thinking_end",
            contentIndex: index,
            content: summary,
            partial: output,
          });
          thoughtIndex = null;
        };

        while (true) {
          const activity = await controller.next();
          if (activity === null) {
            const ended = turnEndedMessage(controller.closeReason());
            if (!isolatedRequest && emitIncompleteTools() > 0) {
              controller.deferResult({
                type: "result",
                status: "ERROR",
                response: "",
                error: ended,
                usage: undefined,
              });
              endWithToolUse();
              return;
            }
            throw new Error(ended);
          }

          try {
            if (!isolatedRequest) onActivity?.(activity);
          } catch {
            // UI side channels are best-effort and must never fail the turn.
          }
          switch (activity.type) {
            case "conversation_fallback": {
              // Runtime/index side channel only; no assistant content.
              break;
            }
            case "usage": {
              usage = activity.usage;
              // Publish step usage on the live partial before the next delta.
              // pi-tps-footer reads usage.output off message_update; attaching
              // only at result makes the decode window look like an end-flush
              // and the footer stays at "—".
              if (!summaryRequest && (usage.output_tokens ?? 0) > 0) {
                attachUsage(usage, false);
                if (textIndex !== null) {
                  stream.push({
                    type: "text_delta",
                    contentIndex: textIndex,
                    delta: "",
                    partial: output,
                  });
                } else if (thinkingIndex !== null) {
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: thinkingIndex,
                    delta: "",
                    partial: output,
                  });
                } else if (thoughtIndex !== null) {
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: thoughtIndex,
                    delta: "",
                    partial: output,
                  });
                }
              }
              break;
            }
            case "thinking_delta": {
              if (!activity.delta) break;
              if (textIndex !== null) closeText();
              closeUnfilledThought();
              if (
                thinkingIndex !== null &&
                activity.stepId !== undefined &&
                thinkingStepId !== undefined &&
                activity.stepId !== thinkingStepId
              ) {
                closeThinking();
              }
              if (thinkingIndex === null) {
                output.content.push({ type: "thinking", thinking: "" });
                thinkingIndex = output.content.length - 1;
                thinkingBuffer = "";
                thinkingStepId = activity.stepId;
                stream.push({
                  type: "thinking_start",
                  contentIndex: thinkingIndex,
                  partial: output,
                });
              }
              hasRealThinking = true;
              if (activity.stepId !== undefined) realThinkingSteps.add(activity.stepId);
              {
                const block = output.content[thinkingIndex];
                const paceOff = process.env.PI_ANTIGRAVITY_THINKING_PACE === "0";
                const graphemes = paceOff
                  ? [activity.delta]
                  : Array.from(
                      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
                        activity.delta,
                      ),
                      (s) => s.segment,
                    );
                // Bound total added latency (~300ms per delta) at ~12ms per step.
                const steps = Math.min(graphemes.length, 25);
                const per = Math.ceil(graphemes.length / Math.max(1, steps));
                for (let i = 0; i < graphemes.length; i += per) {
                  const piece = graphemes.slice(i, i + per).join("");
                  thinkingBuffer += piece;
                  if (block.type === "thinking") block.thinking = thinkingBuffer;
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: thinkingIndex,
                    delta: piece,
                    partial: output,
                  });
                  if (!paceOff && i + per < graphemes.length) {
                    await new Promise((r) => setTimeout(r, 12));
                  }
                }
              }
              break;
            }
            case "thought": {
              if (
                hasRealThinking ||
                (activity.stepId !== undefined && realThinkingSteps.has(activity.stepId))
              ) {
                break;
              }
              if (controller.claimThought()) emitThoughtMarker(activity);
              break;
            }
            case "stall": {
              emitStallMarker(activity);
              break;
            }
            case "tool_start": {
              controller.beginTextSegment();
              if (isolatedRequest) {
                if (!summaryRequest) {
                  if (textIndex !== null) closeText();
                  closeUnfilledThought();
                  if (thinkingIndex === null) {
                    output.content.push({ type: "thinking", thinking: "" });
                    thinkingIndex = output.content.length - 1;
                    thinkingBuffer = "";
                    thinkingStepId = activity.stepId;
                    stream.push({
                      type: "thinking_start",
                      contentIndex: thinkingIndex,
                      partial: output,
                    });
                  }
                  hasRealThinking = true;
                  const args = activity.args ?? {};
                  const detail =
                    (typeof args.CommandLine === "string" && args.CommandLine.trim()) ||
                    (typeof args.AbsolutePath === "string" && args.AbsolutePath.trim()) ||
                    (typeof args.TargetFile === "string" && args.TargetFile.trim()) ||
                    (typeof args.toolAction === "string" && args.toolAction.trim()) ||
                    (typeof args.toolSummary === "string" && args.toolSummary.trim()) ||
                    "";
                  const oneLine = detail.replace(/\s+/g, " ").trim();
                  const clipped = oneLine.length > 96 ? `${oneLine.slice(0, 93)}...` : oneLine;
                  const toolLine = clipped
                    ? `🔧 \`${activity.name}\` · ${clipped}`
                    : `🔧 \`${activity.name}\``;
                  const prefix =
                    thinkingBuffer.length === 0 || thinkingBuffer.endsWith("\n") ? "" : "\n";
                  const delta = `${prefix}${toolLine}\n`;
                  thinkingBuffer += delta;
                  const block = output.content[thinkingIndex];
                  if (block.type === "thinking") block.thinking = thinkingBuffer;
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: thinkingIndex,
                    delta,
                    partial: output,
                  });
                }
                break;
              }
              if (isBridgedMcpStep(activity, bridge.serverName)) break;
              closeText();
              emitStartedReplayTool(activity);
              break;
            }
            case "tool_done": {
              if (isolatedRequest) break;
              if (isBridgedMcpStep(activity, bridge.serverName)) break;
              emitFinishedTool(activity);
              if (pendingReplayTools.size === 0) {
                endWithToolUse();
                return;
              }
              break;
            }
            case "tool_error": {
              if (isolatedRequest) break;
              if (isBridgedMcpStep(activity, bridge.serverName)) break;
              emitFinishedTool(activity);
              if (pendingReplayTools.size === 0) {
                endWithToolUse();
                return;
              }
              break;
            }
            case "bridge_call": {
              if (isolatedRequest) break;
              // agy invoked a pi tool through the bridge: end this message
              // with a toolUse for the REAL pi tool so pi executes it with
              // full ownership (hooks, permissions, rendering, abort).
              closeText();
              closePendingForBridge();
              const toolCall = {
                type: "toolCall" as const,
                id: activity.id,
                name: activity.name,
                arguments: activity.args,
              };
              output.content.push(toolCall);
              const index = output.content.length - 1;
              stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
              stream.push({
                type: "toolcall_delta",
                contentIndex: index,
                delta: JSON.stringify(toolCall.arguments ?? {}),
                partial: output,
              });
              stream.push({
                type: "toolcall_end",
                contentIndex: index,
                toolCall,
                partial: output,
              });
              endWithToolUse();
              return;
            }
            case "text": {
              if (thinkingIndex !== null) closeThinking();
              if (textIndex === null) {
                // Reserve the synthetic thought slot BEFORE the text block only
                // when no real SQLite thinking text was streamed for this step.
                if (
                  !hasRealThinking &&
                  (activity.stepId === undefined || !realThinkingSteps.has(activity.stepId))
                ) {
                  reserveThought();
                }
                output.content.push({ type: "text", text: "" });
                textIndex = output.content.length - 1;
                textBuffer = "";
                stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
              }
              controller.recordEmittedText(activity.delta, activity.stepId);
              textBuffer += activity.delta;
              const block = output.content[textIndex];
              if (block.type === "text") block.text = textBuffer;
              stream.push({
                type: "text_delta",
                contentIndex: textIndex,
                delta: activity.delta,
                partial: output,
              });
              break;
            }
            case "result": {
              if (!isolatedRequest && emitIncompleteTools(activity.error) > 0) {
                controller.deferResult(activity);
                endWithToolUse();
                return;
              }
              // A result carries conversation-cumulative counters, which can
              // represent millions of tokens across agy's internal agent loop.
              // Pi interprets one assistant message's usage as live context and
              // would auto-compact after nearly every user turn. Prefer the
              // latest response step — the actual model call represented by
              // this message — and use the cumulative result only when agy did
              // not expose a response-step usage event.
              if (usage) attachUsage(usage, false);
              else attachUsage(activity.usage, true);

              // Account for text rendered in earlier Pi messages and blocks,
              // not just this closure's textBuffer (which tool boundaries clear).
              const suffix = controller.remainingResponseText(activity.response);
              if (suffix) {
                // A distinct final answer is its own block, not a continuation
                // glued onto the last word of streamed commentary.
                if (suffix === activity.response) closeText();
                controller.recordEmittedText(suffix);
                if (textIndex !== null) {
                  textBuffer += suffix;
                  const block = output.content[textIndex];
                  if (block.type === "text") block.text = textBuffer;
                  stream.push({
                    type: "text_delta",
                    contentIndex: textIndex,
                    delta: suffix,
                    partial: output,
                  });
                } else {
                  closeUnfilledThought();
                  output.content.push({ type: "text", text: suffix });
                  const idx = output.content.length - 1;
                  stream.push({ type: "text_start", contentIndex: idx, partial: output });
                  stream.push({
                    type: "text_delta",
                    contentIndex: idx,
                    delta: suffix,
                    partial: output,
                  });
                  stream.push({
                    type: "text_end",
                    contentIndex: idx,
                    content: suffix,
                    partial: output,
                  });
                }
              }
              closeText();

              const hasResponse =
                Boolean(activity.response?.trim()) ||
                output.content.some((c) => c.type === "text" && Boolean(c.text.trim()));

              // agy flags auto-recovered stream interruptions as ERROR even
              // though the full response was delivered; pi aborts the run on
              // stopReason "error", so complete those turns normally instead.
              const recovered =
                hasResponse &&
                !OVERFLOW_PATTERN.test(activity.error ?? "") &&
                (RECOVERED_INTERRUPTION_PATTERN.test(activity.error ?? "") ||
                  Boolean(activity.response?.trim()));

              if (activity.status === "ERROR" && !recovered) {
                const message = activity.error || "agy reported an error for this turn.";
                output.stopReason = "error";
                output.errorMessage = OVERFLOW_PATTERN.test(message)
                  ? `context_length_exceeded: ${message}`
                  : message;
                stream.push({ type: "error", reason: "error", error: output });
              } else {
                output.stopReason = "stop";
                stream.push({ type: "done", reason: "stop", message: output });
              }
              clearTurn();
              stream.end();
              return;
            }
          }
        }
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    })();

    return stream;
  };
}
