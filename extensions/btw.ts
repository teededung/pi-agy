import {
  buildSessionContext,
  copyToClipboard,
  createAgentSession,
  createExtensionRuntime,
  getAgentDir,
  getMarkdownTheme,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  type AssistantMessage,
  type Message,
  type ThinkingLevel as AiThinkingLevel,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  Box,
  Container,
  Input,
  Key,
  Markdown,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type KeybindingsManager,
  type KeyId,
  type MarkdownTheme,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";
import { loadBtwExtensionResources, readBtwExtensionSources, readBtwWorkspaceMode } from "./btw-extension-tools.ts";
import { createBtwSshWorkspace, type BtwSshWorkspace } from "./btw-ssh-workspace.ts";
import { AGY_BTW_INTERCEPT_EVENT, type AgyBtwInterceptPayload } from "../lib/subagents.ts";

export const BTW_COMMANDS = [
  { name: "btw", description: "Continue a side conversation in a focused BTW modal. Add --save to also persist a visible note." },
  { name: "side", description: "Alias for /btw: continue a side conversation in a focused BTW modal." },
  { name: "btw:tangent", description: "Start or continue a contextless BTW tangent in the focused BTW modal." },
  { name: "btw:ask", description: "Ask a read-only side question: inherits main-session context but exposes only read/grep/find/ls tools." },
  { name: "btw:new", description: "Start a fresh BTW thread with main-session context. Optionally ask the first question immediately." },
  { name: "btw:minimize", description: "Minimize or restore the BTW modal. Auto-restores when background work finishes." },
  { name: "btw:clear", description: "Dismiss the BTW modal/widget and clear the current thread." },
  { name: "btw:inject", description: "Inject the full BTW thread into the main agent as a user message." },
  { name: "btw:summarize", description: "Summarize the BTW thread, then inject the summary into the main agent." },
  { name: "btw:copy", description: "Copy the latest BTW assistant message to the clipboard." },
  { name: "btw:model", description: "Show, set, or clear the BTW-only model override." },
  { name: "btw:thinking", description: "Show, set, or clear the BTW-only thinking override." },
] as const;

const BTW_MESSAGE_TYPE = "btw-note";
const BTW_ENTRY_TYPE = "btw-thread-entry";
const BTW_RESET_TYPE = "btw-thread-reset";
const BTW_MODEL_OVERRIDE_TYPE = "btw-model-override";
const BTW_THINKING_OVERRIDE_TYPE = "btw-thinking-override";
const BTW_DEFAULT_FOCUS_SHORTCUTS: readonly KeyId[] = [Key.alt("/"), Key.super("/")];
const BTW_FOCUS_KEYS_ENV = "PI_BTW_FOCUS_KEYS";
const BTW_FOCUS_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
// Mirrors the SpecialKey union in @earendil-works/pi-tui keys.d.ts (lower-cased).
const BTW_FOCUS_SPECIAL_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
// Symbols from the SymbolKey union (letters/digits are matched directly).
const BTW_FOCUS_SYMBOL_KEYS = new Set([
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*",
  "(", ")", "_", "+", "|", "~", "{", "}", ":", "<", ">", "?",
]);

/**
 * Resolve the BTW overlay focus-toggle shortcuts.
 *
 * Users whose window manager or terminal claims the default shortcuts can override them by
 * setting PI_BTW_FOCUS_KEYS to a comma-separated list of pi-tui key identifiers
 * (e.g. "ctrl+/,ctrl+alt+b"). Blank, duplicate, or unparseable entries are ignored; if no
 * usable entries remain, the defaults are kept so focus toggling never becomes impossible.
 */
export function resolveBtwFocusShortcuts(env: NodeJS.ProcessEnv = process.env): KeyId[] {
  const raw = env[BTW_FOCUS_KEYS_ENV];
  if (typeof raw !== "string" || raw.trim() === "") {
    return [...BTW_DEFAULT_FOCUS_SHORTCUTS];
  }

  const seen = new Set<string>();
  const shortcuts: KeyId[] = [];
  for (const part of raw.split(",")) {
    const candidate = part.trim().toLowerCase();
    if (!candidate || seen.has(candidate) || !isValidFocusShortcut(candidate)) {
      continue;
    }
    seen.add(candidate);
    shortcuts.push(candidate as KeyId);
  }

  return shortcuts.length > 0 ? shortcuts : [...BTW_DEFAULT_FOCUS_SHORTCUTS];
}

/**
 * Validate a candidate against the pi-tui KeyId grammar: zero or more distinct recognized
 * modifiers followed by exactly one base key (letter, digit, symbol, or named special key).
 * Rejects typos like "cmd+/" or "control+x" and duplicate/empty segments.
 */
export function isValidFocusShortcut(candidate: string): boolean {
  const segments = candidate.split("+");
  const base = segments.pop();
  if (base === undefined || !isValidFocusBaseKey(base)) {
    return false;
  }

  const seen = new Set<string>();
  for (const segment of segments) {
    if (!BTW_FOCUS_MODIFIERS.has(segment) || seen.has(segment)) {
      return false;
    }
    seen.add(segment);
  }

  return true;
}

function isValidFocusBaseKey(base: string): boolean {
  if (base.length === 1) {
    return /[a-z0-9]/.test(base) || BTW_FOCUS_SYMBOL_KEYS.has(base);
  }
  return BTW_FOCUS_SPECIAL_KEYS.has(base);
}

function formatFocusShortcutLabel(shortcut: KeyId): string {
  return shortcut
    .split("+")
    .map((segment) => {
      switch (segment) {
        case "ctrl":
          return "Ctrl";
        case "alt":
          return "Alt";
        case "shift":
          return "Shift";
        case "super":
          return "Super";
        default:
          return segment.length === 1 ? segment.toUpperCase() : segment;
      }
    })
    .join("+");
}

export function describeFocusShortcuts(shortcuts: readonly KeyId[]): string {
  const labels = shortcuts.map(formatFocusShortcutLabel);
  if (labels.length <= 1) {
    return labels[0] ?? "";
  }
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

const BTW_FOCUS_SHORTCUTS: readonly KeyId[] = resolveBtwFocusShortcuts();
const BTW_FOCUS_SHORTCUTS_LABEL = describeFocusShortcuts(BTW_FOCUS_SHORTCUTS);

function matchesBtwFocusShortcut(data: string): boolean {
  return BTW_FOCUS_SHORTCUTS.some((shortcut) => matchesKey(data, shortcut));
}

/** Toggles the overlay between framed "window" width and edge-to-edge "full" width. */
const BTW_WIDTH_TOGGLE_SHORTCUT: KeyId = Key.alt("w");

function matchesBtwWidthToggle(data: string): boolean {
  return matchesKey(data, BTW_WIDTH_TOGGLE_SHORTCUT);
}

/** Minimizes the BTW overlay to a compact status widget (and restores it when pressed again). */
const BTW_MINIMIZE_SHORTCUT: KeyId = Key.alt("m");

function matchesBtwMinimizeShortcut(data: string): boolean {
  return matchesKey(data, BTW_MINIMIZE_SHORTCUT);
}

type BtwOverlayWidthMode = "window" | "full";

const BTW_SYSTEM_PROMPT = [
  "You are having an aside conversation with the user, separate from their main working session.",
  "If main session messages are provided, they are for context only — that work is being handled by another agent.",
  "If no main session messages are provided, treat this as a fully contextless tangent thread and rely only on the user's words plus your general instructions.",
  "Focus on answering the user's side questions, helping them think through ideas, or planning next steps.",
  "Do not act as if you need to continue unfinished work from the main session unless the user explicitly asks you to prepare something for injection back to it.",
].join(" ");

const BTW_SUMMARIZE_SYSTEM_PROMPT =
  "Summarize the side conversation concisely. Preserve key decisions, plans, insights, risks, and action items. Output only the summary.";

const BTW_CONTINUE_THREAD_USER_TEXT = "[The following is a separate side conversation. Continue this thread.]";
const BTW_CONTINUE_THREAD_ASSISTANT_TEXT = "Understood, continuing our side conversation.";

type SessionThinkingLevel = "off" | AiThinkingLevel;
type BtwThreadMode = "contextual" | "tangent" | "readonly";
type SessionModel = NonNullable<ExtensionCommandContext["model"]>;
/**
 * Loose model reference parsed from `/btw:model <provider> <id> <api>` and persisted to
 * session entries. Resolved to a full SessionModel via ctx.modelRegistry.find(...).
 */
type BtwModelRef = Pick<SessionModel, "provider" | "id" | "api">;

type BtwDetails = {
  question: string;
  thinking: string;
  answer: string;
  provider: string;
  model: string;
  api: string;
  thinkingLevel: SessionThinkingLevel;
  timestamp: number;
  usage?: AssistantMessage["usage"];
  workspaceIdentity?: string;
};

type ParsedBtwArgs = {
  question: string;
  save: boolean;
  modelSpec?: string;
};

type SaveState = "not-saved" | "saved" | "queued";

type BtwResetDetails = {
  timestamp: number;
  mode?: BtwThreadMode;
};

type BtwModelOverrideDetails =
  | ({ timestamp: number; action: "set" } & Pick<SessionModel, "provider" | "id" | "api">)
  | { timestamp: number; action: "clear" };

type BtwThinkingOverrideDetails =
  | { timestamp: number; action: "set"; thinkingLevel: SessionThinkingLevel }
  | { timestamp: number; action: "clear" };

type ResolvedBtwModel = {
  model: SessionModel | null;
  source: "override" | "main" | "none";
  configuredOverride: SessionModel | null;
  fallbackReason?: string;
};

type ResolvedBtwSettings = {
  model: SessionModel | null;
  modelSource: "override" | "main" | "none";
  configuredModelOverride: SessionModel | null;
  thinkingLevel: SessionThinkingLevel;
  thinkingSource: "override" | "main";
  fallbackReason?: string;
};

type BtwTurnOutcome = "completed" | "aborted" | "failed";

type BtwTranscriptEntry =
  | { id: number; turnId: number; type: "turn-boundary"; phase: "start" | "end"; outcome?: BtwTurnOutcome }
  | { id: number; turnId: number; type: "user-message"; text: string }
  | { id: number; turnId: number; type: "queued-user-message"; text: string; queuePosition: number; queueTotal: number }
  | { id: number; turnId: number; type: "thinking"; text: string; streaming: boolean }
  | { id: number; turnId: number; type: "assistant-text"; text: string; streaming: boolean }
  | { id: number; turnId: number; type: "tool-call"; toolCallId: string; toolName: string; args: string }
  | {
      id: number;
      turnId: number;
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      content: string;
      truncated: boolean;
      isError: boolean;
      streaming: boolean;
    };

type BtwTranscript = BtwTranscriptEntry[];

type BtwTranscriptState = {
  entries: BtwTranscript;
  nextEntryId: number;
  nextTurnId: number;
  currentTurnId: number | null;
  lastTurnId: number | null;
  toolCalls: Map<string, { turnId: number; callEntryId: number; resultEntryId?: number }>;
};

type BtwSessionRuntime = {
  session: AgentSession;
  mode: BtwThreadMode;
  subscriptions: Set<() => void>;
  sideThreadStartIndex: number;
  abortPromise?: Promise<void>;
  promptQueue: Promise<void>;
  hasExtensions: boolean;
  workspace?: BtwSshWorkspace;
  workspaceIdentity: string;
  /** Main-session user turns present when this child was seeded; used to flag stale context. */
  mainTurnsAtSeed: number;
};

/** Warn once the BTW child is this many main-session user turns behind. */
const BTW_STALE_TURNS = 3;

function countMainUserTurns(ctx: ExtensionContext | ExtensionCommandContext): number {
  try {
    return ctx.sessionManager
      .getBranch()
      .filter((entry) => {
        const e = entry as unknown as { type?: string; message?: { role?: string } };
        return e.type === "message" && e.message?.role === "user";
      }).length;
  } catch {
    return 0;
  }
}

type OverlayRuntime = {
  handle?: OverlayHandle;
  refresh?: () => void;
  close?: () => void;
  finish?: () => void;
  setDraft?: (value: string) => void;
  closed?: boolean;
};

function isVisibleBtwMessage(message: { role: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === BTW_MESSAGE_TYPE;
}

function isCustomEntry(entry: unknown, customType: string): entry is { type: "custom"; customType: string; data?: unknown } {
  return !!entry && typeof entry === "object" && (entry as { type?: string }).type === "custom" && (entry as { customType?: string }).customType === customType;
}

function stripDynamicSystemPromptFooter(systemPrompt: string): string {
  return systemPrompt
    .replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
    .replace(/\nCurrent working directory:[^\n]*$/u, "")
    .trim();
}

function createBtwResourceLoader(
  ctx: ExtensionCommandContext,
  tools: readonly string[] | (() => readonly string[]),
  appendSystemPrompt: string[] = [BTW_SYSTEM_PROMPT],
  extensionResources?: ResourceLoader,
  workspaceLabel = `local ${ctx.cwd}`,
): ResourceLoader {
  const extensionsResult = extensionResources?.getExtensions() ?? { extensions: [], errors: [], runtime: createExtensionRuntime() };
  const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());
  // Preserve the parent's project/custom instructions, but override capability
  // claims in its rendered prompt and in the history seeded into this child.
  const capabilities = () => {
    const availableTools = typeof tools === "function" ? tools() : tools;
    return [
      "<btw_capabilities>",
      `Workspace for built-in file and shell tools: ${workspaceLabel}.`,
      availableTools.length > 0
        ? `Available tools in this BTW session: ${availableTools.join(", ")}.`
        : "No tools are available in this BTW session.",
      "This capability list is authoritative for this child session.",
      "Tool and skill instructions inherited from the main session may describe tools that are unavailable here.",
      "Previous tool calls in inherited conversation are historical context, not available capabilities.",
      "Only call tools listed above; do not infer additional tools from the main session.",
      "</btw_capabilities>",
    ].join("\n");
  };

  const resourceLoader: ResourceLoader = {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [...appendSystemPrompt, capabilities()],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async (_options) => {},
  };

  return resourceLoader;
}

async function createBtwModelRuntimeOptions(
  ctx: ExtensionCommandContext,
  model: SessionModel,
): Promise<Pick<CreateAgentSessionOptions, "modelRuntime">> {
  const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider(model.provider);
  const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
  const hasRuntimeApiKey = ctx.modelRegistry.getProviderAuthStatus(model.provider).source === "runtime";

  if (!nativeProvider && !providerConfig && !hasRuntimeApiKey) {
    return {};
  }

  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  if (nativeProvider) {
    modelRuntime.registerNativeProvider(nativeProvider);
  } else if (providerConfig) {
    modelRuntime.registerProvider(model.provider, providerConfig);
  }
  await modelRuntime.refresh({ allowNetwork: false });

  // --api-key is stored only in the parent runtime.
  if (hasRuntimeApiKey) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok && auth.apiKey) {
      await modelRuntime.setRuntimeApiKey(model.provider, auth.apiKey);
    }
  }

  return { modelRuntime };
}

function hasResolvedAuthValues(values?: Record<string, string | null | undefined>): boolean {
  return !!values && Object.values(values).some((value) => typeof value === "string" && value.length > 0);
}

function hasUsableModelAuth(
  ctx: ExtensionCommandContext,
  model: SessionModel,
  auth: Awaited<ReturnType<ExtensionCommandContext["modelRegistry"]["getApiKeyAndHeaders"]>>,
): boolean {
  if (!auth.ok) {
    return false;
  }

  return (
    !!auth.apiKey ||
    hasResolvedAuthValues(auth.headers) ||
    hasResolvedAuthValues(auth.env) ||
    ctx.modelRegistry.hasConfiguredAuth(model)
  );
}

