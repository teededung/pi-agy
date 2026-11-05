/**
 * Persistent `agy acp` (Antigravity CLI 1.5.0+) turn executor implementing
 * `AgyTurnExecutor`.
 *
 * Keeps a single warm `agy acp` server alive across turns, switching `model`,
 * `effort` (`thought_level`), `mode`, `readOnlyPermissions`, `systemPrompt`,
 * and `conversationId` (`session/new` / `session/resume`) dynamically over
 * JSON-RPC without respawning. Automatically falls back to `AgyDriverSession`
 * (`stream-json`) if the discovered `agy` binary is older than `1.5.0`.
 */

import { spawn } from "node:child_process";
import { gte, valid } from "semver";
import {
  AcpTurnNormalizer,
  AgyAcpClient,
  AgyAcpRpcError,
  acpUsageToAgyUsage,
  buildAcpAgyArgs,
  buildAcpChildEnvironment,
  extractAcpQuotaSnapshot,
  formatAcpStopError,
  modelsFromAcpSessionState,
  readAcpMcpServersFromDirectory,
  selectAcpPermissionOutcome,
  type AcpAuthMethod,
  type AcpChildProcess,
  type AcpPromptBlock,
  type AcpQuotaSnapshot,
  type AcpSessionNotification,
  type AcpSessionState,
} from "./agy-acp-client.ts";
import type { AgyModelInfo } from "./models.ts";
import {
  killAgyTree,
  trackAgyChild,
  untrackAgyChild,
} from "./agy-children.ts";
import {
  AgyModelEffortFallbackError,
  AgySpawnError,
  AgyStallError,
  canFallbackToLegacyEffortSuffix,
  extractAgyStderrSummary,
  isAgyModelEffortFallbackError,
  rememberLegacyEffortSuffixModel,
  type AgyTurnRequest,
} from "./agy-client.ts";
import { AgyCompatibilityError, checkAgyBinary } from "./agy-diagnostics.ts";
import {
  AgyDriverSession,
  type AgyDriverState,
  type AgyExecutorCloseReason,
  type AgyExecutorSnapshot,
  type AgyProcessConfigSnapshot,
  type AgyRecycleCause,
  type AgyTurnExecutor,
} from "./agy-driver.ts";
import { AgyThoughtTracker } from "./agy-thoughts.ts";
import {
  detachAgyConversationBridgeMetadata,
  prepareAgyConversationBridgeMetadata,
} from "./conversation-metadata.ts";
import type { AgyFinishedReason } from "./events.ts";
import {
  createSlidingDeadline,
  isAgyProgressActivity,
  newTurnOutcome,
  type AgyActivity,
  type AgyTurnOutcome,
  type SlidingDeadline,
} from "./reducer.ts";
import { isAgySubagentTool } from "./subagents.ts";
import {
  agyHasRunningToolProcess,
  agyProbeSubagents,
  recordAgyTaskOrphans,
  recordAgyTaskOrphansAsync,
  type AgySubagentProbeResult,
} from "./tasks.ts";
import { agyToolStepKey, trackActiveToolStep } from "./tool-steps.ts";

export const MIN_ACP_AGY_VERSION = "1.5.0";

const STDERR_LIMIT = 8_192;
const LIFECYCLE_LIMIT = 24;
const CANCEL_GRACE_MS = 1_500;
const TERM_CLOSE_MS = 1_000;
const MAX_OPEN_SESSIONS = 8;
const MAX_TOOL_LIVENESS_GRACES = 12;
const PARKED_POLL_MS = 5_000;

const PROCESS_RECYCLE_CAUSES = new Set<AgyRecycleCause>([
  "binary",
  "cwd",
  "agent",
  "bridge-catalog",
  "mcp-directory",
  "background-task",
]);

interface OpenAcpSessionMeta {
  systemPrompt: string;
  mcpFingerprint: string;
}

interface ActiveAcpTurn {
  generation: number;
  sessionId?: string;
  request: AgyTurnRequest;
  outcome: AgyTurnOutcome;
  normalizer: AcpTurnNormalizer;
  activeTools: Set<string>;
  activeBridgedTools: Set<string>;
  conversationReported: boolean;
  thoughtTracker: AgyThoughtTracker;
  thoughtPollTimer?: NodeJS.Timeout;
  deadline?: SlidingDeadline;
  stallTimer?: NodeJS.Timeout;
  stallGraces: number;
  silenceMs: number;
  stallEpoch: number;
  lastSubagentUpdateMs?: number;
  subagentSpawned?: boolean;
  aborted: boolean;
  cancelTimer?: NodeJS.Timeout;
  abortHandler?: () => void;
  settleError?: (err: unknown) => void;
}

export interface AgyAcpDriverSessionOptions {
  /** Override conversations directory for `AgyThoughtTracker` in tests. */
  conversationsDir?: string;
  /** Override CLI log directory for `AgyThoughtTracker` in tests. */
  logDir?: string;
  /** Override tool-process liveness probe in tests. */
  probeToolProcess?: (pids: number[]) => Promise<boolean>;
  /** Override subagent liveness probe in tests. */
  probeSubagents?: (parentConversationId: string | undefined) => Promise<AgySubagentProbeResult>;
  /** Override cancel grace window before force-killing an unresponsive ACP server. */
  cancelGraceMs?: number;
}

function isBridgedToolName(name: string): boolean {
  return (
    name === "call_mcp_tool" ||
    /^pi__[A-Za-z0-9_]+$/.test(name) ||
    /^mcp_[^_]+_pi__/.test(name) ||
    /\/pi__[A-Za-z0-9_]+$/.test(name)
  );
}

