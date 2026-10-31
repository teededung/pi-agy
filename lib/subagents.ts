/**
 * Subagent roster — folds agy's subagent tool calls into a live list for
 * `/agy-subagents`. agy has no read-only subcommand or slash command for live
 * subagent state (`/subagents` expands to a model turn), so the only zero-token
 * source is the stream itself: `invoke_subagent`/`run_subagent`/
 * `define_subagent`/`browser_subagent` spawns arrive as ordinary tool steps
 * (ACTIVE → DONE/ERROR), `send_message` addresses a spawned agent, and
 * `manage_subagents` carries lifecycle actions (kill/…). Tracking is
 * best-effort: entries describe observed tool activity, not agy's internal
 * hub state.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, visibleWidth } from "@earendil-works/pi-tui";
import { isAgyEditTool, safeRenderDiff } from "./diff.ts";
import type { AgyActivity } from "./reducer.ts";
import { cleanToolOutputLines, formatAgyCall, summarizeAgyResult } from "./render.ts";
import { agyToolStepKey } from "./tool-steps.ts";

export type AgySubagentStatus = "running" | "done" | "error" | "killed";

export interface AgySubagentWorkerEntry {
  conversationId: string;
  name: string;
  typeName?: string;
  status: AgySubagentStatus;
  startedAtMs: number;
  durationSeconds?: number;
  spawnStepIndex?: number;
  lastActivity?: string;
  lastAction?: string;
  lastStepIndex?: number;
  lastUpdatedAtMs?: number;
}

export interface AgySubagentEntry {
  key: string;
  /** Subagent name from the call args, or the tool name when absent. */
  name: string;
  /** Underlying subagent typeName (e.g. `teamwork_preview`, `DeepCoder`, `DeepInvestigator`). */
  typeName?: string;
  /** Tool that produced the entry (`invoke_subagent`, `run_subagent`, …). */
  tool: string;
  status: AgySubagentStatus;
  startedAtMs: number;
  /** Subagent conversation ID when reported in output. */
  conversationId?: string;
  /** agy-reported duration once the step completes. */
  durationSeconds?: number;
  /** Task/prompt summary when the call carried one. */
  detail?: string;
  /** Latest observed step/tool progress from subagent (or nested worker) transcript. */
  lastActivity?: string;
  /** Latest observed action on this root subagent's own transcript. */
  ownLastAction?: string;
  /** Latest observed step index in the active subagent/worker transcript. */
  lastStepIndex?: number;
  /** Timestamp (ms) of the latest transcript/db update in the subagent subtree. */
  lastUpdatedAtMs?: number;
  /** Nested workers spawned by this subagent (e.g. DeepInvestigatorWorkerL0, DeepCoderWorkerL0). */
  workers?: AgySubagentWorkerEntry[];
  /** `send_message` calls addressed to this entry. */
  messages: number;
  error?: string;
}

const SPAWN_TOOLS = new Set([
  "invoke_subagent",
  "run_subagent",
  "define_subagent",
  "browser_subagent",
]);
const MESSAGE_TOOLS = new Set(["send_message"]);
const MANAGE_TOOLS = new Set(["manage_subagents"]);

/** True for tool names in agy's subagent orchestration family. */
export function isAgySubagentTool(name: string): boolean {
  return SPAWN_TOOLS.has(name) || MESSAGE_TOOLS.has(name) || MANAGE_TOOLS.has(name);
}

/** First defined non-empty string among the given keys (agy mixes key casings). */
function pickArg(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function pickSubagentRecord(args: Record<string, unknown>): Record<string, unknown> | undefined {
  let raw = args.Subagents ?? args.subagents;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      // Ignore unparseable JSON string
    }
  }
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "object" && raw[0] !== null) {
    return raw[0] as Record<string, unknown>;
  }
  return undefined;
}

function pickName(args: Record<string, unknown>, tool: string): string {
  const sub = pickSubagentRecord(args);
  if (sub) {
    const name = pickArg(sub, [
      "Role",
      "role",
      "TypeName",
      "typeName",
      "Name",
      "name",
      "Type",
      "type",
    ]);
    if (name) return name;
  }
  return (
    pickArg(args, [
      "Name",
      "name",
      "Subagent",
      "subagent",
      "subagent_name",
      "SubagentName",
      "Agent",
      "agent",
      "Type",
      "type",
      "Role",
      "role",
    ]) ?? tool
  );
}

function pickTypeName(args: Record<string, unknown>): string | undefined {
  const sub = pickSubagentRecord(args);
  if (sub) {
    const typeName = pickArg(sub, ["TypeName", "typeName", "Type", "type", "Subagent", "subagent"]);
    if (typeName) return typeName;
  }
  return pickArg(args, [
    "TypeName",
    "typeName",
    "Type",
    "type",
    "Subagent",
    "subagent",
    "subagent_name",
    "SubagentName",
  ]);
}

function pickDetail(args: Record<string, unknown>): string | undefined {
  const sub = pickSubagentRecord(args);
  const detail = pickArg(sub ?? args, [
    "Prompt",
    "prompt",
    "Task",
    "task",
    "Instruction",
    "instruction",
    "Instructions",
    "Goal",
    "goal",
    "Description",
    "description",
    "Message",
    "message",
  ]);
  return detail?.replace(/\s+/g, " ").slice(0, 120);
}

/** Case-insensitive lookup by subagent name or conversation ID (send/manage steps carry no step id). */
function findByName(
  roster: Map<string, AgySubagentEntry>,
  name: string,
): AgySubagentEntry | undefined {
  const needle = name.toLowerCase();
  for (const entry of roster.values()) {
    if (entry.name.toLowerCase() === needle) return entry;
    if (entry.conversationId && entry.conversationId.toLowerCase() === needle) return entry;
    if (entry.conversationId && needle.startsWith(entry.conversationId.slice(0, 8).toLowerCase())) return entry;
  }
  return undefined;
}