function extractText(parts: AssistantMessage["content"], type: "text" | "thinking"): string {
  const chunks: string[] = [];

  for (const part of parts) {
    if (type === "text" && part.type === "text") {
      chunks.push(part.text);
    } else if (type === "thinking" && part.type === "thinking") {
      chunks.push(part.thinking);
    }
  }

  return chunks.join("\n").trim();
}

function extractAnswer(message: AssistantMessage): string {
  return extractText(message.content, "text") || "(No text response)";
}

function extractThinking(message: AssistantMessage): string {
  return extractText(message.content, "thinking");
}

const BTW_MODEL_ALIASES: Readonly<Record<string, { id: string; label: string; preferredProvider?: string }>> = {
  argon: { id: "gemini-4-argon", label: "Gemini 4 Argon", preferredProvider: "antigravity" },
  flash: { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", preferredProvider: "antigravity" },
  opus: { id: "claude-opus-5-5", label: "Claude Opus 5.5", preferredProvider: "antigravity" },
  sonnet: { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", preferredProvider: "antigravity" },
  grok: { id: "grok-4.7", label: "Grok 4.7", preferredProvider: "xai-oauth" },
  "grok-fast": { id: "grok-4.7-non-reasoning", label: "Grok 4.7 (non-reasoning)", preferredProvider: "xai-oauth" },
};

function parseBtwThinkingToken(token: string | undefined): SessionThinkingLevel | undefined {
  if (!token) return undefined;
  switch (token.trim().toLowerCase()) {
    case "0":
    case "off":
      return "off";
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
    case "4":
    case "xhigh":
      return "xhigh";
    case "minimal":
      return "minimal" as SessionThinkingLevel;
    default:
      return undefined;
  }
}

function parseBtwArgs(args: string): ParsedBtwArgs {
  let working = args;
  const save = /(?:^|\s)(?:--save|-s)(?=\s|$)/.test(working);
  working = working.replace(/(?:^|\s)(?:--save|-s)(?=\s|$)/g, " ");

  let modelSpec: string | undefined;
  const modelFlagMatch = working.match(/(?:^|\s)(?:--model|-m)(?:=(\S+)|\s+(\S+))(?=\s|$)/);
  if (modelFlagMatch) {
    modelSpec = (modelFlagMatch[1] ?? modelFlagMatch[2])?.trim();
    working = working.replace(modelFlagMatch[0], " ");
  }

  return { question: working.trim(), save, ...(modelSpec ? { modelSpec } : {}) };
}

type ParsedBtwModelCommand =
  | { action: "show"; interactive: boolean }
  | { action: "clear" }
  | { action: "set"; model: BtwModelRef; thinkingLevel?: SessionThinkingLevel }
  | { action: "lookup"; query: string; thinkingLevel?: SessionThinkingLevel }
  | { action: "invalid"; message: string };

function parseSingleBtwModelSpecToken(
  token: string,
): { query: string; thinkingLevel?: SessionThinkingLevel } | { action: "clear" } | { action: "show" } {
  const lower = token.toLowerCase();
  if (lower === "show" || lower === "status") {
    return { action: "show" };
  }
  if (lower === "clear" || lower === "reset" || lower === "default" || lower === "main") {
    return { action: "clear" };
  }

  const aliasMatch = token.match(
    /^(argon|flash|opus|sonnet|grok-fast|grok)(?:[-:]?(0|1|2|3|4|off|low|mid|medium|high|xhigh))?$/i,
  );
  if (aliasMatch) {
    const base = aliasMatch[1]!.toLowerCase();
    const thinkingLevel =
      base === "grok-fast" ? "off" : parseBtwThinkingToken(aliasMatch[2]);
    return { query: base, thinkingLevel };
  }

  const suffixMatch = token.match(/^([a-z0-9/_.-]+?):?(?:[-:](0|1|2|3|4|off|low|mid|medium|high|xhigh))$/i);
  if (suffixMatch && !BTW_MODEL_ALIASES[lower]) {
    const thinkingLevel = parseBtwThinkingToken(suffixMatch[2]);
    if (thinkingLevel) {
      return { query: suffixMatch[1]!, thinkingLevel };
    }
  }

  return { query: token };
}

function splitBtwModelCommandArgs(args: string): { spec: string; question: string } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { spec: "", question: "" };
  }
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return { spec: trimmed, question: "" };
  }
  const firstToken = match[1]!;
  const rest = match[2]?.trim() ?? "";
  if (!rest) {
    return { spec: firstToken, question: "" };
  }

  // Keep legacy 2-token `<model> <thinkingLevel>` when there is no trailing question,
  // e.g. `/btw:model argon medium` or `/btw:model argon 2`.
  const restParts = rest.split(/\s+/);
  if (restParts.length === 1 && parseBtwThinkingToken(restParts[0])) {
    return { spec: `${firstToken} ${restParts[0]}`, question: "" };
  }

  return { spec: firstToken, question: rest };
}

function parseBtwModelArgs(args: string): ParsedBtwModelCommand {
  const trimmed = args.trim();
  if (!trimmed) {
    return { action: "show", interactive: true };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    const single = parseSingleBtwModelSpecToken(parts[0]!);
    if ("action" in single) {
      return single.action === "show" ? { action: "show", interactive: false } : { action: "clear" };
    }
    return { action: "lookup", query: single.query, thinkingLevel: single.thinkingLevel };
  }

  if (parts.length === 2) {
    const secondThinking = parseBtwThinkingToken(parts[1]);
    if (secondThinking) {
      const single = parseSingleBtwModelSpecToken(parts[0]!);
      if (!("action" in single)) {
        return { action: "lookup", query: single.query, thinkingLevel: secondThinking };
      }
    }
    return { action: "lookup", query: `${parts[0]}/${parts[1]}` };
  }

  if (parts.length === 3) {
    const [provider, id, api] = parts;
    return { action: "set", model: { provider, id, api } as BtwModelRef };
  }

  return {
    action: "invalid",
    message:
      "Usage: /btw:model [opus|sonnet|argon|flash|grok][1|2|3] [prompt] | <provider>/<model> [prompt] | clear",
  };
}