export class AgyAcpDriverSession implements AgyTurnExecutor {
  readonly supportsNativeSystemPrompt = true;
  readonly supportsNativeImages = true;

  #state: AgyDriverState = "idle";
  #child: AcpChildProcess | undefined;
  #client: AgyAcpClient | undefined;
  #config: AgyProcessConfigSnapshot | undefined;
  #openSessions = new Map<string, OpenAcpSessionMeta>();
  #lastConversationId: string | undefined;
  #stderrTail = "";
  #active: ActiveAcpTurn | undefined;
  #queue: Promise<void> = Promise.resolve();
  #generation = 0;
  #lifecycle: string[] = [];
  #shutdown = false;

  #spawnCount = 0;
  #submittedTurns = 0;
  #reusedTurns = 0;
  #recycleCount = 0;
  #currentProcessTurns = 0;
  #recycleReasons = new Map<AgyRecycleCause, number>();
  #lastRecycleReason: AgyRecycleCause | undefined;
  #lastQuota: AcpQuotaSnapshot | undefined;
  #discoveredModels: AgyModelInfo[] | undefined;

  #orphanScanRunning = false;
  #orphanScanPending: { pid: number; conversationId: string } | undefined;
  #orphanScanTail: Promise<void> = Promise.resolve();

  #legacyDriver: AgyDriverSession | undefined;