/** Fold one stream activity into the roster; ignores non-tool activities. */
export function trackAgySubagent(
  roster: Map<string, AgySubagentEntry>,
  activity: AgyActivity,
  now = Date.now(),
): void {
  if (
    activity.type !== "tool_start" &&
    activity.type !== "tool_done" &&
    activity.type !== "tool_error"
  ) {
    return;
  }
  const { name: tool, args } = activity;

  if (MESSAGE_TOOLS.has(tool)) {
    if (activity.type !== "tool_start") return;
    const target = pickArg(args, [
      "Recipient",
      "recipient",
      "To",
      "to",
      "Target",
      "target",
      "Subagent",
      "subagent",
      "Name",
      "name",
    ]);
    const entry = target ? findByName(roster, target) : undefined;
    if (entry) entry.messages += 1;
    return;
  }

  if (MANAGE_TOOLS.has(tool)) {
    if (activity.type === "tool_start") {
      const action = (
        pickArg(args, ["Action", "action", "Operation", "operation"]) ?? ""
      ).toLowerCase();
      if (!/kill|stop|terminat|cancel|abort/.test(action)) return;
      const cids = Array.isArray(args.ConversationIds)
        ? (args.ConversationIds as unknown[])
        : Array.isArray(args.conversationIds)
          ? (args.conversationIds as unknown[])
          : undefined;

      if (cids && cids.length > 0) {
        for (const cid of cids) {
          if (typeof cid === "string") {
            const entry = findByName(roster, cid);
            if (entry && entry.status === "running") {
              entry.status = "killed";
              entry.durationSeconds = Math.max(0, (now - entry.startedAtMs) / 1000);
            }
          }
        }
        return;
      }

      const target = pickArg(args, [
        "Name",
        "name",
        "Subagent",
        "subagent",
        "subagent_id",
        "SubagentId",
        "Id",
        "id",
      ]);
      if (target) {
        const entry = findByName(roster, target);
        if (entry && entry.status === "running") {
          entry.status = "killed";
          entry.durationSeconds = Math.max(0, (now - entry.startedAtMs) / 1000);
        }
        return;
      }
      for (const entry of roster.values()) {
        if (entry.status === "running") {
          entry.status = "killed";
          entry.durationSeconds = Math.max(0, (now - entry.startedAtMs) / 1000);
        }
      }
      return;
    }

    if (activity.type === "tool_done" && activity.output && typeof activity.output === "string") {
      try {
        const jsonMatch = activity.output.match(/\[\s*\{.*\}\s*\]/s);
        if (jsonMatch) {
          const list = JSON.parse(jsonMatch[0]);
          if (Array.isArray(list)) {
            for (const item of list) {
              const cid = typeof item.conversationId === "string" ? item.conversationId : undefined;
              const state = typeof item.state === "string" ? item.state.toLowerCase() : undefined;
              if (cid && state) {
                const entry =
                  findByName(roster, cid) ??
                  (typeof item.role === "string" ? findByName(roster, item.role) : undefined);
                if (entry) {
                  if (!entry.conversationId) entry.conversationId = cid;
                  if ((state === "done" || state === "completed") && entry.status === "running") {
                    entry.status = "done";
                    entry.durationSeconds = Math.max(0, (now - entry.startedAtMs) / 1000);
                  } else if ((state === "errored" || state === "error") && entry.status === "running") {
                    entry.status = "error";
                    entry.durationSeconds = Math.max(0, (now - entry.startedAtMs) / 1000);
                  }
                }
              }
            }
          }
        }
      } catch {
        // best effort
      }
    }
    return;
  }

  if (!SPAWN_TOOLS.has(tool)) return;
  const key = agyToolStepKey({ stepId: activity.stepId, name: `${tool}:${pickName(args, tool)}` });
  if (activity.type === "tool_start") {
    if (!roster.has(key)) {
      const typeName = pickTypeName(args);
      roster.set(key, {
        key,
        name: pickName(args, tool),
        ...(typeName ? { typeName } : {}),
        tool,
        status: "running",
        startedAtMs: now,
        detail: pickDetail(args),
        messages: 0,
      });
    }
    return;
  }
  const entry = roster.get(key);
  if (!entry) return;
  if (activity.type === "tool_done") {
    if (entry.status === "running" && tool === "define_subagent") {
      entry.status = "done";
      if (entry.durationSeconds === undefined) {
        entry.durationSeconds = activity.durationSeconds;
      }
    }
    if (activity.output && typeof activity.output === "string") {
      const cidMatch = activity.output.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
      if (cidMatch) {
        entry.conversationId = cidMatch[0];
      }
    }
    // Note: Do not set durationSeconds on tool_done for invoke_subagent because
    // the tool returns immediately (~0.2s) while the subagent runs asynchronously in background.
  } else {
    entry.status = "error";
    entry.error = activity.message;
    if (entry.durationSeconds === undefined) {
      entry.durationSeconds = Math.max(0, (now - entry.startedAtMs) / 1000);
    }
  }
}

export function unwrapTranscriptArg(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    let s = trimmed.replace(/\n?<truncated \d+ bytes>[\s\S]*$/i, "\n… (truncated)");
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1);
    } else if (s.startsWith('"') || s.startsWith("'")) {
      s = s.slice(1);
    }
    return s
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

export function unwrapTranscriptArgs(rawArgs: unknown): Record<string, unknown> {
  if (typeof rawArgs !== "object" || rawArgs === null) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawArgs as Record<string, unknown>)) {
    out[k] = unwrapTranscriptArg(v);
  }
  return out;
}

function cleanTranscriptString(raw: unknown): string | undefined {
  const unwrapped = unwrapTranscriptArg(raw);
  if (typeof unwrapped === "number" && Number.isFinite(unwrapped)) return String(unwrapped);
  if (typeof unwrapped !== "string") return undefined;
  const cleaned = unwrapped.replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function describeTranscriptToolCall(toolCall: Record<string, unknown>): string | undefined {
  const name = typeof toolCall.name === "string" ? toolCall.name.trim() : undefined;
  if (!name) return undefined;
  const args =
    typeof toolCall.args === "object" && toolCall.args !== null
      ? (toolCall.args as Record<string, unknown>)
      : {};
  const action =
    cleanTranscriptString(args.toolAction) ??
    cleanTranscriptString(args.toolSummary) ??
    cleanTranscriptString(args.Role) ??
    cleanTranscriptString(args.role);
  if (action) {
    return `${name}: ${action.slice(0, 72)}`;
  }
  const commandLine = cleanTranscriptString(args.CommandLine);
  if (commandLine) {
    return `${name}: ${commandLine.slice(0, 60)}`;
  }
  const target =
    cleanTranscriptString(args.Path) ??
    cleanTranscriptString(args.path) ??
    cleanTranscriptString(args.AbsolutePath) ??
    cleanTranscriptString(args.TargetFile) ??
    cleanTranscriptString(args.DirectoryPath) ??
    cleanTranscriptString(args.SearchPath) ??
    cleanTranscriptString(args.Query);
  if (target) {
    const shortTarget = target.includes("/") ? path.basename(target) || target : target;
    return `${name}: ${shortTarget.slice(0, 60)}`;
  }
  return name;
}

interface SubagentTranscriptSnapshot {
  cid: string;
  role?: string;
  firstStepMs?: number;
  lastStepIndex?: number;
  lastStepMs: number;
  lastAction?: string;
}

function extractCreatedAtMs(raw: string): number | undefined {
  const match = raw.match(/"created_at"\s*:\s*"([^"]+)"/);
  if (!match) return undefined;
  const ms = Date.parse(match[1]!);
  return Number.isFinite(ms) ? ms : undefined;
}