function resolveBtwModelQuery(
  ctx: ExtensionContext | ExtensionCommandContext,
  query: string,
): SessionModel | null {
  const raw = query.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  const allModels = [
    ...ctx.modelRegistry.getAvailable(),
    ...ctx.modelRegistry.getAll(),
  ];
  const uniqueModels: SessionModel[] = [];
  const seen = new Set<string>();
  for (const m of allModels) {
    const key = `${m.provider}/${m.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueModels.push(m as SessionModel);
    }
  }

  const aliasEntry = BTW_MODEL_ALIASES[lower];
  if (aliasEntry) {
    if (aliasEntry.preferredProvider) {
      const preferred = ctx.modelRegistry.find(aliasEntry.preferredProvider, aliasEntry.id);
      if (preferred) return preferred as SessionModel;
    }
    const byExactId = uniqueModels.find((m) => m.id.toLowerCase() === aliasEntry.id.toLowerCase());
    if (byExactId) return byExactId;
    const byPartial = uniqueModels.find((m) => m.id.toLowerCase().includes(lower));
    if (byPartial) return byPartial;
  }

  if (raw.includes("/")) {
    const slashIdx = raw.indexOf("/");
    const provider = raw.slice(0, slashIdx).trim();
    const modelId = raw.slice(slashIdx + 1).trim();
    const direct = ctx.modelRegistry.find(provider, modelId);
    if (direct) return direct as SessionModel;
    const caseInsensitive = uniqueModels.find(
      (m) => m.provider.toLowerCase() === provider.toLowerCase() && m.id.toLowerCase() === modelId.toLowerCase(),
    );
    if (caseInsensitive) return caseInsensitive;
  }

  return (
    uniqueModels.find((m) => m.id.toLowerCase() === lower) ??
    uniqueModels.find((m) => `${m.provider}/${m.id}`.toLowerCase() === lower) ??
    uniqueModels.find((m) => m.id.toLowerCase().startsWith(lower)) ??
    uniqueModels.find((m) => m.id.toLowerCase().includes(lower) || m.name?.toLowerCase().includes(lower)) ??
    null
  );
}

export type BtwCompletionItem = {
  value: string;
  label: string;
  description: string;
};

function getBtwModelCompletions(
  argumentPrefix: string,
  ctx?: ExtensionContext | ExtensionCommandContext | null,
): BtwCompletionItem[] {
  const prefix = argumentPrefix.trim().toLowerCase();
  const items: BtwCompletionItem[] = [
    {
      value: "clear",
      label: "clear",
      description: "Reset override — inherit main thread model & thinking",
    },
  ];

  const aliasOrder = ["flash", "argon", "opus", "sonnet", "grok", "grok-fast"] as const;
  for (const alias of aliasOrder) {
    const info = BTW_MODEL_ALIASES[alias]!;
    if (alias === "grok-fast") {
      items.push({
        value: alias,
        label: alias,
        description: `${info.label} (${info.id}) · thinking off`,
      });
      continue;
    }
    items.push({
      value: alias,
      label: alias,
      description: `${info.label} (${info.id}) · keep current thinking`,
    });
    for (const [digit, level] of [
      ["1", "low"],
      ["2", "medium"],
      ["3", "high"],
    ] as const) {
      items.push({
        value: `${alias}${digit}`,
        label: `${alias}${digit}`,
        description: `${info.label} (${info.id}) · thinking ${level}`,
      });
    }
  }

  if (ctx) {
    const knownIds = new Set(Object.values(BTW_MODEL_ALIASES).map((a) => a.id.toLowerCase()));
    for (const model of ctx.modelRegistry.getAvailable()) {
      if (knownIds.has(model.id.toLowerCase())) continue;
      const ref = `${model.provider}/${model.id}`;
      items.push({
        value: ref,
        label: ref,
        description: `${model.name || model.id} (${model.api})`,
      });
    }
  }

  if (!prefix) {
    return items;
  }

  return items.filter(
    (item) =>
      item.label.toLowerCase().startsWith(prefix) ||
      item.value.toLowerCase().startsWith(prefix) ||
      item.description.toLowerCase().includes(prefix),
  );
}

function getBtwThinkingCompletions(argumentPrefix: string): BtwCompletionItem[] {
  const prefix = argumentPrefix.trim().toLowerCase();
  const items: BtwCompletionItem[] = [
    { value: "clear", label: "clear", description: "Inherit main thread thinking level" },
    { value: "low", label: "low (1)", description: "Fast, lightweight reasoning" },
    { value: "medium", label: "medium (2)", description: "Balanced reasoning effort" },
    { value: "high", label: "high (3)", description: "Deep reasoning effort" },
    { value: "xhigh", label: "xhigh (4)", description: "Maximum reasoning effort" },
    { value: "off", label: "off (0)", description: "Disable thinking / non-reasoning" },
  ];
  if (!prefix) return items;
  return items.filter(
    (item) =>
      item.value.toLowerCase().startsWith(prefix) ||
      item.label.toLowerCase().includes(prefix) ||
      item.description.toLowerCase().includes(prefix),
  );
}

function parseBtwThinkingArgs(args: string):
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; thinkingLevel: SessionThinkingLevel } {
  const trimmed = args.trim();
  if (!trimmed || trimmed.toLowerCase() === "show") {
    return { action: "show" };
  }

  if (trimmed.toLowerCase() === "clear" || trimmed.toLowerCase() === "reset" || trimmed.toLowerCase() === "default") {
    return { action: "clear" };
  }

  const parsedToken = parseBtwThinkingToken(trimmed);
  return { action: "set", thinkingLevel: parsedToken ?? (trimmed as SessionThinkingLevel) };
}

function formatModelRef(model: Pick<SessionModel, "provider" | "id" | "api">): string {
  return `${model.provider}/${model.id} (${model.api})`;
}

/**
 * Tool surfaces keyed by BTW mode. Read-only mode exposes only pi's built-in
 * read-only tools so the child session cannot mutate the workspace; every other
 * mode matches pi's default coding-agent toolset (read/bash/edit/write).
 */
const BTW_TOOLS_BY_MODE: Record<BtwThreadMode, readonly string[]> = {
  contextual: ["read", "bash", "edit", "write"],
  tangent: ["read", "bash", "edit", "write"],
  readonly: ["read", "grep", "find", "ls"],
};

function withoutParentToolDeclarations(message: Message): Message {
  if ((message as { role: string }).role !== "system") return message;
  const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message as Message & {
    toolsAdded?: unknown;
    toolsRemoved?: unknown;
  };
  return rest as Message;
}

function buildBtwSeedState(
  ctx: ExtensionCommandContext,
  thread: BtwDetails[],
  mode: BtwThreadMode,
  sessionModel: SessionModel | null,
): { messages: Message[]; sideThreadStartIndex: number } {
  const messages: Message[] = [];

  if (mode === "contextual" || mode === "readonly") {
    try {
      messages.push(
        ...(buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as Message[]).filter(
          (message) => !isVisibleBtwMessage(message),
        ).map(withoutParentToolDeclarations),
      );
    } catch {
      messages.push(
        ...ctx.sessionManager.getEntries().flatMap((entry) => {
          if (!entry || typeof entry !== "object") {
            return [];
          }

          const message = entry as unknown as Partial<Message> & { role?: string; customType?: string; content?: unknown };
          if (typeof message.role !== "string" || !Array.isArray(message.content)) {
            return [];
          }

          return isVisibleBtwMessage({ role: message.role, customType: message.customType })
            ? []
            : [withoutParentToolDeclarations(message as Message)];
        }),
      );
    }
  }

  const sideThreadStartIndex = messages.length;

  if (thread.length > 0) {
    messages.push(
      {
        role: "user",
        content: [{ type: "text", text: BTW_CONTINUE_THREAD_USER_TEXT }],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: BTW_CONTINUE_THREAD_ASSISTANT_TEXT }],
        provider: sessionModel?.provider ?? "unknown",
        model: sessionModel?.id ?? "unknown",
        api: sessionModel?.api ?? "openai-responses",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    );

    for (const entry of thread) {
      messages.push(
        {
          role: "user",
          content: [{ type: "text", text: entry.question }],
          timestamp: entry.timestamp,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: entry.answer }],
          provider: entry.provider,
          model: entry.model,
          api: entry.api || sessionModel?.api || ctx.model?.api || "openai-responses",
          usage:
            entry.usage ?? {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          stopReason: "stop",
          timestamp: entry.timestamp,
        },
      );
    }
  }

  return {
    messages,
    sideThreadStartIndex,
  };
}

function formatToolPreview(value: unknown): string {
  if (value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const path = (value as { path?: unknown }).path;
    if (typeof path === "string") {
      return path;
    }
  }

  try {
    const preview = JSON.stringify(value);
    if (!preview || preview === "{}") {
      return "";
    }
    return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
  } catch {
    return "";
  }
}

function createEmptyTranscriptState(): BtwTranscriptState {
  return {
    entries: [],
    nextEntryId: 1,
    nextTurnId: 1,
    currentTurnId: null,
    lastTurnId: null,
    toolCalls: new Map(),
  };
}

function appendTranscriptEntry<T extends BtwTranscriptEntry>(
  state: BtwTranscriptState,
  entry: Omit<T, "id">,
): T {
  const nextEntry = { ...entry, id: state.nextEntryId++ } as T;
  state.entries.push(nextEntry);
  return nextEntry;
}

function ensureTranscriptTurn(state: BtwTranscriptState): number {
  if (state.currentTurnId !== null) {
    return state.currentTurnId;
  }

  const turnId = state.nextTurnId++;
  state.currentTurnId = turnId;
  state.lastTurnId = turnId;
  appendTranscriptEntry(state, { type: "turn-boundary", turnId, phase: "start" } as Omit<Extract<BtwTranscriptEntry, { type: "turn-boundary" }>, "id">);
  return turnId;
}

function finishTranscriptTurn(
  state: BtwTranscriptState,
  turnId?: number | null,
  outcome: BtwTurnOutcome = "completed",
): void {
  const resolvedTurnId = turnId ?? state.currentTurnId;
  if (resolvedTurnId === null || resolvedTurnId === undefined) {
    return;
  }

  const endBoundary = state.entries.find(
    (entry): entry is Extract<BtwTranscriptEntry, { type: "turn-boundary" }> =>
      entry.turnId === resolvedTurnId && entry.type === "turn-boundary" && entry.phase === "end",
  );
  if (endBoundary) {
    endBoundary.outcome = outcome;
  } else {
    appendTranscriptEntry(state, {
      type: "turn-boundary",
      turnId: resolvedTurnId,
      phase: "end",
      outcome,
    } as Omit<Extract<BtwTranscriptEntry, { type: "turn-boundary" }>, "id">);
  }

  for (const entry of state.entries) {
    if (entry.turnId !== resolvedTurnId) {
      continue;
    }

    if (entry.type === "thinking" || entry.type === "assistant-text" || entry.type === "tool-result") {
      entry.streaming = false;
    }
  }

  state.lastTurnId = resolvedTurnId;
  if (state.currentTurnId === resolvedTurnId) {
    state.currentTurnId = null;
  }
}

function findLatestTranscriptEntry<TType extends BtwTranscriptEntry["type"]>(
  state: BtwTranscriptState,
  turnId: number,
  type: TType,
): Extract<BtwTranscriptEntry, { type: TType }> | undefined {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const entry = state.entries[i];
    if (entry.turnId === turnId && entry.type === type) {
      return entry as Extract<BtwTranscriptEntry, { type: TType }>;
    }
  }

  return undefined;
}

function ensureTranscriptTurnForUserMessage(state: BtwTranscriptState): number {
  if (state.currentTurnId !== null) {
    const currentAssistant = findLatestTranscriptEntry(state, state.currentTurnId, "assistant-text");
    if (currentAssistant && !currentAssistant.streaming) {
      finishTranscriptTurn(state, state.currentTurnId);
    }
  }

  return ensureTranscriptTurn(state);
}

function extractMessageText(message: { content?: string | AssistantMessage["content"] | UserMessage["content"] }): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function upsertUserMessageEntry(state: BtwTranscriptState, turnId: number, text: string): void {
  if (!text) {
    return;
  }

  const existing = findLatestTranscriptEntry(state, turnId, "user-message");
  if (existing) {
    existing.text = text;
    return;
  }

  appendTranscriptEntry(state, { type: "user-message", turnId, text } as Omit<Extract<BtwTranscriptEntry, { type: "user-message" }>, "id">);
}

function upsertTranscriptTextEntry(
  state: BtwTranscriptState,
  turnId: number,
  type: "thinking" | "assistant-text",
  text: string,
  streaming: boolean,
): void {
  if (!text) {
    return;
  }

  const existing = findLatestTranscriptEntry(state, turnId, type);
  if (existing) {
    existing.text = text;
    existing.streaming = streaming;
    return;
  }

  appendTranscriptEntry(state, { type, turnId, text, streaming } as Omit<Extract<BtwTranscriptEntry, { type: "thinking" | "assistant-text" }>, "id">);
}

function summarizeToolResult(value: unknown, maxLength = 400): { content: string; truncated: boolean } {
  let content = "";

  if (value && typeof value === "object") {
    const toolValue = value as {
      content?: Array<{ type?: string; text?: string }>;
      error?: unknown;
      message?: unknown;
    };

    if (Array.isArray(toolValue.content)) {
      content = toolValue.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
    }

    if (!content && typeof toolValue.error === "string") {
      content = toolValue.error;
    }

    if (!content && typeof toolValue.message === "string") {
      content = toolValue.message;
    }
  }

  if (!content) {
    if (typeof value === "string") {
      content = value;
    } else if (value !== undefined) {
      try {
        content = JSON.stringify(value, null, 2);
      } catch {
        content = String(value);
      }
    }
  }

  if (!content) {
    content = "(no tool output)";
  }

  const truncated = content.length > maxLength;
  return {
    content: truncated ? `${content.slice(0, maxLength - 3)}...` : content,
    truncated,
  };
}

function ensureToolCallEntry(
  state: BtwTranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  args: string,
): { turnId: number; callEntryId: number; resultEntryId?: number } {
  const existing = state.toolCalls.get(toolCallId);
  if (existing) {
    return existing;
  }

  const callEntry = appendTranscriptEntry(state, {
    type: "tool-call",
    turnId,
    toolCallId,
    toolName,
    args,
  } as Omit<Extract<BtwTranscriptEntry, { type: "tool-call" }>, "id">);
  const record = { turnId, callEntryId: callEntry.id };
  state.toolCalls.set(toolCallId, record);
  return record;
}

function upsertToolResultEntry(
  state: BtwTranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  content: string,
  truncated: boolean,
  isError: boolean,
  streaming: boolean,
): void {
  const toolCall = ensureToolCallEntry(state, turnId, toolCallId, toolName, "");
  const existing =
    toolCall.resultEntryId !== undefined
      ? state.entries.find((entry) => entry.id === toolCall.resultEntryId && entry.type === "tool-result")
      : undefined;

  if (existing && existing.type === "tool-result") {
    existing.content = content;
    existing.truncated = truncated;
    existing.isError = isError;
    existing.streaming = streaming;
    return;
  }

  const resultEntry = appendTranscriptEntry(state, {
    type: "tool-result",
    turnId,
    toolCallId,
    toolName,
    content,
    truncated,
    isError,
    streaming,
  } as Omit<Extract<BtwTranscriptEntry, { type: "tool-result" }>, "id">);
  toolCall.resultEntryId = resultEntry.id;
}

function applyAssistantMessageToTranscript(
  state: BtwTranscriptState,
  turnId: number,
  message: AssistantMessage,
  streaming: boolean,
): void {
  const assistantMessage = message;
  const thinking = extractThinking(assistantMessage);
  const answer = extractMessageText(assistantMessage);

  if (thinking) {
    upsertTranscriptTextEntry(state, turnId, "thinking", thinking, streaming);
  }

  if (answer) {
    upsertTranscriptTextEntry(state, turnId, "assistant-text", answer, streaming);
  }
}

function applyTranscriptEvent(state: BtwTranscriptState, event: AgentSessionEvent): void {
  switch (event.type) {
    case "turn_start": {
      ensureTranscriptTurn(state);
      return;
    }
    case "message_start": {
      if (event.message.role === "user") {
        const turnId = ensureTranscriptTurnForUserMessage(state);
        upsertUserMessageEntry(state, turnId, extractMessageText(event.message));
        return;
      }

      if (event.message.role === "assistant") {
        const turnId = ensureTranscriptTurn(state);
        applyAssistantMessageToTranscript(state, turnId, event.message, true);
      }
      return;
    }
    case "message_update": {
      if (event.message.role !== "assistant") {
        return;
      }

      const turnId = ensureTranscriptTurn(state);
      applyAssistantMessageToTranscript(state, turnId, event.message, true);
      return;
    }
    case "message_end": {
      if (event.message.role === "user") {
        const turnId = ensureTranscriptTurnForUserMessage(state);
        upsertUserMessageEntry(state, turnId, extractMessageText(event.message));
        return;
      }

      if (event.message.role === "assistant") {
        const turnId = ensureTranscriptTurn(state);
        applyAssistantMessageToTranscript(state, turnId, event.message, false);
      }
      return;
    }
    case "tool_execution_start": {
      const turnId = ensureTranscriptTurn(state);
      ensureToolCallEntry(state, turnId, event.toolCallId, event.toolName, formatToolPreview(event.args));
      return;
    }
    case "tool_execution_update": {
      const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? ensureTranscriptTurn(state);
      const result = summarizeToolResult(event.partialResult);
      upsertToolResultEntry(
        state,
        turnId,
        event.toolCallId,
        event.toolName,
        result.content,
        result.truncated,
        false,
        true,
      );
      return;
    }
    case "tool_execution_end": {
      const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? ensureTranscriptTurn(state);
      const result = summarizeToolResult(event.result);
      upsertToolResultEntry(
        state,
        turnId,
        event.toolCallId,
        event.toolName,
        result.content,
        result.truncated,
        event.isError,
        false,
      );
      return;
    }
    case "turn_end": {
      const stopReason = event.message.role === "assistant" ? event.message.stopReason : "stop";
      const outcome: BtwTurnOutcome =
        stopReason === "aborted" ? "aborted" : stopReason === "error" ? "failed" : "completed";
      finishTranscriptTurn(state, undefined, outcome);
      return;
    }
    default:
      return;
  }
}

function appendPersistedTranscriptTurn(state: BtwTranscriptState, details: BtwDetails): void {
  const turnId = ensureTranscriptTurn(state);
  upsertUserMessageEntry(state, turnId, details.question);
  if (details.thinking) {
    upsertTranscriptTextEntry(state, turnId, "thinking", details.thinking, false);
  }
  upsertTranscriptTextEntry(state, turnId, "assistant-text", details.answer, false);
  finishTranscriptTurn(state, turnId);
}

function setTranscriptFailure(state: BtwTranscriptState, message: string): void {
  const turnId = state.currentTurnId ?? state.lastTurnId ?? ensureTranscriptTurn(state);
  upsertTranscriptTextEntry(state, turnId, "assistant-text", `❌ ${message}`, false);
  finishTranscriptTurn(state, turnId, "failed");
}

function hasStreamingTranscriptEntry(entries: BtwTranscript): boolean {
  return entries.some(
    (entry) =>
      (entry.type === "thinking" || entry.type === "assistant-text" || entry.type === "tool-result") &&
      entry.streaming,
  );
}

function getCompletedExchangeCount(entries: BtwTranscript): number {
  const completedTurnIds = new Set(
    entries.flatMap((entry) =>
      entry.type === "turn-boundary" &&
      entry.phase === "end" &&
      (entry.outcome === undefined || entry.outcome === "completed")
        ? [entry.turnId]
        : [],
    ),
  );
  return entries.filter(
    (entry) => entry.type === "assistant-text" && !entry.streaming && completedTurnIds.has(entry.turnId),
  ).length;
}

function buildOverlayTranscript(
  entries: BtwTranscript,
  theme: ExtensionContext["ui"]["theme"],
  markdownTheme: MarkdownTheme,
  contentWidth: number,
): string[] {
  if (entries.length === 0) {
    return [theme.fg("dim", "No BTW thread yet. Ask a side question to start one.")];
  }

  const lines: string[] = [];
  const userBadge = buildTranscriptBadge(theme, "You", "userMessageBg", "accent");
  const thinkingBadge = buildTranscriptBadge(theme, "Thinking", "toolPendingBg", "warning");
  const toolBadge = buildTranscriptBadge(theme, "Tool", "toolPendingBg", "warning");
  const assistantBadge = buildTranscriptBadge(theme, "Assistant", "customMessageBg", "success");
  const separator = theme.fg("borderMuted", "────────────────────────────────────────");
  const blockIndent = BTW_BLOCK_INDENT;
  const resultIndent = blockIndent;

  const pushBlankLine = () => {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
  };

  const pushInlineBlock = (
    header: string,
    text: string,
    options: { blankBefore?: boolean; style?: (value: string) => string } = {},
  ) => {
    const bodyLines = text.split("\n");
    const style = options.style ?? ((value: string) => value);
    if (options.blankBefore !== false) {
      pushBlankLine();
    }

    const firstLine = bodyLines.shift() ?? "";
    lines.push(`${header}${firstLine ? ` ${style(firstLine)}` : ""}`);
    for (const line of bodyLines) {
      lines.push(`${blockIndent}${style(line)}`);
    }
  };

  const pushStackedBlock = (
    header: string,
    text: string,
    options: { blankBefore?: boolean; indent?: string; style?: (value: string) => string } = {},
  ) => {
    const bodyLines = text.split("\n");
    const indent = options.indent ?? blockIndent;
    const style = options.style ?? ((value: string) => value);
    if (options.blankBefore !== false) {
      pushBlankLine();
    }

    lines.push(header);
    for (const line of bodyLines) {
      lines.push(`${indent}${style(line)}`);
    }
  };

  for (const entry of entries) {
    if (entry.type === "turn-boundary") {
      if (entry.phase === "start" && lines.length > 0) {
        pushBlankLine();
        lines.push(separator);
      }
      continue;
    }

    if (entry.type === "user-message") {
      pushInlineBlock(userBadge, entry.text, { blankBefore: false });
      continue;
    }

    if (entry.type === "queued-user-message") {
      if (lines.length > 0) {
        pushBlankLine();
        lines.push(separator);
      }
      const queuedLabel = entry.queueTotal > 1 ? `Queued #${entry.queuePosition}` : "Queued";
      const queuedBadge = buildTranscriptBadge(theme, queuedLabel, "toolPendingBg", "warning");
      const waitingHint = theme.fg("dim", "(⏳ waiting for current turn...)");
      pushStackedBlock(`${queuedBadge} ${waitingHint}`, entry.text, {
        blankBefore: false,
        style: (line) => theme.fg("dim", line),
      });
      continue;
    }

    if (entry.type === "thinking") {
      const thinkingHeader = entry.streaming ? `${thinkingBadge} ${theme.fg("warning", "▍")}` : thinkingBadge;
      const markdownLines = new Markdown(entry.text, 0, 0, markdownTheme, {
        color: (text: string) => theme.fg("warning", text),
        italic: true,
      })
        .render(Math.max(1, contentWidth))
        .map((line) => line.replace(/\s+$/u, ""));
      pushBlankLine();
      lines.push(thinkingHeader);
      for (const line of markdownLines) {
        lines.push(line ? `${blockIndent}${line}` : "");
      }
      continue;
    }

    if (entry.type === "tool-call") {
      const toolLabel = theme.fg("warning", theme.bold(entry.toolName));
      const argsLabel = entry.args ? theme.fg("dim", ` · ${entry.args}`) : "";
      pushInlineBlock(toolBadge, `${toolLabel}${argsLabel}`);
      continue;
    }

    if (entry.type === "tool-result") {
      const resultHeaderLabel = entry.isError
        ? theme.fg("error", "↳ error")
        : entry.streaming
          ? theme.fg("warning", "↳ streaming result")
          : theme.fg("dim", "↳ result");
      const truncationLabel = entry.truncated ? theme.fg("dim", " (truncated)") : "";
      pushStackedBlock(`${resultHeaderLabel}${truncationLabel}`, entry.content, {
        blankBefore: false,
        indent: resultIndent,
        style: (line) => (entry.isError ? theme.fg("error", line) : theme.fg("dim", line)),
      });
      continue;
    }

    if (entry.type === "assistant-text") {
      const assistantHeader = entry.streaming ? `${assistantBadge} ${theme.fg("warning", "▍")}` : assistantBadge;
      const markdownLines = new Markdown(entry.text, 0, 0, markdownTheme)
        .render(Math.max(1, contentWidth))
        .map((line) => line.replace(/\s+$/u, ""));
      pushBlankLine();
      lines.push(assistantHeader);
      for (const line of markdownLines) {
        lines.push(line ? `${blockIndent}${line}` : "");
      }
    }
  }

  return lines;
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
  for (let i = session.state.messages.length - 1; i >= 0; i--) {
    const message = session.state.messages[i];
    if (message.role === "assistant") {
      return message as AssistantMessage;
    }
  }

  return null;
}

type BtwHandoffExchange = {
  user: string;
  assistant: string;
};

function buildBtwMessageContent(question: string, answer: string): string {
  return `**Question**\n\n${question}\n\n**Answer**\n\n${answer}`;
}

function formatThread(thread: BtwHandoffExchange[]): string {
  return thread.map((entry) => `User: ${entry.user.trim()}\nAssistant: ${entry.assistant.trim()}`).join("\n\n---\n\n");
}

