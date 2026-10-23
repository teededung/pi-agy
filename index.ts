// antigravity — use Google Antigravity (agy) models inside the pi coding
// agent via the agy stream-json RPC. pi stays the UI: model picker, portable
// sessions, and rendering; agy owns native context and runs the selected model with
// --dangerously-skip-permissions always enabled (headless agy turns
// auto-deny tools that would need a permission prompt otherwise).
//
// Commands:
//   /m              one-shot model consult: /m <opus|sonnet|argon|flash>[1|2|3] <prompt>
//   /boost          toggle Boost multi-agent mode or run a task with orchestration
//   /teamwork       toggle Teamwork two-phase multi-agent mode or start a project
//   /agy            show agy conversation and persistent-driver status
//   /agy-tools      toggle Pi tools on/off or show the current mode
//   /agy-reset      drop the current agy conversation (next turn starts fresh)
//   /agy-models     re-discover models from `agy models` and re-register
//   /agy-agents     list configured custom agents
//   /agy-doctor     diagnose binary, models, driver, bridge, and local state
//   /agy-subagents  list subagent activity observed on the agy stream
//   /agy-usage      show Antigravity model quotas (weekly and 5-hour limits)
//   /agy-boost      alias for /boost
//   /agy-teamwork   alias for /teamwork
//   /consult        alias for /m
//   /clear          clear agy conversation and start a new Pi session
//   /rename         alias for /name (set session display name and sync to agy)

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { getDocsPath, getExamplesPath, getReadmePath } from "@earendil-works/pi-coding-agent";
import { Marked, stripTerminalSequences, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { piConfigDir, readJson, writeJson } from "./lib/config.ts";
import {
  getAgyChildrenRegistry,
  installAgyDeathHooks,
  killAllAgyTrees,
  signalAgyTree,
  signalVerifiedAgyOrphans,
} from "./lib/agy-children.ts";
import {
  checkAgyBinary,
  isBelowRecommendedAgy,
  MIN_AGY_VERSION,
  RECOMMENDED_AGY_VERSION,
  runAgyCommand,
} from "./lib/agy-diagnostics.ts";
import { parseAgyAgents, readAgyProcessProfile } from "./lib/agy-profile.ts";
import { createPiToolsAgent } from "./lib/pi-tools-agent.ts";
import { readAgyToolMode, resolveAgyToolModeCommand, type AgyToolMode } from "./lib/tool-mode.ts";
import { loadSavedAgyToolMode, saveAgyToolMode } from "./lib/tool-mode-settings.ts";
import { removeMcpCacheEntry } from "./lib/mcp-cache.ts";
import { createPrivateMcpConfig } from "./lib/mcp-config.ts";
import { AgyPiBridge, selectBridgedTools, type PiToolInfo } from "./lib/bridge.ts";
import { createBridgeLifecycleManager } from "./lib/bridge-lifecycle.ts";
import {
  ACTIVATE_SKILL_TOOL_NAME,
  activateSkillDescription,
  activateSkillParameters,
  handleActivateSkill,
  piPrivateSkills,
  usableSkillCatalog,
  type SkillLite,
} from "./lib/skills.ts";
import {
  AGY_PI_SCHEDULING_CONTEXT_WINDOW,
  ALL_FALLBACK_MODELS,
  capabilitiesForModel,
  FALLBACK_MODELS,
  formatAgyConsultLabel,
  getAgyConsultCompletions,
  isAgyModelHidden,
  mergeAgyModels,
  modelCacheIsFresh,
  parseAgyModels,
  pricingForModel,
  resolveAgyConsultSpec,
  resolveAgyModelEffort,
  thinkingLevelMapForModel,
  type AgyModelInfo,
} from "./lib/models.ts";
import type { AgyActivity } from "./lib/reducer.ts";
import {
  AGY_COMPACTION_ENTRY,
  agyContextTokens,
  detectAgyCompaction,
  formatAgyContextTokens,
  type AgyCompactionMarker,
} from "./lib/agy-compaction.ts";
import {
  AGY_CONVERSATION_STATE_ENTRY,
  agyConversationExists,
  restorableAgyConversation,
  type PersistedAgyConversation,
  type PersistedAgyReset,
} from "./lib/conversation-state.ts";
import {
  detachAgyConversationBridgeMetadata,
  readAgyConversationMetadata,
  sweepStalePiToolsConversations,
  syncAgyConversationTitle,
} from "./lib/conversation-metadata.ts";
import { AgyReplayStore, type RecordedAgyTool } from "./lib/replay.ts";
import {
  agyGroupLeadingDescendants,
  agyGroupSurvivors,
  agyTaskStopPids,
  findAgyTask,
  listAgyTasks,
  stopAgyTask,
  type AgyTask,
} from "./lib/tasks.ts";
import {
  AGY_BTW_INTERCEPT_EVENT,
  formatAgySubagents,
  formatAgySubagentsLivePreviewLines,
  isAgySubagentTool,
  shouldInterceptSubagentSteerInput,
  summarizeAgySubagentsWidget,
  syncAgySubagentRoster,
  trackAgySubagent,
  type AgyBtwInterceptPayload,
  type AgySubagentEntry,
} from "./lib/subagents.ts";
import { findAgyArtifact, listAgyArtifacts } from "./lib/artifacts.ts";
import { fetchAgyUsage } from "./lib/usage.ts";
import {
  buildAgyRelayedInstructions,
  WRAPPER_TOOL_DESCRIPTION,
  WRAPPER_TOOL_NAME,
} from "./lib/prompt.ts";
import { wrapperToolActiveAfterModelSwitch } from "./lib/wrapper-activation.ts";
import { openAgyTasksPicker } from "./src/tasks-ui.ts";
import { openArtifact, openAgyArtifactsPicker } from "./src/artifacts-ui.ts";
import { openAgySubagentsPicker } from "./src/subagents-ui.ts";
import { openAgyUsagePicker } from "./src/usage-ui.ts";
import { agyToolLabel, cleanToolOutputLines, formatAgyCall, summarizeAgyResult } from "./lib/render.ts";
import { computeAgyToolDiff, isAgyEditTool, safeRenderDiff } from "./lib/diff.ts";
import {
  mapThinkingToEffort,
  streamAntigravity,
  type OneShotConsultOverride,
} from "./src/provider.ts";
import {
  AntigravityRuntime,
  createAntigravityRuntime,
  runAntigravity,
  type AntigravityStateSnapshot,
} from "./src/runtime.ts";

const MODEL_CACHE_FILE = path.join(piConfigDir("antigravity"), "model-list.json");
const DISCOVERY_TIMEOUT_MS = 15_000;

function statusOneLine(value: string, maxLength = 160): string {
  return stripTerminalSequences(value)
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

// --- Pi-tool bridge ---------------------------------------------------------

const BRIDGE_ENABLED = process.env.PI_ANTIGRAVITY_PI_TOOL_BRIDGE !== "0";

async function execAgy(args: string[], timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<string> {
  return (await runAgyCommand(args, { timeoutMs })).stdout;
}

interface ModelCache {
  fetchedAt?: number;
  source?: "live" | "fallback";
  models: AgyModelInfo[];
}

/**
 * Default rates (USD per Mtok) feed pi's native cost calculation. Per-model
 * overrides belong in pi's own ~/.pi/agent/models.json under
 * providers.antigravity.modelOverrides — pi applies them over registered models.
 */
function toProviderModel(model: AgyModelInfo): ProviderModelConfig {
  const capabilities = capabilitiesForModel(model.id);
  const thinkingLevelMap = thinkingLevelMapForModel(model);
  return {
    id: model.id,
    name: model.name,
    reasoning: true,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: ["text"],
    cost: pricingForModel(model.id),
    contextWindow: capabilities.contextWindow,
    maxTokens: capabilities.maxTokens,
  };
}

/** Collapse effort variants, dedupe, and filter hidden models (also heals pre-0.2.0 caches). */
function normalizeModels(models: AgyModelInfo[]): AgyModelInfo[] {
  return mergeAgyModels(models)
    .filter((model) => !isAgyModelHidden(model.id))
    .map((model) => {
      if (model.supportedEfforts.length > 0) return model;
      const fallback = ALL_FALLBACK_MODELS.find((candidate) => candidate.id === model.id);
      return fallback?.supportedEfforts.length
        ? {
            ...model,
            supportedEfforts: [...fallback.supportedEfforts],
            defaultEffort: fallback.defaultEffort,
          }
        : model;
    });
}

async function listAgyModels(): Promise<AgyModelInfo[]> {
  try {
    return parseAgyModels(await execAgy(["models"]));
  } catch {
    return [];
  }
}

function getInitialModelCache(): ModelCache {
  const cached = readJson<ModelCache | null>(MODEL_CACHE_FILE, null);
  if (cached?.models?.length && modelCacheIsFresh(cached)) {
    return { ...cached, models: normalizeModels(cached.models) };
  }
  // An expired or missing cache may have been written by an older extension
  // (e.g. a fallback catalog that predates newer models), so never register
  // stale disk state at startup: use the catalog baked into this build and
  // let the startup refresh pull the live list.
  return {
    fetchedAt: 0,
    source: "fallback",
    models: FALLBACK_MODELS,
  };
}

async function discoverModels(refresh = false): Promise<ModelCache> {
  if (!refresh) {
    const cached = readJson<ModelCache | null>(MODEL_CACHE_FILE, null);
    if (cached?.models?.length && modelCacheIsFresh(cached)) {
      return { ...cached, models: normalizeModels(cached.models) };
    }
  }
  const live = await listAgyModels();
  const cache: ModelCache = live.length
    ? { fetchedAt: Date.now(), source: "live", models: normalizeModels(live) }
    : { fetchedAt: Date.now(), source: "fallback", models: FALLBACK_MODELS };
  try {
    writeJson(MODEL_CACHE_FILE, cache);
  } catch {
    // Cache is best-effort; discovery still returns.
  }
  return cache;
}

const MARKED_BR_PATCH_SYMBOL = Symbol.for("pi-agy.marked-br-patch");

/**
 * Normalize inline `<br>`, `<br/>`, and `<br />` HTML tags into Marked `br`
 * tokens on the shared `@earendil-works/pi-tui` Marked Tokenizer prototype so
 * multi-line Markdown table cells render as real line breaks in both
 * `pi-better-render` and Pi's built-in Markdown renderer without modifying
 * external packages.
 */
function installMarkedBrTagPatch(): void {
  try {
    const marked = new Marked({ gfm: true }) as unknown as {
      Tokenizer?: { prototype?: { tag?: (src: string) => any; [MARKED_BR_PATCH_SYMBOL]?: boolean } };
    };
    const proto = marked.Tokenizer?.prototype;
    if (!proto || typeof proto.tag !== "function" || proto[MARKED_BR_PATCH_SYMBOL]) return;
    const origTag = proto.tag;
    proto.tag = function patchedTag(this: unknown, src: string) {
      const tok = origTag.call(this, src);
      if (tok && tok.type === "html" && typeof tok.raw === "string" && /^<br\s*\/?>$/i.test(tok.raw.trim())) {
        return { type: "br", raw: tok.raw };
      }
      return tok;
    };
    proto[MARKED_BR_PATCH_SYMBOL] = true;
  } catch {
    // Best-effort patch for pi-tui / pi-better-render Marked inline tokenizer.
  }
}

installMarkedBrTagPatch();

export default function antigravityExtension(pi: ExtensionAPI): void {
  pi.registerFlag("agy-tools", {
    description: "Antigravity tool mode: native or pi (execute work through Pi tools)",
    type: "string",
  });
  // Flags are not populated while the extension factory runs.
  let toolMode: AgyToolMode | undefined;
  const getToolMode = () =>
    (toolMode ??= readAgyToolMode(pi.getFlag("agy-tools"), process.env, loadSavedAgyToolMode()));
  let switchingToolMode = false;

  installMarkedBrTagPatch();
  installAgyDeathHooks();
  const runtime = createAntigravityRuntime();
  const service = runtime.runSync(AntigravityRuntime);
  const replay = new AgyReplayStore();
  let currentCache = getInitialModelCache();
  let observedContextTokens: number | undefined;
  let persistedConversationKey: string | undefined;
  // Live subagent roster, folded from stream activities since the last
  // conversation reset/restore. In-memory only: agy's own conversation
  // database remains the durable record.
  const subagentRoster = new Map<string, AgySubagentEntry>();
  let selectedModelKey: string | undefined;
  let sessionBoostMode = false;
  let oneShotBoost = false;
  let sessionTeamworkMode = false;
  let oneShotTeamwork = false;
  let teamworkLaunchedThisTurn = false;
  let subagentSpawnedThisTurn = false;

  interface ActiveOneShotConsult extends OneShotConsultOverride {
    restoreModel?: NonNullable<ExtensionContext["model"]>;
    restoreThinkingLevel?: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  }
  let oneShotConsult: ActiveOneShotConsult | undefined;
  let lastConsultUsed: OneShotConsultOverride | undefined;

  const AGY_CONSULT_ENTRY = "antigravity-consult";
  interface AgyConsultMarker {
    version: 1;
    modelId: string;
    modelName?: string;
    effort?: OneShotConsultOverride["effort"];
    completedAt: string;
  }

  const isBoostActive = (): boolean => sessionBoostMode || oneShotBoost;
  const isTeamworkActive = (): boolean => sessionTeamworkMode || oneShotTeamwork;
  const getOneShotConsult = (): OneShotConsultOverride | undefined => oneShotConsult;

  const updateOrchestrationStatus = (ui?: ExtensionContext["ui"]): void => {
    if (!ui) return;
    try {
      ui.setStatus(
        "agy-boost",
        isBoostActive() ? ui.theme.fg("accent", "[boost]\u00A0") : undefined,
      );
      ui.setStatus(
        "agy-teamwork",
        isTeamworkActive() ? ui.theme.fg("accent", "[teamwork]\u00A0") : undefined,
      );
    } catch {
      // UI may be unavailable (e.g. non-interactive modes).
    }
  };

  const updateConsultStatus = (ui?: ExtensionContext["ui"]): void => {
    if (!ui) return;
    try {
      const activeConsult = oneShotConsult ?? lastConsultUsed;
      if (activeConsult) {
        const effortSuffix = activeConsult.effort ? ` · ${activeConsult.effort}` : "";
        ui.setStatus(
          "agy-consult",
          ui.theme.fg("accent", `[consult: ${activeConsult.modelId}${effortSuffix}]\u00A0`),
        );
      } else {
        ui.setStatus("agy-consult", undefined);
      }
    } catch {
      // UI may be unavailable (e.g. non-interactive modes).
    }
  };

  pi.registerEntryRenderer(AGY_COMPACTION_ENTRY, (entry, _options, theme) => {
    const marker = entry.data as AgyCompactionMarker;
    const text =
      theme.fg("dim", "── ") +
      theme.fg("accent", "agy compacted context") +
      theme.fg(
        "dim",
        ` · ~${formatAgyContextTokens(marker.beforeTokens)} → ~${formatAgyContextTokens(marker.afterTokens)} ──`,
      );
    return {
      render: (width: number) => [truncateToWidth(text, width, "")],
      invalidate: () => {},
    };
  });

  pi.registerEntryRenderer(AGY_CONSULT_ENTRY, (entry, _options, theme) => {
    const marker = entry.data as AgyConsultMarker | undefined;
    if (!marker?.modelId) return undefined;
    const modelLabel = marker.modelName || marker.modelId;
    const effortPart = marker.effort ? ` (${marker.effort})` : "";
    const label = `Consulted ${modelLabel}${effortPart}`;
    return new Text(theme.italic(theme.fg("thinkingText", label)), 1, 0);
  });

  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== "user") return markdown;
    return markdown.replace(/\n(Consulted [^\n]+)$/, (_match, label: string) => {
      const probedTheme = activeSessionCtx
        ? probeCtx(() => activeSessionCtx?.ui?.theme)
        : undefined;
      if (probedTheme && !probedTheme.stale && probedTheme.value) {
        return `\n\x1b[3m${probedTheme.value.fg("thinkingText", label)}\x1b[23m`;
      }
      return `\n\x1b[3m\x1b[90m${label}\x1b[39m\x1b[23m`;
    });
  });

  const conversationStateKey = (state: {
    conversationId: string;
    modelId: string;
    turns: number;
  }): string => `${state.conversationId}:${state.modelId}:${state.turns}`;

  /**
   * Every session-bound getter on a stale ctx throws once pi invalidates the
   * extension runner (dispose/newSession/fork/switchSession/reload), and
   * events dispatched around the swap — e.g. agent_settled landing after a
   * /new or a shutdown — still reach our handlers. Probe first; a dead session
   * has nothing to persist into and no widget to update.
   */
  function probeCtx<T>(read: () => T): { stale: true } | { stale: false; value: T } {
    try {
      return { stale: false, value: read() };
    } catch {
      return { stale: true };
    }
  }

  let activeSessionCtx: ExtensionContext | undefined;
  let lastSyncedSessionTitleKey: string | undefined;
  let trackedConversationId: string | undefined;

  async function captureActiveConversationId(): Promise<string | undefined> {
    let cid = trackedConversationId;
    try {
      const snap = await runAntigravity(runtime, service.snapshot);
      if (snap.conversationId) cid = snap.conversationId;
    } catch {
      // Runtime may already be closed.
    }
    return cid;
  }

  function detachConversationMetadata(conversationId: string | undefined): void {
    if (!conversationId) return;
    if (trackedConversationId === conversationId) {
      trackedConversationId = undefined;
    }
    detachAgyConversationBridgeMetadata(conversationId);
  }

  const detachOnProcessExit = () => {
    detachConversationMetadata(trackedConversationId);
    piToolsAgent.removeSync();
    mcpConfig.removeSync();
  };
  process.once("exit", detachOnProcessExit);

  async function syncSessionNameToAgy(
    ctx: ExtensionContext | undefined = activeSessionCtx,
    knownConversationId?: string,
  ): Promise<void> {
    if (!ctx) return;
    const probe = probeCtx(() => ({
      provider: ctx.model?.provider,
      sessionName: ctx.sessionManager.getSessionName()?.trim(),
    }));
    if (probe.stale || probe.value.provider !== "antigravity" || !probe.value.sessionName) return;
    const conversationId =
      knownConversationId ?? (await runAntigravity(runtime, service.snapshot)).conversationId;
    if (!conversationId) return;
    detachAgyConversationBridgeMetadata(conversationId);
    const titleKey = `${conversationId}:${probe.value.sessionName}`;
    if (titleKey === lastSyncedSessionTitleKey) return;
    if (await syncAgyConversationTitle(conversationId, probe.value.sessionName)) {
      lastSyncedSessionTitleKey = titleKey;
      detachAgyConversationBridgeMetadata(conversationId);
    }
  }

  /** Compact footer status while this provider is selected. */
  function refreshToolModeStatus(ctx: ExtensionContext): void {
    probeCtx(() => {
      if (!ctx.hasUI) return;
      ctx.ui.setStatus(
        "antigravity",
        ctx.model?.provider === "antigravity"
          ? `pi-tools:${getToolMode() === "pi" ? "on" : "off"}`
          : undefined,
      );
    });
  }

  async function persistConversationState(ctx: ExtensionContext, force = false): Promise<void> {
    activeSessionCtx = ctx;
    // Read every session-bound field before the first await — the stale window
    // widens once this handler yields.
    const probe = probeCtx(() => ({
      provider: ctx.model?.provider,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
    }));
    if (probe.stale || probe.value.provider !== "antigravity") return;
    const { sessionId, cwd } = probe.value;
    const snapshot = await runAntigravity(runtime, service.snapshot);
    if (!snapshot.conversationId || !snapshot.model || snapshot.cwd !== cwd) return;
    trackedConversationId = snapshot.conversationId;
    detachAgyConversationBridgeMetadata(snapshot.conversationId);
    await syncSessionNameToAgy(ctx, snapshot.conversationId);
    const state: PersistedAgyConversation = {
      version: 1,
      kind: "conversation",
      sessionId,
      conversationId: snapshot.conversationId,
      cwd,
      modelId: snapshot.model,
      toolMode: getToolMode(),
      bridgeServer: BRIDGE_ENABLED ? mcpConfig.serverName : undefined,
      turns: snapshot.turns,
      usage: snapshot.conversationUsage,
      contextTokens: observedContextTokens,
    };
    const key = conversationStateKey(state);
    if (!force && key === persistedConversationKey) return;
    try {
      pi.appendEntry(AGY_CONVERSATION_STATE_ENTRY, state);
    } catch {
      return; // Session went stale mid-persist.
    }
    persistedConversationKey = key;
  }

  function appendConversationReset(ctx: ExtensionContext): void {
    const probe = probeCtx(() => ({
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
    }));
    if (probe.stale) return;
    const reset: PersistedAgyReset = {
      version: 1,
      kind: "reset",
      sessionId: probe.value.sessionId,
      cwd: probe.value.cwd,
    };
    try {
      pi.appendEntry(AGY_CONVERSATION_STATE_ENTRY, reset);
    } catch {
      return;
    }
    observedContextTokens = undefined;
    persistedConversationKey = undefined;
  }

  // --- Pi-tool bridge setup -------------------------------------------------

  const mcpConfig = createPrivateMcpConfig();
  const bridge = new AgyPiBridge(mcpConfig.serverName);
  const bridgeToken = randomUUID();
  const piToolsAgent = createPiToolsAgent(path.join(mcpConfig.directory, ".agents", "agents"));
  bridge.requireToken(bridgeToken);
  bridge.setOnCall((call) => service.pushBridgeCall(call));

  const bridgeManager = createBridgeLifecycleManager({
    bridge,
    bridgeToken,
    enabled: BRIDGE_ENABLED,
    writeMcpConfig: async (_serverName, url, token) => mcpConfig.write(url, token),
    removeMcpConfig: async () => mcpConfig.remove(),
    evictMcpCache: removeMcpCacheEntry,
    // tasksUi is populated by the session_start handler; read it lazily so a
    // warning raised before UI attach is simply dropped rather than throwing.
    notifyWarning: (message) => tasksUi?.notify(message, "warning"),
  });

  /** Prepare private MCP discovery before agy scans its workspace at startup. */
  function validateToolMode(mode: AgyToolMode): void {
    if (mode === "pi") {
      if (!BRIDGE_ENABLED) {
        throw new Error("antigravity: Pi tool mode requires the Pi-tool bridge to be enabled.");
      }
      if (readAgyProcessProfile().agent) {
        throw new Error(
          "antigravity: Pi tool mode manages its own agent; unset PI_ANTIGRAVITY_AGENT.",
        );
      }
    }
  }

  async function ensureBridgeRegistered(ui?: ExtensionUIContext): Promise<void> {
    const mode = getToolMode();
    validateToolMode(mode);
    // Native mode supports built-in MCP only. Pi mode can execute any active Pi tool.
    const resources = probeCtx(() => [...pi.getAllTools(), ...pi.getCommands()]);
    if (mode === "native" && !resources.stale) {
      bridgeManager.warnMcpAdapterUnsupported(
        resources.value,
        ui ? (warning) => ui.notify(warning, "warning") : undefined,
      );
    }
    const registered = await bridgeManager.ensureRegistered((warning) =>
      ui?.notify(warning, "warning"),
    );
    if (mode === "pi") {
      const url = bridge.url;
      if (!registered || !url) {
        throw new Error("antigravity: Pi tool mode requires a registered Pi-tool bridge.");
      }
      await piToolsAgent.prepare({ serverName: bridge.serverName, url, token: bridgeToken });
    }
  }

  function getProcessProfile(isolated = false) {
    // Disposable turns (/btw, compaction) are not routed through the bridge,
    // so they keep agy's native tools and never see the private MCP config.
    if (isolated) return readAgyProcessProfile();
    if (switchingToolMode) {
      throw new Error("antigravity: tool mode is changing; retry when the switch finishes.");
    }
    const profile = {
      ...readAgyProcessProfile(),
      mcpDirectory: bridgeManager.isRegistered() ? mcpConfig.directory : undefined,
    };
    if (getToolMode() === "native") return profile;
    if (!bridgeManager.isRegistered() || !piToolsAgent.isPrepared()) {
      throw new Error("antigravity: Pi tool mode could not prepare its agent and bridge.");
    }
    return { ...profile, agent: piToolsAgent.name };
  }

  /**
   * Remove this instance's private discovery and descriptor cache.
   * Runs when the session leaves Antigravity models and on shutdown.
   */
  async function teardownBridge(): Promise<void> {
    const cid = await captureActiveConversationId();
    try {
      await bridgeManager.teardown();
    } finally {
      await piToolsAgent.remove();
      detachConversationMetadata(cid);
    }
  }

  // --- Skill passing (Phase 2) ----------------------------------------------
  // pi's loaded skills, refreshed per turn via before_agent_start so /reload
  // is respected. Model-invocation-disabled skills are excluded.
  let loadedSkills: SkillLite[] = [];

  /** Native mode relays Pi docs; Pi tool mode uses the provider's current Pi snapshot. */
  const getSystemPromptRelay = () =>
    getToolMode() === "pi"
      ? undefined // The provider relays the current Pi instructions for its Pi tools.
      : buildAgyRelayedInstructions({
          readme: getReadmePath(),
          docs: getDocsPath(),
          examples: getExamplesPath(),
          cwd: activeSessionCtx?.cwd || tasksSessionCwd || process.cwd(),
        });

  function captureSkills(skills: unknown): void {
    if (!Array.isArray(skills)) return;
    loadedSkills = skills
      .map((skill) => skill as Partial<SkillLite> & { disableModelInvocation?: boolean })
      .filter(
        (skill) => skill.disableModelInvocation !== true && typeof skill.filePath === "string",
      )
      .map((skill) => ({
        name: String(skill.name),
        description: String(skill.description ?? ""),
        filePath: String(skill.filePath),
        baseDir: String(skill.baseDir ?? path.dirname(String(skill.filePath))),
      }));
  }

  const bridgedSkills = () => usableSkillCatalog(piPrivateSkills(loadedSkills, tasksSessionCwd));

  /**
   * Bridge mode keeps the catalog in activate_skill's schema (refreshed on
   * every agy spawn), so nothing is appended to the prompt. When the bridge
   * is off OR failed to register, pi-private skills are simply unavailable —
   * warn the user once instead of stuffing the catalog into the prompt.
   * The undefined return is intentional; the runtime's bootstrapSuffix
   * plumbing stays so a future direct-mode catalog needs no new wiring.
   */
  const getBootstrapSuffix = () => {
    bridgeManager.warnSkillsUnavailable(bridgedSkills());
    return undefined;
  };

  /** Publish one `pi__activate_skill` tool for global pi skills. */
  function refreshSkillTools(): void {
    if (!BRIDGE_ENABLED) return;
    if (getToolMode() === "pi") {
      // Pi instructions already carry the skill catalog and paths. Read skills
      // through Pi tools so their file access follows the Pi execution pipeline.
      bridge.setDynamicTools([]);
      return;
    }
    const skills = bridgedSkills();
    if (skills.length === 0) {
      bridge.setDynamicTools([]);
      return;
    }
    bridge.setDynamicTools([
      {
        name: ACTIVATE_SKILL_TOOL_NAME,
        description: activateSkillDescription(skills),
        parameters: activateSkillParameters(skills),
        handler: (args) => handleActivateSkill(skills, args),
      },
    ]);
  }

  bridge.setToolSource(() => {
    if (!BRIDGE_ENABLED) return [];
    let activeNames: string[] = [];
    let allTools: PiToolInfo[] = [];
    try {
      activeNames = pi.getActiveTools();
      allTools = pi.getAllTools() as PiToolInfo[];
    } catch {
      return []; // API unavailable (print/RPC edge) — expose nothing.
    }
    return selectBridgedTools(allTools, activeNames, getToolMode());
  });

  // Per-skill tools are gone; one activate_skill tool is published on every
  // skills capture via refreshSkillTools().

  // --- Status-bar hint for live agy background tasks, artifacts, subagents ---

  const AGY_STATUS_WIDGET_KEY = "agy-status";
  const AGY_TASKS_WIDGET_KEY = "agy-tasks";
  const AGY_ARTIFACTS_WIDGET_KEY = "agy-artifacts";
  let tasksUi: ExtensionUIContext | undefined;
  let tasksSessionCwd: string | undefined;
  let widgetLiveCount = -1;
  let widgetArtifactCount = -1;
  let lastRenderedLive = -1;
  let lastRenderedArtifacts = -1;
  let lastRenderedSubagents = -1;
  let lastRenderedSubagentSummary = "";
  let widgetScanInFlight = false;
  let widgetScanQueued = false;
  let agyAgentActive = false;
  let widgetPollTimer: ReturnType<typeof setInterval> | undefined;
  const WIDGET_POLL_MS = 2_000;

  function hasRunningSubagent(): boolean {
    for (const entry of subagentRoster.values()) {
      if (entry.status === "running") return true;
    }
    return false;
  }

  /** Active-tool snapshot for the provider's native re-execution fallback. */
  const isActiveTool = (name: string): boolean => {
    try {
      return pi.getActiveTools().includes(name);
    } catch {
      return false; // API unavailable (print/RPC edge) — stay on the wrapper.
    }
  };

  function joinHintItems(
    items: string[],
    maxWidth: number,
    theme: { fg(color: string, text: string): string },
  ): string {
    const sepStandard = theme.fg("dim", "  │  ");
    const sepCompact = theme.fg("dim", " │ ");
    const sepMinimal = "  ";

    for (const sep of [sepStandard, sepCompact, sepMinimal]) {
      const sepWidth = visibleWidth(sep);
      const totalWidth =
        items.reduce((acc, it) => acc + visibleWidth(it), 0) + sepWidth * (items.length - 1);
      if (totalWidth <= maxWidth) {
        return items.join(sep);
      }
    }
    return items.join(sepStandard);
  }

  function packHintItems(
    items: string[],
    width: number,
    theme: { fg(color: string, text: string): string },
  ): string[] {
    if (items.length === 0) return [];
    if (items.length === 1) return [truncateToWidth(items[0]!, width, "")];

    const singleLine = joinHintItems(items, width, theme);
    if (visibleWidth(singleLine) <= width) {
      return [singleLine];
    }

    const lines: string[] = [];
    let currentLineItems: string[] = [];

    for (const item of items) {
      const candidate = [...currentLineItems, item];
      const candidateJoined = joinHintItems(candidate, width, theme);
      if (currentLineItems.length === 0 || visibleWidth(candidateJoined) <= width) {
        currentLineItems = candidate;
      } else {
        lines.push(joinHintItems(currentLineItems, width, theme));
        currentLineItems = [item];
      }
    }
    if (currentLineItems.length > 0) {
      lines.push(joinHintItems(currentLineItems, width, theme));
    }

    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  /** Slash commands shown in the status widget; clickable in fullscreen mode. */
  const AGY_WIDGET_COMMANDS = ["/agy-tasks", "/agy-artifacts", "/agy-subagents"];

  function renderAgyStatusWidget(force = false): void {
    if (!tasksUi) return;
    const liveTasks = Math.max(0, widgetLiveCount);
    const artifacts = Math.max(0, widgetArtifactCount);
    const subagents = subagentRoster.size;
    const now = Date.now();
    const liveSubSummary = summarizeAgySubagentsWidget(subagentRoster, now);
    const livePreviewPlain = formatAgySubagentsLivePreviewLines(subagentRoster, now);
    const subagentSummary = [liveSubSummary ?? "", ...livePreviewPlain].join("\n");

    if (
      !force &&
      liveTasks === lastRenderedLive &&
      artifacts === lastRenderedArtifacts &&
      subagents === lastRenderedSubagents &&
      subagentSummary === lastRenderedSubagentSummary
    ) {
      return;
    }
    lastRenderedLive = liveTasks;
    lastRenderedArtifacts = artifacts;
    lastRenderedSubagents = subagents;
    lastRenderedSubagentSummary = subagentSummary;

    try {
      tasksUi.setWidget(AGY_TASKS_WIDGET_KEY, undefined);
      tasksUi.setWidget(AGY_ARTIFACTS_WIDGET_KEY, undefined);

      if (liveTasks === 0 && artifacts === 0 && subagents === 0) {
        tasksUi.setWidget(AGY_STATUS_WIDGET_KEY, undefined);
        return;
      }

      tasksUi.setWidget(AGY_STATUS_WIDGET_KEY, (tui, theme) => {
        // Click regions for the slash-command hints, rebuilt on every render.
        const regions: { x: number; y: number; width: number; command: string }[] = [];
        const widget = {
          render: (width: number) => {
            const previewLines = formatAgySubagentsLivePreviewLines(
              subagentRoster,
              now,
              theme,
            ).map((line) => truncateToWidth(line, width, ""));
            const items: string[] = [];
            if (liveTasks > 0) {
              items.push(
                theme.fg("warning", "■ ") +
                  theme.fg("text", `${liveTasks} agy background task${liveTasks === 1 ? "" : "s"}`) +
                  theme.fg("dim", " • ") +
                  theme.fg("accent", "/agy-tasks") +
                  theme.fg("dim", " to view"),
              );
            }
            if (artifacts > 0) {
              items.push(
                theme.fg("success", "◆ ") +
                  theme.fg("text", `${artifacts} agy artifact${artifacts === 1 ? "" : "s"}`) +
                  theme.fg("dim", " • ") +
                  theme.fg("accent", "/agy-artifacts") +
                  theme.fg("dim", " to view"),
              );
            }
            if (subagents > 0) {
              items.push(
                theme.fg("accent", "◆ ") +
                  theme.fg(
                    "text",
                    liveSubSummary
                      ? `agy subagent${subagents === 1 ? "" : "s"}: ${liveSubSummary}`
                      : `${subagents} agy subagent${subagents === 1 ? "" : "s"}`,
                  ) +
                  theme.fg("dim", " • ") +
                  theme.fg("accent", "/agy-subagents"),
              );
            }
            const hintLines = packHintItems(items, width, theme);
            const lines = [...previewLines, ...hintLines];
            regions.length = 0;
            lines.forEach((line, y) => {
              const plain = stripTerminalSequences(line);
              for (const command of AGY_WIDGET_COMMANDS) {
                const index = plain.indexOf(command);
                if (index < 0) continue;
                regions.push({
                  x: visibleWidth(plain.slice(0, index)),
                  y,
                  width: visibleWidth(command),
                  command,
                });
              }
            });
            return lines;
          },
          invalidate: () => {},
        };
        // Mouse input only exists in fullscreen mode; typing the command stays
        // the keyboard path everywhere else.
        if ((tui as { mode?: string }).mode !== "fullscreen") return widget;
        let pressed: (typeof regions)[number] | undefined;
        const hitAt = (event: { x: number; y: number }) =>
          regions.find((r) => event.y === r.y && event.x >= r.x && event.x < r.x + r.width);
        return {
          ...widget,
          handleMouse(event: {
            type: string;
            button?: string;
            x: number;
            y: number;
            shift?: boolean;
            alt?: boolean;
            ctrl?: boolean;
          }) {
            if (event.button !== "left" || event.shift || event.alt || event.ctrl) return undefined;
            const hit = hitAt(event);
            if (event.type === "press" && hit) {
              pressed = hit;
              return { handled: true, capture: true, render: false };
            }
            if (event.type === "drag" && pressed) {
              if (hit?.command !== pressed.command) pressed = undefined;
              return { handled: true, render: false };
            }
            if (event.type === "release") {
              const started = pressed;
              pressed = undefined;
              if (!started) return undefined;
              if (hit?.command === started.command) {
                // expandPromptTemplates routes the text to the extension-command
                // handler instead of sending it to the model as a prompt.
                pi.sendUserMessage(started.command, { expandPromptTemplates: true });
              }
              return { handled: true, render: false };
            }
            return undefined;
          },
        };
      });
    } catch {
      // UI may be unavailable (print/RPC modes or teardown).
    }
  }

  function setAgyTasksWidget(live: number): void {
    if (live === widgetLiveCount) return;
    widgetLiveCount = live;
    renderAgyStatusWidget();
  }

  function setAgyArtifactsWidget(count: number): void {
    if (count === widgetArtifactCount) return;
    widgetArtifactCount = count;
    renderAgyStatusWidget();
  }

  function reconcileWidgetPolling(): void {
    const shouldPoll = Boolean(
      tasksUi && (agyAgentActive || widgetLiveCount > 0 || hasRunningSubagent()),
    );
    if (shouldPoll && !widgetPollTimer) {
      widgetPollTimer = setInterval(updateAgyTasksWidget, WIDGET_POLL_MS);
      widgetPollTimer.unref?.();
    } else if (!shouldPoll && widgetPollTimer) {
      clearInterval(widgetPollTimer);
      widgetPollTimer = undefined;
    }
  }

  /** Rescan task state independently from agy's provider stream. */
  function updateAgyTasksWidget(): void {
    if (!tasksUi) return;
    if (widgetScanInFlight) {
      widgetScanQueued = true;
      return;
    }
    widgetScanInFlight = true;
    void (async () => {
      try {
        const snapshot = await runAntigravity(runtime, service.snapshot);
        if (!snapshot.conversationId) {
          setAgyTasksWidget(0);
          setAgyArtifactsWidget(0);
          return;
        }
        const [tasks, artifacts] = await Promise.all([
          listAgyTasks(snapshot.conversationId, {
            sessionCwd: tasksSessionCwd,
            agyPids: [...getAgyChildrenRegistry().live],
          }),
          listAgyArtifacts(snapshot.conversationId),
          syncAgySubagentRoster(subagentRoster, snapshot.conversationId).catch(() => false),
        ]);
        setAgyTasksWidget(
          tasks.filter(
            (task) => task.pids.length > 0 || task.orphans.length > 0 || task.ambiguous.length > 0,
          ).length,
        );
        setAgyArtifactsWidget(artifacts.length);
        if (subagentRoster.size > 0) {
          renderAgyStatusWidget();
        }
      } catch {
        // Runtime closed or scan failed; leave the widget as-is.
      } finally {
        widgetScanInFlight = false;
        if (widgetScanQueued) {
          widgetScanQueued = false;
          queueMicrotask(updateAgyTasksWidget);
        } else {
          reconcileWidgetPolling();
        }
      }
    })();
  }

  function handleAgyActivity(activity: AgyActivity): void {
    if (activity.type === "conversation_fallback") {
      observedContextTokens = undefined;
      persistedConversationKey = undefined;
      subagentRoster.clear();
      renderAgyStatusWidget(true);
      return;
    }
    trackAgySubagent(subagentRoster, activity);
    if (
      (activity.type === "tool_start" ||
        activity.type === "tool_done" ||
        activity.type === "tool_error") &&
      isAgySubagentTool(activity.name)
    ) {
      if (activity.type === "tool_start") {
        subagentSpawnedThisTurn = true;
        if (JSON.stringify(activity.args ?? {}).includes("teamwork_preview")) {
          teamworkLaunchedThisTurn = true;
        }
      }
      renderAgyStatusWidget();
      updateAgyTasksWidget();
    }
    if (activity.type === "usage") {
      const nextContextTokens = agyContextTokens(activity.usage);
      const compaction = detectAgyCompaction(observedContextTokens, nextContextTokens);
      if (compaction) {
        const marker: AgyCompactionMarker = {
          version: 1,
          ...compaction,
          detectedAt: new Date().toISOString(),
        };
        try {
          pi.appendEntry(AGY_COMPACTION_ENTRY, marker);
        } catch {
          // Session replaced mid-activity; the marker is advisory only.
        }
      }
      observedContextTokens = nextContextTokens;
      return;
    }
    if (
      (activity.type === "tool_start" ||
        activity.type === "tool_done" ||
        activity.type === "tool_error") &&
      (activity.name === "run_command" || activity.name === "schedule")
    ) {
      // ACTIVE arrives before a sleeping command completes. Start the
      // independent filesystem scan now instead of waiting for onSettled,
      // then retry once in case the task log and holder fd are still racing.
      updateAgyTasksWidget();
      if (activity.type === "tool_start") {
        const retry = setTimeout(updateAgyTasksWidget, 500);
        retry.unref?.();
      }
    }
  }

  pi.registerTool({
    name: WRAPPER_TOOL_NAME,
    label: "antigravity",
    description: WRAPPER_TOOL_DESCRIPTION,
    parameters: Type.Object({
      tool: Type.String(),
      input: Type.Unknown(),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const recorded = replay.take(toolCallId);
      if (!recorded) {
        throw new Error(`No recorded antigravity result for "${params.tool}".`);
      }
      if (!recorded.diff && isAgyEditTool(params.tool)) {
        try {
          recorded.diff = await computeAgyToolDiff(
            params.tool,
            params.input,
            ctx?.cwd,
            recorded.conversationId,
            recorded.stepId,
            recorded.output,
          );
        } catch {
          // Diff computation is best-effort and must not fail the tool execution
        }
      }
      const isError = recorded.isError === true || Boolean(recorded.error);
      const rawBody = recorded.error ?? recorded.output ?? "";
      const body = rawBody.replace(/\r/g, "");
      return {
        content: [{ type: "text", text: body ? body.slice(0, 16_000) : "(no output)" }],
        details: recorded,
        isError,
      };
    },
    renderCall(args, theme) {
      return new Text(formatAgyCall(args.tool, args.input, theme), 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      const rawBody = result.content[0]?.type === "text" ? result.content[0].text : "";
      const body = rawBody.replace(/\r/g, "");
      const details = result.details as RecordedAgyTool | undefined;
      const tool = details?.agyTool ?? "tool";
      const isError = context.isError || details?.isError === true || Boolean(details?.error);

      if (details?.diff) {
        const rendered = safeRenderDiff(details.diff, theme);
        return new Text(`\n${rendered}`, 0, 0);
      }

      const secs =
        typeof details?.durationSeconds === "number"
          ? theme.fg("muted", `(${details.durationSeconds.toFixed(2)}s)`)
          : "";
      const { counts } = summarizeAgyResult(tool, details?.output);

      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const hasExitInBody = /(?:The\s+)?command\s+exited\s+with\s+code/i.test(body);
      const exitSuffix =
        isError && details?.exitCode !== undefined && !hasExitInBody
          ? theme.fg("error", `Command exited with code ${details.exitCode}`)
          : "";

      const parts = [
        icon,
        counts ? theme.fg("muted", counts) : "",
        exitSuffix,
        secs,
      ].filter(Boolean);

      let text = parts.join(" ");

      const outputLines = cleanToolOutputLines(body);
      if (outputLines.length > 0 && body !== "(no output)") {
        const maxLines = 5;
        const shown = expanded ? outputLines : outputLines.slice(0, maxLines);
        text += `\n${shown.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
        if (!expanded && outputLines.length > maxLines) {
          text += theme.fg("muted", `\n… +${outputLines.length - maxLines} lines (ctrl+o to expand)`);
        }
      } else if (isError && !exitSuffix) {
        text += `\n${theme.fg("error", "failed")}`;
      }

      return new Text(text, 0, 0);
    },
  });

  const registerAntigravityProvider = (models: AgyModelInfo[]) => {
    const visibleModels = models.filter((model) => !isAgyModelHidden(model.id));
    pi.registerProvider("antigravity", {
      name: "Google Antigravity (agy)",
      baseUrl: "agy://local-stream-json",
      apiKey: "agy-local-session",
      api: "antigravity-stream-json",
      models: visibleModels.map(toProviderModel),
      streamSimple: streamAntigravity(
        runtime,
        service,
        replay,
        bridge,
        () => {
          subagentSpawnedThisTurn = false;
          const hadOneShotBoost = oneShotBoost;
          oneShotBoost = false;
          if (hadOneShotBoost || teamworkLaunchedThisTurn) {
            if (teamworkLaunchedThisTurn) {
              teamworkLaunchedThisTurn = false;
              oneShotTeamwork = false;
              sessionTeamworkMode = false;
            }
            updateOrchestrationStatus(tasksUi);
          }
          updateAgyTasksWidget();
        },
        getBootstrapSuffix,
        isActiveTool,
        handleAgyActivity,
        createAntigravityRuntime,
        (modelId) =>
          currentCache.models.find((candidate) => candidate.id === modelId) ??
          ALL_FALLBACK_MODELS.find((candidate) => candidate.id === modelId),
        getProcessProfile,
        bridgeManager.processRevision,
        getSystemPromptRelay,
        isBoostActive,
        getOneShotConsult,
        () => currentCache.models,
        (consult) => {
          lastConsultUsed = consult;
          if (tasksUi) updateConsultStatus(tasksUi);
        },
        isTeamworkActive,
      ),
    });
  };

  registerAntigravityProvider(currentCache.models);

  async function refreshStaleModelsWhenSelected(): Promise<void> {
    if (modelCacheIsFresh(currentCache)) return;
    const fresh = await discoverModels(true);
    currentCache = fresh;
    registerAntigravityProvider(fresh.models);
  }

  // Startup registration must stay synchronous, and the picker needs a
  // correct list even when the default model is not from antigravity (the
  // session_start/model_select hooks only refresh once agy is selected): a
  // no-op for fresh caches, otherwise a background heal of the registration.
  void refreshStaleModelsWhenSelected().catch((error) => {
    console.error("pi-agy: background model refresh failed", error);
  });

  pi.on("before_agent_start", (event) => {
    captureSkills(event.systemPromptOptions?.skills);
    refreshSkillTools();
  });

  // While a Boost, Teamwork, or subagent-bearing turn is streaming, pressing
  // Enter in the main editor normally queues a "steer" message that stalls
  // until every subagent finishes. Route it to the parallel /btw conversation
  // so the user can keep chatting immediately; Alt+Enter ("followUp") still
  // queues for the main session.
  pi.on("input", async (event, ctx) => {
    const probe = probeCtx(() => ctx.model?.provider);
    const intercepted = shouldInterceptSubagentSteerInput({
      source: event.source,
      streamingBehavior: event.streamingBehavior,
      text: event.text,
      hasImages: Boolean(event.images && event.images.length > 0),
      provider: probe.stale ? undefined : probe.value,
      agyAgentActive,
      isBoostActive: isBoostActive(),
      isTeamworkActive: isTeamworkActive(),
      subagentSpawnedThisTurn,
    });
    if (!intercepted) {
      return;
    }
    const payload: AgyBtwInterceptPayload<ExtensionContext> = { text: intercepted, ctx };
    pi.events.emit(AGY_BTW_INTERCEPT_EVENT, payload);
    if (!payload.handled) {
      return;
    }
    await payload.promise;
    return { action: "handled" };
  });

  // The agy stream reports tool starts immediately, but its DONE event can be
  // delayed by a sleeping command. Poll the independent filesystem task
  // source while the agent or any discovered task is live, then stop when
  // both are idle. This keeps the widget current without a permanent timer.
  let sessionNamePollTimer: ReturnType<typeof setInterval> | undefined;

  function ensureSessionNamePolling(): void {
    if (sessionNamePollTimer) return;
    sessionNamePollTimer = setInterval(() => {
      void syncSessionNameToAgy().catch(() => {});
    }, 2_000);
    sessionNamePollTimer.unref?.();
  }

  pi.on("agent_start", (_event, ctx) => {
    activeSessionCtx = ctx;
    subagentSpawnedThisTurn = false;
    const probe = probeCtx(() => ctx.model?.provider);
    if (probe.stale || probe.value !== "antigravity") return;
    agyAgentActive = true;
    void syncSessionNameToAgy(ctx).catch(() => {});
    updateAgyTasksWidget();
    reconcileWidgetPolling();
  });

  pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
    subagentSpawnedThisTurn = false;
    const hadOneShotBoost = oneShotBoost;
    oneShotBoost = false;
    if (hadOneShotBoost || teamworkLaunchedThisTurn) {
      if (teamworkLaunchedThisTurn) {
        teamworkLaunchedThisTurn = false;
        oneShotTeamwork = false;
        sessionTeamworkMode = false;
      }
      const ui = probeCtx(() => ctx.ui);
      if (!ui.stale && ui.value) updateOrchestrationStatus(ui.value);
    }
    const consultRecord = lastConsultUsed ?? oneShotConsult;
    const finishedConsult = oneShotConsult;
    oneShotConsult = undefined;
    lastConsultUsed = undefined;
    if (consultRecord) {
      const ui = probeCtx(() => ctx.ui);
      if (!ui.stale && ui.value) updateConsultStatus(ui.value);
      if (finishedConsult?.restoreModel) {
        try {
          await pi.setModel(finishedConsult.restoreModel);
          if (finishedConsult.restoreThinkingLevel) {
            pi.setThinkingLevel(finishedConsult.restoreThinkingLevel);
          }
        } catch {
          // Best-effort restore
        }
      }
    }
    activeSessionCtx = ctx;
    const probe = probeCtx(() => ctx.model?.provider);
    if (!probe.stale && (probe.value === "antigravity" || agyAgentActive)) {
      agyAgentActive = false;
      updateAgyTasksWidget();
    }
    await persistConversationState(ctx);
  });

  // The display-only `antigravity` wrapper tool only matters while an agy
  // model is active (the provider synthesizes its toolCalls from recorded
  // agy activity). Keep it out of every other model's tool payload: sync
  // active-tool state whenever the selected model changes, including the
  // session's initial restore.
  const syncWrapperToolActivation = (provider: string | undefined) => {
    try {
      const next = wrapperToolActiveAfterModelSwitch(
        pi.getActiveTools(),
        WRAPPER_TOOL_NAME,
        provider,
        "antigravity",
      );
      if (next) pi.setActiveTools([...next]);
    } catch {
      // Tool APIs unavailable (print/RPC edge) — leave the set untouched.
    }
  };

  pi.on("session_start", async (event, ctx: ExtensionContext) => {
    activeSessionCtx = ctx;
    lastSyncedSessionTitleKey = undefined;
    oneShotConsult = undefined;
    lastConsultUsed = undefined;
    oneShotBoost = false;
    oneShotTeamwork = false;
    teamworkLaunchedThisTurn = false;
    if (event.reason === "new") {
      sessionBoostMode = false;
      sessionTeamworkMode = false;
    }
    ensureSessionNamePolling();
    syncWrapperToolActivation(ctx.model?.provider);
    refreshToolModeStatus(ctx);
    selectedModelKey = ctx.model ? `${ctx.model.provider}:${ctx.model.id}` : undefined;
    const restored =
      event.reason !== "fork" && ctx.model?.provider === "antigravity"
        ? restorableAgyConversation(
            ctx.sessionManager.getBranch(),
            ctx.sessionManager.getSessionId(),
            ctx.cwd,
            getToolMode(),
            BRIDGE_ENABLED ? mcpConfig.serverName : undefined,
          )
        : undefined;
    const compatibleRestore =
      restored &&
      (await agyConversationExists(restored.conversationId))
        ? restored
        : undefined;
    const previousConversationId = await captureActiveConversationId();
    // Fresh instances have new private discovery credentials and server names.
    // Rebuild from Pi history when the saved conversation belongs to another
    // bridge, agent, or tool mode.
    await runAntigravity(
      runtime,
      service.setSession(ctx.cwd, undefined, !compatibleRestore && event.reason !== "new"),
    );
    if (previousConversationId && previousConversationId !== compatibleRestore?.conversationId) {
      detachConversationMetadata(previousConversationId);
    }
    sweepStalePiToolsConversations();
    if (compatibleRestore) {
      trackedConversationId = compatibleRestore.conversationId;
      await runAntigravity(
        runtime,
        service.restoreConversation({
          conversationId: compatibleRestore.conversationId,
          modelId: compatibleRestore.modelId,
          cwd: compatibleRestore.cwd,
          turns: compatibleRestore.turns,
          usage: compatibleRestore.usage,
        }),
      );
      observedContextTokens = compatibleRestore.contextTokens;
      persistedConversationKey = conversationStateKey(compatibleRestore);
      await syncSessionNameToAgy(ctx, compatibleRestore.conversationId);
    } else {
      observedContextTokens = undefined;
      persistedConversationKey = undefined;
      subagentRoster.clear();
    }
    if (ctx.hasUI) tasksUi = ctx.ui;
    tasksSessionCwd = ctx.cwd;
    lastRenderedLive = -1;
    lastRenderedArtifacts = -1;
    lastRenderedSubagents = -1;
    updateAgyTasksWidget();
    renderAgyStatusWidget(true);
    if (ctx.hasUI) {
      updateOrchestrationStatus(ctx.ui);
      updateConsultStatus(ctx.ui);
    }
    // The pi-tool bridge is only useful while an Antigravity model is
    // selected: register lazily here (session resumed on an agy model) and on
    // model_select; non-agy sessions never touch agy at all.
    if (ctx.model?.provider === "antigravity") {
      await ensureBridgeRegistered(ctx.ui);
      await refreshStaleModelsWhenSelected();
    }
  });

  pi.on("model_select", async (event, ctx) => {
    syncWrapperToolActivation(event.model?.provider);
    refreshToolModeStatus(ctx);
    const nextModelKey = event.model ? `${event.model.provider}:${event.model.id}` : undefined;
    if (
      selectedModelKey?.startsWith("antigravity:") &&
      !nextModelKey?.startsWith("antigravity:")
    ) {
      // Another provider/model can add context that the mutable agy
      // conversation never saw. Force a branch bootstrap when agy is selected
      // again instead of silently resuming stale native history.
      const cwd = probeCtx(() => ctx.cwd);
      if (!cwd.stale) {
        const previousConversationId = await captureActiveConversationId();
        await runAntigravity(runtime, service.setSession(cwd.value, undefined, true));
        detachConversationMetadata(previousConversationId);
        observedContextTokens = undefined;
        persistedConversationKey = undefined;
      }
    }
    selectedModelKey = nextModelKey;
    // The bridge exists only while an Antigravity model is selected.
    if (event.model?.provider === "antigravity") {
      const ui = probeCtx(() => ctx?.ui);
      await ensureBridgeRegistered(ui.stale ? undefined : ui.value);
      await refreshStaleModelsWhenSelected();
      if (!ui.stale && ui.value) {
        updateOrchestrationStatus(ui.value);
        updateConsultStatus(ui.value);
      }
    } else {
      const ui = probeCtx(() => ctx?.ui);
      if (!ui.stale && ui.value) {
        try {
          ui.value.setStatus("agy-boost", undefined);
          ui.value.setStatus("agy-teamwork", undefined);
          ui.value.setStatus("agy-consult", undefined);
        } catch {
          // Best effort
        }
      }
      await teardownBridge();
    }
  });

  pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
    // An agy conversation cannot be rewound to match a different pi branch.
    // Restart it and bootstrap the selected branch on the next provider call.
    const cwd = probeCtx(() => ctx.cwd);
    if (cwd.stale) return;
    const previousConversationId = await captureActiveConversationId();
    await runAntigravity(runtime, service.setSession(cwd.value, undefined, true));
    detachConversationMetadata(previousConversationId);
    appendConversationReset(ctx);
    subagentRoster.clear();
    setAgyTasksWidget(0);
    setAgyArtifactsWidget(0);
    renderAgyStatusWidget(true);
  });

  pi.on("session_compact", async (_event, ctx: ExtensionContext) => {
    // Pi manual/overflow compaction changes the session branch but not agy's
    // native conversation. Re-anchor the same owner after the compaction entry.
    await persistConversationState(ctx, true);
  });

  pi.on("session_shutdown", async () => {
    await syncSessionNameToAgy().catch(() => {});
    if (sessionNamePollTimer) clearInterval(sessionNamePollTimer);
    sessionNamePollTimer = undefined;
    activeSessionCtx = undefined;
    agyAgentActive = false;
    if (widgetPollTimer) clearInterval(widgetPollTimer);
    widgetPollTimer = undefined;
    widgetScanQueued = false;
    // Group ids signalled at the top of shutdown; survivors get SIGKILL after
    // service.close has given SIGTERM its grace. Every target in this set was
    // verified by live ancestry or a current lsof hold moments earlier.
    const sweepTargets = new Set<number>();
    // Signal every process-group-leading child of our tracked agy processes.
    // agy >= 1.2.0 runs tasks in their own process groups, so killAllAgyTrees
    // (which only reaches agy's own group) leaves them running; ancestry is
    // proof of ownership here — no per-task attribution needed — while agy is
    // still alive to be their parent.
    try {
      const leaders = await agyGroupLeadingDescendants([...getAgyChildrenRegistry().live]);
      for (const pid of leaders) {
        sweepTargets.add(pid);
        signalAgyTree({ pid }, "SIGTERM");
      }
    } catch {
      // Process scan failed; service.close and killAllAgyTrees still run.
    }
    // Orphans recorded at earlier recycles are proven descendants of agy
    // processes this pi spawned — ours regardless of which conversation the
    // service snapshot currently names (or whether a /agy reset cleared it).
    // signalVerifiedAgyOrphans re-checks each record's identity first, so a
    // stale record can never signal a reused pid or a stranger's group.
    signalVerifiedAgyOrphans("SIGTERM");
    // Stop any live agy background tasks so closing pi leaves nothing
    // running silently. A task stop only ever signals proven log holders;
    // recorded orphans were covered above, and advisory matches are never
    // signalled.
    try {
      const snapshot = await runAntigravity(runtime, service.snapshot);
      if (snapshot.conversationId) {
        const tasks = await listAgyTasks(snapshot.conversationId, {
          sessionCwd: tasksSessionCwd,
        });
        const live = tasks.filter((task) => task.pids.length > 0);
        const stopped = await Promise.all(live.map((task) => stopAgyTask(task)));
        for (const { pgids } of stopped) {
          for (const pgid of pgids) sweepTargets.add(pgid);
        }
      }
    } catch {
      // Runtime closed or scan failed; nothing to stop.
    }
    // Close the runtime: aborts any in-flight agy child process, then tear
    // down the Effect runtime.
    const shutdownConversationId = await captureActiveConversationId();
    try {
      await runAntigravity(runtime, service.close);
    } catch {
      // Already closed.
    }
    process.removeListener("exit", detachOnProcessExit);
    detachConversationMetadata(shutdownConversationId);
    await teardownBridge();
    sweepStalePiToolsConversations();
    try {
      tasksUi?.setStatus("antigravity", undefined);
      tasksUi?.setWidget(AGY_STATUS_WIDGET_KEY, undefined);
      tasksUi?.setWidget(AGY_TASKS_WIDGET_KEY, undefined);
      tasksUi?.setWidget(AGY_ARTIFACTS_WIDGET_KEY, undefined);
      tasksUi?.setStatus("agy-boost", undefined);
      tasksUi?.setStatus("agy-teamwork", undefined);
      tasksUi?.setStatus("agy-consult", undefined);
    } catch {
      // UI may already be gone.
    }
    tasksUi = undefined;
    widgetLiveCount = -1;
    widgetArtifactCount = -1;
    lastRenderedLive = -1;
    lastRenderedArtifacts = -1;
    lastRenderedSubagents = -1;
    subagentRoster.clear();
    widgetScanInFlight = false;
    try {
      await runtime.dispose();
    } catch {
      // Disposed gracefully
    }
    // Escalate: any signalled group that still holds members ignored its
    // SIGTERM — force it now. -pgid addresses the group, so a dead leader's
    // pid can never be confused with a reused process. Recorded orphans go
    // through signalVerifiedAgyOrphans again — identity is re-checked, never
    // inherited from the earlier sweep.
    try {
      for (const pgid of await agyGroupSurvivors(sweepTargets)) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // Group already gone.
        }
      }
    } catch {
      // Escalation scan failed; killAllAgyTrees still runs.
    }
    signalVerifiedAgyOrphans("SIGKILL");
    // Sweep any remaining tracked agy process trees (including earlier turns
    // that finished logically while grandchildren held stdio open).
    killAllAgyTrees();
  });

  pi.registerCommand("agy", {
    description: "Show agy status, or persistently toggle Pi tools with tools [on|off|status]",
    getArgumentCompletions: (prefix) =>
      ["tools", "tools on", "tools off", "tools status"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [action, ...rest] = args.trim().split(/\s+/);
      if (action === "tools") return handleAgyToolsCommand(rest.join(" "), ctx);
      if (args.trim()) {
        ctx.ui.notify(
          'antigravity: use "/agy-tools", "/m", "/boost", "/teamwork", "/agy-reset", "/agy-models", "/agy-agents", "/agy-doctor", "/agy-subagents", "/agy-tasks", "/agy-artifacts", or "/agy-usage".',
          "error",
        );
        return;
      }
      const snapshot = await runAntigravity(runtime, service.snapshot);
      const id = snapshot.conversationId;
      if (id) await syncSessionNameToAgy(ctx, id);
      const piSessionName = probeCtx(() => ctx.sessionManager.getSessionName()?.trim());
      const metadata = id ? await readAgyConversationMetadata(id) : undefined;
      const metadataTitle =
        (!piSessionName.stale && piSessionName.value ? statusOneLine(piSessionName.value) : undefined) ??
        (metadata?.metadata?.title ? statusOneLine(metadata.metadata.title) : undefined);
      const title = metadataTitle || (id ? id.slice(0, 12) : "none — next turn starts fresh");
      const updated = metadata?.metadata?.updatedAt
        ? new Date(metadata.metadata.updatedAt).toLocaleString()
        : undefined;
      const details = [
        `model: ${snapshot.model ?? "unselected"}`,
        `turns: ${snapshot.turns}`,
        `driver: ${snapshot.executor.mode}/${snapshot.executor.state}${snapshot.executor.pid ? ` pid=${snapshot.executor.pid}` : ""}`,
        observedContextTokens === undefined
          ? undefined
          : `native context: ~${formatAgyContextTokens(observedContextTokens)}/${formatAgyContextTokens(AGY_PI_SCHEDULING_CONTEXT_WINDOW)}`,
        metadata?.metadata?.numSteps === undefined
          ? undefined
          : `native steps: ${metadata.metadata.numSteps}`,
        updated ? `updated: ${updated}` : undefined,
      ].filter((part): part is string => part !== undefined);
      let profile = "agent: none · mode: default";
      try {
        const configured = readAgyProcessProfile();
        const agent = getToolMode() === "pi" ? piToolsAgent.name : configured.agent;
        const boostState = ` · boost: ${sessionBoostMode ? "ON" : "OFF"} · teamwork: ${isTeamworkActive() ? "ON" : "OFF"}`;
        profile = `agent: ${agent ?? "none"} · mode: ${configured.mode ?? "default"} · tools: ${getToolMode()}${boostState}`;
      } catch (error) {
        profile = `profile error: ${error instanceof Error ? error.message : String(error)}`;
      }
      ctx.ui.notify(
        `antigravity: ${title}\nconversation: ${id ?? "none"}\n${details.join(" · ")}\n${profile}`,
        "info",
      );
    },
  });

  pi.registerCommand("agy-tools", {
    description: "Toggle and save Pi tools, or use on, off, or status",
    getArgumentCompletions: (prefix) =>
      ["on", "off", "status"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: handleAgyToolsCommand,
  });

  async function handleAgyToolsCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const action = resolveAgyToolModeCommand(args, getToolMode());
    const notifyStatus = () => {
      refreshToolModeStatus(ctx);
      ctx.ui.notify(
        `antigravity: Pi tools ${getToolMode() === "pi" ? "ON (pi)" : "OFF (native)"}.`,
        "info",
      );
    };
    if (action === undefined) {
      ctx.ui.notify(
        'agy-tools: usage "/agy-tools [on|off|status]"; no argument toggles the mode.',
        "error",
      );
      return;
    }
    if (action === "status") {
      notifyStatus();
      return;
    }
    await ctx.waitForIdle();
    const session = probeCtx(() => ({ cwd: ctx.cwd, provider: ctx.model?.provider }));
    if (session.stale) return;
    if (switchingToolMode) {
      ctx.ui.notify("antigravity: a tool-mode switch is already in progress.", "info");
      return;
    }
    const previous = getToolMode();
    const next = args.trim() ? action : previous === "pi" ? "native" : "pi";
    if (next === previous) {
      try {
        await saveAgyToolMode(next);
        notifyStatus();
      } catch (error) {
        ctx.ui.notify(
          `antigravity: could not save tool mode (${error instanceof Error ? error.message : String(error)}).`,
          "error",
        );
      }
      return;
    }
    try {
      validateToolMode(next);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }
    switchingToolMode = true;
    try {
      const previousConversationId = await captureActiveConversationId();
      await runAntigravity(runtime, service.setSession(session.value.cwd, undefined, true));
      detachConversationMetadata(previousConversationId);
      appendConversationReset(ctx);
      subagentRoster.clear();
      setAgyTasksWidget(0);
      setAgyArtifactsWidget(0);
      await teardownBridge();
      toolMode = next;
      refreshSkillTools();
      if (session.value.provider === "antigravity") await ensureBridgeRegistered(ctx.ui);
      bridge.refreshTools();
      await saveAgyToolMode(next);
      notifyStatus();
    } catch (error) {
      toolMode = previous;
      refreshSkillTools();
      let message = error instanceof Error ? error.message : String(error);
      try {
        await teardownBridge();
        if (session.value.provider === "antigravity") await ensureBridgeRegistered(ctx.ui);
        bridge.refreshTools();
      } catch (restoreError) {
        message += `; restoring ${previous} mode also failed: ${
          restoreError instanceof Error ? restoreError.message : String(restoreError)
        }`;
      }
      ctx.ui.notify(
        `antigravity: failed to switch tools; mode remains ${previous} (${message}).`,
        "error",
      );
    } finally {
      switchingToolMode = false;
      refreshToolModeStatus(ctx);
    }
  }

  pi.registerCommand("agy-reset", {
    description: "Drop the agy conversation and driver; next turn starts fresh",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify('agy-reset: usage "/agy-reset".', "error");
        return;
      }
      const previousConversationId = await captureActiveConversationId();
      await runAntigravity(runtime, service.reset);
      detachConversationMetadata(previousConversationId);
      oneShotBoost = false;
      oneShotTeamwork = false;
      teamworkLaunchedThisTurn = false;
      sessionTeamworkMode = false;
      updateOrchestrationStatus(ctx.ui);
      subagentRoster.clear();
      setAgyTasksWidget(0);
      setAgyArtifactsWidget(0);
      renderAgyStatusWidget(true);
      appendConversationReset(ctx);
      ctx.ui.notify("antigravity: conversation reset; next turn starts fresh.", "info");
    },
  });

  pi.registerCommand("clear", {
    description: "Clear conversation and start a new one",
    handler: async (args, ctx) => {
      const previousConversationId = await captureActiveConversationId();
      await runAntigravity(runtime, service.reset);
      detachConversationMetadata(previousConversationId);
      oneShotBoost = false;
      oneShotTeamwork = false;
      teamworkLaunchedThisTurn = false;
      sessionTeamworkMode = false;
      updateOrchestrationStatus(ctx.ui);
      subagentRoster.clear();
      setAgyTasksWidget(0);
      setAgyArtifactsWidget(0);
      renderAgyStatusWidget(true);
      const result = await ctx.newSession();
      if (result.cancelled) return;
      const initialPrompt = args.trim();
      if (initialPrompt) {
        pi.sendUserMessage(initialPrompt);
      } else {
        ctx.ui.notify("✓ Cleared conversation and started a new session.", "info");
      }
    },
  });

  pi.registerCommand("rename", {
    description: "Set session display name (alias for /name)",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        const currentName = pi.getSessionName()?.trim() ?? ctx.sessionManager.getSessionName()?.trim();
        if (currentName) {
          ctx.ui.notify(`Session name: ${currentName}`, "info");
        } else {
          ctx.ui.notify("Usage: /rename <name>", "warning");
        }
        return;
      }
      pi.setSessionName(name);
      const sessionName = pi.getSessionName() ?? ctx.sessionManager.getSessionName();
      if (sessionName && sessionName !== name) {
        ctx.ui.notify(
          `Session name was normalized from ${JSON.stringify(name)} to ${JSON.stringify(sessionName)}`,
          "warning",
        );
      }
      await syncSessionNameToAgy(ctx);
      ctx.ui.notify(`Session name set: ${sessionName ?? name}`, "info");
    },
  });

  pi.registerCommand("agy-models", {
    description: "Re-discover models from `agy models` and re-register the provider",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify('agy-models: usage "/agy-models".', "error");
        return;
      }
      const refreshed = await discoverModels(true);
      currentCache = refreshed;
      registerAntigravityProvider(refreshed.models);
      ctx.ui.notify(
        `antigravity: ${refreshed.models.length} models registered (${refreshed.source}).`,
        "info",
      );
    },
  });

  pi.registerCommand("agy-agents", {
    description: "List configured custom agy agents",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify('agy-agents: usage "/agy-agents".', "error");
        return;
      }
      try {
        const agents = parseAgyAgents(await execAgy(["agents"]));
        ctx.ui.notify(
          agents.length > 0
            ? `antigravity custom agents:\n${agents.map((agent) => `• ${agent}`).join("\n")}`
            : "antigravity: no custom agents configured.",
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `antigravity: failed to list agents (${error instanceof Error ? error.message : String(error)}).`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("agy-doctor", {
    description: "Diagnose binary, models, driver, bridge, and conversation state",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify('agy-doctor: usage "/agy-doctor".', "error");
        return;
      }
      const lines = ["antigravity doctor"];
      const binary = await checkAgyBinary({ refresh: true });
      if (binary.ok) {
        lines.push(
          `binary: ${binary.binary} (${binary.version}, ${binary.source})`,
          `binary selection: ${binary.selectionReason ?? "compatible candidate"}`,
          `minimum: ${MIN_AGY_VERSION}`,
        );
        if (isBelowRecommendedAgy(binary.version)) {
          lines.push(
            `binary: WARN agy ${binary.version} < recommended ${RECOMMENDED_AGY_VERSION} (stall retry, empty-file and artifact-path fixes); run \`agy update\`.`,
          );
        }
      } else {
        lines.push(
          `binary: ERROR [${binary.category}] ${binary.message}`,
          `minimum: ${MIN_AGY_VERSION}`,
        );
      }
      for (const candidate of binary.candidates ?? []) {
        const selected = binary.ok && candidate.binary === binary.binary ? "selected" : "candidate";
        lines.push(
          `binary ${selected}: ${candidate.source} ${candidate.binary} · ${
            candidate.ok
              ? candidate.development
                ? (candidate.version ?? "development")
                : (candidate.version ?? "unknown")
              : `ERROR [${candidate.category ?? "unknown"}]`
          }`,
        );
      }

      try {
        const discovered = normalizeModels(parseAgyModels((await runAgyCommand(["models"])).stdout));
        if (discovered.length === 0) throw new Error("no valid model rows returned");
        currentCache = { fetchedAt: Date.now(), source: "live", models: discovered };
        registerAntigravityProvider(discovered);
        lines.push(`models: ${discovered.length} (live)`);
        const missing = FALLBACK_MODELS.filter((f) => !discovered.some((d) => d.id === f.id));
        if (missing.length > 0) {
          const hint = missing.some((m) => /argon/i.test(m.id))
            ? " (Gemini models may need GEMINI_API_KEY sign-in; fixed in agy 1.4.3)"
            : "";
          lines.push(`models: WARN not in live list: ${missing.map((m) => m.id).join(", ")}${hint}`);
        }
      } catch (error) {
        lines.push(
          `models: ERROR ${error instanceof Error ? error.message : String(error)}; ${currentCache.models.length} cached (${currentCache.source})`,
        );
      }

      let snapshot: AntigravityStateSnapshot | undefined;
      try {
        snapshot = await runAntigravity(runtime, service.snapshot);
        const executor = snapshot.executor;
        const config = executor.config;
        lines.push(
          `driver: ${executor.mode} · ${executor.state}${executor.pid ? ` · pid ${executor.pid}` : ""}`,
          `driver binary: ${config?.binary ?? "none"}${config?.binaryVersion ? ` · ${config.binaryVersion}` : ""}`,
          `driver config: model=${config?.model ?? "none"} effort=${config?.effort ?? "none"} agent=${config?.agent ?? "none"} mode=${config?.mode ?? "default"}`,
        );
        if (executor.stats) {
          const stats = executor.stats;
          const reasons = Object.entries(stats.recycleReasons)
            .map(([reason, count]) => `${reason}=${count}`)
            .join(", ");
          lines.push(
            executor.mode === "persistent"
              ? `driver stats: spawns=${stats.spawnCount} respawns=${Math.max(0, stats.spawnCount - 1)} turns=${stats.submittedTurns} reused=${stats.reusedTurns} recycles=${stats.recycleCount} current=${stats.currentProcessTurns}`
              : `driver stats: one-shot launches=${stats.spawnCount} turns=${stats.submittedTurns}`,
            `driver recycle reasons: ${reasons || "none"}`,
          );
        }
      } catch (error) {
        lines.push(`driver: ERROR ${error instanceof Error ? error.message : String(error)}`);
      }

      const selected = currentCache.models.find((model) => model.id === ctx.model?.id);
      let profile = "agent=none mode=default";
      try {
        const configured = readAgyProcessProfile();
        const agent = getToolMode() === "pi" ? piToolsAgent.name : configured.agent;
        profile = `agent=${agent ?? "none"} mode=${configured.mode ?? "default"} tools=${getToolMode()}`;
        lines.push(
          `selection: ${ctx.model?.id ?? "none"} · effort ${
            resolveAgyModelEffort(
              selected,
              ctx.thinkingLevel === "off"
                ? undefined
                : mapThinkingToEffort(
                    ctx.thinkingLevel as Exclude<typeof ctx.thinkingLevel, "off">,
                  ),
            ) ?? "none"
          }`,
        );
      } catch (error) {
        lines.push(`profile: ERROR ${error instanceof Error ? error.message : String(error)}`);
      }
      lines.push(`profile: ${profile}`);
      lines.push(
        `bridge: enabled=${BRIDGE_ENABLED} running=${bridgeManager.isRunning()} prepared=${bridgeManager.isRegistered()} revision=${bridgeManager.processRevision()}`,
        `bridge discovery: ${bridgeManager.isRegistered() ? mcpConfig.directory : "none"}`,
      );

      const conversationId = snapshot?.conversationId;
      if (conversationId) {
        const [exists, metadata] = await Promise.all([
          agyConversationExists(conversationId),
          readAgyConversationMetadata(conversationId),
        ]);
        lines.push(
          `conversation: ${conversationId} · db ${exists ? "readable" : "missing/unreadable"}`,
          `metadata: ${metadata.status}`,
        );
      } else {
        lines.push("conversation: none", "metadata: not applicable");
      }
      ctx.ui.notify(lines.join("\n"), binary.ok ? "info" : "error");
    },
  });

  pi.registerCommand("agy-tasks", {
    description: "List agy background tasks; `stop <task-id>|stop all` to terminate",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const snapshot = await runAntigravity(runtime, service.snapshot);
      const conversationId = snapshot.conversationId;

      // No arguments: interactive dashboard overlay (x stops, r rescans).
      if (!arg) {
        if (!conversationId) {
          ctx.ui.notify("agy-tasks: no agy conversation in this session yet.", "error");
          return;
        }
        const rescan = () =>
          listAgyTasks(conversationId, {
            sessionCwd: ctx.cwd,
            agyPids: [...getAgyChildrenRegistry().live],
          });
        await openAgyTasksPicker(ctx, rescan);
        updateAgyTasksWidget();
        return;
      }

      const stopMatch = arg.match(/^stop\s+(.+)$/);
      if (!stopMatch) {
        ctx.ui.notify('agy-tasks: usage "/agy-tasks" or "/agy-tasks stop <task-id>|all".', "error");
        return;
      }
      const target = stopMatch[1].trim();
      // `stop all` reaps recorded groups whose agy parent has exited — scoped
      // to the identity-verified registry, not to the task list, so missing
      // or deleted task logs never block it. With no live conversation (a
      // /agy reset cleared the snapshot, not the registry) the sweep runs
      // unscoped: every recorded group is this pi's own work either way.
      // protectAttached keeps still-attached groups safe in both cases —
      // they may be a foreground command under a running driver. Per-task
      // stops can never do this: nothing binds a recorded process to a task.
      const orphanGroups =
        target === "all"
          ? signalVerifiedAgyOrphans("SIGTERM", {
              conversationId,
              protectAttached: true,
            })
          : 0;
      if (!conversationId) {
        ctx.ui.notify(
          orphanGroups > 0
            ? `agy-tasks: reaped ${orphanGroups} recorded orphan group(s).`
            : "agy-tasks: no agy conversation in this session yet.",
          orphanGroups > 0 ? "info" : "error",
        );
        if (orphanGroups > 0) updateAgyTasksWidget();
        return;
      }
      // The task listing is best-effort — a log disappearing mid-scan or a
      // failed `ps` must not block the verified orphan sweep above.
      let tasks: AgyTask[] = [];
      try {
        tasks = await listAgyTasks(conversationId, {
          sessionCwd: ctx.cwd,
          agyPids: [...getAgyChildrenRegistry().live],
        });
      } catch (error) {
        ctx.ui.notify(
          `agy-tasks: task scan failed (${error instanceof Error ? error.message : String(error)}).`,
          "warning",
        );
      }
      const selected =
        target === "all"
          ? tasks.filter(
              (task) =>
                task.pids.length > 0 || task.orphans.length > 0 || task.ambiguous.length > 0,
            )
          : [findAgyTask(tasks, target)].filter(
              (task): task is NonNullable<typeof task> => task !== undefined,
            );
      if (selected.length === 0) {
        ctx.ui.notify(
          orphanGroups > 0
            ? `agy-tasks: no running task "${target}" in this conversation; reaped ${orphanGroups} recorded orphan group(s).`
            : `agy-tasks: no running task "${target}" in this conversation.`,
          orphanGroups > 0 ? "info" : "error",
        );
        if (orphanGroups > 0) updateAgyTasksWidget();
        return;
      }
      const stoppable = selected.filter((task) => agyTaskStopPids(task).length > 0);
      if (stoppable.length === 0 && orphanGroups === 0) {
        ctx.ui.notify(
          `agy-tasks: ${selected.map((task) => task.id).join(", ")} has no provably-owned process (unclear); nothing signalled. Check the process manually before killing.`,
          "warning",
        );
        return;
      }
      const results = await Promise.all(stoppable.map((task) => stopAgyTask(task)));
      const stopped = stoppable.map((task) => task.id).join(", ");
      const skipped = selected.length - stoppable.length;
      const signalled = results.reduce((sum, result) => sum + result.signaled, 0) + orphanGroups;
      ctx.ui.notify(
        `agy-tasks: sent SIGTERM to ${signalled} process(es)${stopped ? ` via ${stopped}` : ""}${orphanGroups > 0 ? `, incl. ${orphanGroups} recorded orphan group(s)` : ""}${skipped > 0 ? `; ${skipped} skipped as unclear` : ""}.`,
        "info",
      );
      updateAgyTasksWidget();
    },
  });

  pi.registerCommand("agy-artifacts", {
    description: "List the agy conversation's artifacts (agent-created files, uploads)",
    handler: async (args, ctx) => {
      const snapshot = await runAntigravity(runtime, service.snapshot);
      const conversationId = snapshot.conversationId;
      if (!conversationId) {
        ctx.ui.notify("agy-artifacts: no agy conversation in this session yet.", "error");
        return;
      }
      const rescan = () => listAgyArtifacts(conversationId);
      const arg = args.trim();

      // `open <name>`: non-interactive open by exact name or unique prefix.
      const openMatch = arg.match(/^open\s+(.+)$/);
      if (openMatch) {
        const artifacts = await rescan();
        const artifact = findAgyArtifact(artifacts, openMatch[1]);
        if (!artifact) {
          ctx.ui.notify(`agy-artifacts: no artifact matching "${openMatch[1]}".`, "error");
          return;
        }
        try {
          await openArtifact(artifact.absolutePath);
          ctx.ui.notify(`agy-artifacts: opened ${artifact.name}`, "info");
        } catch (error) {
          ctx.ui.notify(
            `agy-artifacts: failed to open ${artifact.name} (${error instanceof Error ? error.message : error}).`,
            "error",
          );
        }
        return;
      }
      if (arg) {
        ctx.ui.notify(
          'agy-artifacts: usage "/agy-artifacts" or "/agy-artifacts open <name>".',
          "error",
        );
        return;
      }

      await openAgyArtifactsPicker(ctx, rescan);
    },
  });

  pi.registerCommand("agy-subagents", {
    description: "Interactive dashboard of agy subagents & Boost workers (`list` for text summary)",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg && arg !== "list" && arg !== "text") {
        ctx.ui.notify('agy-subagents: usage "/agy-subagents" or "/agy-subagents list".', "error");
        return;
      }
      const rescan = async () => {
        try {
          const snapshot = await runAntigravity(runtime, service.snapshot);
          if (snapshot.conversationId) {
            await syncAgySubagentRoster(subagentRoster, snapshot.conversationId);
            renderAgyStatusWidget();
          }
        } catch {
          // Best-effort sync
        }
        return [...subagentRoster.values()];
      };
      if (arg === "list" || arg === "text" || !ctx.hasUI) {
        await rescan();
        const report = formatAgySubagents(subagentRoster);
        ctx.ui.notify(
          report ??
            "antigravity: no subagent activity observed this session. Subagents appear here as agy streams invoke_subagent/send_message steps.",
          "info",
        );
        return;
      }
      await openAgySubagentsPicker(ctx, rescan);
      renderAgyStatusWidget();
    },
  });

  pi.registerCommand("agy-usage", {
    description: "Show Antigravity model quotas (weekly and 5-hour limits)",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify('agy-usage: usage "/agy-usage".', "error");
        return;
      }
      await openAgyUsagePicker(ctx, (signal) => fetchAgyUsage({ signal }));
    },
  });

  const toggleCommandCompletions = (prefix: string) =>
    ["on", "off", "status"]
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value }));

  const handleOrchestrationCommand = (
    mode: "boost" | "teamwork",
    args: string,
    ctx: ExtensionCommandContext,
  ): void => {
    const trimmed = args.trim();
    const isBoost = mode === "boost";
    const label = isBoost ? "Boost" : "Teamwork";
    const enabledMessage = isBoost
      ? "Boost mode enabled (multi-agent orchestration)."
      : "Teamwork mode enabled (two-phase prompt crafting + teamwork_preview orchestration).";
    const getActive = () => (isBoost ? isBoostActive() : isTeamworkActive());
    const setActive = (next: boolean) => {
      if (isBoost) {
        sessionBoostMode = next;
        if (!next) oneShotBoost = false;
        if (next) {
          sessionTeamworkMode = false;
          oneShotTeamwork = false;
        }
      } else {
        sessionTeamworkMode = next;
        if (!next) oneShotTeamwork = false;
        if (next) {
          sessionBoostMode = false;
          oneShotBoost = false;
        }
      }
      updateOrchestrationStatus(ctx.ui);
    };

    if (!trimmed) {
      const next = !getActive();
      setActive(next);
      ctx.ui.notify(next ? enabledMessage : `${label} mode disabled.`, "info");
      return;
    }
    if (/^(on|enable|true)$/i.test(trimmed)) {
      setActive(true);
      ctx.ui.notify(enabledMessage, "info");
      return;
    }
    if (/^(off|disable|false)$/i.test(trimmed)) {
      setActive(false);
      ctx.ui.notify(`${label} mode disabled.`, "info");
      return;
    }
    if (/^status$/i.test(trimmed)) {
      ctx.ui.notify(`${label} mode is currently ${getActive() ? "ON" : "OFF"}.`, "info");
      return;
    }

    if (isBoost) {
      oneShotBoost = true;
      sessionTeamworkMode = false;
      oneShotTeamwork = false;
      updateOrchestrationStatus(ctx.ui);
      if (ctx.isIdle()) {
        pi.sendUserMessage(`/boost ${trimmed}`);
      } else {
        pi.sendUserMessage(`/boost ${trimmed}`, { deliverAs: "followUp" });
        ctx.ui.notify("Boost task queued as follow-up.", "info");
      }
      return;
    }

    // Teamwork project run: keep oneShotTeamwork active across Phase 1 Q&A turns
    // until Phase 2 invokes `teamwork_preview` and settles.
    oneShotTeamwork = true;
    sessionBoostMode = false;
    oneShotBoost = false;
    updateOrchestrationStatus(ctx.ui);
    if (ctx.isIdle()) {
      pi.sendUserMessage(`/teamwork ${trimmed}`);
    } else {
      pi.sendUserMessage(`/teamwork ${trimmed}`, { deliverAs: "followUp" });
      ctx.ui.notify("Teamwork project queued as follow-up.", "info");
    }
  };

  const handleBoostCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    handleOrchestrationCommand("boost", args, ctx);
  };
  const handleTeamworkCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    handleOrchestrationCommand("teamwork", args, ctx);
  };

  pi.registerCommand("boost", {
    description: "Toggle Boost multi-agent mode or execute a task with subagent orchestration",
    getArgumentCompletions: toggleCommandCompletions,
    handler: handleBoostCommand,
  });

  pi.registerCommand("agy-boost", {
    description: "Toggle Boost multi-agent mode or execute a task with subagent orchestration (alias for /boost)",
    getArgumentCompletions: toggleCommandCompletions,
    handler: handleBoostCommand,
  });

  pi.registerCommand("teamwork", {
    description:
      "Toggle Teamwork two-phase multi-agent mode or start a project with teamwork_preview orchestration",
    getArgumentCompletions: toggleCommandCompletions,
    handler: handleTeamworkCommand,
  });

  pi.registerCommand("agy-teamwork", {
    description:
      "Toggle Teamwork two-phase multi-agent mode or start a project with teamwork_preview orchestration (alias for /teamwork)",
    getArgumentCompletions: toggleCommandCompletions,
    handler: handleTeamworkCommand,
  });

  const listOtherPiModels = (registry: ExtensionContext["modelRegistry"]) => {
    try {
      return registry.getAvailable().filter((m) => m.provider !== "antigravity");
    } catch {
      return [];
    }
  };

  const handleOtherPiModelConsult = async (
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<boolean> => {
    const trimmed = args.trim();
    const spaceAt = trimmed.search(/\s/);
    if (spaceAt < 0) return false;
    const token = trimmed.slice(0, spaceAt).toLowerCase();
    const prompt = trimmed.slice(spaceAt).trim();
    const match = listOtherPiModels(ctx.modelRegistry).find(
      (m) => `${m.provider}/${m.id}`.toLowerCase() === token || m.id.toLowerCase() === token,
    );
    if (!match || !prompt) return false;

    const label = `Consulted ${match.name || match.id}`;
    const message = `${prompt}\n${label}`;
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the current turn to finish before consulting another pi model.", "warning");
      return true;
    }
    const restoreModel = ctx.model;
    const restoreThinkingLevel = pi.getThinkingLevel();
    try {
      await pi.setModel(match);
    } catch {
      ctx.ui.notify(`Cannot switch to ${match.provider}/${match.id}.`, "error");
      return true;
    }
    oneShotConsult = {
      modelId: match.id,
      effort: undefined,
      restoreModel,
      restoreThinkingLevel,
    };
    if (ctx.hasUI) updateConsultStatus(ctx.ui);
    pi.sendUserMessage(message);
    return true;
  };

  const handleConsultCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (await handleOtherPiModelConsult(args, ctx)) return;
    const parsed = resolveAgyConsultSpec(args, currentCache.models);
    if (!parsed.ok) {
      ctx.ui.notify(parsed.error, "error");
      return;
    }

    const sessionThinking = pi.getThinkingLevel();
    const sessionEffort =
      sessionThinking === "off"
        ? undefined
        : mapThinkingToEffort(sessionThinking as Exclude<typeof sessionThinking, "off">);
    const effectiveEffort =
      parsed.effort ?? resolveAgyModelEffort(parsed.model, sessionEffort);
    const consultLabel = formatAgyConsultLabel(parsed.model, effectiveEffort);
    const userMessageWithConsult = `${parsed.prompt}\n${consultLabel}`;

    if (ctx.isIdle()) {
      let restoreModel: NonNullable<ExtensionContext["model"]> | undefined;
      let restoreThinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]> | undefined;
      if (ctx.model?.provider !== "antigravity") {
        const agyModel = ctx.modelRegistry.find("antigravity", parsed.model.id);
        if (agyModel) {
          restoreModel = ctx.model;
          restoreThinkingLevel = sessionThinking;
          try {
            await pi.setModel(agyModel);
          } catch {
            // Fall through; provider override still applies if antigravity is selected.
          }
        }
      }
      oneShotConsult = {
        modelId: parsed.model.id,
        effort: effectiveEffort,
        restoreModel,
        restoreThinkingLevel,
      };
      if (ctx.hasUI) updateConsultStatus(ctx.ui);
      pi.sendUserMessage(userMessageWithConsult);
    } else {
      pi.sendUserMessage(userMessageWithConsult, { deliverAs: "followUp" });
      ctx.ui.notify(
        `Consult (${parsed.model.id}${effectiveEffort ? ` · ${effectiveEffort}` : ""}) queued as follow-up.`,
        "info",
      );
    }
  };

  const consultCommandOptions = {
    description:
      "One-shot model consult: /m <opus|sonnet|argon|flash>[1|2|3] <prompt> (1=low, 2=mid, 3=high, omit=session thinking)",
    getArgumentCompletions: (argumentPrefix: string) => {
      const probedModelId = activeSessionCtx
        ? probeCtx(() =>
            activeSessionCtx?.model?.provider === "antigravity"
              ? activeSessionCtx.model.id
              : undefined,
          )
        : undefined;
      const currentModelId =
        (probedModelId && !probedModelId.stale ? probedModelId.value : undefined) ??
        (selectedModelKey?.startsWith("antigravity:")
          ? selectedModelKey.slice("antigravity:".length)
          : undefined);
      const agyItems = getAgyConsultCompletions(argumentPrefix, currentCache.models, currentModelId) ?? [];
      const prefix = argumentPrefix.trim().toLowerCase();
      const otherItems = activeSessionCtx
        ? (probeCtx(() => listOtherPiModels(activeSessionCtx!.modelRegistry)).value ?? [])
            .map((m) => ({
              value: `${m.provider}/${m.id} `,
              label: `${m.provider}/${m.id}`,
              description: `${m.name || m.id} · pi model`,
            }))
            .filter(
              (item) =>
                !prefix ||
                item.label.toLowerCase().includes(prefix) ||
                item.description.toLowerCase().includes(prefix),
            )
        : [];
      if (argumentPrefix.includes(" ")) return null;
      const all = [...agyItems, ...otherItems];
      return all.length > 0 ? all : null;
    },
    handler: handleConsultCommand,
  };

  pi.registerCommand("m", consultCommandOptions);
  pi.registerCommand("consult", {
    ...consultCommandOptions,
    description: `${consultCommandOptions.description} (alias for /m)`,
  });
  pi.registerCommand("agy-consult", {
    ...consultCommandOptions,
    description: `${consultCommandOptions.description} (alias for /m)`,
  });
}