async function readTranscriptTailSnapshot(
  transcriptPath: string,
  cid: string,
  role?: string,
): Promise<SubagentTranscriptSnapshot | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    const stat = await fs.stat(transcriptPath);
    if (stat.size <= 0) return undefined;
    const tailBytes = Math.min(stat.size, 32_768);
    const offset = Math.max(0, stat.size - tailBytes);
    handle = await fs.open(transcriptPath, "r");
    const buf = Buffer.alloc(tailBytes);
    const { bytesRead } = await handle.read(buf, 0, tailBytes, offset);
    let headStepMs: number | undefined;
    if (offset > 0) {
      const headBuf = Buffer.alloc(Math.min(stat.size, 2_048));
      const headRead = await handle.read(headBuf, 0, headBuf.length, 0);
      headStepMs = extractCreatedAtMs(headBuf.toString("utf8", 0, headRead.bytesRead));
    }
    const chunk = buf.toString("utf8", 0, bytesRead);
    if (headStepMs === undefined) {
      headStepMs = extractCreatedAtMs(chunk);
    }
    const rawLines = chunk.split("\n");
    if (offset > 0 && rawLines.length > 1) {
      rawLines.shift();
    }
    let lastStepIndex: number | undefined;
    let lastStepMs: number | undefined;
    let lastAction: string | undefined;

    for (let i = rawLines.length - 1; i >= 0; i -= 1) {
      const line = rawLines[i]!.trim();
      if (!line.startsWith("{")) continue;
      let step: {
        step_index?: unknown;
        type?: unknown;
        created_at?: unknown;
        tool_calls?: unknown;
        content?: unknown;
        thinking?: unknown;
      };
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }
      if (lastStepMs === undefined && typeof step.created_at === "string") {
        const ms = Date.parse(step.created_at);
        if (Number.isFinite(ms)) lastStepMs = ms;
      }
      if (lastStepIndex === undefined && typeof step.step_index === "number") {
        lastStepIndex = step.step_index;
      }
      if (!lastAction) {
        if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
          const firstTool = step.tool_calls[0];
          if (typeof firstTool === "object" && firstTool !== null) {
            lastAction = describeTranscriptToolCall(firstTool as Record<string, unknown>);
          }
        } else if (step.type === "PLANNER_RESPONSE") {
          const text =
            cleanTranscriptString(step.content) ?? cleanTranscriptString(step.thinking);
          if (text) {
            lastAction = text.slice(0, 72);
          }
        }
      }
      if (lastStepIndex !== undefined && lastAction !== undefined && lastStepMs !== undefined) {
        break;
      }
    }

    return {
      cid,
      role,
      firstStepMs: headStepMs,
      lastStepIndex,
      lastStepMs: lastStepMs ?? (stat.mtimeMs || 0),
      lastAction,
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readConversationCompletionMap(
  systemDir: string,
): Promise<{ latestServerRestartMs: number; completedByMessage: Map<string, number> }> {
  let latestServerRestartMs = 0;
  const completedByMessage = new Map<string, number>();
  try {
    const msgDir = path.join(systemDir, "messages");
    const msgFiles = await fs.readdir(msgDir);
    for (const file of msgFiles) {
      if (!file.endsWith(".json") || file === "read.json") continue;
      try {
        const raw = await fs.readFile(path.join(msgDir, file), "utf8");
        const msg = JSON.parse(raw) as {
          sender?: unknown;
          timestamp?: unknown;
          content?: unknown;
        };
        const ts = typeof msg.timestamp === "string" ? Date.parse(msg.timestamp) : NaN;
        const ms = Number.isFinite(ts) ? ts : 0;
        if (
          msg.sender === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("All your subagents and background tasks have been stopped")
        ) {
          latestServerRestartMs = Math.max(latestServerRestartMs, ms);
        } else if (
          typeof msg.sender === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(msg.sender)
        ) {
          const key = msg.sender.toLowerCase();
          completedByMessage.set(key, Math.max(completedByMessage.get(key) ?? 0, ms));
        }
      } catch {
        // Ignore unreadable message files
      }
    }
  } catch {
    // No messages directory yet
  }
  return { latestServerRestartMs, completedByMessage };
}

function resolveSubagentStatusFromDisk(params: {
  currentStatus: AgySubagentStatus;
  diskState?: string;
  doneAtMs?: number;
  newestUpdateMs: number;
  latestServerRestartMs: number;
}): { status: AgySubagentStatus; endMs?: number; stoppedByRestart?: boolean } {
  const { currentStatus, diskState = "", doneAtMs, newestUpdateMs, latestServerRestartMs } = params;
  const upper = diskState.toUpperCase();
  // A subagent that sent its completion message at the end of its transcript
  // finished normally, even if the orchestrator later ran manage_subagents(kill)
  // to clean up the pool or the server restarted afterward.
  const completedCleanly =
    doneAtMs !== undefined && (newestUpdateMs <= 0 || doneAtMs >= newestUpdateMs - 15_000);

  if (completedCleanly || upper.includes("DONE") || upper.includes("COMPLETE")) {
    return {
      status: "done",
      endMs: doneAtMs ?? (newestUpdateMs > 0 ? newestUpdateMs : Date.now()),
    };
  }
  if (upper.includes("ERROR") || upper.includes("FAIL")) {
    return {
      status: "error",
      endMs: newestUpdateMs > 0 ? newestUpdateMs : Date.now(),
    };
  }
  if (upper.includes("KILLED")) {
    return {
      status: "killed",
      endMs: newestUpdateMs > 0 ? newestUpdateMs : Date.now(),
    };
  }
  if (
    currentStatus === "running" &&
    latestServerRestartMs > 0 &&
    newestUpdateMs > 0 &&
    latestServerRestartMs > newestUpdateMs + 1_000
  ) {
    return {
      status: "killed",
      endMs: newestUpdateMs,
      stoppedByRestart: true,
    };
  }
  return { status: currentStatus };
}

/**
 * Synchronize the in-memory subagent roster with agy's on-disk brain directory
 * (`~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/`).
 *
 * Updates each subagent's live step index, active tool description (including
 * nested child workers such as `DeepInvestigatorWorkerL0` / `DeepCoderWorkerL0`),
 * completion state, and server-restart termination state.
 */
export async function syncAgySubagentRoster(
  roster: Map<string, AgySubagentEntry>,
  parentConversationId: string | undefined,
  brainDir = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain"),
): Promise<boolean> {
  if (!parentConversationId) return false;
  let changed = false;

  const parentSystemDir = path.join(brainDir, parentConversationId, ".system_generated");
  const { latestServerRestartMs, completedByMessage } =
    await readConversationCompletionMap(parentSystemDir);

  const diskStates = new Map<
    string,
    {
      state?: string;
      role?: string;
      typeName?: string;
      mtimeMs: number;
      spawnStepIndex?: number;
    }
  >();
  try {
    const subDir = path.join(parentSystemDir, "subagents");
    const subFiles = await fs.readdir(subDir);
    for (const file of subFiles) {
      if (!file.endsWith(".json")) continue;
      const fullPath = path.join(subDir, file);
      try {
        const [raw, stat] = await Promise.all([fs.readFile(fullPath, "utf8"), fs.stat(fullPath)]);
        const parsed = JSON.parse(raw) as {
          conversationId?: unknown;
          state?: unknown;
          spawnStepIndex?: unknown;
          subagentDescriptor?: { role?: unknown; typeName?: unknown };
        };
        if (typeof parsed.conversationId !== "string") continue;
        const cid = parsed.conversationId;
        const role =
          typeof parsed.subagentDescriptor?.role === "string"
            ? parsed.subagentDescriptor.role
            : undefined;
        const typeName =
          typeof parsed.subagentDescriptor?.typeName === "string"
            ? parsed.subagentDescriptor.typeName
            : undefined;
        const state = typeof parsed.state === "string" ? parsed.state : undefined;
        const spawnStepIndex =
          typeof parsed.spawnStepIndex === "number" ? parsed.spawnStepIndex : undefined;
        const mtimeMs = stat.birthtimeMs || stat.mtimeMs || Date.now();
        diskStates.set(cid, { state, role, typeName, mtimeMs, spawnStepIndex });

        let entry = findByName(roster, cid);
        if (!entry && role) entry = findByName(roster, role);
        if (!entry && typeName) entry = findByName(roster, typeName);
        if (entry) {
          if (!entry.conversationId) {
            entry.conversationId = cid;
            changed = true;
          }
          if (typeName && entry.typeName !== typeName) {
            entry.typeName = typeName;
            changed = true;
          }
          if (role && entry.name === typeName && role !== typeName) {
            entry.name = role;
            changed = true;
          }
        } else {
          const name = role ?? typeName ?? "subagent";
          const key = agyToolStepKey({
            stepId: spawnStepIndex,
            name: `invoke_subagent:${name}`,
          });
          roster.set(key, {
            key,
            name,
            ...(typeName ? { typeName } : {}),
            tool: "invoke_subagent",
            status: "running",
            startedAtMs: mtimeMs,
            conversationId: cid,
            messages: 0,
          });
          changed = true;
        }
      } catch {
        // Ignore malformed subagent file
      }
    }
  } catch {
    // No subagents directory yet
  }

  for (const entry of roster.values()) {
    const rootCid = entry.conversationId;
    if (!rootCid) continue;

    const visited = new Set<string>();
    const queue: Array<{
      cid: string;
      role?: string;
      typeName?: string;
      state?: string;
      spawnStepIndex?: number;
      mtimeMs?: number;
      parentCid?: string;
    }> = [{ cid: rootCid, role: entry.name }];
    let bestSnapshot: SubagentTranscriptSnapshot | undefined;
    let newestUpdateMs = entry.lastUpdatedAtMs ?? 0;
    const workers: AgySubagentWorkerEntry[] = [];
    const completionMaps = new Map<
      string,
      { latestServerRestartMs: number; completedByMessage: Map<string, number> }
    >();

    while (queue.length > 0 && visited.size < 128) {
      const current = queue.shift()!;
      if (visited.has(current.cid)) continue;
      visited.add(current.cid);

      const transcriptPath = path.join(
        brainDir,
        current.cid,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      const snap = await readTranscriptTailSnapshot(transcriptPath, current.cid, current.role);
      if (snap) {
        if (current.cid === rootCid) {
          if (snap.firstStepMs && snap.firstStepMs < entry.startedAtMs) {
            entry.startedAtMs = snap.firstStepMs;
          }
          if (snap.lastAction && entry.ownLastAction !== snap.lastAction) {
            entry.ownLastAction = snap.lastAction;
            changed = true;
          }
        }
        newestUpdateMs = Math.max(newestUpdateMs, snap.lastStepMs);
        if (
          !bestSnapshot ||
          snap.lastStepMs > bestSnapshot.lastStepMs ||
          (snap.cid !== rootCid && (snap.lastStepIndex ?? 0) > (bestSnapshot.lastStepIndex ?? 0))
        ) {
          bestSnapshot = snap;
        }
      }

      if (current.cid !== rootCid) {
        const parentInfo = current.parentCid
          ? completionMaps.get(current.parentCid)
          : undefined;
        const workerDoneAtMs = parentInfo?.completedByMessage.get(current.cid.toLowerCase());
        const workerRestartMs = Math.max(
          latestServerRestartMs,
          parentInfo?.latestServerRestartMs ?? 0,
        );
        const workerStartedMs = snap?.firstStepMs ?? current.mtimeMs ?? entry.startedAtMs;
        const workerNewestMs = snap?.lastStepMs ?? current.mtimeMs ?? workerStartedMs;
        const resolved = resolveSubagentStatusFromDisk({
          currentStatus: "running",
          diskState: current.state,
          doneAtMs: workerDoneAtMs,
          newestUpdateMs: workerNewestMs,
          latestServerRestartMs: workerRestartMs,
        });
        const actionSuffix = snap?.lastAction ? ` · ${snap.lastAction}` : "";
        const workerActivity =
          snap?.lastStepIndex !== undefined
            ? `step ${snap.lastStepIndex}${actionSuffix}`
            : snap?.lastAction;
        workers.push({
          conversationId: current.cid,
          name: current.role ?? current.typeName ?? `worker-${current.cid.slice(0, 8)}`,
          typeName: current.typeName,
          status: resolved.status,
          startedAtMs: workerStartedMs,
          durationSeconds:
            resolved.status === "running"
              ? undefined
              : Math.max(0, ((resolved.endMs ?? workerNewestMs) - workerStartedMs) / 1000),
          spawnStepIndex: current.spawnStepIndex,
          lastActivity: workerActivity,
          lastAction: snap?.lastAction,
          lastStepIndex: snap?.lastStepIndex,
          lastUpdatedAtMs: workerNewestMs,
        });
      }

      try {
        const childSystemDir = path.join(brainDir, current.cid, ".system_generated");
        const childSubDir = path.join(childSystemDir, "subagents");
        const childFiles = await fs.readdir(childSubDir);
        const jsonFiles = childFiles.filter((cf) => cf.endsWith(".json"));
        if (jsonFiles.length > 0 && !completionMaps.has(current.cid)) {
          completionMaps.set(current.cid, await readConversationCompletionMap(childSystemDir));
        }
        const childItems: Array<{
          cid: string;
          role?: string;
          typeName?: string;
          state?: string;
          spawnStepIndex?: number;
          mtimeMs: number;
        }> = [];
        for (const cf of jsonFiles) {
          try {
            const fullChildPath = path.join(childSubDir, cf);
            const [raw, stat] = await Promise.all([
              fs.readFile(fullChildPath, "utf8"),
              fs.stat(fullChildPath),
            ]);
            const childRec = JSON.parse(raw) as {
              conversationId?: unknown;
              state?: unknown;
              spawnStepIndex?: unknown;
              subagentDescriptor?: { role?: unknown; typeName?: unknown };
            };
            if (typeof childRec.conversationId === "string") {
              const childRole =
                typeof childRec.subagentDescriptor?.role === "string"
                  ? childRec.subagentDescriptor.role
                  : undefined;
              const childType =
                typeof childRec.subagentDescriptor?.typeName === "string"
                  ? childRec.subagentDescriptor.typeName
                  : undefined;
              childItems.push({
                cid: childRec.conversationId,
                role: childRole ?? childType,
                typeName: childType,
                state: typeof childRec.state === "string" ? childRec.state : undefined,
                spawnStepIndex:
                  typeof childRec.spawnStepIndex === "number"
                    ? childRec.spawnStepIndex
                    : undefined,
                mtimeMs: stat.birthtimeMs || stat.mtimeMs || Date.now(),
              });
            }
          } catch {
            // ignore
          }
        }
        childItems.sort((a, b) => {
          const aAlive = a.state === "SUBAGENT_STATE_ALIVE" ? 0 : 1;
          const bAlive = b.state === "SUBAGENT_STATE_ALIVE" ? 0 : 1;
          if (aAlive !== bAlive) return aAlive - bAlive;
          return (
            (a.spawnStepIndex ?? Number.MAX_SAFE_INTEGER) -
            (b.spawnStepIndex ?? Number.MAX_SAFE_INTEGER)
          );
        });
        for (const item of childItems) {
          queue.push({ ...item, parentCid: current.cid });
        }
      } catch {
        // no nested subagents
      }
    }

    if (workers.length > 0 || (entry.workers && entry.workers.length > 0)) {
      entry.workers = workers;
      changed = true;
    }

    if (newestUpdateMs > (entry.lastUpdatedAtMs ?? 0)) {
      entry.lastUpdatedAtMs = newestUpdateMs;
      changed = true;
    }

    if (bestSnapshot && bestSnapshot.lastStepIndex !== undefined) {
      const workerPrefix =
        bestSnapshot.cid !== rootCid ? `worker ${bestSnapshot.cid.slice(0, 8)} · ` : "";
      const actionSuffix = bestSnapshot.lastAction ? ` · ${bestSnapshot.lastAction}` : "";
      const nextActivity = `${workerPrefix}step ${bestSnapshot.lastStepIndex}${actionSuffix}`;
      if (
        entry.lastActivity !== nextActivity ||
        entry.lastStepIndex !== bestSnapshot.lastStepIndex
      ) {
        entry.lastActivity = nextActivity;
        entry.lastStepIndex = bestSnapshot.lastStepIndex;
        changed = true;
      }
    }

    const disk = diskStates.get(rootCid);
    const doneAtMs = completedByMessage.get(rootCid.toLowerCase());
    const resolved = resolveSubagentStatusFromDisk({
      currentStatus: entry.status,
      diskState: disk?.state,
      doneAtMs,
      newestUpdateMs,
      latestServerRestartMs,
    });
    if (resolved.status !== entry.status) {
      entry.status = resolved.status;
      if (resolved.stoppedByRestart) {
        entry.error = entry.error ?? "stopped by server restart";
      }
      const endMs =
        resolved.endMs ?? (newestUpdateMs > entry.startedAtMs ? newestUpdateMs : Date.now());
      entry.durationSeconds = Math.max(0, (endMs - entry.startedAtMs) / 1000);
      changed = true;
    }
  }

  return changed;
}

export function formatSubagentElapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${m}m`;
}

function formatStepClock(iso: unknown): string {
  if (typeof iso !== "string") return "--:--:--";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "--:--:--";
  const d = new Date(ms);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatDetailedToolCall(toolCall: Record<string, unknown>): string {
  const name = typeof toolCall.name === "string" ? toolCall.name.trim() : "tool";
  const args =
    typeof toolCall.args === "object" && toolCall.args !== null
      ? (toolCall.args as Record<string, unknown>)
      : {};
  const summary =
    cleanTranscriptString(args.toolSummary) ?? cleanTranscriptString(args.toolAction);
  const cmd = cleanTranscriptString(args.CommandLine);
  const filePath =
    cleanTranscriptString(args.AbsolutePath) ??
    cleanTranscriptString(args.TargetFile) ??
    cleanTranscriptString(args.DirectoryPath) ??
    cleanTranscriptString(args.SearchPath);
  const query = cleanTranscriptString(args.Query);
  const sub = pickSubagentRecord(args);
  const subRole = sub
    ? pickArg(sub, ["Role", "role", "TypeName", "typeName", "Name", "name"])
    : undefined;

  const details: string[] = [];
  if (subRole) details.push(subRole);
  if (summary && summary !== subRole) details.push(summary);
  if (cmd) details.push(`$ ${cmd}`);
  else if (filePath) {
    const lineRange =
      args.StartLine || args.EndLine
        ? `:${cleanTranscriptString(args.StartLine) ?? "1"}-${cleanTranscriptString(args.EndLine) ?? ""}`
        : "";
    details.push(`${filePath}${lineRange}`);
  } else if (query) {
    details.push(`"${query}"`);
  }

  return details.length > 0 ? `${name} — ${details.join(" · ")}` : name;
}

interface TranscriptStepRecord {
  step_index?: unknown;
  source?: unknown;
  type?: unknown;
  status?: unknown;
  error?: unknown;
  created_at?: unknown;
  thinking?: unknown;
  content?: unknown;
  tool_calls?: unknown;
}

function parseStepTimestamps(rawContent: string): { durationSeconds?: number; body: string } {
  let body = rawContent.replace(/\r\n?/g, "\n");
  let createdMs: number | undefined;
  let completedMs: number | undefined;
  const createdMatch = body.match(/^Created At:\s*([^\n]+)\n/);
  if (createdMatch) {
    const ms = Date.parse(createdMatch[1]!.trim());
    if (Number.isFinite(ms)) createdMs = ms;
    body = body.slice(createdMatch[0].length);
  }
  const completedMatch = body.match(/^Completed At:\s*([^\n]+)\n?/);
  if (completedMatch) {
    const ms = Date.parse(completedMatch[1]!.trim());
    if (Number.isFinite(ms)) completedMs = ms;
    body = body.slice(completedMatch[0].length);
  }
  const durationSeconds =
    createdMs !== undefined && completedMs !== undefined && completedMs >= createdMs
      ? (completedMs - createdMs) / 1000
      : undefined;
  return { durationSeconds, body: body.trim() };
}

const AGY_TRUNCATED_PREVIEW_HEADER_RE =
  /^The tool's output was truncated due to being too long\.[\s\S]*?Here is a preview with the middle of the output truncated:\s*\n?/i;

const AGY_EDIT_PREAMBLE_RE =
  /^The following changes were made by the \S+ tool to:\s*[^\n]+?\.\s*/i;

const AGY_PROACTIVE_COMMAND_HINT_RE =
  /\s*If relevant,\s*proactively run terminal commands to execute this code for the USER\.\s*Don't ask for permission\.\s*/gi;

function extractSubagentEditDiff(text: string): {
  diff: string;
  added: number;
  removed: number;
} | null {
  const withoutTailTrunc = text.replace(/\n?<truncated \d+ (?:bytes|lines)>[\s\S]*$/i, "");
  const startIdx = withoutTailTrunc.indexOf("[diff_block_start]");
  if (startIdx < 0) return null;
  const afterStart = withoutTailTrunc
    .slice(startIdx + "[diff_block_start]".length)
    .replace(/^\r?\n/, "");
  const endIdx = afterStart.indexOf("[diff_block_end]");
  const diff = (endIdx >= 0 ? afterStart.slice(0, endIdx) : afterStart).trim();
  if (!diff) return null;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { diff, added, removed };
}

function renderThemedToolCard(
  toolCall: Record<string, unknown>,
  genericStep: TranscriptStepRecord | undefined,
  stepBadge: string,
  theme: Theme,
  width: number,
): string[] {
  const toolName = typeof toolCall.name === "string" ? toolCall.name.trim() : "tool";
  const unwrappedArgs = unwrapTranscriptArgs(toolCall.args);
  const summary =
    cleanTranscriptString(unwrappedArgs.toolSummary) ??
    cleanTranscriptString(unwrappedArgs.toolAction);
  const callFormatted = formatAgyCall(toolName, unwrappedArgs, theme);

  let bgToken: "toolPendingBg" | "toolErrorBg" | "toolSuccessBg" = "toolSuccessBg";
  const resultLines: string[] = [];

  if (!genericStep) {
    bgToken = "toolPendingBg";
    resultLines.push(theme.fg("warning", "⏳ running…"));
  } else {
    const rawContent = typeof genericStep.content === "string" ? genericStep.content : "";
    if (rawContent.includes("Tool is running as a background task")) {
      bgToken = "toolPendingBg";
      const taskMatch = rawContent.match(/task-\d+/);
      resultLines.push(
        theme.fg(
          "warning",
          `⏳ running in background${taskMatch ? ` (${taskMatch[0]})` : ""}`,
        ),
      );
    } else {
      const { durationSeconds, body } = parseStepTimestamps(rawContent);
      const isError =
        genericStep.status === "ERROR" ||
        Boolean(genericStep.error) ||
        /Encountered error|The command exited with code [1-9]/i.test(body);
      bgToken = isError ? "toolErrorBg" : "toolSuccessBg";

      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const secs =
        durationSeconds !== undefined ? theme.fg("muted", `(${durationSeconds.toFixed(2)}s)`) : "";

      if ((toolName === "view_file" || toolName === "read_file") && !isError) {
        const rangeMatch = body.match(/Showing lines (\d+)(?: to |-)\s*(\d+)(?: of (\d+))?/i);
        const totalMatch = body.match(/Total Lines:\s*(\d+)/i);
        const totalLines = rangeMatch?.[3] ?? totalMatch?.[1];
        const countLabel = rangeMatch
          ? `lines ${rangeMatch[1]}–${rangeMatch[2]}${totalLines ? ` of ${totalLines}` : ""}`
          : totalLines
            ? `${totalLines} lines`
            : "";
        const statusParts = [icon, countLabel ? theme.fg("muted", countLabel) : "", secs].filter(
          Boolean,
        );
        resultLines.push(statusParts.join(" "));
      } else {
        let cleanedBody = body.replace(AGY_TRUNCATED_PREVIEW_HEADER_RE, "");
        let exitLabel = "";
        if (toolName === "run_command") {
          const exitMatch = cleanedBody.match(/^The command exited with code (\d+)\.\s*/i);
          if (exitMatch) {
            const code = Number(exitMatch[1]);
            cleanedBody = cleanedBody.slice(exitMatch[0].length).replace(/^Output:\s*\n?/i, "");
            if (code !== 0) {
              exitLabel = theme.fg("error", `exit ${code}`);
            }
          }
        }

        if (isAgyEditTool(toolName) && !isError) {
          const extracted = extractSubagentEditDiff(cleanedBody);
          if (extracted) {
            const deltaCounts =
              extracted.added > 0 || extracted.removed > 0
                ? [
                    extracted.added > 0 ? theme.fg("success", `+${extracted.added}`) : "",
                    extracted.removed > 0 ? theme.fg("error", `-${extracted.removed}`) : "",
                  ]
                    .filter(Boolean)
                    .join(" ")
                : "";
            resultLines.push([icon, deltaCounts, secs].filter(Boolean).join(" "));
            const rawDiffLines = safeRenderDiff(extracted.diff, theme)
              .split("\n")
              .filter((line) => !/^\s*\.\.\.\s*$/.test(line.replace(/\x1b\[[0-9;]*m/g, "")));
            const maxDiffLines = 10;
            resultLines.push(...rawDiffLines.slice(0, maxDiffLines));
            if (rawDiffLines.length > maxDiffLines) {
              resultLines.push(
                theme.fg("muted", `… +${rawDiffLines.length - maxDiffLines} diff lines`),
              );
            }
          } else if (/^Created file\s+/i.test(cleanedBody)) {
            resultLines.push([icon, theme.fg("muted", "created file"), secs].filter(Boolean).join(" "));
          } else {
            cleanedBody = cleanedBody
              .replace(AGY_EDIT_PREAMBLE_RE, "")
              .replace(AGY_PROACTIVE_COMMAND_HINT_RE, "")
              .trim();
            resultLines.push([icon, secs].filter(Boolean).join(" "));
            const outputLines = cleanToolOutputLines(cleanedBody).filter(
              (l) => !/^<truncated \d+ (?:bytes|lines)>$/i.test(l.trim()),
            );
            for (const outLine of outputLines.slice(0, 4)) {
              resultLines.push(theme.fg("toolOutput", outLine));
            }
          }
        } else {
          const { counts } = summarizeAgyResult(toolName, cleanedBody);
          const statusParts = [
            icon,
            counts ? theme.fg("muted", counts) : "",
            exitLabel,
            secs,
          ].filter(Boolean);
          resultLines.push(statusParts.join(" "));

          const outputLines = cleanToolOutputLines(cleanedBody).filter(
            (l) => !/^<truncated \d+ (?:bytes|lines)>$/i.test(l.trim()),
          );
          if (outputLines.length > 0 && cleanedBody !== "(no output)") {
            const maxOutputLines = isError ? 6 : 4;
            const shown = outputLines.slice(0, maxOutputLines);
            for (const outLine of shown) {
              resultLines.push(theme.fg(isError ? "error" : "toolOutput", outLine));
            }
            if (outputLines.length > maxOutputLines) {
              resultLines.push(
                theme.fg("muted", `… +${outputLines.length - maxOutputLines} lines`),
              );
            }
          }
        }
      }
    }
  }

  const headerLine = summary ? `${stepBadge} ${theme.fg("muted", summary)}` : stepBadge;
  const cardBody = [callFormatted, ...resultLines].join("\n");
  const card = new Text(cardBody, 1, 0, (s) => theme.bg(bgToken, s));
  return [headerLine, ...card.render(Math.max(16, width))];
}

function renderMarkdownBlock(
  markdownText: string,
  width: number,
  maxLines: number,
  theme: Theme,
  style?: { color?: (text: string) => string; italic?: boolean },
): string[] {
  const md = new Markdown(
    markdownText.trim(),
    2,
    0,
    getMarkdownTheme(),
    style,
  );
  const rendered = md.render(Math.max(16, width));
  while (rendered.length > 0 && rendered[rendered.length - 1]!.trim() === "") {
    rendered.pop();
  }
  if (rendered.length > maxLines) {
    return [
      ...rendered.slice(0, maxLines),
      `  ${theme.fg("dim", `… (+${rendered.length - maxLines} more lines)`)}`,
    ];
  }
  return rendered;
}

async function formatConversationTranscriptLines(
  conversationId: string,
  brainDir: string,
  maxSteps = 250,
  theme?: Theme,
  width = 96,
): Promise<string[]> {
  const transcriptPath = path.join(
    brainDir,
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
  let raw: string;
  try {
    raw = await fs.readFile(transcriptPath, "utf8");
  } catch {
    return [
      theme
        ? theme.fg("muted", "(waiting for transcript steps…)")
        : "(waiting for transcript steps…)",
    ];
  }

  const rawLines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
  const sliced = rawLines.length > maxSteps ? rawLines.slice(rawLines.length - maxSteps) : rawLines;
  const steps: TranscriptStepRecord[] = [];
  for (const line of sliced) {
    try {
      steps.push(JSON.parse(line) as TranscriptStepRecord);
    } catch {
      // skip malformed line
    }
  }

  const out: string[] = [];
  if (rawLines.length > maxSteps) {
    const omittedText = `… (${rawLines.length - maxSteps} earlier steps omitted)`;
    out.push(theme ? theme.fg("dim", omittedText) : omittedText);
  }

  const consumedIndices = new Set<number>();

  for (let i = 0; i < steps.length; i++) {
    if (consumedIndices.has(i)) continue;
    const step = steps[i]!;
    const idx = typeof step.step_index === "number" ? step.step_index : "?";
    const clock = formatStepClock(step.created_at);
    const prefix = `[${clock}] #${idx}`;
    const stepBadge = theme
      ? `${theme.fg("dim", `[${clock}]`)} ${theme.fg("muted", `#${idx}`)}`
      : prefix;

    if (
      (step.type === "SYSTEM_MESSAGE" || step.type === "USER_INPUT") &&
      typeof step.content === "string"
    ) {
      const msgMatch = step.content.match(
        /\[Message\]\s+timestamp=[^\s]+\s+sender=([^\s]+)\s+priority=[^\s]+\s+content=([\s\S]*?)<\/SYSTEM_MESSAGE>/,
      );
      if (msgMatch) {
        const sender = msgMatch[1]!;
        const body = msgMatch[2]!.replace(/\n?<truncated \d+ bytes>[\s\S]*$/i, "\n…").trim();
        if (theme) {
          if (out.length > 0 && out[out.length - 1] !== "") out.push("");
          out.push(`${stepBadge} ${theme.fg("accent", theme.bold(`📩 Message from ${sender}`))}`);
          out.push(...renderMarkdownBlock(body, width, 16, theme));
        } else {
          const oneLineBody = body.replace(/\s+/g, " ");
          out.push(
            `${prefix} 📩 from ${sender}: ${oneLineBody.slice(0, 220)}${oneLineBody.length > 220 ? "…" : ""}`,
          );
        }
      } else if (
        (idx === 0 || step.type === "USER_INPUT") &&
        !step.content.includes("This is a periodic system reminder")
      ) {
        const cleaned = step.content
          .replace(/^[\s\S]*?<SYSTEM_MESSAGE>\s*/i, "")
          .replace(/\s*<\/SYSTEM_MESSAGE>[\s\S]*$/i, "")
          .replace(/\n?<truncated \d+ bytes>[\s\S]*$/i, "\n…")
          .trim();
        if (cleaned) {
          if (theme) {
            if (out.length > 0 && out[out.length - 1] !== "") out.push("");
            out.push(`${stepBadge} ${theme.fg("accent", theme.bold("📋 Task"))}`);
            out.push(...renderMarkdownBlock(cleaned, width, 16, theme));
          } else {
            const oneLineTask = cleaned.replace(/\s+/g, " ");
            out.push(
              `${prefix} 📋 Task: ${oneLineTask.slice(0, 260)}${oneLineTask.length > 260 ? "…" : ""}`,
            );
          }
        }
      }
      continue;
    }

    if (step.type === "PLANNER_RESPONSE") {
      if (typeof step.thinking === "string" && step.thinking.trim()) {
        const cleanedThinking = step.thinking
          .replace(/\n?<truncated \d+ bytes>[\s\S]*$/i, "\n…")
          .trim();
        if (theme) {
          if (out.length > 0 && out[out.length - 1] !== "") out.push("");
          out.push(`${stepBadge} ${theme.fg("muted", "💭 thinking")}`);
          out.push(
            ...renderMarkdownBlock(cleanedThinking, width, 28, theme, {
              color: (t) => theme.fg("thinkingText", t),
              italic: true,
            }),
          );
        } else {
          const thought = cleanedThinking.replace(/\s+/g, " ").trim();
          out.push(`${prefix} 💭 ${thought}`);
        }
      }

      if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
        const validCalls = step.tool_calls.filter(
          (tc): tc is Record<string, unknown> => Boolean(tc && typeof tc === "object"),
        );
        let genericCursor = i + 1;
        for (let callIdx = 0; callIdx < validCalls.length; callIdx++) {
          const tc = validCalls[callIdx]!;
          let pairedGeneric: TranscriptStepRecord | undefined;
          if (genericCursor < steps.length && steps[genericCursor]?.type === "GENERIC") {
            pairedGeneric = steps[genericCursor];
            consumedIndices.add(genericCursor);
            genericCursor += 1;
          }
          const callStepLabel =
            validCalls.length > 1 ? `#${idx}.${callIdx + 1}` : `#${idx}`;
          const callPrefix = `[${clock}] ${callStepLabel}`;
          const callBadge = theme
            ? `${theme.fg("dim", `[${clock}]`)} ${theme.fg("muted", callStepLabel)}`
            : callPrefix;
          if (theme) {
            if (out.length > 0 && out[out.length - 1] !== "") out.push("");
            out.push(
              ...renderThemedToolCard(
                tc,
                pairedGeneric,
                callBadge,
                theme,
                width,
              ),
            );
          } else {
            out.push(`${callPrefix} 🔧 ${formatDetailedToolCall(tc)}`);
          }
        }
      }

      if (typeof step.content === "string" && step.content.trim()) {
        const cleanedContent = step.content
          .replace(/\n?<truncated \d+ bytes>[\s\S]*$/i, "\n…")
          .trim();
        if (theme) {
          if (out.length > 0 && out[out.length - 1] !== "") out.push("");
          out.push(`${stepBadge} ${theme.fg("accent", theme.bold("💬 response"))}`);
          out.push(...renderMarkdownBlock(cleanedContent, width, 40, theme));
        } else {
          const contentLines = cleanedContent
            .replace(/\r\n?/g, "\n")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          if (contentLines.length === 1) {
            out.push(`${prefix} 💬 ${contentLines[0]}`);
          } else if (contentLines.length > 1) {
            out.push(`${prefix} 💬 ${contentLines[0]}`);
            for (const extra of contentLines.slice(1, 12)) {
              out.push(`    ${extra}`);
            }
            if (contentLines.length > 12) {
              out.push(`    … (+${contentLines.length - 12} more lines)`);
            }
          }
        }
      }
      continue;
    }

    if (step.type === "GENERIC" && typeof step.content === "string") {
      if (step.content.includes("Tool is running as a background task")) {
        const taskMatch = step.content.match(/task-\d+/);
        const text = `${prefix} ⏳ Moved to background task ${taskMatch ? taskMatch[0] : ""}`.trim();
        out.push(theme ? theme.fg("warning", text) : text);
      } else if (
        step.status === "ERROR" ||
        /Encountered error|exited with code [1-9]/i.test(step.content)
      ) {
        const cleaned = step.content
          .replace(/^Created At:.*\n?/gm, "")
          .replace(/^Completed At:.*\n?/gm, "")
          .replace(/\s+/g, " ")
          .trim();
        const errLine = `${stepBadge} ⚠️ ${cleaned.slice(0, 220)}${cleaned.length > 220 ? "…" : ""}`;
        out.push(theme ? theme.fg("error", errLine) : errLine);
      }
    }
  }

  return out.length > 0
    ? out
    : [
        theme
          ? theme.fg("muted", "(no transcript steps recorded yet)")
          : "(no transcript steps recorded yet)",
      ];
}