function isThreadContinuationMarker(messages: Message[], index: number): boolean {
  const userMessage = messages[index];
  const assistantMessage = messages[index + 1];
  return (
    userMessage?.role === "user" &&
    extractMessageText(userMessage) === BTW_CONTINUE_THREAD_USER_TEXT &&
    assistantMessage?.role === "assistant" &&
    extractMessageText(assistantMessage) === BTW_CONTINUE_THREAD_ASSISTANT_TEXT
  );
}

function extractBtwHandoffThread(sessionRuntime: BtwSessionRuntime): BtwHandoffExchange[] {
  const handoffMessages = sessionRuntime.session.state.messages.slice(sessionRuntime.sideThreadStartIndex);
  const threadMessages = isThreadContinuationMarker(handoffMessages as Message[], 0) ? handoffMessages.slice(2) : handoffMessages;
  const exchanges: BtwHandoffExchange[] = [];
  let currentUser = "";
  let currentAssistant = "";
  let excludeCurrent = false;

  const pushCurrent = () => {
    if (!excludeCurrent && (currentUser || currentAssistant)) {
      exchanges.push({
        user: currentUser.trim() || "(No user prompt)",
        assistant: currentAssistant.trim() || "(No assistant response)",
      });
    }
    currentUser = "";
    currentAssistant = "";
    excludeCurrent = false;
  };

  for (const message of threadMessages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    if (message.role === "user") {
      const text = extractMessageText(message).trim();
      if (!text) {
        continue;
      }
      pushCurrent();
      currentUser = text;
      continue;
    }

    if (message.stopReason === "aborted" || message.stopReason === "error") {
      excludeCurrent = true;
      continue;
    }

    const text = extractMessageText(message).trim();
    if (text) {
      currentAssistant = currentAssistant ? `${currentAssistant}\n\n${text}` : text;
    }
  }

  pushCurrent();
  return exchanges;
}

function saveVisibleBtwNote(
  pi: ExtensionAPI,
  details: BtwDetails,
  saveRequested: boolean,
  wasBusy: boolean,
): SaveState {
  if (!saveRequested) {
    return "not-saved";
  }

  const message = {
    customType: BTW_MESSAGE_TYPE,
    content: buildBtwMessageContent(details.question, details.answer),
    display: true,
    details,
  };

  if (wasBusy) {
    pi.sendMessage(message, { deliverAs: "followUp" });
    return "queued";
  }

  pi.sendMessage(message);
  return "saved";
}

function canRenderBtwOverlay(ctx: ExtensionContext | ExtensionCommandContext): boolean {
  return ctx.hasUI && ctx.mode === "tui";
}

function notifyInlineQuestionRequired(
  ctx: ExtensionCommandContext,
  command: "/btw" | "/btw:tangent" | "/btw:new" | "/btw:ask",
): void {
  notify(ctx, `${command} cannot open its composer outside Pi's TUI. Pass the question inline instead.`, "warning");
}

function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}

/** Fixed overlay rows outside the transcript viewport (must match render() structure). */
const BTW_OVERLAY_CHROME_LINES = 9;
/** Indent applied to transcript block bodies. */
const BTW_BLOCK_INDENT = "    ";

function getOverlayTitle(mode: BtwThreadMode): string {
  if (mode === "tangent") {
    return "BTW tangent";
  }
  if (mode === "readonly") {
    return "BTW ask · read-only";
  }
  return "BTW";
}

function buildTranscriptBadge(
  theme: ExtensionContext["ui"]["theme"],
  label: string,
  background: "userMessageBg" | "toolPendingBg" | "customMessageBg",
  foreground: "accent" | "warning" | "success",
): string {
  return theme.bg(background, theme.fg(foreground, theme.bold(` ${label} `)));
}

export class BtwOverlayComponent extends Container implements Focusable {
  private readonly input: Input;
  private readonly handleRawInput: (data: string) => void;
  private readonly transcript: Container;
  private readonly statusText: Text;
  private readonly modeText: Text;
  private readonly summaryText: Text;
  private readonly hintsText: Text;
  private readonly readTranscriptEntries: () => BtwTranscript;
  private readonly getStatus: () => string | null;
  private readonly getMode: () => BtwThreadMode;
  private readonly getWidthMode: () => BtwOverlayWidthMode;
  private readonly getWorkspaceLabel: () => string;
  private readonly onSubmitCallback: (value: string) => void;
  private readonly onDismissCallback: () => void;
  private readonly onUnfocusCallback: () => void;
  private readonly onToggleWidthCallback: () => void;
  private readonly onMinimizeCallback: () => void;
  private readonly onAbortCallback: () => void;
  private readonly getModelLabel: () => string;
  private readonly getOverlayContext: () => ExtensionContext | ExtensionCommandContext | null;
  private readonly tui: TUI;
  private readonly theme: ExtensionContext["ui"]["theme"];
  private readonly markdownTheme: MarkdownTheme;
  private readonly managesMouseReporting: boolean;
  private transcriptLines: string[] = [];
  private transcriptScrollOffset = 0;
  private transcriptViewportHeight = 8;
  private contentWidth = 66;
  private followTranscript = true;
  private _focused = false;
  private modeTextValue = "";
  private summaryTextValue = "";
  private statusTextValue = "";
  private hintsTextValue = "";
  private readonly keybindings: KeybindingsManager;
  private completionQuery = "";
  private completionDismissedFor: string | null = null;
  private completionItems: BtwCompletionItem[] = [];
  private completionIndex = 0;

  private syncMouseReporting(enabled: boolean): void {
    if (!this.managesMouseReporting) {
      return;
    }
    this.tui.terminal?.write?.(enabled ? "\x1b[?1000h\x1b[?1006h" : "\x1b[?1000l\x1b[?1006l");
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    if (this._focused !== value) {
      this._focused = value;
      this.syncMouseReporting(value);
    }
    this.input.focused = value;
  }

  constructor(
    tui: TUI,
    theme: ExtensionContext["ui"]["theme"],
    keybindings: KeybindingsManager,
    readTranscriptEntries: () => BtwTranscript,
    getStatus: () => string | null,
    getMode: () => BtwThreadMode,
    getWidthMode: () => BtwOverlayWidthMode,
    onSubmit: (value: string) => void,
    onDismiss: () => void,
    onUnfocus: () => void,
    onToggleWidth: () => void,
    getWorkspaceLabel: () => string = () => "local",
    onMinimize: () => void = onUnfocus,
    onAbort: () => void = onDismiss,
    getModelLabel: () => string = () => "",
    getOverlayContext: () => ExtensionContext | ExtensionCommandContext | null = () => null,
    private readonly getStaleNotice: () => string | null = () => null,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.markdownTheme = getMarkdownTheme();
    // Fullscreen Pi owns mouse reporting for the entire terminal session. In
    // regular mode BTW manages it while the overlay exists and is focused.
    this.managesMouseReporting = tui.mode !== "fullscreen";
    this.readTranscriptEntries = readTranscriptEntries;
    this.getStatus = getStatus;
    this.getMode = getMode;
    this.getWidthMode = getWidthMode;
    this.getWorkspaceLabel = getWorkspaceLabel;
    this.onSubmitCallback = onSubmit;
    this.onDismissCallback = onDismiss;
    this.onUnfocusCallback = onUnfocus;
    this.onToggleWidthCallback = onToggleWidth;
    this.onMinimizeCallback = onMinimize;
    this.onAbortCallback = onAbort;
    this.getModelLabel = getModelLabel;
    this.getOverlayContext = getOverlayContext;

    this.modeText = new Text("", 1, 0);
    this.summaryText = new Text("", 1, 0);
    this.transcript = new Container();
    this.statusText = new Text("", 1, 0);

    this.input = new Input();
    this.input.onSubmit = (value) => {
      this.followTranscript = true;
      this.onSubmitCallback(value);
    };
    this.input.onEscape = () => {
      this.onDismissCallback();
    };

    this.hintsText = new Text("", 1, 0);

    this.syncMouseReporting(true);

    const originalHandleInput = this.input.handleInput.bind(this.input);
    this.handleRawInput = originalHandleInput;
    this.input.handleInput = (data: string) => {
      if (keybindings.matches(data, "app.clear")) {
        if (this.input.getValue().length > 0) {
          this.setDraft("");
          return;
        }

        this.onAbortCallback();
        return;
      }

      if (this.handleCompletionInput(data)) return;

      if (keybindings.matches(data, "tui.select.cancel")) {
        this.onDismissCallback();
        return;
      }
      originalHandleInput(data);
      this.updateCompletions();
      this.tui.requestRender();
    };

    this.refresh();
  }

  private updateCompletions(): void {
    const value = this.input.getValue();
    if (value !== this.completionQuery) {
      this.completionQuery = value;
      this.completionIndex = 0;
      this.completionDismissedFor = null;
    }
    if (value === this.completionDismissedFor) {
      this.completionItems = [];
      return;
    }

    if (/^\/[^\s]*$/.test(value)) {
      this.completionItems = BTW_COMMANDS.filter((command) => `/${command.name}`.startsWith(value)).map((command) => ({
        value: `/${command.name} `,
        label: `/${command.name}`,
        description: command.description,
      }));
      return;
    }

    const modelArgMatch = value.match(/^\/btw:model\s+([^\s]*)$/i);
    if (modelArgMatch) {
      const argPrefix = modelArgMatch[1] ?? "";
      this.completionItems = getBtwModelCompletions(argPrefix, this.getOverlayContext()).map((item) => ({
        value: `/btw:model ${item.value}`,
        label: `/btw:model ${item.label}`,
        description: item.description,
      }));
      return;
    }

    const thinkingArgMatch = value.match(/^\/btw:thinking\s+([^\s]*)$/i);
    if (thinkingArgMatch) {
      const argPrefix = thinkingArgMatch[1] ?? "";
      this.completionItems = getBtwThinkingCompletions(argPrefix).map((item) => ({
        value: `/btw:thinking ${item.value}`,
        label: `/btw:thinking ${item.label}`,
        description: item.description,
      }));
      return;
    }

    this.completionItems = [];
  }

  private handleCompletionInput(data: string): boolean {
    this.updateCompletions();
    if (!this.completionItems.length || this.keybindings.matches(data, "app.clear")) return false;
    const currentValue = this.input.getValue().trim();
    const currentSelection = this.completionItems[this.completionIndex];
    const isExactMatch = currentSelection && currentSelection.value.trim() === currentValue;
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      this.completionIndex = (this.completionIndex + delta + this.completionItems.length) % this.completionItems.length;
    } else if (matchesKey(data, Key.tab)) {
      if (currentSelection) {
        const nextDraft = currentSelection.value.endsWith(" ")
          ? currentSelection.value
          : `${currentSelection.value} `;
        this.setDraft(nextDraft);
      }
    } else if (matchesKey(data, Key.enter) && !isExactMatch) {
      if (currentSelection) {
        this.setDraft(currentSelection.value);
      }
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.completionDismissedFor = this.input.getValue();
      this.completionItems = [];
    } else {
      return false;
    }
    this.tui.requestRender();
    return true;
  }

  private completionRows(): string[] {
    this.updateCompletions();
    const start = Math.max(0, this.completionIndex - 4);
    return this.completionItems.slice(start, start + 5).map((item, index) => {
      const selected = start + index === this.completionIndex;
      return this.theme.fg(selected ? "accent" : "dim",
        `${selected ? "→" : " "} ${item.label}  ${item.description}`);
    });
  }

  private get borderless(): boolean {
    // Full-width mode drops the vertical bars and corner glyphs so a terminal
    // Shift+drag selection captures only the dialog's own text — with side
    // borders, the leftmost/rightmost columns would land inside the drag.
    return this.getWidthMode() === "full";
  }

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    if (this.borderless) {
      return `${truncated}${" ".repeat(padding)}`;
    }
    return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
  }

  private ruleLine(innerWidth: number): string {
    if (this.borderless) {
      return this.theme.fg("border", "─".repeat(innerWidth));
    }
    return this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`);
  }

  private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    if (this.borderless) {
      return this.theme.fg("border", "─".repeat(innerWidth));
    }
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
  }

  private wrapTranscript(innerWidth: number): string[] {
    const wrapped: string[] = [];
    for (const line of this.transcriptLines) {
      if (!line) {
        wrapped.push("");
        continue;
      }
      wrapped.push(...wrapTextWithAnsi(line, Math.max(1, innerWidth)));
    }
    return wrapped;
  }

  private getDialogHeight(): number {
    const terminalRows = process.stdout.rows ?? 30;
    return Math.max(18, Math.min(32, Math.floor(terminalRows * 0.78)));
  }

  private scrollTranscript(delta: number): void {
    if (delta < 0) {
      this.followTranscript = false;
    }
    this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset + delta);
    this.tui.requestRender();
  }

  dispose(): void {
    this.syncMouseReporting(false);
  }

  private getMouseScrollDelta(data: string): number | null {
    const match = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
    if (!match) {
      return null;
    }

    const button = Number(match[1]);
    if ((button & 64) !== 64) {
      return null;
    }

    return (button & 1) === 0 ? -3 : 3;
  }

  handleInput(data: string): void {
    if (matchesBtwMinimizeShortcut(data)) {
      this.onMinimizeCallback();
      return;
    }

    if (matchesBtwFocusShortcut(data)) {
      this.onUnfocusCallback();
      return;
    }

    if (matchesBtwWidthToggle(data)) {
      this.onToggleWidthCallback();
      return;
    }

    const mouseScrollDelta = this.getMouseScrollDelta(data);
    if (mouseScrollDelta !== null) {
      this.scrollTranscript(mouseScrollDelta);
      return;
    }

    if (this.handleCompletionInput(data)) return;

    if (
      this.keybindings.matches(data, "tui.altScreen.top") ||
      matchesKey(data, "ctrl+pageup") ||
      matchesKey(data, "ctrl+home")
    ) {
      this.followTranscript = false;
      this.transcriptScrollOffset = 0;
      this.tui.requestRender();
      return;
    }

    if (
      this.keybindings.matches(data, "tui.altScreen.bottom") ||
      matchesKey(data, "ctrl+pagedown") ||
      matchesKey(data, "ctrl+end")
    ) {
      this.followTranscript = true;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.up)) {
      const step = matchesKey(data, Key.pageUp) ? Math.max(1, this.transcriptViewportHeight - 1) : 1;
      this.scrollTranscript(-step);
      return;
    }

    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.down)) {
      const step = matchesKey(data, Key.pageDown) ? Math.max(1, this.transcriptViewportHeight - 1) : 1;
      this.scrollTranscript(step);
      return;
    }

    this.input.handleInput(data);
  }

  private inputFrameLine(dialogWidth: number): string {
    const borderColumns = this.borderless ? 0 : 2;
    const targetWidth = Math.max(1, dialogWidth - borderColumns);
    const previousFocused = this.input.focused;
    // Input.render() emits CURSOR_MARKER when focused. In overlay mode that APC marker
    // can skew width/composition on this one row before the TUI strips it, producing a
    // right-edge notch and shifted border. Render the embedded input unfocused here so
    // the row stays geometrically stable while the overlay still owns keyboard input.
    this.input.focused = false;
    try {
      const renderedInputLine = this.input.render(targetWidth)[0] ?? "";
      const inputLine = truncateToWidth(renderedInputLine, targetWidth, "");
      const padding = Math.max(0, targetWidth - visibleWidth(inputLine));
      if (this.borderless) {
        return `${inputLine}${" ".repeat(padding)}`;
      }
      return `${this.theme.fg("border", "│")}${inputLine}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
    } finally {
      this.input.focused = previousFocused;
    }
  }

  private fitRenderedLine(line: string, width: number): string {
    return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
  }

  override render(width: number): string[] {
    const dialogWidth = Math.max(24, width);
    const borderColumns = this.borderless ? 0 : 2;
    const innerWidth = Math.max(22, dialogWidth - borderColumns);
    const contentWidth = Math.max(1, innerWidth - BTW_BLOCK_INDENT.length);
    if (contentWidth !== this.contentWidth) {
      this.contentWidth = contentWidth;
      this.rebuildTranscriptLines();
    }
    const transcriptLines = this.wrapTranscript(innerWidth);
    const dialogHeight = this.getDialogHeight();
    const chromeHeight = BTW_OVERLAY_CHROME_LINES;
    const completionRows = this.completionRows();
    const transcriptHeight = Math.max(1, dialogHeight - chromeHeight - completionRows.length);
    this.transcriptViewportHeight = transcriptHeight;

    const maxScroll = Math.max(0, transcriptLines.length - transcriptHeight);
    if (this.followTranscript) {
      this.transcriptScrollOffset = maxScroll;
    } else {
      this.transcriptScrollOffset = Math.max(0, Math.min(this.transcriptScrollOffset, maxScroll));
      if (this.transcriptScrollOffset >= maxScroll) {
        this.followTranscript = true;
      }
    }

    const visibleTranscript = transcriptLines.slice(
      this.transcriptScrollOffset,
      this.transcriptScrollOffset + transcriptHeight,
    );
    const transcriptPadCount = Math.max(0, transcriptHeight - visibleTranscript.length);
    const hiddenAbove = this.transcriptScrollOffset;
    const hiddenBelow = Math.max(0, maxScroll - this.transcriptScrollOffset);
    const summary =
      hiddenAbove || hiddenBelow
        ? `${this.summaryTextValue.trim()} · ↑${hiddenAbove} ↓${hiddenBelow}`
        : this.summaryTextValue.trim();

    const lines = [this.borderLine(innerWidth, "top")];

    lines.push(this.frameLine(this.theme.fg("accent", this.theme.bold(this.modeTextValue.trim())), innerWidth));
    lines.push(this.frameLine(this.theme.fg("dim", summary), innerWidth));
    lines.push(this.ruleLine(innerWidth));

    for (const line of visibleTranscript) {
      lines.push(this.frameLine(line, innerWidth));
    }
    for (let i = 0; i < transcriptPadCount; i++) {
      lines.push(this.frameLine("", innerWidth));
    }

    lines.push(this.ruleLine(innerWidth));
    lines.push(this.frameLine(this.theme.fg("warning", this.statusTextValue.trim()), innerWidth));
    for (const row of completionRows) lines.push(this.frameLine(row, innerWidth));
    lines.push(this.inputFrameLine(dialogWidth));
    lines.push(this.frameLine(this.theme.fg("dim", this.hintsTextValue.trim()), innerWidth));
    lines.push(this.borderLine(innerWidth, "bottom"));

    return lines.map((line) => this.fitRenderedLine(line, width));
  }

  setDraft(value: string): void {
    // Input.setValue preserves the cursor. Paste into an empty input so a
    // completed command leaves the cursor after its trailing space.
    this.input.setValue("");
    if (value) this.handleRawInput(`\x1b[200~${value}\x1b[201~`);
    this.updateCompletions();
    this.tui.requestRender();
  }

  getDraft(): string {
    return this.input.getValue();
  }

  getTranscriptEntries(): BtwTranscript {
    return this.readTranscriptEntries().map((entry) => ({ ...entry }));
  }

  private rebuildTranscriptLines(): void {
    this.transcriptLines = buildOverlayTranscript(
      this.readTranscriptEntries(),
      this.theme,
      this.markdownTheme,
      this.contentWidth,
    );
  }

  refresh(): void {
    const modelLabel = this.getModelLabel();
    this.modeTextValue = `${getOverlayTitle(this.getMode())}${modelLabel ? ` · ${modelLabel}` : ""} · ${this.getWorkspaceLabel()} · hidden thread preserved`;
    this.modeText.setText(this.modeTextValue);
    const entries = this.readTranscriptEntries();
    const exchanges = getCompletedExchangeCount(entries);
    const queuedCount = entries.filter((entry) => entry.type === "queued-user-message").length;
    const currentStatus = this.getStatus();
    const isStreaming =
      hasStreamingTranscriptEntry(entries) ||
      queuedCount > 0 ||
      Boolean(currentStatus?.trim().startsWith("⏳"));
    const active = isStreaming ? " · streaming" : " · idle";
    const queuedBadge = queuedCount > 0 ? ` · 📥 ${queuedCount} queued` : "";
    this.summaryTextValue = `${exchanges} exchange${exchanges === 1 ? "" : "s"}${active}${queuedBadge}`;
    this.summaryText.setText(this.summaryTextValue);

    this.rebuildTranscriptLines();
    this.transcript.clear();
    for (const line of this.transcriptLines) {
      this.transcript.addChild(new Text(line, 1, 0));
    }

    // Skip the branch scan while streaming: the notice is hidden then anyway.
    const staleNotice = currentStatus?.trim().startsWith("⏳") ? null : this.getStaleNotice();
    const baseStatus = staleNotice
      ? `${currentStatus ?? "Ready."} ${staleNotice}`
      : currentStatus ?? "Ready. Enter submits; Esc or Alt+m minimizes while working.";
    const status =
      queuedCount > 0 && !baseStatus.includes("queued")
        ? `${baseStatus} · 📥 ${queuedCount} queued`
        : baseStatus;
    this.statusTextValue = status;
    this.statusText.setText(this.statusTextValue);
    this.hintsTextValue = isStreaming
      ? `↑↓ scroll · Alt+m / Esc minimize · Ctrl+C abort · ${BTW_FOCUS_SHORTCUTS_LABEL} focus · Alt+w width`
      : `↑↓ select/scroll · Alt+m / Esc minimize · ${BTW_FOCUS_SHORTCUTS_LABEL} focus · Alt+w width · Ctrl+C (empty input) close`;
    this.hintsText.setText(this.hintsTextValue);
    this.tui.requestRender();
  }
}