  readonly #conversationsDir: string | undefined;
  readonly #logDir: string | undefined;
  readonly #probeToolProcess: (pids: number[]) => Promise<boolean>;
  readonly #probeSubagents: (
    parentConversationId: string | undefined,
  ) => Promise<AgySubagentProbeResult>;
  readonly #cancelGraceMs: number;

  constructor(options: AgyAcpDriverSessionOptions = {}) {
    this.#conversationsDir = options.conversationsDir;
    this.#logDir = options.logDir;
    this.#probeToolProcess = options.probeToolProcess ?? agyHasRunningToolProcess;
    this.#probeSubagents = options.probeSubagents ?? agyProbeSubagents;
    this.#cancelGraceMs = options.cancelGraceMs ?? CANCEL_GRACE_MS;
  }

  run(request: AgyTurnRequest): Promise<AgyTurnOutcome> {
    if (this.#shutdown) {
      return Promise.reject(new AgySpawnError("agy ACP driver is shut down.", ""));
    }
    const runNext = () => this.#runWithEffortFallback(request);
    const result = this.#queue.then(runNext, runNext);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  snapshot(): AgyExecutorSnapshot {
    if (this.#legacyDriver) {
      return this.#legacyDriver.snapshot();
    }
    const authMethods = this.#client?.getAuthMethods();
    return {
      mode: "acp",
      state: this.#state,
      pid: this.#child?.pid,
      conversationId: this.#active?.sessionId ?? this.#lastConversationId,
      config: this.#config ? { ...this.#config } : undefined,
      lifecycle: [...this.#lifecycle],
      stats: {
        spawnCount: this.#spawnCount,
        submittedTurns: this.#submittedTurns,
        reusedTurns: this.#reusedTurns,
        recycleCount: this.#recycleCount,
        currentProcessTurns: this.#currentProcessTurns,
        recycleReasons: Object.fromEntries(this.#recycleReasons),
        lastRecycleReason: this.#lastRecycleReason,
      },
      ...(this.#lastQuota ? { acpQuota: { ...this.#lastQuota } } : {}),
      ...(this.#discoveredModels?.length ? { discoveredModels: [...this.#discoveredModels] } : {}),
      ...(authMethods?.length ? { authMethods: [...authMethods] } : {}),
    };
  }

  async authenticate(options?: {
    methodId?: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<{ methodId: string; methodName?: string; authMethods: AcpAuthMethod[] }> {
    if (this.#shutdown) {
      throw new AgySpawnError("agy ACP driver is shut down.", "");
    }
    const binaryInfo = await checkAgyBinary();
    if (!binaryInfo.ok) {
      throw new AgyCompatibilityError(binaryInfo);
    }
    const sem = valid(binaryInfo.version);
    if (!binaryInfo.development && (!sem || !gte(sem, MIN_ACP_AGY_VERSION))) {
      throw new AgySpawnError(
        `agy ${binaryInfo.version ?? "unknown"} does not support ACP authenticate; run \`agy login\` in a terminal.`,
        "",
      );
    }
    if (!this.#child || !this.#client) {
      this.#spawnProcess({
        binary: binaryInfo.binary,
        binaryVersion: binaryInfo.version,
        binaryRevision: binaryInfo.revision,
        cwd: options?.cwd ?? process.cwd(),
      });
    }
    const res = await this.#client!.authenticate(options?.methodId, options?.signal);
    this.#openSessions.clear();
    return res;
  }

  async close(reason: AgyExecutorCloseReason, cause?: AgyRecycleCause): Promise<void> {
    if (reason === "shutdown") this.#shutdown = true;
    if (this.#legacyDriver) {
      await this.#legacyDriver.close(reason, cause);
      return;
    }

    const effectiveCause = cause ?? "unspecified";
    this.#log(`close:${reason}${cause ? `:${cause}` : ""}`);

    // Session-only transitions (model switch, /agy-reset, session restore) do NOT
    // require killing the warm `agy acp` process when idle!
    const needsHardKill =
      reason === "shutdown" ||
      reason === "abort" ||
      PROCESS_RECYCLE_CAUSES.has(effectiveCause);

    const active = this.#active;
    if (active && active.sessionId && this.#client) {
      active.aborted = true;
      this.#client.cancel(active.sessionId);
      if (!needsHardKill) {
        // Wait briefly for cooperative `session/cancel` completion so we can keep
        // the warm ACP process alive even across mid-turn recycles when possible.
        const settled = await this.#waitUntilInactive(this.#cancelGraceMs);
        if (settled) {
          await this.#releaseSessionHandles(cause);
          return;
        }
      }
    } else if (!active && !needsHardKill) {
      await this.#releaseSessionHandles(cause);
      return;
    }

    if (reason === "recycle" && this.#child) {
      this.#recordRecycle(effectiveCause);
    }
    await this.#killProcess(reason === "shutdown" ? "dead" : "idle");
  }

  async #releaseSessionHandles(cause: AgyRecycleCause | undefined): Promise<void> {
    if (cause === "reset" || cause === "conversation-reset" || cause === "session-tree") {
      if (this.#lastConversationId && this.#client) {
        await this.#client.closeSession(this.#lastConversationId);
      }
      this.#openSessions.delete(this.#lastConversationId ?? "");
      this.#lastConversationId = undefined;
    }
  }

  async #runWithEffortFallback(request: AgyTurnRequest): Promise<AgyTurnOutcome> {
    try {
      return await this.#runExclusive(request);
    } catch (error) {
      if (!isAgyModelEffortFallbackError(error) || !canFallbackToLegacyEffortSuffix(request)) {
        throw error;
      }
      rememberLegacyEffortSuffixModel(request.model);
      this.#log(`fallback:legacy-effort-suffix:${request.model}-${request.effort}`);
      return await this.#runExclusive({ ...request, legacyEffortSuffix: true });
    }
  }

  async #runExclusive(request: AgyTurnRequest): Promise<AgyTurnOutcome> {
    if (this.#shutdown) {
      throw new AgySpawnError("agy ACP driver is shut down.", "");
    }
    if (request.signal?.aborted) {
      const aborted = newTurnOutcome();
      aborted.status = "ERROR";
      aborted.error = "agy turn was aborted.";
      aborted.finished = true;
      return aborted;
    }

    let binary = request.binary;
    let binaryVersion: string | undefined;
    let binaryRevision: string | undefined;

    if (!request.spawnOverride && !binary) {
      const checked = await checkAgyBinary({ refresh: false });
      if (!checked.ok) throw new AgyCompatibilityError(checked);
      if (
        !checked.development &&
        valid(checked.version) &&
        !gte(checked.version, MIN_ACP_AGY_VERSION)
      ) {
        this.#log(`fallback:stream-json:${checked.version}`);
        this.#legacyDriver ??= new AgyDriverSession();
        const legacyPrompt = request.systemPromptRelay
          ? [request.systemPromptRelay, request.prompt].filter(Boolean).join("\n\n")
          : request.prompt;
        return this.#legacyDriver.run({ ...request, prompt: legacyPrompt });
      }
      binary = checked.binary;
      binaryVersion = checked.version;
      binaryRevision = checked.revision;
    } else if (!binary) {
      binary = "agy";
    }

    const desiredConfig: AgyProcessConfigSnapshot = {
      binary,
      binaryVersion,
      binaryRevision,
      cwd: request.cwd,
      mcpDirectory: request.mcpDirectory,
      model: request.model,
      effort: request.effort,
      agent: request.agent,
      mode: request.mode,
      readOnlyPermissions: request.readOnlyPermissions,
      bridgeRevision: request.bridgeRevision,
    };

    const recycleCause = this.#processRecycleCause(desiredConfig);
    if (this.#child && recycleCause) {
      this.#log(`recycle:${recycleCause}`);
      this.#recordRecycle(recycleCause);
      await this.#killProcess("idle");
    }

    const reusedProcess = Boolean(this.#child && this.#client);
    if (!this.#child || !this.#client) {
      this.#spawnProcess(desiredConfig, request.spawnOverride);
    } else {
      // Update dynamic turn metadata reflected in `/agy-doctor` without respawning.
      this.#config = desiredConfig;
    }

    const child = this.#child!;
    const client = this.#client!;
    const generation = this.#generation;

    this.#submittedTurns += 1;
    if (reusedProcess && this.#currentProcessTurns > 0) {
      this.#reusedTurns += 1;
    }
    this.#currentProcessTurns += 1;
    this.#state = "running";

    const outcome = newTurnOutcome();
    outcome.conversationId = request.conversationId;
    const normalizer = new AcpTurnNormalizer(outcome);
    const thoughtTracker = new AgyThoughtTracker(
      request.conversationId,
      this.#conversationsDir,
      {
        ...(this.#logDir ? { logDir: this.#logDir } : {}),
        emitThinkingDeltas: false,
      },
    );

    const turn: ActiveAcpTurn = {
      generation,
      sessionId: request.conversationId,
      request,
      outcome,
      normalizer,
      activeTools: new Set(),
      activeBridgedTools: new Set(),
      conversationReported: false,
      thoughtTracker,
      stallGraces: 0,
      silenceMs: 0,
      stallEpoch: 0,
      aborted: false,
    };
    this.#active = turn;

    let settledCid = request.conversationId;
    if (request.conversationId) {
      prepareAgyConversationBridgeMetadata(
        request.conversationId,
        request.agent,
        request.mcpDirectory,
      );
    }

    try {
      return await awaitTurnExecution(
        turn,
        child,
        client,
        {
          openSessions: this.#openSessions,
          cancelGraceMs: this.#cancelGraceMs,
          onConversation: (cid) => {
            settledCid = cid;
            this.#lastConversationId = cid;
            if (!turn.conversationReported) {
              turn.conversationReported = true;
              request.onConversation?.(cid);
            }
          },
          onRearmStall: () => this.#rearmStallTimer(turn),
          onArmOverall: () => this.#armOverallTimer(turn),
          onPollThoughts: () => this.#pollThoughts(turn),
          onEmitSideActivity: (activity) => this.#emitSideActivity(turn, activity),
          onRecordProgress: () => this.#recordProgress(turn),
          onQueueOrphanScan: (cid) => this.#queueOrphanScan(child.pid, cid),
          onForceKillOnCancelTimeout: async () => {
            await this.#killProcess(this.#shutdown ? "dead" : "idle");
          },
          onSessionState: (state) => this.#captureSessionModels(state),
          onQuota: (quota) => {
            this.#lastQuota = quota;
          },
        },
      );
    } catch (error) {
      if (
        outcome.activities.length === 0 &&
        canFallbackToLegacyEffortSuffix(request) &&
        isAgyModelEffortFallbackError(error instanceof Error ? error.message : String(error))
      ) {
        throw new AgyModelEffortFallbackError(
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    } finally {
      this.#cleanupActiveTurn(turn);
      if (settledCid) {
        detachAgyConversationBridgeMetadata(settledCid);
      }
      if (this.#child === child) {
        this.#state = "ready";
      }
    }
  }

  #processRecycleCause(desired: AgyProcessConfigSnapshot): AgyRecycleCause | undefined {
    const current = this.#config;
    if (!current) return undefined;
    if (
      current.binary !== desired.binary ||
      current.binaryRevision !== desired.binaryRevision
    ) {
      return "binary";
    }
    if ((current.cwd ?? "") !== (desired.cwd ?? "")) return "cwd";
    if ((current.agent ?? "") !== (desired.agent ?? "")) return "agent";
    if ((current.mcpDirectory ?? "") !== (desired.mcpDirectory ?? "")) return "mcp-directory";
    if ((current.bridgeRevision ?? "") !== (desired.bridgeRevision ?? "")) return "bridge-catalog";
    return undefined;
  }

  #spawnProcess(config: AgyProcessConfigSnapshot, spawnOverride?: typeof spawn): void {
    const args = buildAcpAgyArgs({
      cwd: config.cwd,
      mcpDirectory: config.mcpDirectory,
      agent: config.agent,
    });
    const runSpawn = spawnOverride ?? spawn;
    const rawChild = runSpawn(config.binary, args, {
      cwd: config.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildAcpChildEnvironment(process.env),
      detached: process.platform !== "win32",
    });
    if (!rawChild.stdin || !rawChild.stdout || !rawChild.stderr) {
      killAgyTree(rawChild);
      throw new AgySpawnError("failed to start agy acp with piped stdio.", "");
    }
    const child = rawChild as AcpChildProcess;
    const generation = ++this.#generation;
    this.#child = child;
    this.#config = config;
    this.#openSessions.clear();
    this.#stderrTail = "";
    this.#spawnCount += 1;
    this.#currentProcessTurns = 0;
    this.#state = "starting";
    trackAgyChild(child);
    this.#log(`spawn:acp:pid=${child.pid ?? "unknown"}`);

    const client = new AgyAcpClient(child, {
      onUpdate: (notification) => this.#onSessionUpdate(generation, notification),
      onPermission: (permReq) => {
        const turn = this.#active;
        // Rearm stall timer while handling permission callback.
        if (turn && turn.generation === generation) {
          this.#rearmStallTimer(turn);
        }
        return selectAcpPermissionOutcome(
          permReq,
          Boolean(turn?.request.readOnlyPermissions),
        );
      },
      onTransportError: (err) => {
        if (generation !== this.#generation) return;
        this.#log(`protocol-error:${err.message.slice(0, 80)}`);
        const turn = this.#active;
        void this.#killProcess("dead").finally(() => {
          turn?.settleError?.(new AgySpawnError(err.message, this.#stderrTail));
        });
      },
    });
    this.#client = client;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (generation !== this.#generation) return;
      this.#stderrTail += chunk;
      if (this.#stderrTail.length > STDERR_LIMIT) {
        this.#stderrTail = this.#stderrTail.slice(-STDERR_LIMIT);
      }
      if (this.#active && this.#active.generation === generation) {
        this.#rearmStallTimer(this.#active);
      }
    });

    child.on("error", (err) => {
      if (generation !== this.#generation) return;
      const stderr = this.#stderrTail;
      this.#detachChild(child, "dead");
      const spawnErr = new AgySpawnError(
        `failed to start agy acp (${err.message}). Install agy 1.5.0+ or set AGY_BINARY.`,
        stderr,
      );
      client.failAll(spawnErr);
      this.#active?.settleError?.(spawnErr);
    });

    child.on("close", (code, signal) => {
      if (generation !== this.#generation) return;
      const stderr = this.#stderrTail;
      this.#detachChild(child, "dead");
      this.#log(`close:${code ?? signal ?? "unknown"}`);
      const tail = extractAgyStderrSummary(stderr);
      const exitErr = new AgySpawnError(
        `agy acp exited with code ${code ?? signal ?? "signal"} before producing a result${
          tail ? `: ${tail}` : ""
        }`,
        stderr,
      );
      client.failAll(exitErr);
      const active = this.#active;
      if (active) {
        const finish = () => active.settleError?.(exitErr);
        if (this.#orphanScanRunning || this.#orphanScanPending) {
          void this.#orphanScanTail.then(finish, finish);
        } else {
          finish();
        }
      }
    });
  }

  #onSessionUpdate(generation: number, notification: AcpSessionNotification): void {
    const turn = this.#active;
    if (!turn || turn.generation !== generation) return;
    if (turn.sessionId && notification.sessionId !== turn.sessionId) return;

    if (!turn.sessionId && notification.sessionId) {
      turn.sessionId = notification.sessionId;
      turn.outcome.conversationId = notification.sessionId;
      turn.thoughtTracker.setConversationId(notification.sessionId);
      this.#lastConversationId = notification.sessionId;
      if (!turn.conversationReported) {
        turn.conversationReported = true;
        turn.request.onConversation?.(notification.sessionId);
      }
    }

    this.#pollThoughts(turn);
    const activities = turn.normalizer.consumeUpdate(notification, (patch) => {
      if (turn.sessionId && this.#client) {
        const merged = this.#client.mergeSessionState(turn.sessionId, patch);
        this.#captureSessionModels(merged);
      }
    });

    for (const activity of activities) {
      if (
        !turn.thoughtTracker.prepareStreamActivity(
          activity,
          turn.outcome.conversationId,
          (side) => this.#emitSideActivity(turn, side),
        )
      ) {
        continue;
      }
      if (activity.type === "tool_start" && isAgySubagentTool(activity.name)) {
        turn.subagentSpawned = true;
      }
      const key =
        activity.type === "tool_start" ||
        activity.type === "tool_done" ||
        activity.type === "tool_error"
          ? agyToolStepKey(activity)
          : undefined;
      const repeatedToolStart =
        activity.type === "tool_start" && key !== undefined && turn.activeTools.has(key);
      trackActiveToolStep(turn.activeTools, activity);
      if (key !== undefined) {
        if (activity.type === "tool_start" && isBridgedToolName(activity.name)) {
          turn.activeBridgedTools.add(key);
        } else if (activity.type === "tool_done" || activity.type === "tool_error") {
          turn.activeBridgedTools.delete(key);
        }
      }
      if (
        (activity.type === "tool_start" ||
          activity.type === "tool_done" ||
          activity.type === "tool_error") &&
        this.#child?.pid !== undefined &&
        turn.sessionId
      ) {
        this.#queueOrphanScan(this.#child.pid, turn.sessionId);
      }
      if (isAgyProgressActivity(activity, repeatedToolStart)) {
        this.#recordProgress(turn);
      }
      turn.request.onActivity?.(activity);
    }

    this.#rearmStallTimer(turn);
  }

  #emitSideActivity(turn: ActiveAcpTurn, activity: AgyActivity): void {
    turn.outcome.activities.push(activity);
    if (isAgyProgressActivity(activity)) {
      this.#recordProgress(turn);
    }
    turn.request.onActivity?.(activity);
  }

  #pollThoughts(turn: ActiveAcpTurn): boolean {
    if (this.#active !== turn) return false;
    const cid = turn.sessionId ?? turn.outcome.conversationId;
    const progressed = turn.thoughtTracker.sync(cid, (activity) =>
      this.#emitSideActivity(turn, activity),
    );
    if (progressed) {
      if (turn.thoughtTracker.agentProgressed) {
        this.#recordProgress(turn);
      }
      this.#rearmStallTimer(turn);
    }
    return progressed;
  }

  #recordProgress(turn: ActiveAcpTurn): void {
    turn.deadline?.touch();
    turn.request.onProgress?.();
  }

  #armOverallTimer(turn: ActiveAcpTurn): void {
    const initialMs = turn.request.timeoutMs ?? 0;
    if (initialMs <= 0) return;
    const renewMs = Math.max(initialMs, turn.request.progressTimeoutMs ?? 0);
    if (turn.deadline) {
      turn.deadline.touch();
      return;
    }
    turn.deadline = createSlidingDeadline(
      initialMs,
      () => {
        if (this.#active !== turn) return;
        const secs = Math.round(renewMs / 1000);
        if (turn.sessionId && this.#client) {
          this.#client.cancel(turn.sessionId);
        }
        turn.settleError?.(new AgySpawnError(`agy timed out after ${secs}s`, this.#stderrTail));
      },
      renewMs,
    );
  }

  #stallBudgetMs(turn: ActiveAcpTurn): number {
    const idleMs = turn.request.inactivityTimeoutMs ?? 0;
    if (idleMs <= 0) return 0;
    if (turn.activeTools.size === 0) return idleMs;
    return turn.request.toolInactivityTimeoutMs ?? Math.max(idleMs, 300_000);
  }

  #rearmStallTimer(turn: ActiveAcpTurn): void {
    if (turn.stallTimer) clearTimeout(turn.stallTimer);
    turn.stallTimer = undefined;
    turn.stallGraces = 0;
    turn.silenceMs = 0;
    turn.stallEpoch += 1;
    const budgetMs = this.#stallBudgetMs(turn);
    if (budgetMs <= 0) return;
    const epoch = turn.stallEpoch;
    turn.stallTimer = setTimeout(() => void this.#onStallExpired(turn, budgetMs, epoch), budgetMs);
    turn.stallTimer.unref?.();
  }

  #scheduleGraceCheck(turn: ActiveAcpTurn, remainingMs: number, epoch: number): void {
    const delayMs = Math.min(PARKED_POLL_MS, remainingMs);
    if (turn.stallTimer) clearTimeout(turn.stallTimer);
    turn.stallTimer = setTimeout(
      () => void this.#onStallExpired(turn, delayMs, epoch, remainingMs - delayMs),
      delayMs,
    );
    turn.stallTimer.unref?.();
  }

  async #onStallExpired(
    turn: ActiveAcpTurn,
    budgetMs: number,
    epoch: number,
    graceRemainingMs = 0,
  ): Promise<void> {
    const child = this.#child;
    if (this.#active !== turn || !child || turn.stallEpoch !== epoch) return;
    if (this.#pollThoughts(turn)) return;

    // Never stall-kill `agy acp` while Pi itself is executing a bridged tool
    // (e.g., waiting for user input in `ask_user_question` or running `pi__bash`).
    if (turn.activeBridgedTools.size > 0) {
      turn.silenceMs = 0;
      this.#scheduleGraceCheck(turn, this.#stallBudgetMs(turn), epoch);
      return;
    }

    turn.silenceMs += budgetMs;
    const toolActive = turn.activeTools.size > 0;
    const stale = () => this.#active !== turn || turn.stallEpoch !== epoch;
    const conversationId = turn.sessionId ?? turn.outcome.conversationId;

    const likelyCompacting = turn.thoughtTracker.isLikelyCompacting(toolActive);
    const retrying = turn.thoughtTracker.isRetrying;
    if (
      (turn.thoughtTracker.isGenerating || likelyCompacting || retrying) &&
      (graceRemainingMs > 0 || turn.stallGraces < MAX_TOOL_LIVENESS_GRACES)
    ) {
      if (graceRemainingMs > 0) {
        this.#scheduleGraceCheck(turn, graceRemainingMs, epoch);
        return;
      }
      turn.stallGraces += 1;
      this.#log(
        retrying
          ? `stall:api-retry:${turn.stallGraces}`
          : likelyCompacting
            ? `stall:compacting:${turn.stallGraces}`
            : `stall:db-generating:${turn.stallGraces}`,
      );
      this.#scheduleGraceCheck(turn, this.#stallBudgetMs(turn), epoch);
      return;
    }

    const subagents = await this.#probeSubagents(conversationId).catch(() => ({
      hasAlive: false,
      aliveCount: 0,
      aliveConversationIds: [],
      newestUpdateMs: 0,
    }));
    if (stale()) return;

    if (subagents.hasAlive) {
      turn.subagentSpawned = true;
      if (subagents.newestUpdateMs > (turn.lastSubagentUpdateMs ?? 0)) {
        turn.lastSubagentUpdateMs = subagents.newestUpdateMs;
        turn.stallGraces = 0;
        turn.silenceMs = 0;
        this.#armOverallTimer(turn);
        this.#log(`stall:subagents-alive:progress:${subagents.aliveCount}`);
        this.#scheduleGraceCheck(turn, this.#stallBudgetMs(turn), epoch);
        return;
      }
      if (graceRemainingMs > 0) {
        this.#scheduleGraceCheck(turn, graceRemainingMs, epoch);
        return;
      }
      if (turn.stallGraces < MAX_TOOL_LIVENESS_GRACES) {
        turn.stallGraces += 1;
        this.#log(`stall:subagents-alive:grace:${turn.stallGraces}`);
        this.#scheduleGraceCheck(turn, this.#stallBudgetMs(turn), epoch);
        return;
      }
    }

    if (
      child.pid !== undefined &&
      (graceRemainingMs > 0 || turn.stallGraces < MAX_TOOL_LIVENESS_GRACES)
    ) {
      const working = await this.#probeToolProcess([child.pid]).catch(() => false);
      if (stale()) return;
      if (working) {
        if (graceRemainingMs > 0) {
          this.#scheduleGraceCheck(turn, graceRemainingMs, epoch);
          return;
        }
        turn.stallGraces += 1;
        this.#log(`stall:tool-alive:${turn.stallGraces}`);
        this.#scheduleGraceCheck(turn, this.#stallBudgetMs(turn), epoch);
        return;
      }
    }

    const stallError = new AgyStallError(turn.silenceMs, toolActive);
    this.#log(`stall:expired:${turn.silenceMs}ms`);
    this.#recordRecycle("unspecified");
    await this.#killProcess("idle");
    turn.settleError?.(stallError);
  }

  #cleanupActiveTurn(turn: ActiveAcpTurn): void {
    if (this.#active === turn) {
      this.#active = undefined;
    }
    turn.thoughtTracker.finishCompacting((activity) => this.#emitSideActivity(turn, activity));
    turn.deadline?.clear();
    if (turn.stallTimer) clearTimeout(turn.stallTimer);
    turn.stallTimer = undefined;
    if (turn.thoughtPollTimer) clearInterval(turn.thoughtPollTimer);
    turn.thoughtPollTimer = undefined;
    if (turn.cancelTimer) clearTimeout(turn.cancelTimer);
    turn.cancelTimer = undefined;
    if (turn.abortHandler) {
      turn.request.signal?.removeEventListener("abort", turn.abortHandler);
      turn.abortHandler = undefined;
    }
    turn.thoughtTracker.close();
  }

  #queueOrphanScan(pid: number | undefined, conversationId: string | undefined): void {
    if (pid === undefined || !conversationId) return;
    this.#orphanScanPending = { pid, conversationId };
    if (this.#orphanScanRunning) return;
    this.#orphanScanRunning = true;
    this.#orphanScanTail = (async () => {
      try {
        for (;;) {
          const pending = this.#orphanScanPending;
          this.#orphanScanPending = undefined;
          if (!pending) break;
          await recordAgyTaskOrphansAsync(pending.pid, pending.conversationId);
        }
      } finally {
        this.#orphanScanRunning = false;
      }
    })();
  }

  async #killProcess(nextState: AgyDriverState): Promise<void> {
    const child = this.#child;
    const client = this.#client;
    if (!child) {
      this.#state = nextState;
      return;
    }
    this.#detachChild(child, "stopping");
    client?.failAll(new AgySpawnError("agy acp process was terminated.", this.#stderrTail));
    trackAgyChild(child);
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        child.off("close", finish);
        untrackAgyChild(child);
        resolve();
      };
      const timer = setTimeout(finish, TERM_CLOSE_MS);
      timer.unref?.();
      child.once("close", finish);
      killAgyTree(child);
      try {
        child.kill("SIGKILL");
      } catch {}
      if (child.exitCode !== null || child.signalCode !== null) finish();
    });
    this.#state = nextState;
  }

  #detachChild(child: AcpChildProcess, nextState: AgyDriverState): void {
    if (this.#child !== child) return;
    recordAgyTaskOrphans(
      child.pid,
      this.#active?.sessionId ?? this.#lastConversationId,
    );
    untrackAgyChild(child);
    try {
      child.stdin.destroy();
    } catch {}
    this.#child = undefined;
    this.#client = undefined;
    this.#openSessions.clear();
    this.#currentProcessTurns = 0;
    this.#state = nextState;
    this.#generation += 1;
  }

  #waitUntilInactive(timeoutMs: number): Promise<boolean> {
    if (!this.#active) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (!this.#active) {
          clearInterval(poll);
          resolve(true);
        } else if (Date.now() - started >= timeoutMs) {
          clearInterval(poll);
          resolve(false);
        }
      }, 25);
      poll.unref?.();
    });
  }

  #recordRecycle(cause: AgyRecycleCause): void {
    this.#recycleCount += 1;
    this.#lastRecycleReason = cause;
    this.#recycleReasons.set(cause, (this.#recycleReasons.get(cause) ?? 0) + 1);
  }

  #captureSessionModels(state: AcpSessionState): void {
    const discovered = modelsFromAcpSessionState(state);
    if (discovered?.length) {
      this.#discoveredModels = discovered;
    }
  }

  #log(message: string): void {
    this.#lifecycle.push(`${new Date().toISOString()} ${message}`);
    if (this.#lifecycle.length > LIFECYCLE_LIMIT) this.#lifecycle.shift();
  }
}

