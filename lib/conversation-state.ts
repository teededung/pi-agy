import { constants as fsConstants, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgyUsage } from "./events.ts";
import type { AgyToolMode } from "./tool-mode.ts";

export const AGY_CONVERSATION_STATE_ENTRY = "pi-agy-conversation-state";

export interface PersistedAgyConversation {
  version: 1;
  kind: "conversation";
  sessionId: string;
  conversationId: string;
  cwd: string;
  modelId: string;
  toolMode?: AgyToolMode;
  /** Bridge discovery belongs to one extension instance. */
  bridgeServer?: string;
  turns: number;
  usage: AgyUsage;
  /** Most recent observed model context footprint (input + cache read). */
  contextTokens?: number;
}

export interface PersistedAgyReset {
  version: 1;
  kind: "reset";
  sessionId: string;
  cwd: string;
}

export type PersistedAgyState = PersistedAgyConversation | PersistedAgyReset;

export function agyConversationDatabasePath(
  conversationId: string,
  homeDirectory = os.homedir(),
): string {
  return path.join(
    homeDirectory,
    ".gemini",
    "antigravity-cli",
    "conversations",
    `${conversationId}.db`,
  );
}

export async function agyConversationExists(
  conversationId: string,
  homeDirectory?: string,
): Promise<boolean> {
  try {
    await fs.access(agyConversationDatabasePath(conversationId, homeDirectory), fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isContextChangingEntry(candidate: SessionEntry): boolean {
  if (candidate.type === "message") {
    const role = (candidate as { message?: { role?: string } }).message?.role;
    // System messages carry system prompt sections and tool declarations (e.g. MCP updates).
    // They are configuration/inventory updates, not conversation turns, and do not invalidate the native agy conversation.
    return role !== "system";
  }
  return (
    candidate.type === "model_change" ||
    candidate.type === "compaction" ||
    candidate.type === "branch_summary" ||
    candidate.type === "custom_message" ||
    candidate.type === "context_edit"
  );
}

function isBoundedString(value: unknown, maxLength = 4_096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseUsage(value: unknown): AgyUsage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const usage: AgyUsage = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "thinking_tokens",
    "cache_read_tokens",
    "total_tokens",
  ] as const) {
    const field = record[key];
    if (field === undefined) continue;
    if (!isNonNegativeNumber(field)) return undefined;
    usage[key] = field;
  }
  return usage;
}

export function parsePersistedAgyState(value: unknown): PersistedAgyState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !isBoundedString(record.sessionId, 256)) return undefined;
  if (!isBoundedString(record.cwd)) return undefined;
  if (record.kind === "reset") {
    return {
      version: 1,
      kind: "reset",
      sessionId: record.sessionId,
      cwd: record.cwd,
    };
  }
  if (record.kind !== "conversation") return undefined;
  if (!isBoundedString(record.conversationId, 256)) return undefined;
  if (!isBoundedString(record.modelId, 256)) return undefined;
  if (record.toolMode !== undefined && record.toolMode !== "native" && record.toolMode !== "pi") {
    return undefined;
  }
  if (!Number.isSafeInteger(record.turns) || (record.turns as number) < 0) return undefined;
  if (record.bridgeServer !== undefined && !isBoundedString(record.bridgeServer, 64)) {
    return undefined;
  }
  const usage = parseUsage(record.usage);
  if (!usage) return undefined;
  if (record.contextTokens !== undefined && !isNonNegativeNumber(record.contextTokens)) {
    return undefined;
  }
  return {
    version: 1,
    kind: "conversation",
    sessionId: record.sessionId,
    conversationId: record.conversationId,
    cwd: record.cwd,
    modelId: record.modelId,
    ...(record.toolMode ? { toolMode: record.toolMode } : {}),
    ...(record.bridgeServer ? { bridgeServer: record.bridgeServer as string } : {}),
    turns: record.turns as number,
    usage,
    contextTokens: record.contextTokens as number | undefined,
  };
}

/**
 * Find a conversation that exactly owns the active Pi session branch.
 *
 * Forked session files inherit custom entries but receive a new session id, so
 * they cannot resume the same mutable agy conversation. Likewise, any Pi
 * context-changing entry after the state marker makes it stale. Harmless
 * labels, UI-only custom entries, and session metadata may follow it.
 */
export function restorableAgyConversation(
  branch: readonly SessionEntry[],
  sessionId: string,
  cwd: string,
  toolMode: AgyToolMode = "native",
  bridgeServer?: string,
): PersistedAgyConversation | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (
      entry.type !== "custom" ||
      (entry.customType !== AGY_CONVERSATION_STATE_ENTRY &&
        entry.customType !== "pi-antigravity-conversation-state")
    ) {
      continue;
    }
    const state = parsePersistedAgyState(entry.data);
    // The newest state marker is authoritative. A reset or malformed marker
    // must not accidentally resurrect an older conversation.
    if (!state || state.kind === "reset") return undefined;
    if ((state.toolMode ?? "native") !== toolMode) return undefined;
    if (state.sessionId !== sessionId || state.cwd !== cwd) return undefined;
    // In Pi tool mode, prepareAgyConversationBridgeMetadata rebinds
    // trajectory_metadata_blob to the current instance's pi-tools-* agent and
    // bridge workspace before spawning, so server rotation across /reload or
    // session resume stays compatible as long as the bridge remains enabled.
    if (
      toolMode === "pi"
        ? Boolean(state.bridgeServer) !== Boolean(bridgeServer)
        : state.bridgeServer !== bridgeServer
    ) {
      return undefined;
    }
    if (branch.slice(index + 1).some(isContextChangingEntry)) {
      return undefined;
    }
    // Reject state markers re-anchored after /compact without a post-compaction
    // turn, or reusing a pre-compaction conversationId.
    let sawMessageSinceCompaction = false;
    let sawCompactionBeforeMarker = false;
    for (let prior = index - 1; prior >= 0; prior -= 1) {
      const priorEntry = branch[prior];
      if (!sawCompactionBeforeMarker && priorEntry.type === "message") {
        sawMessageSinceCompaction = true;
      }
      if (priorEntry.type === "compaction" || priorEntry.type === "branch_summary") {
        if (!sawMessageSinceCompaction) return undefined;
        sawCompactionBeforeMarker = true;
        continue;
      }
      if (
        sawCompactionBeforeMarker &&
        priorEntry.type === "custom" &&
        (priorEntry.customType === AGY_CONVERSATION_STATE_ENTRY ||
          priorEntry.customType === "pi-antigravity-conversation-state")
      ) {
        const priorState = parsePersistedAgyState(priorEntry.data);
        if (
          priorState?.kind === "conversation" &&
          priorState.conversationId === state.conversationId
        ) {
          return undefined;
        }
      }
    }
    return state;
  }
  return undefined;
}