export default function (pi: ExtensionAPI) {
  let pendingThread: BtwDetails[] = [];
  let pendingMode: BtwThreadMode = "contextual";
  let btwModelOverride: SessionModel | null = null;
  let btwThinkingOverride: SessionThinkingLevel | null = null;
  let transcriptState = createEmptyTranscriptState();
  let overlayStatus: string | null = null;
  let overlayDraft = "";
  let overlayWidthMode: BtwOverlayWidthMode = "window";
  let overlayMinimized = false;
  // Set when a resumed session already has BTW exchanges: show the minimized badge until the overlay opens or is dismissed.
  let restoredBadge = false;
  let pendingSubmissionsCount = 0;
  let activeBtwExecutions = 0;
  let nextQueuedPromptId = 1;
  let queuedPrompts: Array<{ id: number; question: string; generation: number }> = [];
  let overlayRuntime: OverlayRuntime | null = null;
  let lastUiContext: ExtensionContext | ExtensionCommandContext | null = null;
  let activeBtwSession: BtwSessionRuntime | null = null;
  let btwLifecycleGeneration = 0;
  let btwSubmissionQueue = Promise.resolve();
  let btwSessionCreationQueue = Promise.resolve();

  function invalidateBtwLifecycle(): void {
    btwLifecycleGeneration += 1;
    queuedPrompts = [];
  }

  function getTranscriptEntriesWithQueue(): BtwTranscript {
    if (queuedPrompts.length === 0) {
      return transcriptState.entries;
    }
    const total = queuedPrompts.length;
    return [
      ...transcriptState.entries,
      ...queuedPrompts.map((item, idx) => ({
        id: -item.id,
        turnId: -item.id,
        type: "queued-user-message" as const,
        text: item.question,
        queuePosition: idx + 1,
        queueTotal: total,
      })),
    ];
  }

  function isBtwWorking(): boolean {
    const sessionRuntime = activeBtwSession;
    return (
      (Boolean(sessionRuntime?.session.isStreaming) && !sessionRuntime?.abortPromise) ||
      pendingSubmissionsCount > 0 ||
      queuedPrompts.length > 0 ||
      hasStreamingTranscriptEntry(transcriptState.entries)
    );
  }

  function buildMinimizedStatusPreview(): string {
    const withQueueSuffix = (text: string): string =>
      queuedPrompts.length > 0 && !text.includes("queued")
        ? `${text} · 📥 ${queuedPrompts.length} queued`
        : text;
    const entries = transcriptState.entries;
    const currentTurnId = transcriptState.currentTurnId;
    if (currentTurnId !== null) {
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.turnId !== currentTurnId) {
          continue;
        }
        if (entry.type === "assistant-text" && entry.text.trim()) {
          const lastLine = entry.text
            .trim()
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .pop();
          if (lastLine) {
            const preview = lastLine.length > 56 ? `${lastLine.slice(0, 53)}...` : lastLine;
            return withQueueSuffix(`⏳ ${preview}`);
          }
        }
        if (entry.type === "tool-call") {
          return withQueueSuffix(`⏳ tool: ${entry.toolName}${entry.args ? ` · ${entry.args}` : ""}`);
        }
        if (entry.type === "thinking" && entry.streaming) {
          const lastToolLine = entry.text
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("🔧 "))
            .pop();
          if (lastToolLine) {
            const preview = lastToolLine.length > 56 ? `${lastToolLine.slice(0, 53)}...` : lastToolLine;
            return withQueueSuffix(`⏳ ${preview}`);
          }
          return withQueueSuffix("⏳ thinking...");
        }
      }
    }
    if (overlayStatus) {
      return withQueueSuffix(overlayStatus);
    }
    const exchanges = getCompletedExchangeCount(entries);
    return isBtwWorking()
      ? withQueueSuffix("⏳ working...")
      : `${exchanges} exchange${exchanges === 1 ? "" : "s"} · ready`;
  }

  function syncUi(ctx?: ExtensionContext | ExtensionCommandContext): void {
    const activeCtx = ctx ?? lastUiContext;
    if (!activeCtx?.hasUI) {
      return;
    }

    const overlayOpen = Boolean(overlayRuntime && !overlayRuntime.closed);
    if ((overlayMinimized && overlayOpen) || (restoredBadge && !overlayOpen)) {
      activeCtx.ui.setWidget("btw", (_tui, theme) => ({
        render(width: number): string[] {
          const working = isBtwWorking();
          const badge = theme.bg(
            "customMessageBg",
            theme.fg("accent", theme.bold(` ${getOverlayTitle(pendingMode)} (minimized) `)),
          );
          const statusPreview = buildMinimizedStatusPreview();
          const statusColored = working
            ? theme.fg("warning", ` ${statusPreview} `)
            : theme.fg("success", ` ${statusPreview} `);
          const stale = getBtwStaleNotice();
          const staleText = stale ? theme.fg("warning", ` ${stale} `) : "";
          const hint = `${theme.fg("dim", "· ")}${theme.fg("accent", "Alt+m")}${theme.fg("muted", " or ")}${theme.fg("accent", "/btw")}${theme.fg("muted", " to restore")}`;
          return [truncateToWidth(`${badge}${statusColored}${staleText}${hint}`, Math.max(1, width))];
        },
        invalidate() {},
      }));
    } else {
      activeCtx.ui.setWidget("btw", undefined);
    }

    overlayRuntime?.refresh?.();
  }

  function setOverlayStatus(status: string | null, ctx?: ExtensionContext | ExtensionCommandContext): void {
    overlayStatus = status;
    syncUi(ctx);
  }

  function setOverlayDraft(value: string): void {
    overlayDraft = value;
    overlayRuntime?.setDraft?.(value);
  }

  function dismissOverlay(ctx?: ExtensionContext | ExtensionCommandContext): void {
    overlayMinimized = false;
    restoredBadge = false;
    overlayRuntime?.close?.();
    overlayRuntime = null;
    syncUi(ctx);
  }

  function minimizeOverlay(ctx?: ExtensionContext | ExtensionCommandContext): void {
    const handle = overlayRuntime?.handle;
    if (!handle) {
      return;
    }

    overlayMinimized = true;
    handle.unfocus();
    handle.setHidden(true);
    syncUi(ctx);
  }

  function restoreOverlay(ctx?: ExtensionContext | ExtensionCommandContext): void {
    const handle = overlayRuntime?.handle;
    if (!handle) {
      return;
    }

    overlayMinimized = false;
    handle.setHidden(false);
    handle.focus();
    syncUi(ctx);
  }

  async function toggleOverlayMinimize(ctx?: ExtensionContext | ExtensionCommandContext): Promise<void> {
    const activeCtx = ctx ?? lastUiContext;
    const handle = overlayRuntime?.handle;
    if (handle) {
      if (overlayMinimized || handle.isHidden()) {
        restoreOverlay(activeCtx ?? undefined);
      } else {
        minimizeOverlay(activeCtx ?? undefined);
      }
      return;
    }

    if (activeCtx && (pendingThread.length > 0 || activeBtwSession || transcriptState.entries.length > 0)) {
      overlayMinimized = false;
      await ensureOverlay(activeCtx);
    }
  }

  function toggleOverlayFocus(ctx?: ExtensionContext | ExtensionCommandContext): void {
    const activeCtx = ctx ?? lastUiContext;
    const handle = overlayRuntime?.handle;
    // Focus shortcuts never restore a minimized/closed overlay; use Alt+m or /btw for that.
    if (!handle || overlayMinimized || handle.isHidden()) {
      return;
    }

    if (handle.isFocused()) {
      handle.unfocus();
    } else {
      handle.focus();
    }
    overlayRuntime?.refresh?.();
  }

  function focusOverlay(): void {
    restoreOverlay();
  }

  function getOverlayOptions(): OverlayOptions {
    const base: OverlayOptions = {
      minWidth: 72,
      maxHeight: "78%",
      anchor: "top-center",
      nonCapturing: true,
    };
    if (overlayWidthMode === "full") {
      // Edge-to-edge so a terminal Shift+drag selection captures only the
      // dialog's own text — nothing from the main screen sits beside it.
      return { ...base, width: "100%", margin: { top: 1 } };
    }
    // Framed "window" look: narrower, inset from the terminal edges.
    return { ...base, width: "78%", margin: { top: 1, left: 2, right: 2 } };
  }

  async function toggleOverlayWidth(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
    overlayWidthMode = overlayWidthMode === "window" ? "full" : "window";

    // overlayOptions is resolved once at showOverlay time, so a width change
    // requires tearing down and re-opening the overlay. The close path persists
    // the draft into overlayDraft, and ensureOverlay restores it on reopen.
    const wasFocused = overlayRuntime?.handle?.isFocused() ?? true;
    dismissOverlay(ctx);
    await ensureOverlay(ctx);
    if (!wasFocused) {
      overlayRuntime?.handle?.unfocus();
      overlayRuntime?.refresh?.();
    }
    setOverlayStatus(
      overlayWidthMode === "full"
        ? "Full-width mode. Shift+drag now selects only the dialog. Alt+w to restore the window."
        : "Window mode. Alt+w switches to full-width for clean copy selection.",
      ctx,
    );
  }

  function removeBtwSessionSubscription(sessionRuntime: BtwSessionRuntime, unsubscribe: () => void): void {
    if (!sessionRuntime.subscriptions.delete(unsubscribe)) {
      return;
    }

    try {
      unsubscribe();
    } catch {
      // Ignore unsubscribe errors during BTW session replacement/shutdown.
    }
  }

  function clearBtwSessionSubscriptions(sessionRuntime: BtwSessionRuntime): void {
    for (const unsubscribe of [...sessionRuntime.subscriptions]) {
      removeBtwSessionSubscription(sessionRuntime, unsubscribe);
    }
  }

  function handleBtwSessionEvent(
    sessionRuntime: BtwSessionRuntime,
    event: AgentSessionEvent,
    ctx?: ExtensionContext | ExtensionCommandContext,
  ): void {
    if (activeBtwSession?.session !== sessionRuntime.session || !overlayRuntime) {
      return;
    }

    applyTranscriptEvent(transcriptState, event);

    if (event.type === "tool_execution_start") {
      setOverlayStatus(`⏳ running tool: ${event.toolName}`, ctx);
      return;
    }

    if (event.type === "tool_execution_end") {
      setOverlayStatus(sessionRuntime.session.isStreaming ? `⏳ running tool: ${event.toolName}` : "⏳ streaming...", ctx);
      return;
    }

    if (event.type === "turn_end") {
      setOverlayStatus("⏳ streaming...", ctx);
      return;
    }

    if (
      event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end" ||
      event.type === "turn_start"
    ) {
      if (event.type === "message_update" && event.message.role === "assistant") {
        const thinkingText = extractThinking(event.message);
        const lastToolLine = thinkingText
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("🔧 "))
          .pop();
        if (lastToolLine) {
          setOverlayStatus(`⏳ ${lastToolLine}`, ctx);
          return;
        }
      }
      syncUi(ctx);
    }
  }

  function subscribeOverlayToActiveBtwSession(ctx?: ExtensionContext | ExtensionCommandContext): void {
    const sessionRuntime = activeBtwSession;
    if (!sessionRuntime || sessionRuntime.subscriptions.size > 0) {
      return;
    }

    const unsubscribe = sessionRuntime.session.subscribe((event: AgentSessionEvent) => {
      handleBtwSessionEvent(sessionRuntime, event, ctx);
    });
    sessionRuntime.subscriptions.add(unsubscribe);
  }

  function requestBtwSessionAbort(sessionRuntime: BtwSessionRuntime): Promise<void> {
    sessionRuntime.abortPromise ??= Promise.resolve()
      .then(() => sessionRuntime.session.abort())
      .catch(() => {
        // Ignore abort errors during BTW cancellation/replacement/shutdown.
      });
    return sessionRuntime.abortPromise;
  }

  async function disposeBtwSession(): Promise<void> {
    const current = activeBtwSession;
    activeBtwSession = null;
    if (!current) {
      return;
    }

    clearBtwSessionSubscriptions(current);
    await requestBtwSessionAbort(current);
    await disposeChildSession(current.session, current.hasExtensions, current.workspace);
  }

  async function disposeChildSession(session: AgentSession, hasExtensions: boolean, workspace?: BtwSshWorkspace): Promise<void> {
    try {
      if (hasExtensions) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      }
    } finally {
      try {
        session.dispose();
      } finally {
        await workspace?.dispose();
      }
    }
  }

  async function dismissOverlaySession(ctx?: ExtensionContext | ExtensionCommandContext): Promise<void> {
    invalidateBtwLifecycle();
    dismissOverlay(ctx);
    await disposeBtwSession();
  }

  /**
   * When BTW is actively streaming/working, Escape minimizes the overlay to the
   * compact status widget so the turn keeps running in the background and
   * automatically pops back up when finished. When idle (or already aborting),
   * Escape dismisses the overlay immediately.
   */
  async function handleOverlayEscape(ctx?: ExtensionContext | ExtensionCommandContext): Promise<void> {
    // After an abort the status says "Press Esc or Ctrl+C again to dismiss",
    // so Esc still dismisses there. Otherwise Esc minimizes, like Alt+m.
    if (overlayStatus?.startsWith("⏹")) {
      await dismissOverlaySession(ctx);
      return;
    }
    minimizeOverlay(ctx);
  }

  /**
   * Ctrl+C (when the input draft is empty) aborts an in-flight BTW request while
   * keeping the overlay open so the partial transcript remains readable, or
   * dismisses the overlay when idle.
   */
  async function dismissOrAbortOverlaySession(ctx?: ExtensionContext | ExtensionCommandContext): Promise<void> {
    const sessionRuntime = activeBtwSession;
    if ((sessionRuntime?.session.isStreaming && !sessionRuntime.abortPromise) || queuedPrompts.length > 0) {
      invalidateBtwLifecycle();
      setOverlayStatus("⏹ Aborting. Press Esc or Ctrl+C again to dismiss the BTW overlay.", ctx);
      if (sessionRuntime) {
        await requestBtwSessionAbort(sessionRuntime);
      }
      if (activeBtwSession === sessionRuntime && overlayRuntime) {
        setOverlayStatus("⏹ Aborted. Press Esc or Ctrl+C again to dismiss the BTW overlay.", ctx);
      }
      return;
    }
    await dismissOverlaySession(ctx);
  }

  async function resolveBtwModel(
    ctx: ExtensionCommandContext,
    notifyOnFallback = false,
  ): Promise<ResolvedBtwModel> {
    if (btwModelOverride) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(btwModelOverride);
      if (hasUsableModelAuth(ctx, btwModelOverride, auth)) {
        return {
          model: btwModelOverride,
          source: "override",
          configuredOverride: btwModelOverride,
        };
      }

      const fallbackReason = ctx.model
        ? `Configured BTW model ${formatModelRef(btwModelOverride)} has no credentials. Falling back to main model ${formatModelRef(
            ctx.model,
          )}.`
        : `Configured BTW model ${formatModelRef(btwModelOverride)} has no credentials, and no main model is active.`;
      if (notifyOnFallback) {
        notify(ctx, fallbackReason, "warning");
      }

      if (ctx.model) {
        return {
          model: ctx.model,
          source: "main",
          configuredOverride: btwModelOverride,
          fallbackReason,
        };
      }

      return {
        model: null,
        source: "none",
        configuredOverride: btwModelOverride,
        fallbackReason,
      };
    }

    if (ctx.model) {
      return {
        model: ctx.model,
        source: "main",
        configuredOverride: null,
      };
    }

    return {
      model: null,
      source: "none",
      configuredOverride: null,
    };
  }

  async function resolveBtwSettings(
    ctx: ExtensionCommandContext,
    notifyOnFallback = false,
  ): Promise<ResolvedBtwSettings> {
    const resolvedModel = await resolveBtwModel(ctx, notifyOnFallback);
    const thinkingLevel = btwThinkingOverride ?? (pi.getThinkingLevel() as SessionThinkingLevel);

    return {
      model: resolvedModel.model,
      modelSource: resolvedModel.source,
      configuredModelOverride: resolvedModel.configuredOverride,
      thinkingLevel,
      thinkingSource: btwThinkingOverride ? "override" : "main",
      fallbackReason: resolvedModel.fallbackReason,
    };
  }

  function describeResolvedModel(settings: ResolvedBtwSettings): string {
    if (!settings.model) {
      if (settings.configuredModelOverride && settings.fallbackReason) {
        return `BTW model unavailable. ${settings.fallbackReason}`;
      }
      return "BTW model unavailable. No active model selected.";
    }

    const source =
      settings.modelSource === "override"
        ? "override"
        : settings.configuredModelOverride
          ? "inherited fallback"
          : "inherits main thread";
    return `BTW model: ${formatModelRef(settings.model)} (${source}).${
      settings.fallbackReason ? ` ${settings.fallbackReason}` : ""
    }`;
  }

  function describeResolvedThinking(settings: ResolvedBtwSettings): string {
    const source = settings.thinkingSource === "override" ? "override" : "inherits main thread";
    return `BTW thinking: ${settings.thinkingLevel} (${source}).`;
  }

  async function setBtwModelOverride(ctx: ExtensionCommandContext, nextModel: SessionModel | null): Promise<void> {
    invalidateBtwLifecycle();
    btwModelOverride = nextModel;
    const details: BtwModelOverrideDetails = nextModel
      ? { action: "set", timestamp: Date.now(), provider: nextModel.provider, id: nextModel.id, api: nextModel.api }
      : { action: "clear", timestamp: Date.now() };
    pi.appendEntry(BTW_MODEL_OVERRIDE_TYPE, details);
    await disposeBtwSession();
    const settings = await resolveBtwSettings(ctx);
    const message = nextModel
      ? `BTW model override set to ${formatModelRef(nextModel)}.`
      : "BTW model override cleared. BTW now inherits the main thread model.";
    setOverlayStatus(message, ctx);
    notify(ctx, `${message} ${describeResolvedModel(settings)}`, "info");
  }

  async function setBtwThinkingOverride(
    ctx: ExtensionCommandContext,
    nextThinkingLevel: SessionThinkingLevel | null,
  ): Promise<void> {
    invalidateBtwLifecycle();
    btwThinkingOverride = nextThinkingLevel;
    const details: BtwThinkingOverrideDetails = nextThinkingLevel
      ? { action: "set", timestamp: Date.now(), thinkingLevel: nextThinkingLevel }
      : { action: "clear", timestamp: Date.now() };
    pi.appendEntry(BTW_THINKING_OVERRIDE_TYPE, details);
    await disposeBtwSession();
    const settings = await resolveBtwSettings(ctx);
    const message = nextThinkingLevel
      ? `BTW thinking override set to ${nextThinkingLevel}.`
      : "BTW thinking override cleared. BTW now inherits the main thread thinking level.";
    setOverlayStatus(message, ctx);
    notify(ctx, `${message} ${describeResolvedThinking(settings)}`, "info");
  }

  async function createBtwSubSession(
    ctx: ExtensionCommandContext,
    mode: BtwThreadMode,
    settings: ResolvedBtwSettings,
  ): Promise<BtwSessionRuntime> {
    if (!settings.model) {
      throw new Error(settings.fallbackReason || "No active model selected.");
    }

    const agentDir = getAgentDir();
    const sources = mode === "readonly" ? [] : await readBtwExtensionSources({
      cwd: ctx.cwd,
      agentDir,
      projectTrusted: ctx.isProjectTrusted(),
    });
    const modelRuntimeOptions = await createBtwModelRuntimeOptions(ctx, settings.model);
    const extensionResources = sources.length > 0 ? await loadBtwExtensionResources({
      cwd: ctx.cwd,
      agentDir,
      sources,
      parentExtensionPaths: [
        ...pi.getAllTools().map((tool) => tool.sourceInfo.path),
        ...pi.getCommands().flatMap((command) => command.sourceInfo ? [command.sourceInfo.path] : []),
      ],
    }) : undefined;
    const sessionManager = SessionManager.inMemory(ctx.cwd);
    const { messages: seedMessages, sideThreadStartIndex } = buildBtwSeedState(ctx, pendingThread, mode, settings.model);

    // The session manager is the source of provider context. Seed it before
    // creating the AgentSession so its initial context includes these messages.
    for (const message of seedMessages) {
      sessionManager.appendMessage(message);
    }

    const builtinTools = BTW_TOOLS_BY_MODE[mode];
    const workspaceMode = await readBtwWorkspaceMode({ cwd: ctx.cwd, agentDir, projectTrusted: ctx.isProjectTrusted() });
    const workspace = workspaceMode === "ssh" ? await createBtwSshWorkspace(pi, ctx, mode === "readonly") : undefined;
    const workspaceIdentity = workspace?.identity ?? `local:${ctx.cwd}`;
    if (pendingThread.some((entry) => (entry.workspaceIdentity ?? `local:${ctx.cwd}`) !== workspaceIdentity)) {
      await workspace?.dispose();
      throw new Error("BTW workspace differs from its saved thread. Run /btw:clear before continuing.");
    }
    let childSession: AgentSession | undefined;
    const sessionOptions: CreateAgentSessionOptions = {
      cwd: ctx.cwd,
      sessionManager,
      model: settings.model,
      ...modelRuntimeOptions,
      thinkingLevel: settings.thinkingLevel,
      ...(workspace ? { customTools: workspace.tools } : {}),
      // Extension sessions need a live registry for tools registered at startup
      // or later. Read-only sessions keep the structural built-in allowlist.
      ...(extensionResources ? { noTools: "builtin" as const } : { tools: [...builtinTools] }),
      resourceLoader: createBtwResourceLoader(
        ctx, () => childSession?.getActiveToolNames() ?? builtinTools, [BTW_SYSTEM_PROMPT], extensionResources, workspace?.label,
      ),
    };
    let created: Awaited<ReturnType<typeof createAgentSession>>;
    try {
      created = await createAgentSession(sessionOptions);
    } catch (error) {
      await workspace?.dispose();
      throw error;
    }
    const { session, extensionsResult } = created;
    childSession = session;
    const hasExtensions = !!extensionResources;
    if (hasExtensions) {
      try {
        if (extensionsResult.errors.length > 0) {
          throw new Error(extensionsResult.errors.map((error) => `${error.path}: ${error.error}`).join("\n"));
        }
        const collectToolNames = () => {
          const builtinNames = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);
          const extensionNames = new Set<string>();
          for (const extension of extensionsResult.extensions) {
            for (const name of extension.tools.keys()) {
              if (builtinNames.has(name) || extensionNames.has(name)) {
                throw new Error(`BTW extension tool name collision: ${name}.`);
              }
              extensionNames.add(name);
            }
          }
          return [...extensionNames];
        };
        session.setActiveToolsByName([...builtinTools, ...collectToolNames()]);
        const startupErrors: string[] = [];
        let starting = true;
        await session.bindExtensions({
          onError: (error) => {
            const message = `${error.extensionPath}: ${error.error}`;
            if (starting) startupErrors.push(message);
            else notify(ctx, `BTW extension error: ${message}`, "error");
          },
        });
        starting = false;
        if (startupErrors.length > 0) throw new Error(startupErrors.join("\n"));
        collectToolNames();
      } catch (error) {
        try {
          await session.abort();
        } finally {
          await disposeChildSession(session, true, workspace);
        }
        throw error;
      }
    }

    return { session, mode, subscriptions: new Set(), sideThreadStartIndex, promptQueue: Promise.resolve(), hasExtensions, workspace, workspaceIdentity, mainTurnsAtSeed: countMainUserTurns(ctx) };
  }

  /** Notice when the BTW child's seeded main context is several user turns behind the main session. */
  function getBtwStaleNotice(): string | null {
    const runtime = activeBtwSession;
    const ctx = lastUiContext;
    if (!runtime || !ctx || runtime.mode === "tangent") return null;
    const behind = countMainUserTurns(ctx) - runtime.mainTurnsAtSeed;
    if (behind < BTW_STALE_TURNS) return null;
    return `⚠ BTW context is ${behind} main-chat turns behind · /btw:new to refresh or /btw:clear to reset`;
  }

  function ensureBtwSession(ctx: ExtensionCommandContext, mode: BtwThreadMode): Promise<BtwSessionRuntime | null> {
    const generation = btwLifecycleGeneration;
    // Composer-only commands can overlap while npm resolution is in flight.
    // Serialize creation so they reuse one child and never race package installs.
    const creation = btwSessionCreationQueue.then(() => createOrReuseBtwSession(ctx, mode, generation));
    btwSessionCreationQueue = creation.then(() => {}, () => {});
    return creation;
  }

  async function createOrReuseBtwSession(
    ctx: ExtensionCommandContext,
    mode: BtwThreadMode,
    generation: number,
  ): Promise<BtwSessionRuntime | null> {
    if (generation !== btwLifecycleGeneration) return null;
    const settings = await resolveBtwSettings(ctx, true);
    if (generation !== btwLifecycleGeneration || !settings.model) {
      return null;
    }

    if (activeBtwSession?.mode === mode) {
      try {
        activeBtwSession.workspace?.assertCurrent();
        return activeBtwSession;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setOverlayStatus(message, ctx);
        notify(ctx, message, "error");
        return null;
      }
    }

    await disposeBtwSession();
    if (generation !== btwLifecycleGeneration) return null;
    try {
      const created = await createBtwSubSession(ctx, mode, settings);
      if (generation !== btwLifecycleGeneration) {
        await requestBtwSessionAbort(created);
        await disposeChildSession(created.session, created.hasExtensions, created.workspace);
        return null;
      }
      activeBtwSession = created;
    } catch (error) {
      if (generation !== btwLifecycleGeneration) return null;
      const message = `Could not start BTW session: ${error instanceof Error ? error.message : String(error)}`;
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      return null;
    }
    return activeBtwSession;
  }

  function getActiveBtwModelBadge(): string {
    const model = btwModelOverride ?? lastUiContext?.model ?? null;
    const thinking = btwThinkingOverride ?? (pi.getThinkingLevel() as SessionThinkingLevel);
    if (!model) {
      return "";
    }
    const isOverridden = Boolean(btwModelOverride || btwThinkingOverride);
    return `${model.id} (${thinking}${isOverridden ? "*" : ""})`;
  }

  async function applyBtwModelSpec(ctx: ExtensionCommandContext, spec: string): Promise<boolean> {
    const parsed = parseBtwModelArgs(spec);
    if (parsed.action === "invalid" || parsed.action === "show") {
      const msg = parsed.action === "invalid" ? parsed.message : "Invalid model specification.";
      setOverlayStatus(msg, ctx);
      notify(ctx, msg, "error");
      return false;
    }

    if (parsed.action === "clear") {
      if (btwThinkingOverride !== null) {
        btwThinkingOverride = null;
        pi.appendEntry(BTW_THINKING_OVERRIDE_TYPE, { action: "clear", timestamp: Date.now() });
      }
      await setBtwModelOverride(ctx, null);
      return true;
    }

    let resolved: SessionModel | null = null;
    let thinkingLevel: SessionThinkingLevel | undefined;

    if (parsed.action === "set") {
      resolved = (ctx.modelRegistry.find(parsed.model.provider, parsed.model.id) as SessionModel | undefined) ?? null;
      thinkingLevel = parsed.thinkingLevel;
    } else if (parsed.action === "lookup") {
      resolved = resolveBtwModelQuery(ctx, parsed.query);
      thinkingLevel = parsed.thinkingLevel;
    }

    if (!resolved) {
      const target = parsed.action === "set" ? `${parsed.model.provider}/${parsed.model.id}` : parsed.query;
      const message = `Unknown model "${target}". Try: flash1..3, argon1..3, opus1..3, sonnet1..3, grok, or clear.`;
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      return false;
    }

    if (thinkingLevel !== undefined) {
      btwThinkingOverride = thinkingLevel;
      const thinkingDetails: BtwThinkingOverrideDetails = {
        action: "set",
        timestamp: Date.now(),
        thinkingLevel,
      };
      pi.appendEntry(BTW_THINKING_OVERRIDE_TYPE, thinkingDetails);
    }

    await setBtwModelOverride(ctx, resolved);
    return true;
  }

  async function ensureOverlay(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
    if (!canRenderBtwOverlay(ctx)) {
      return;
    }
    lastUiContext = ctx;
    restoredBadge = false;

    if (overlayRuntime?.handle) {
      subscribeOverlayToActiveBtwSession(ctx);
      focusOverlay();
      return;
    }

    let resolveHandleReady!: () => void;
    const handleReady = new Promise<void>((resolve) => {
      resolveHandleReady = resolve;
    });

    const runtime: OverlayRuntime = {};
    const closeRuntime = () => {
      resolveHandleReady();
      if (runtime.closed) {
        return;
      }
      runtime.closed = true;
      if (activeBtwSession) {
        clearBtwSessionSubscriptions(activeBtwSession);
      }
      if (overlayRuntime === runtime) {
        overlayRuntime = null;
      }
      runtime.finish?.();
    };

    runtime.close = closeRuntime;
    overlayRuntime = runtime;

    void ctx.ui
      .custom<void>(
        async (tui, theme, keybindings, done) => {
          runtime.finish = () => {
            done();
          };

          const overlay = new BtwOverlayComponent(
            tui,
            theme,
            keybindings,
            () => getTranscriptEntriesWithQueue(),
            () => overlayStatus,
            () => pendingMode,
            () => overlayWidthMode,
            (value) => {
              void submitFromOverlay(ctx, value);
            },
            () => {
              void handleOverlayEscape(ctx);
            },
            () => {
              overlayRuntime?.handle?.unfocus();
              overlayRuntime?.refresh?.();
            },
            () => {
              void toggleOverlayWidth(ctx);
            },
            () => activeBtwSession?.workspace?.label ?? "local",
            () => {
              minimizeOverlay(ctx);
            },
            () => {
              void dismissOrAbortOverlaySession(ctx);
            },
            () => getActiveBtwModelBadge(),
            () => lastUiContext ?? ctx,
            () => getBtwStaleNotice(),
          );

          overlay.focused = runtime.handle?.isFocused() ?? true;
          overlay.setDraft(overlayDraft);
          runtime.setDraft = (value) => {
            overlay.setDraft(value);
          };
          runtime.refresh = () => {
            overlay.focused = runtime.handle?.isFocused() ?? false;
            overlay.refresh();
          };
          runtime.close = () => {
            overlayDraft = overlay.getDraft();
            closeRuntime();
          };

          subscribeOverlayToActiveBtwSession(ctx);

          if (runtime.closed) {
            done();
          }

          return overlay;
        },
        {
          overlay: true,
          overlayOptions: getOverlayOptions(),
          onHandle: (handle) => {
            runtime.handle = handle;
            if (overlayMinimized) {
              handle.unfocus();
              handle.setHidden(true);
            } else {
              handle.focus();
            }
            resolveHandleReady();
            if (runtime.closed) {
              closeRuntime();
            }
          },
        },
      )
      .catch((error) => {
        resolveHandleReady();
        if (overlayRuntime === runtime) {
          overlayRuntime = null;
        }
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      });

    await handleReady;
  }

  async function dispatchBtwCommand(name: string, args: string, ctx: ExtensionCommandContext): Promise<boolean> {
    const trimmedArgs = args.trim();

    if (name === "btw") {
      const { question, save, modelSpec } = parseBtwArgs(trimmedArgs);
      if (modelSpec && !(await applyBtwModelSpec(ctx, modelSpec))) {
        return true;
      }
      if (!question) {
        if (!canRenderBtwOverlay(ctx)) {
          notifyInlineQuestionRequired(ctx, "/btw");
          return true;
        }
        overlayMinimized = false;
        await ensureBtwSession(ctx, pendingMode);
        await ensureOverlay(ctx);
        return true;
      }

      if (pendingMode !== "contextual") {
        await resetThread(ctx, true, "contextual");
      }

      await runBtw(ctx, question, save, "contextual");
      return true;
    }

    if (name === "btw:tangent") {
      const { question, save, modelSpec } = parseBtwArgs(trimmedArgs);
      if (modelSpec && !(await applyBtwModelSpec(ctx, modelSpec))) {
        return true;
      }
      if (!question && !canRenderBtwOverlay(ctx)) {
        notifyInlineQuestionRequired(ctx, "/btw:tangent");
        return true;
      }
      if (pendingMode !== "tangent") {
        await resetThread(ctx, true, "tangent");
      }

      if (!question) {
        overlayMinimized = false;
        await ensureBtwSession(ctx, "tangent");
        await ensureOverlay(ctx);
        return true;
      }

      await runBtw(ctx, question, save, "tangent");
      return true;
    }

    if (name === "btw:ask") {
      const { question, save, modelSpec } = parseBtwArgs(trimmedArgs);
      if (modelSpec && !(await applyBtwModelSpec(ctx, modelSpec))) {
        return true;
      }
      if (!question && !canRenderBtwOverlay(ctx)) {
        notifyInlineQuestionRequired(ctx, "/btw:ask");
        return true;
      }

      // Read-only mode is a distinct capability boundary, so switching into it
      // resets the thread and lets ensureBtwSession recreate the child session.
      if (pendingMode !== "readonly") {
        await resetThread(ctx, true, "readonly");
      }

      if (!question) {
        overlayMinimized = false;
        await ensureBtwSession(ctx, "readonly");
        await ensureOverlay(ctx);
        return true;
      }

      await runBtw(ctx, question, save, "readonly");
      return true;
    }

    if (name === "btw:new") {
      const { question, save, modelSpec } = parseBtwArgs(trimmedArgs);
      if (modelSpec && !(await applyBtwModelSpec(ctx, modelSpec))) {
        return true;
      }
      if (!question && !canRenderBtwOverlay(ctx)) {
        notifyInlineQuestionRequired(ctx, "/btw:new");
        return true;
      }

      await resetThread(ctx, true, "contextual");
      if (question) {
        await runBtw(ctx, question, save, "contextual");
      } else {
        overlayMinimized = false;
        await ensureBtwSession(ctx, "contextual");
        setOverlayStatus("Started a fresh BTW thread.", ctx);
        await ensureOverlay(ctx);
        notify(ctx, "Started a fresh BTW thread.", "info");
      }
      return true;
    }

    if (name === "btw:minimize") {
      await toggleOverlayMinimize(ctx);
      return true;
    }

    if (name === "btw:clear") {
      await resetThread(ctx);
      dismissOverlay(ctx);
      notify(ctx, "Cleared BTW thread.", "info");
      return true;
    }

    if (name === "btw:copy") {
      let latest: string | undefined;
      for (let i = transcriptState.entries.length - 1; i >= 0; i--) {
        const entry = transcriptState.entries[i];
        if (entry.type === "assistant-text" && entry.text.trim() && !entry.text.startsWith("❌")) {
          latest = entry.text.trim();
          break;
        }
      }
      if (!latest) {
        setOverlayStatus("No BTW message to copy yet.", ctx);
        notify(ctx, "No BTW message to copy yet.", "warning");
        return true;
      }
      try {
        await copyToClipboard(latest);
        const msg = `Copied latest BTW message (${latest.length} chars).`;
        setOverlayStatus(msg, ctx);
        notify(ctx, msg, "info");
      } catch (error) {
        const msg = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
        setOverlayStatus(msg, ctx);
        notify(ctx, msg, "error");
      }
      return true;
    }

    if (name === "btw:model") {
      const { spec, question } = splitBtwModelCommandArgs(trimmedArgs);
      const parsed = parseBtwModelArgs(spec);
      if (parsed.action === "invalid") {
        setOverlayStatus(parsed.message, ctx);
        notify(ctx, parsed.message, "error");
        return true;
      }

      if (parsed.action === "show" && !question) {
        const settings = await resolveBtwSettings(ctx);
        const message = `${describeResolvedModel(settings)} ${describeResolvedThinking(settings)}`;
        if (parsed.interactive && ctx.hasUI && !overlayRuntime?.handle) {
          const completions = getBtwModelCompletions("", ctx);
          const options = completions.map((item) => `${item.label} — ${item.description}`);
          const selected = await ctx.ui.select(`Select BTW model (${message})`, options);
          if (selected) {
            const idx = options.indexOf(selected);
            const chosen = completions[idx];
            if (chosen) {
              await applyBtwModelSpec(ctx, chosen.value);
            }
          }
          return true;
        }
        setOverlayStatus(message, ctx);
        notify(ctx, message, settings.model ? "info" : "warning");
        return true;
      }

      if (!(await applyBtwModelSpec(ctx, spec))) {
        return true;
      }
      if (question) {
        await runBtw(ctx, question, false, pendingMode);
      }
      return true;
    }

    if (name === "btw:thinking") {
      const match = trimmedArgs.match(/^(\S+)(?:\s+([\s\S]*))?$/);
      const levelArg = match?.[1] ?? "";
      const question = match?.[2]?.trim() ?? "";
      const parsed = parseBtwThinkingArgs(levelArg);
      if (parsed.action === "show" && !question) {
        const settings = await resolveBtwSettings(ctx);
        const message = describeResolvedThinking(settings);
        setOverlayStatus(message, ctx);
        notify(ctx, message, "info");
        return true;
      }

      await setBtwThinkingOverride(ctx, parsed.action === "clear" ? null : parsed.action === "set" ? parsed.thinkingLevel : null);
      if (question) {
        await runBtw(ctx, question, false, pendingMode);
      }
      return true;
    }

    if (name === "btw:inject") {
      await btwSubmissionQueue;
      if (pendingThread.length === 0) {
        notify(ctx, "No BTW thread to inject.", "warning");
        return true;
      }

      setOverlayStatus("⏳ injecting into the main session...", ctx);
      await ensureOverlay(ctx);

      try {
        const { thread } = await getBtwHandoffThread(ctx);
        const instructions = trimmedArgs;
        const content = instructions
          ? `Here is a side conversation I had. ${instructions}\n\n${formatThread(thread)}`
          : `Here is a side conversation I had for additional context:\n\n${formatThread(thread)}`;

        sendThreadToMain(ctx, content);
        const count = thread.length;
        await resetThread(ctx);
        dismissOverlay();
        notify(ctx, `Injected BTW thread (${count} exchange${count === 1 ? "" : "s"}).`, "info");
      } catch (error) {
        setOverlayStatus("Inject failed. Thread preserved for retry or summarize.", ctx);
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    if (name === "btw:summarize") {
      await btwSubmissionQueue;
      if (pendingThread.length === 0) {
        notify(ctx, "No BTW thread to summarize.", "warning");
        return true;
      }

      setOverlayStatus("⏳ summarizing...", ctx);
      await ensureOverlay(ctx);

      try {
        const { thread } = await getBtwHandoffThread(ctx);
        const summary = await summarizeThread(ctx, thread);
        const instructions = trimmedArgs;
        const content = instructions
          ? `Here is a summary of a side conversation I had. ${instructions}\n\n${summary}`
          : `Here is a summary of a side conversation I had:\n\n${summary}`;

        sendThreadToMain(ctx, content);
        const count = thread.length;
        await resetThread(ctx);
        dismissOverlay();
        notify(ctx, `Injected BTW summary (${count} exchange${count === 1 ? "" : "s"}).`, "info");
      } catch (error) {
        setOverlayStatus("Summarize failed. Thread preserved for retry or injection.", ctx);
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    return false;
  }

  function parseOverlayBtwCommand(value: string): { name: string; args: string } | null {
    const trimmed = value.trim();
    const match = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    if (!match || !BTW_COMMANDS.some((command) => command.name === match[1])) {
      return null;
    }

    return {
      name: match[1] === "side" ? "btw" : match[1],
      args: match[2]?.trim() ?? "",
    };
  }

  async function submitFromOverlay(ctx: ExtensionCommandContext | ExtensionContext, value: string): Promise<void> {
    const question = value.trim();
    if (!question) {
      setOverlayStatus("Enter a BTW prompt before submitting.", ctx);
      return;
    }

    if (!("getSystemPrompt" in ctx)) {
      setOverlayStatus("BTW overlay submit requires a command context. Reopen BTW from a command.", ctx);
      return;
    }

    const cmdCtx = ctx as ExtensionCommandContext;
    const btwCommand = parseOverlayBtwCommand(question);
    if (btwCommand) {
      setOverlayDraft("");
      await dispatchBtwCommand(btwCommand.name, btwCommand.args, cmdCtx);
      return;
    }

    setOverlayDraft("");
    await runBtw(cmdCtx, question, false, pendingMode);
  }

  async function resetThread(
    ctx: ExtensionContext | ExtensionCommandContext,
    persist = true,
    mode: BtwThreadMode = "contextual",
  ): Promise<void> {
    invalidateBtwLifecycle();
    await disposeBtwSession();
    pendingThread = [];
    pendingMode = mode;
    transcriptState = createEmptyTranscriptState();
    setOverlayDraft("");
    setOverlayStatus(null, ctx);
    if (persist) {
      const details: BtwResetDetails = { timestamp: Date.now(), mode };
      pi.appendEntry(BTW_RESET_TYPE, details);
    }
    syncUi(ctx);
  }

  async function restoreThread(ctx: ExtensionContext): Promise<void> {
    invalidateBtwLifecycle();
    await disposeBtwSession();
    pendingThread = [];
    pendingMode = "contextual";
    btwModelOverride = null;
    btwThinkingOverride = null;
    transcriptState = createEmptyTranscriptState();
    overlayDraft = "";
    lastUiContext = ctx;
    overlayStatus = null;

    const branch = ctx.sessionManager.getBranch();
    let lastResetIndex = -1;

    for (let i = 0; i < branch.length; i++) {
      if (isCustomEntry(branch[i], BTW_MODEL_OVERRIDE_TYPE)) {
        const details = (branch[i] as unknown as { data?: BtwModelOverrideDetails }).data;
        if (details?.action === "set") {
          const resolved = ctx.modelRegistry.find(details.provider, details.id);
          if (resolved) {
            btwModelOverride = resolved;
          } else {
            // Configured override is no longer in the registry; drop it on restore.
            btwModelOverride = null;
          }
        } else if (details?.action === "clear") {
          btwModelOverride = null;
        }
      }

      if (isCustomEntry(branch[i], BTW_THINKING_OVERRIDE_TYPE)) {
        const details = (branch[i] as unknown as { data?: BtwThinkingOverrideDetails }).data;
        btwThinkingOverride =
          details?.action === "set"
            ? details.thinkingLevel
            : details?.action === "clear"
              ? null
              : btwThinkingOverride;
      }

      if (isCustomEntry(branch[i], BTW_RESET_TYPE)) {
        lastResetIndex = i;
        const details = (branch[i] as unknown as { data?: BtwResetDetails }).data;
        pendingMode = details?.mode ?? "contextual";
      }
    }

    for (const entry of branch.slice(lastResetIndex + 1)) {
      if (!isCustomEntry(entry, BTW_ENTRY_TYPE)) {
        continue;
      }

      const details = (entry as unknown as { data?: BtwDetails }).data;
      if (!details?.question || !details.answer) {
        continue;
      }

      const normalizedDetails: BtwDetails = {
        ...details,
        api: details.api || ctx.model?.api || "openai-responses",
      };

      pendingThread.push(normalizedDetails);
      appendPersistedTranscriptTurn(transcriptState, normalizedDetails);
    }

    restoredBadge = pendingThread.length > 0 && !overlayRuntime;
    syncUi(ctx);
  }

  async function runBtw(
    ctx: ExtensionCommandContext,
    question: string,
    saveRequested: boolean,
    mode: BtwThreadMode,
  ): Promise<void> {
    const generation = btwLifecycleGeneration;
    const shouldQueue =
      activeBtwExecutions > 0 ||
      queuedPrompts.length > 0 ||
      Boolean(activeBtwSession?.session.isStreaming);
    const queuedId = shouldQueue ? nextQueuedPromptId++ : null;
    if (queuedId !== null) {
      queuedPrompts.push({ id: queuedId, question, generation });
    }
    const dequeuePrompt = () => {
      if (queuedId === null) {
        return;
      }
      const next = queuedPrompts.filter((item) => item.id !== queuedId);
      if (next.length !== queuedPrompts.length) {
        queuedPrompts = next;
        syncUi(ctx);
      }
    };

    pendingSubmissionsCount += 1;
    const submission = btwSubmissionQueue.then(async () => {
      activeBtwExecutions += 1;
      try {
        if (generation !== btwLifecycleGeneration) {
          dequeuePrompt();
          return;
        }
        await executeBtw(ctx, question, saveRequested, mode, generation, dequeuePrompt);
      } finally {
        dequeuePrompt();
        activeBtwExecutions = Math.max(0, activeBtwExecutions - 1);
        pendingSubmissionsCount = Math.max(0, pendingSubmissionsCount - 1);
        if (generation === btwLifecycleGeneration && pendingSubmissionsCount === 0 && overlayMinimized && overlayRuntime?.handle) {
          const mainEditorHasDraft = Boolean(ctx.ui?.getEditorText?.()?.trim());
          if (ctx.isIdle() && !mainEditorHasDraft) {
            restoreOverlay(ctx);
          } else {
            syncUi(ctx);
          }
        } else {
          syncUi(ctx);
        }
      }
    });
    btwSubmissionQueue = submission.catch(() => {});
    if (canRenderBtwOverlay(ctx)) {
      if (!shouldQueue || !overlayStatus) {
        setOverlayStatus("⏳ streaming...", ctx);
      }
      if (!overlayMinimized || !overlayRuntime?.handle) {
        await ensureOverlay(ctx);
      }
      syncUi(ctx);
      return;
    }
    await submission;
  }

  async function executeBtw(
    ctx: ExtensionCommandContext,
    question: string,
    saveRequested: boolean,
    mode: BtwThreadMode,
    generation: number,
    onPromptStarting?: () => void,
  ): Promise<void> {
    const isCurrentGeneration = () => generation === btwLifecycleGeneration;
    lastUiContext = ctx;
    const settings = await resolveBtwSettings(ctx);
    if (!isCurrentGeneration()) {
      return;
    }
    const model = settings.model;
    if (!model) {
      const message = settings.fallbackReason || "No active model selected.";
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      return;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!isCurrentGeneration()) {
      return;
    }
    if (!hasUsableModelAuth(ctx, model, auth)) {
      const message = auth.ok ? `No credentials available for ${model.provider}/${model.id}.` : auth.error;
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      await ensureOverlay(ctx);
      return;
    }

    const sessionRuntime = await ensureBtwSession(ctx, mode);
    if (!isCurrentGeneration()) {
      if (sessionRuntime && activeBtwSession === sessionRuntime) {
        await disposeBtwSession();
      }
      return;
    }
    if (!sessionRuntime) {
      return;
    }
    subscribeOverlayToActiveBtwSession(ctx);

    const session = sessionRuntime.session;
    const wasBusy = !ctx.isIdle();
    const overlayAvailable = canRenderBtwOverlay(ctx);
    pendingMode = mode;
    const thinkingLevel = settings.thinkingLevel;

    let releasePromptTurn!: () => void;
    const previousPromptTurns = sessionRuntime.promptQueue;
    const currentPromptTurn = new Promise<void>((resolve) => {
      releasePromptTurn = resolve;
    });
    sessionRuntime.promptQueue = previousPromptTurns.then(() => currentPromptTurn);

    if (session.isStreaming || sessionRuntime.abortPromise) {
      setOverlayStatus("⏳ waiting for the current BTW turn to finish...", ctx);
    }
    await previousPromptTurns;
    if (activeBtwSession !== sessionRuntime) {
      releasePromptTurn();
      return;
    }

    if (sessionRuntime.abortPromise) {
      setOverlayStatus("⏳ waiting for cancellation to finish...", ctx);
      await sessionRuntime.abortPromise;
      if (activeBtwSession !== sessionRuntime) {
        releasePromptTurn();
        return;
      }
    }

    if (!isCurrentGeneration()) {
      releasePromptTurn();
      return;
    }

    sessionRuntime.abortPromise = undefined;
    onPromptStarting?.();
    setOverlayStatus("⏳ streaming...", ctx);
    if (!overlayMinimized || !overlayRuntime?.handle) {
      await ensureOverlay(ctx);
    }

    try {
      sessionRuntime.workspace?.assertCurrent();
      await session.prompt(question, { source: "extension" });
      if (!isCurrentGeneration()) {
        return;
      }

      const response = getLastAssistantMessage(session);
      if (!response) {
        throw new Error("BTW request finished without a response.");
      }
      if (response.stopReason === "aborted") {
        const abortedTurnId = transcriptState.currentTurnId ?? transcriptState.lastTurnId;
        finishTranscriptTurn(transcriptState, abortedTurnId, "aborted");
        setOverlayStatus("⏹ Aborted. Press Esc or Ctrl+C again to dismiss the BTW overlay.", ctx);
        return;
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "BTW request failed.");
      }

      const completedTurnId = transcriptState.lastTurnId ?? transcriptState.currentTurnId;
      const streamedThinking =
        completedTurnId !== null ? findLatestTranscriptEntry(transcriptState, completedTurnId, "thinking")?.text : "";
      const answer = extractAnswer(response);
      const thinking = extractThinking(response) || streamedThinking || "";

      const details: BtwDetails = {
        question,
        thinking,
        answer,
        provider: model.provider,
        model: model.id,
        api: model.api,
        thinkingLevel,
        timestamp: Date.now(),
        usage: response.usage,
        workspaceIdentity: sessionRuntime.workspaceIdentity,
      };

      pendingThread.push(details);
      pi.appendEntry(BTW_ENTRY_TYPE, details);

      const saveState = saveVisibleBtwNote(pi, details, saveRequested || !overlayAvailable, wasBusy);
      if (!overlayAvailable) {
        const message =
          saveState === "queued"
            ? "BTW response queued to display after the current turn finishes."
            : "Displayed BTW response in the session.";
        notify(ctx, message, "info");
        setOverlayStatus(message, ctx);
      } else if (saveState === "saved") {
        notify(ctx, "Saved BTW note to the session.", "info");
        setOverlayStatus("Saved BTW note to the session.", ctx);
      } else if (saveState === "queued") {
        notify(ctx, "BTW note queued to save after the current turn finishes.", "info");
        setOverlayStatus("BTW note queued to save after the current turn finishes.", ctx);
      } else {
        setOverlayStatus("Ready for a follow-up. Hidden BTW thread updated.", ctx);
      }
    } catch (error) {
      if (!isCurrentGeneration()) {
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      setTranscriptFailure(transcriptState, errorMessage);
      setOverlayStatus("Request failed. Thread preserved for retry or follow-up.", ctx);
      notify(ctx, errorMessage, "error");
      await disposeBtwSession();
    } finally {
      releasePromptTurn();
      syncUi(ctx);
    }
  }

  function getPendingThreadForHandoff(): BtwHandoffExchange[] {
    return pendingThread.map((entry) => ({ user: entry.question, assistant: entry.answer }));
  }

  async function getBtwHandoffThread(
    ctx: ExtensionCommandContext,
  ): Promise<{ sessionRuntime: BtwSessionRuntime | null; thread: BtwHandoffExchange[] }> {
    const pendingSubmissions = btwSubmissionQueue;
    await pendingSubmissions;

    const sessionRuntime = activeBtwSession ?? (await ensureBtwSession(ctx, pendingMode));
    if (sessionRuntime) {
      const pendingPromptTurns = sessionRuntime.promptQueue;
      const pendingAbort = sessionRuntime.abortPromise;
      await pendingPromptTurns;
      await pendingAbort;
      if (activeBtwSession !== sessionRuntime) {
        throw new Error("BTW session closed before handoff completed.");
      }
    }

    const thread = sessionRuntime ? extractBtwHandoffThread(sessionRuntime) : [];
    const resolvedThread = thread.length > 0 ? thread : getPendingThreadForHandoff();

    if (resolvedThread.length === 0) {
      throw new Error("No BTW thread available for handoff.");
    }

    return { sessionRuntime, thread: resolvedThread };
  }

  async function summarizeThread(ctx: ExtensionCommandContext, thread: BtwHandoffExchange[]): Promise<string> {
    const settings = await resolveBtwSettings(ctx, true);
    const model = settings.model;
    if (!model) {
      throw new Error(settings.fallbackReason || "No active model selected.");
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!hasUsableModelAuth(ctx, model, auth)) {
      throw new Error(auth.ok ? `No credentials available for ${model.provider}/${model.id}.` : auth.error);
    }

    const modelRuntimeOptions = await createBtwModelRuntimeOptions(ctx, model);

    const sessionOptions: CreateAgentSessionOptions = {
      sessionManager: SessionManager.inMemory(),
      model,
      ...modelRuntimeOptions,
      thinkingLevel: "off",
      tools: [],
      resourceLoader: createBtwResourceLoader(ctx, [], [BTW_SUMMARIZE_SYSTEM_PROMPT]),
    };
    const { session } = await createAgentSession(sessionOptions);

    try {
      await session.prompt(formatThread(thread), { source: "extension" });

      const response = getLastAssistantMessage(session);
      if (!response) {
        throw new Error("BTW summarize finished without a response.");
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "Failed to summarize BTW thread.");
      }
      if (response.stopReason === "aborted") {
        throw new Error("BTW summarize aborted.");
      }

      return extractAnswer(response);
    } finally {
      try {
        await session.abort();
      } catch {
        // Ignore abort errors during summarize session shutdown.
      }
      session.dispose();
    }
  }

  function sendThreadToMain(ctx: ExtensionCommandContext, content: string): void {
    if (ctx.isIdle()) {
      pi.sendUserMessage(content);
    } else {
      pi.sendUserMessage(content, { deliverAs: "followUp" });
    }
  }

  pi.registerMessageRenderer(BTW_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details as BtwDetails | undefined;
    const content = details
      ? buildBtwMessageContent(details.question, details.answer)
      : typeof message.content === "string"
        ? message.content
        : "[non-text btw message]";

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", theme.bold("[BTW]")), 0, 0));
    box.addChild(
      new Markdown(content, 0, 0, getMarkdownTheme(), {
        color: (text: string) => theme.fg("customMessageText", text),
      }),
    );

    if (expanded && details) {
      box.addChild(
        new Text(
          theme.fg(
            "dim",
            `model: ${details.provider}/${details.model} (${details.api ?? "openai-responses"}) · thinking: ${details.thinkingLevel}`,
          ),
          0,
          0,
        ),
      );

      if (details.usage) {
        box.addChild(
          new Text(
            theme.fg(
              "dim",
              `tokens: in ${details.usage.input} · out ${details.usage.output} · total ${details.usage.totalTokens}`,
            ),
            0,
            0,
          ),
        );
      }
    }

    return box;
  });

  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((message) => !isVisibleBtwMessage(message)),
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    await restoreThread(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreThread(ctx);
  });

  pi.on("session_shutdown", async () => {
    invalidateBtwLifecycle();
    await disposeBtwSession();
    dismissOverlay();
  });

  pi.events.on(AGY_BTW_INTERCEPT_EVENT, (raw) => {
    const payload = raw as AgyBtwInterceptPayload<ExtensionContext> | undefined;
    if (!payload?.text || !payload.ctx) return;
    payload.handled = true;
    if (overlayMinimized) {
      if (overlayRuntime?.handle) {
        restoreOverlay(payload.ctx);
      } else {
        overlayMinimized = false;
      }
    }
    payload.promise = submitFromOverlay(payload.ctx, payload.text);
  });

  for (const shortcut of BTW_FOCUS_SHORTCUTS) {
    pi.registerShortcut(shortcut, {
      description: "Toggle BTW overlay focus (does not restore a minimized overlay).",
      handler: async (_ctx) => {
        toggleOverlayFocus();
      },
    });
  }

  pi.registerShortcut(BTW_MINIMIZE_SHORTCUT, {
    description: "Minimize or restore the BTW overlay.",
    handler: async (ctx) => {
      await toggleOverlayMinimize(ctx);
    },
  });

  pi.registerShortcut(BTW_WIDTH_TOGGLE_SHORTCUT, {
    description: "Toggle the BTW overlay between window and full-width layouts.",
    handler: async () => {
      if (!overlayRuntime || !lastUiContext) {
        return;
      }
      await toggleOverlayWidth(lastUiContext);
    },
  });

  for (const command of BTW_COMMANDS) {
    pi.registerCommand(command.name, {
      description: command.description,
      getArgumentCompletions: (argumentPrefix: string) => {
        if (command.name === "btw:model") {
          if (argumentPrefix.includes(" ")) return null;
          const items = getBtwModelCompletions(argumentPrefix, lastUiContext);
          return items.length > 0 ? items : null;
        }
        if (command.name === "btw:thinking") {
          if (argumentPrefix.includes(" ")) return null;
          const items = getBtwThinkingCompletions(argumentPrefix);
          return items.length > 0 ? items : null;
        }
        const mFlagMatch = argumentPrefix.match(/^(?:--save\s+|-s\s+)?(?:-m|--model)\s+([^\s]*)$/);
        if (mFlagMatch) {
          const prefix = argumentPrefix.slice(0, argumentPrefix.length - (mFlagMatch[1]?.length ?? 0));
          const items = getBtwModelCompletions(mFlagMatch[1] ?? "", lastUiContext).filter((i) => i.value !== "clear");
          return items.length > 0
            ? items.map((item) => ({
                value: `${prefix}${item.value} `,
                label: item.label,
                description: item.description,
              }))
            : null;
        }
        return null;
      },
      handler: async (args, ctx) => {
        await dispatchBtwCommand(command.name === "side" ? "btw" : command.name, args, ctx);
      },
    });
  }

}