/**
 * Build a readable, live-refreshable progress log for a subagent or worker
 * directly from its on-disk `transcript.jsonl` (plus nested workers when
 * inspecting a parent coordinator subagent).
 */
export async function readAgySubagentProgressLog(
  target: {
    conversationId?: string;
    name: string;
    status: AgySubagentStatus;
    detail?: string;
    error?: string;
    workers?: AgySubagentWorkerEntry[];
  },
  options: {
    brainDir?: string;
    includeWorkers?: boolean;
    theme?: Theme;
    width?: number;
  } = {},
): Promise<string[]> {
  const brainDir =
    options.brainDir ?? path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
  const { theme, width = 96 } = options;
  const lines: string[] = [];

  if (target.detail) {
    if (theme) {
      lines.push(`${theme.fg("accent", theme.bold("Prompt:"))} ${theme.fg("text", target.detail)}`);
    } else {
      lines.push(`Prompt: ${target.detail}`);
    }
  }
  if (target.error) {
    if (theme) {
      lines.push(`${theme.fg("error", theme.bold("Error:"))} ${theme.fg("error", target.error)}`);
    } else {
      lines.push(`Error: ${target.error}`);
    }
  }
  if (!target.conversationId) {
    const waiting = "(waiting for subagent conversation ID…)";
    lines.push(theme ? theme.fg("muted", waiting) : waiting);
    return lines;
  }

  const mainLines = await formatConversationTranscriptLines(
    target.conversationId,
    brainDir,
    250,
    theme,
    width,
  );
  if (lines.length > 0 && mainLines.length > 0 && mainLines[0] !== "") lines.push("");
  lines.push(...mainLines);

  if (options.includeWorkers !== false && target.workers && target.workers.length > 0) {
    for (const worker of target.workers) {
      const elapsed =
        worker.status === "running"
          ? Math.max(0, (Date.now() - worker.startedAtMs) / 1000)
          : (worker.durationSeconds ?? 0);
      lines.push("");
      if (theme) {
        const statusColor =
          worker.status === "running"
            ? "warning"
            : worker.status === "done"
              ? "success"
              : worker.status === "error"
                ? "error"
                : "muted";
        const label = ` Worker: ${worker.name} (${worker.conversationId.slice(0, 8)}) · ${worker.status} · ${formatSubagentElapsed(elapsed)} `;
        const barLen = Math.max(4, width - visibleWidth(label) - 4);
        lines.push(
          theme.fg("border", "━━") +
            theme.fg(statusColor, theme.bold(label)) +
            theme.fg("border", "━".repeat(barLen)),
        );
      } else {
        lines.push(
          `━━ Worker: ${worker.name} (${worker.conversationId.slice(0, 8)}) · ${worker.status} · ${formatSubagentElapsed(elapsed)} ━━`,
        );
      }
      const workerLines = await formatConversationTranscriptLines(
        worker.conversationId,
        brainDir,
        150,
        theme,
        width,
      );
      lines.push(...workerLines);
    }
  }

  return lines;
}