async function awaitTurnExecution(
  turn: ActiveAcpTurn,
  _child: AcpChildProcess,
  client: AgyAcpClient,
  hooks: {
    openSessions: Map<string, OpenAcpSessionMeta>;
    cancelGraceMs: number;
    onConversation: (cid: string) => void;
    onRearmStall: () => void;
    onArmOverall: () => void;
    onPollThoughts: () => boolean;
    onEmitSideActivity: (activity: AgyActivity) => void;
    onRecordProgress: () => void;
    onQueueOrphanScan: (cid: string) => void;
    onForceKillOnCancelTimeout: () => Promise<void>;
    onSessionState: (state: AcpSessionState) => void;
    onQuota: (quota: AcpQuotaSnapshot) => void;
  },
): Promise<AgyTurnOutcome> {
  const { request, outcome, normalizer, thoughtTracker } = turn;
  hooks.onArmOverall();
  hooks.onRearmStall();

  turn.thoughtPollTimer = setInterval(() => {
    hooks.onPollThoughts();
  }, 250);
  turn.thoughtPollTimer.unref?.();

  let rejectInterrupt!: (err: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupt = reject;
  });
  turn.settleError = (err) => rejectInterrupt(err);

  const cwd = request.cwd ?? process.cwd();
  const additionalDirectories =
    request.mcpDirectory && request.mcpDirectory !== cwd ? [request.mcpDirectory] : undefined;
  const mcpServers = readAcpMcpServersFromDirectory(request.mcpDirectory);
  const mcpFingerprint = JSON.stringify(mcpServers);

  await Promise.race([client.initialize(request.signal), interrupted]);

  const useNativeSystemPrompt = client.supportsSystemPromptAppend();
  const desiredSystemPrompt = useNativeSystemPrompt ? (request.systemPrompt ?? "") : "";

  let sessionId = request.conversationId;
  if (sessionId) {
    const existing = hooks.openSessions.get(sessionId);
    if (!existing) {
      const resumedState = await Promise.race([
        client.resumeSession(
          {
            sessionId,
            cwd,
            additionalDirectories,
            mcpServers,
            ...(desiredSystemPrompt ? { systemPromptAppend: desiredSystemPrompt } : {}),
          },
          request.signal,
        ),
        interrupted,
      ]);
      hooks.onSessionState(resumedState);
      rememberOpenSession(hooks.openSessions, client, sessionId, {
        systemPrompt: desiredSystemPrompt,
        mcpFingerprint,
      });
    } else if (
      existing.systemPrompt !== desiredSystemPrompt ||
      existing.mcpFingerprint !== mcpFingerprint
    ) {
      // Refresh in-memory ACP session handle when system instructions or MCP servers
      // changed while preserving `<sessionId>.db` on disk.
      await Promise.race([client.closeSession(sessionId, request.signal), interrupted]);
      const resumedState = await Promise.race([
        client.resumeSession(
          {
            sessionId,
            cwd,
            additionalDirectories,
            mcpServers,
            ...(desiredSystemPrompt ? { systemPromptAppend: desiredSystemPrompt } : {}),
          },
          request.signal,
        ),
        interrupted,
      ]);
      hooks.onSessionState(resumedState);
      rememberOpenSession(hooks.openSessions, client, sessionId, {
        systemPrompt: desiredSystemPrompt,
        mcpFingerprint,
      });
    }
  } else {
    const created = await Promise.race([
      client.newSession(
        {
          cwd,
          additionalDirectories,
          mcpServers,
          ...(desiredSystemPrompt ? { systemPromptAppend: desiredSystemPrompt } : {}),
        },
        request.signal,
      ),
      interrupted,
    ]);
    sessionId = created.sessionId;
    hooks.onSessionState(created);
    rememberOpenSession(hooks.openSessions, client, sessionId, {
      systemPrompt: desiredSystemPrompt,
      mcpFingerprint,
    });
  }

  turn.sessionId = sessionId;
  outcome.conversationId = sessionId;
  thoughtTracker.setConversationId(sessionId);
  hooks.onConversation(sessionId);
  hooks.onQueueOrphanScan(sessionId);

  await Promise.race([
    client.configureSession(
      sessionId,
      {
        model: request.model,
        effort: request.effort,
        mode: request.mode,
        readOnlyPermissions: request.readOnlyPermissions,
      },
      request.signal,
    ),
    interrupted,
  ]);
  hooks.onSessionState(client.getSessionState(sessionId));

  const promptText =
    !useNativeSystemPrompt && request.systemPromptRelay
      ? [request.systemPromptRelay, request.prompt].filter(Boolean).join("\n\n")
      : request.prompt;

  const blocks: AcpPromptBlock[] = [];
  if (request.images?.length && client.supportsPromptImages()) {
    for (const img of request.images) {
      if (img.data && img.mimeType) {
        blocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
    }
  }
  blocks.push({ type: "text", text: promptText });

  let resolveAbortedOutcome: ((abortedOutcome: AgyTurnOutcome) => void) | undefined;
  const abortedPromise = new Promise<AgyTurnOutcome>((resolve) => {
    resolveAbortedOutcome = resolve;
  });

  if (request.signal) {
    turn.abortHandler = () => {
      if (turn.aborted) return;
      turn.aborted = true;
      if (turn.sessionId) {
        client.cancel(turn.sessionId);
      }
      turn.cancelTimer = setTimeout(() => {
        void hooks.onForceKillOnCancelTimeout().finally(() => {
          outcome.finished = true;
          outcome.status = "ERROR";
          outcome.error = "agy turn was aborted.";
          resolveAbortedOutcome?.(outcome);
        });
      }, hooks.cancelGraceMs);
      turn.cancelTimer.unref?.();
    };
    request.signal.addEventListener("abort", turn.abortHandler, { once: true });
    if (request.signal.aborted) {
      turn.abortHandler();
    }
  }

  let promptResponse;
  try {
    const winner = await Promise.race([
      client.prompt(sessionId, blocks).then((res) => ({ kind: "prompt" as const, res })),
      abortedPromise.then((res) => ({ kind: "aborted" as const, res })),
      interrupted,
    ]);
    if (winner.kind === "aborted") {
      return winner.res;
    }
    promptResponse = winner.res;
  } catch (err) {
    if (turn.aborted || request.signal?.aborted) {
      outcome.finished = true;
      outcome.status = "ERROR";
      outcome.error = "agy turn was aborted.";
      return outcome;
    }
    if (err instanceof AgyAcpRpcError) {
      throw new AgySpawnError(err.message, "");
    }
    throw err;
  }

  if (turn.cancelTimer) {
    clearTimeout(turn.cancelTimer);
    turn.cancelTimer = undefined;
  }

  hooks.onPollThoughts();
  thoughtTracker.flushUnemittedCheckpoints(sessionId, hooks.onEmitSideActivity);

  if (turn.aborted || request.signal?.aborted || promptResponse.stopReason === "cancelled") {
    outcome.finished = true;
    outcome.status = "ERROR";
    outcome.finishedReason = "interrupted";
    outcome.response = normalizer.finalResponseText();
    outcome.error = "agy turn was aborted.";
    return outcome;
  }

  const quota = extractAcpQuotaSnapshot(promptResponse);
  if (quota) {
    hooks.onQuota(quota);
  }

  const turnUsage = acpUsageToAgyUsage(promptResponse);
  if (turnUsage) {
    // Emit per-turn step usage before `result` so `provider.ts` attaches live
    // per-turn context/output token counts directly rather than treating ACP's
    // per-turn counters as cumulative conversation totals.
    const usageActivity: AgyActivity = { type: "usage", usage: turnUsage };
    outcome.activities.push(usageActivity);
    hooks.onRecordProgress();
    request.onActivity?.(usageActivity);
  }

  const stopReason = promptResponse.stopReason || "end_turn";
  const isOk = stopReason === "end_turn";
  const finishedReason: AgyFinishedReason | undefined = isOk
    ? undefined
    : stopReason === "cancelled"
      ? "interrupted"
      : "error";
  const rawErr =
    typeof promptResponse.error === "string"
      ? promptResponse.error
      : typeof promptResponse.error?.message === "string"
        ? promptResponse.error.message
        : undefined;

  const finalText = normalizer.finalResponseText();
  outcome.finished = true;
  outcome.status = isOk ? "OK" : "ERROR";
  outcome.finishedReason = finishedReason;
  outcome.response = finalText;
  outcome.error = isOk
    ? undefined
    : formatAcpStopError(stopReason, rawErr, finalText, quota);

  const resultActivity: AgyActivity = {
    type: "result",
    status: outcome.status,
    ...(finishedReason ? { finishedReason } : {}),
    response: outcome.response,
    error: outcome.error,
  };
  outcome.activities.push(resultActivity);
  request.onActivity?.(resultActivity);

  return outcome;
}

function rememberOpenSession(
  openSessions: Map<string, OpenAcpSessionMeta>,
  client: AgyAcpClient,
  sessionId: string,
  meta: OpenAcpSessionMeta,
): void {
  openSessions.delete(sessionId);
  openSessions.set(sessionId, meta);
  while (openSessions.size > MAX_OPEN_SESSIONS) {
    const oldest = openSessions.keys().next().value;
    if (!oldest) break;
    openSessions.delete(oldest);
    void client.closeSession(oldest);
  }
}