/** Compact one-line summary for the status bar widget. */
export function summarizeAgySubagentsWidget(
  roster: Map<string, AgySubagentEntry>,
  now = Date.now(),
): string | undefined {
  const entries = [...roster.values()];
  if (entries.length === 0) return undefined;
  const running = entries.filter((e) => e.status === "running");
  if (running.length > 0) {
    const active = running[running.length - 1]!;
    const elapsed = formatSubagentElapsed(Math.max(0, (now - active.startedAtMs) / 1000));
    const progress = active.lastActivity ? ` · ${active.lastActivity}` : "";
    return `${running.length} running (${elapsed}${progress})`;
  }
  const latest = entries[entries.length - 1]!;
  const elapsed = formatSubagentElapsed(
    latest.durationSeconds ?? Math.max(0, (now - latest.startedAtMs) / 1000),
  );
  return `${entries.length} tracked (${latest.status} · ${elapsed})`;
}

function formatAgentPreviewLabel(name: string, typeName?: string): string {
  const trimmedName = name.trim() || "subagent";
  const trimmedType = typeName?.trim();
  if (trimmedType && trimmedType.toLowerCase() !== trimmedName.toLowerCase()) {
    return `Agent(${trimmedType}: ${trimmedName})`;
  }
  return `Agent(${trimmedName})`;
}

function cleanAgentPreviewAction(raw?: string): string {
  if (!raw) return "Working";
  const strippedStep = raw
    .replace(/^(?:worker\s+[0-9a-f-]+\s*·\s*)?(?:step\s+\d+\s*(?:·\s*)?)?/i, "")
    .trim();
  const strippedTool = strippedStep.replace(/^[a-z0-9_]+:\s+/i, "").trim();
  return strippedTool || strippedStep || "Working";
}

/**
 * Multi-line live preview rows for running subagents and nested workers
 * (used by both `/boost` and `/teamwork` in the main session widget),
 * matching agy native's `• Agent(typeName: Role) <action> • <elapsed>` stack.
 */
export function formatAgySubagentsLivePreviewLines(
  roster: Map<string, AgySubagentEntry>,
  now = Date.now(),
  theme?: { fg(color: string, text: string): string },
): string[] {
  const lines: string[] = [];
  const pushRow = (
    name: string,
    typeName: string | undefined,
    rawAction: string | undefined,
    startedAtMs: number,
  ) => {
    const label = formatAgentPreviewLabel(name, typeName);
    const action = cleanAgentPreviewAction(rawAction);
    const elapsed = formatSubagentElapsed(Math.max(0, (now - startedAtMs) / 1000));
    lines.push(
      theme
        ? `${theme.fg("accent", "• ")}${theme.fg("text", label)} ${theme.fg("dim", `${action} • ${elapsed}`)}`
        : `• ${label} ${action} • ${elapsed}`,
    );
  };
  for (const entry of roster.values()) {
    const runningWorkers = (entry.workers ?? []).filter((w) => w.status === "running");
    // Render deepest/newest workers first so the stack matches agy native's TUI.
    for (let i = runningWorkers.length - 1; i >= 0; i -= 1) {
      const w = runningWorkers[i]!;
      pushRow(w.name, w.typeName, w.lastAction ?? w.lastActivity, w.startedAtMs);
    }
    if (entry.status === "running") {
      pushRow(
        entry.name,
        entry.typeName,
        entry.ownLastAction ?? entry.lastActivity ?? entry.detail,
        entry.startedAtMs,
      );
    }
  }
  return lines;
}

/** One line per entry plus a header; empty roster returns undefined. */
export function formatAgySubagents(
  roster: Map<string, AgySubagentEntry>,
  now = Date.now(),
): string | undefined {
  const entries = [...roster.values()];
  if (entries.length === 0) return undefined;
  const running = entries.filter((entry) => entry.status === "running").length;
  const lines = [
    `antigravity subagents: ${entries.length} tracked${running ? ` · ${running} running` : ""}`,
  ];
  for (const entry of entries) {
    const elapsed =
      entry.status === "running"
        ? Math.max(0, (now - entry.startedAtMs) / 1000)
        : (entry.durationSeconds ?? Math.max(0, (now - entry.startedAtMs) / 1000));
    const idTag = entry.conversationId ? ` (${entry.conversationId.slice(0, 8)})` : "";
    const parts = [
      `• ${entry.name}${idTag}`,
      entry.status,
      formatSubagentElapsed(elapsed),
      entry.lastActivity,
      entry.messages > 0 ? `${entry.messages} msg${entry.messages === 1 ? "" : "s"}` : undefined,
      entry.detail ? `"${entry.detail}"` : undefined,
      entry.error,
    ].filter((part): part is string => part !== undefined);
    lines.push(parts.join(" · "));
    if (entry.workers && entry.workers.length > 0) {
      for (let i = 0; i < entry.workers.length; i++) {
        const w = entry.workers[i]!;
        const branch = i === entry.workers.length - 1 ? "└─" : "├─";
        const wElapsed =
          w.status === "running"
            ? Math.max(0, (now - w.startedAtMs) / 1000)
            : (w.durationSeconds ?? Math.max(0, (now - w.startedAtMs) / 1000));
        const wParts = [
          `  ${branch} ${w.name} (${w.conversationId.slice(0, 8)})`,
          w.status,
          formatSubagentElapsed(wElapsed),
          w.lastActivity,
        ].filter((part): part is string => part !== undefined);
        lines.push(wParts.join(" · "));
      }
    }
  }
  return lines.join("\n");
}

export const AGY_BTW_INTERCEPT_EVENT = "antigravity:btw-intercept";

export interface AgyBtwInterceptPayload<TCtx = unknown> {
  text: string;
  ctx: TCtx;
  handled?: boolean;
  promise?: Promise<void>;
}

export interface SubagentSteerInterceptCheck {
  source: string;
  streamingBehavior?: string;
  text: string;
  hasImages?: boolean;
  provider?: string;
  agyAgentActive: boolean;
  isBoostActive: boolean;
  isTeamworkActive: boolean;
  subagentSpawnedThisTurn: boolean;
}

/**
 * Return trimmed text when an interactive Enter ("steer") submission during an
 * active Antigravity Boost/Teamwork/subagent turn should be routed to /btw
 * instead of stalling in Pi's steer queue until all subagents finish.
 */
export function shouldInterceptSubagentSteerInput(
  check: SubagentSteerInterceptCheck,
): string | undefined {
  if (check.source !== "interactive" || check.streamingBehavior !== "steer") {
    return undefined;
  }
  if (check.hasImages) {
    return undefined;
  }
  if (check.provider !== "antigravity" || !check.agyAgentActive) {
    return undefined;
  }
  if (!check.isBoostActive && !check.isTeamworkActive && !check.subagentSpawnedThisTurn) {
    return undefined;
  }
  const trimmed = check.text.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("!")) {
    return undefined;
  }
  return trimmed;
}

