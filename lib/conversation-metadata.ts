import { existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const AGY_METADATA_MAX_BYTES = 5 * 1024 * 1024;

export interface AgyConversationMetadata {
  id: string;
  title?: string;
  preview?: string;
  numSteps?: number;
  updatedAt?: string;
  workspaceUris: string[];
  agentName?: string;
}

export type AgyMetadataStatus = "ok" | "missing" | "oversized" | "invalid" | "unreadable";

export interface AgyMetadataResult {
  status: AgyMetadataStatus;
  metadata?: AgyConversationMetadata;
}

export function agyConversationMetadataPath(homeDirectory = os.homedir()): string {
  return path.join(
    homeDirectory,
    ".gemini",
    "antigravity-cli",
    "cache",
    "conversation_metadata.json",
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  const timestamp = boundedString(value, 128);
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
}

export function parseAgyConversationMetadata(
  value: unknown,
  conversationId: string,
): AgyConversationMetadata | undefined {
  const root = record(value);
  const conversations = record(root?.conversations);
  const raw = record(conversations?.[conversationId]);
  const summary = record(raw?.summary) ?? raw;
  if (!summary) return undefined;
  const id = boundedString(summary.ID, 256) ?? boundedString(summary.id, 256);
  if (!id || id !== conversationId) return undefined;

  const numSteps = summary.NumSteps;
  const workspaceUris = Array.isArray(summary.WorkspaceURIs)
    ? summary.WorkspaceURIs.slice(0, 32)
        .map((uri) => boundedString(uri, 4_096))
        .filter((uri): uri is string => uri !== undefined)
    : [];
  return {
    id,
    title: boundedString(summary.Title, 512),
    preview: boundedString(summary.Preview, 2_048),
    numSteps:
      Number.isSafeInteger(numSteps) && (numSteps as number) >= 0
        ? (numSteps as number)
        : undefined,
    updatedAt: validTimestamp(summary.UpdatedAt),
    workspaceUris,
    agentName: boundedString(summary.AgentName, 256),
  };
}

export async function readAgyConversationMetadata(
  conversationId: string,
  options: { file?: string; maxBytes?: number } = {},
): Promise<AgyMetadataResult> {
  const file = options.file ?? agyConversationMetadataPath();
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    return {
      status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable",
    };
  }
  if (!stat.isFile()) return { status: "unreadable" };
  if (stat.size > (options.maxBytes ?? AGY_METADATA_MAX_BYTES)) return { status: "oversized" };

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, "r");
    const limit = options.maxBytes ?? AGY_METADATA_MAX_BYTES;
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > limit) return { status: "oversized" };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
    } catch {
      return { status: "invalid" };
    }
    const parsed = JSON.parse(text) as unknown;
    const metadata = parseAgyConversationMetadata(parsed, conversationId);
    return metadata ? { status: "ok", metadata } : { status: "invalid" };
  } catch (error) {
    return {
      status: error instanceof SyntaxError ? "invalid" : "unreadable",
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function escapePbtxtString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let n = value >>> 0;
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } | undefined {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos]!;
    pos += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, next: pos };
    shift += 7;
    if (shift > 35) return undefined;
  }
  return undefined;
}

function patchProtobufTitleField(buf: Buffer, newTitle: string, patchNestedField15 = false): Buffer {
  const titleBytes = Buffer.from(newTitle, "utf-8");
  const chunks: Buffer[] = [];
  let offset = 0;
  let sawField1 = false;

  while (offset < buf.length) {
    const fieldStart = offset;
    const tagInfo = readVarint(buf, offset);
    if (!tagInfo) return buf;
    const tag = tagInfo.value;
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;
    offset = tagInfo.next;

    if (wireType === 0) {
      const val = readVarint(buf, offset);
      if (!val) return buf;
      offset = val.next;
      chunks.push(buf.subarray(fieldStart, offset));
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) return buf;
      offset += 8;
      chunks.push(buf.subarray(fieldStart, offset));
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) return buf;
      offset += 4;
      chunks.push(buf.subarray(fieldStart, offset));
    } else if (wireType === 2) {
      const lenInfo = readVarint(buf, offset);
      if (!lenInfo || lenInfo.next + lenInfo.value > buf.length) return buf;
      const bodyStart = lenInfo.next;
      const bodyEnd = bodyStart + lenInfo.value;
      offset = bodyEnd;
      if (fieldNumber === 1) {
        sawField1 = true;
        chunks.push(encodeVarint((1 << 3) | 2), encodeVarint(titleBytes.length), titleBytes);
      } else if (patchNestedField15 && fieldNumber === 15) {
        const patchedNested = patchProtobufTitleField(buf.subarray(bodyStart, bodyEnd), newTitle, false);
        chunks.push(
          encodeVarint((15 << 3) | 2),
          encodeVarint(patchedNested.length),
          patchedNested,
        );
      } else {
        chunks.push(buf.subarray(fieldStart, bodyEnd));
      }
    } else {
      return buf;
    }
  }

  if (!sawField1) {
    chunks.unshift(encodeVarint((1 << 3) | 2), encodeVarint(titleBytes.length), titleBytes);
  }
  return Buffer.concat(chunks);
}

/**
 * Sync a Pi session name to agy's local conversation title stores:
 * 1. `~/.gemini/antigravity-cli/annotations/<conversationId>.pbtxt`
 * 2. `~/.gemini/antigravity-cli/conversation_summaries.db` (`title` + `raw_summary`)
 * 3. `~/.gemini/antigravity-cli/cache/conversation_metadata.json` (`summary.Title`)
 */
export async function syncAgyConversationTitle(
  conversationId: string,
  title: string,
  homeDirectory = os.homedir(),
): Promise<boolean> {
  const normalized = title.replace(/[\r\n\t]+/g, " ").trim().slice(0, 512);
  if (!conversationId || !normalized) return false;

  const baseDir = path.join(homeDirectory, ".gemini", "antigravity-cli");
  let updated = false;

  // 1. Update annotations/<conversationId>.pbtxt
  try {
    const annotationsDir = path.join(baseDir, "annotations");
    await fs.mkdir(annotationsDir, { recursive: true });
    const pbtxtPath = path.join(annotationsDir, `${conversationId}.pbtxt`);
    let existing = "";
    try {
      existing = await fs.readFile(pbtxtPath, "utf-8");
    } catch {
      existing = "";
    }
    const escaped = `title:"${escapePbtxtString(normalized)}"`;
    const nextPbtxt = /title\s*:\s*"(?:\\.|[^"\\])*"/.test(existing)
      ? existing.replace(/title\s*:\s*"(?:\\.|[^"\\])*"/, escaped)
      : existing.trim()
        ? `${escaped}\n${existing.trim()}`
        : escaped;
    if (nextPbtxt !== existing) {
      await fs.writeFile(pbtxtPath, nextPbtxt, "utf-8");
    }
    updated = true;
  } catch {
    // Best-effort
  }

  // 2. Update conversation_summaries.db (both `title` and `raw_summary` protobuf)
  try {
    const dbPath = path.join(baseDir, "conversation_summaries.db");
    const { execFile } = await import("node:child_process");
    const sqlTitle = normalized.replace(/'/g, "''");
    const sqlId = conversationId.replace(/'/g, "''");
    const rawHex = await new Promise<string>((resolve) => {
      execFile(
        "sqlite3",
        [
          "-init",
          "/dev/null",
          "-batch",
          "-noheader",
          "-list",
          dbPath,
          `PRAGMA busy_timeout = 2000; SELECT hex(raw_summary) FROM conversation_summaries WHERE conversation_id = '${sqlId}';`,
        ],
        { timeout: 3000 },
        (_err, stdout) => {
          const lines = (stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
          resolve(lines[lines.length - 1]?.trim() ?? "");
        },
      );
    });
    let updateSql = `PRAGMA busy_timeout = 2000; UPDATE conversation_summaries SET title = '${sqlTitle}' WHERE conversation_id = '${sqlId}';`;
    if (rawHex && /^[0-9A-Fa-f]+$/.test(rawHex)) {
      const patched = patchProtobufTitleField(Buffer.from(rawHex, "hex"), normalized, true);
      updateSql = `PRAGMA busy_timeout = 2000; UPDATE conversation_summaries SET title = '${sqlTitle}', raw_summary = X'${patched.toString("hex")}' WHERE conversation_id = '${sqlId}';`;
    }
    await new Promise<void>((resolve) => {
      execFile(
        "sqlite3",
        ["-init", "/dev/null", "-batch", dbPath, updateSql],
        { timeout: 3000 },
        () => resolve(),
      );
    });
    updated = true;
  } catch {
    // Best-effort
  }

  // 3. Update cache/conversation_metadata.json if present (or touch .db so agy refreshes cache)
  try {
    const metadataPath = agyConversationMetadataPath(homeDirectory);
    const text = await fs.readFile(metadataPath, "utf-8");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const conversations = record(parsed.conversations);
    const entry = record(conversations?.[conversationId]);
    const summary = record(entry?.summary) ?? entry;
    if (summary) {
      if (summary.Title !== normalized) {
        summary.Title = normalized;
        await fs.writeFile(metadataPath, JSON.stringify(parsed), "utf-8");
      }
    } else {
      // Touch conversations/<id>.db so agy's summary cache fills this conversation with the new pbtxt title
      const convDbPath = path.join(baseDir, "conversations", `${conversationId}.db`);
      const now = new Date();
      await fs.utimes(convDbPath, now, now).catch(() => {});
    }
  } catch {
    // Best-effort
  }

  return updated;
}

/**
 * Remove a disposable agy conversation created solely for Pi's internal
 * compaction / branch-summary requests so it never pollutes `agy -c` or
 * evicts the user's real conversations.
 */
export async function deleteDisposableAgyConversation(
  conversationId: string | undefined,
  homeDirectory = os.homedir(),
): Promise<void> {
  if (!conversationId || !/^[0-9a-f-]{36}$/i.test(conversationId)) return;
  const baseDir = path.join(homeDirectory, ".gemini", "antigravity-cli");
  const removals = [
    path.join(baseDir, "conversations", `${conversationId}.db`),
    path.join(baseDir, "conversations", `${conversationId}.db-wal`),
    path.join(baseDir, "conversations", `${conversationId}.db-shm`),
    path.join(baseDir, "annotations", `${conversationId}.pbtxt`),
    path.join(baseDir, "presence", `${conversationId}.lock`),
    path.join(baseDir, "brain", conversationId),
  ];
  await Promise.all(
    removals.map((target) => fs.rm(target, { recursive: true, force: true }).catch(() => {})),
  );
  try {
    const dbPath = path.join(baseDir, "conversation_summaries.db");
    const { execFile } = await import("node:child_process");
    const sqlId = conversationId.replace(/'/g, "''");
    await new Promise<void>((resolve) => {
      execFile(
        "sqlite3",
        [
          dbPath,
          `PRAGMA busy_timeout = 2000; DELETE FROM conversation_summaries WHERE conversation_id = '${sqlId}';`,
        ],
        { timeout: 3000 },
        () => resolve(),
      );
    });
  } catch {
    // Best-effort
  }
}

const PI_TOOLS_AGENT_MARKER = Buffer.from("pi-tools-", "utf-8");
const BRIDGE_PATH_MARKER = Buffer.from("/antigravity/bridges/", "utf-8");

function isBridgeWorkspaceUri(uri: string): boolean {
  return uri.includes("/antigravity/bridges/");
}

function isPiToolsAgentName(name: unknown): name is string {
  return typeof name === "string" && name.startsWith("pi-tools-");
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function bridgeDirStillExists(uri: string): boolean {
  try {
    const filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
    return existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * Strip session-owned `pi-tools-*` custom agent fields (4, 10) and private
 * `/antigravity/bridges/<instance>` workspace fields (1, 7) from a
 * `TrajectoryMetadata` protobuf blob so standalone `agy --resume` can continue
 * the conversation with native agy tools.
 */
export function stripAgyTrajectoryBridgeMetadata(buf: Uint8Array): Buffer {
  const source = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < source.length) {
    const fieldStart = offset;
    const tagInfo = readVarint(source, offset);
    if (!tagInfo) return source;
    const tag = tagInfo.value;
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;
    offset = tagInfo.next;

    if (wireType === 0) {
      const val = readVarint(source, offset);
      if (!val) return source;
      offset = val.next;
      chunks.push(source.subarray(fieldStart, offset));
    } else if (wireType === 1) {
      if (offset + 8 > source.length) return source;
      offset += 8;
      chunks.push(source.subarray(fieldStart, offset));
    } else if (wireType === 5) {
      if (offset + 4 > source.length) return source;
      offset += 4;
      chunks.push(source.subarray(fieldStart, offset));
    } else if (wireType === 2) {
      const lenInfo = readVarint(source, offset);
      if (!lenInfo || lenInfo.next + lenInfo.value > source.length) return source;
      const bodyStart = lenInfo.next;
      const bodyEnd = bodyStart + lenInfo.value;
      offset = bodyEnd;
      const body = source.subarray(bodyStart, bodyEnd);
      if (
        (fieldNumber === 4 || fieldNumber === 10) &&
        body.includes(PI_TOOLS_AGENT_MARKER)
      ) {
        continue;
      }
      if (
        (fieldNumber === 1 || fieldNumber === 7) &&
        body.includes(BRIDGE_PATH_MARKER)
      ) {
        continue;
      }
      chunks.push(source.subarray(fieldStart, bodyEnd));
    } else {
      return source;
    }
  }

  return Buffer.concat(chunks);
}

/**
 * Strip bridge workspace fields (9) and nested `pi-tools-*` / bridge metadata
 * in field 17 from a `ConversationSummary` (`raw_summary`) protobuf blob.
 */
export function stripAgySummaryBridgeMetadata(buf: Uint8Array): Buffer {
  const source = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < source.length) {
    const fieldStart = offset;
    const tagInfo = readVarint(source, offset);
    if (!tagInfo) return source;
    const tag = tagInfo.value;
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;
    offset = tagInfo.next;

    if (wireType === 0) {
      const val = readVarint(source, offset);
      if (!val) return source;
      offset = val.next;
      chunks.push(source.subarray(fieldStart, offset));
    } else if (wireType === 1) {
      if (offset + 8 > source.length) return source;
      offset += 8;
      chunks.push(source.subarray(fieldStart, offset));
    } else if (wireType === 5) {
      if (offset + 4 > source.length) return source;
      offset += 4;
      chunks.push(source.subarray(fieldStart, offset));
    } else if (wireType === 2) {
      const lenInfo = readVarint(source, offset);
      if (!lenInfo || lenInfo.next + lenInfo.value > source.length) return source;
      const bodyStart = lenInfo.next;
      const bodyEnd = bodyStart + lenInfo.value;
      offset = bodyEnd;
      const body = source.subarray(bodyStart, bodyEnd);
      if (fieldNumber === 9 && body.includes(BRIDGE_PATH_MARKER)) {
        continue;
      }
      if (fieldNumber === 17) {
        const cleanedInner = stripAgyTrajectoryBridgeMetadata(body);
        chunks.push(
          encodeVarint((17 << 3) | 2),
          encodeVarint(cleanedInner.length),
          cleanedInner,
        );
        continue;
      }
      if (body.includes(PI_TOOLS_AGENT_MARKER)) {
        continue;
      }
      chunks.push(source.subarray(fieldStart, bodyEnd));
    } else {
      return source;
    }
  }

  return Buffer.concat(chunks);
}

/**
 * Detach session-owned `pi-tools-*` agent and private bridge workspace URIs from
 * agy's local conversation database and summary caches. Runs synchronously so it
 * is safe in `session_shutdown`, mode/session switches, and `process.on("exit")`.
 */
export function detachAgyConversationBridgeMetadata(
  conversationId: string | undefined,
  homeDirectory = os.homedir(),
): boolean {
  if (!conversationId || !/^[0-9a-f-]{36}$/i.test(conversationId)) return false;
  const baseDir = path.join(homeDirectory, ".gemini", "antigravity-cli");
  let modified = false;

  // 1. Strip from conversations/<id>.db (`trajectory_metadata_blob`)
  const convDbPath = path.join(baseDir, "conversations", `${conversationId}.db`);
  if (existsSync(convDbPath)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(convDbPath);
      db.exec("PRAGMA busy_timeout = 2000;");
      const row = db
        .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'")
        .get() as { data?: Uint8Array } | undefined;
      if (row?.data) {
        const current = Buffer.from(row.data);
        if (current.includes(PI_TOOLS_AGENT_MARKER) || current.includes(BRIDGE_PATH_MARKER)) {
          const cleaned = stripAgyTrajectoryBridgeMetadata(current);
          if (!cleaned.equals(current)) {
            db.prepare("UPDATE trajectory_metadata_blob SET data = ? WHERE id = 'main'").run(cleaned);
            modified = true;
          }
        }
      }
    } catch {
      // Best-effort
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  // 2. Strip from conversation_summaries.db
  const summariesDbPath = path.join(baseDir, "conversation_summaries.db");
  if (existsSync(summariesDbPath)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(summariesDbPath);
      db.exec("PRAGMA busy_timeout = 2000;");
      const row = db
        .prepare(
          "SELECT agent_name, workspace_uris, raw_summary FROM conversation_summaries WHERE conversation_id = ?",
        )
        .get(conversationId) as
        | { agent_name?: string; workspace_uris?: string; raw_summary?: Uint8Array }
        | undefined;
      if (row) {
        const nextAgentName = isPiToolsAgentName(row.agent_name) ? "" : (row.agent_name ?? "");
        let nextWorkspaceUris = row.workspace_uris ?? "[]";
        try {
          const parsedUris = JSON.parse(nextWorkspaceUris);
          if (Array.isArray(parsedUris)) {
            const filtered = parsedUris.filter(
              (u): u is string => typeof u === "string" && !isBridgeWorkspaceUri(u),
            );
            if (filtered.length !== parsedUris.length) {
              nextWorkspaceUris = JSON.stringify(filtered);
            }
          }
        } catch {
          // Leave malformed JSON untouched
        }
        const currentRaw = row.raw_summary ? Buffer.from(row.raw_summary) : undefined;
        const nextRaw =
          currentRaw &&
          (currentRaw.includes(PI_TOOLS_AGENT_MARKER) || currentRaw.includes(BRIDGE_PATH_MARKER))
            ? stripAgySummaryBridgeMetadata(currentRaw)
            : currentRaw;
        if (
          nextAgentName !== (row.agent_name ?? "") ||
          nextWorkspaceUris !== (row.workspace_uris ?? "[]") ||
          (currentRaw && nextRaw && !nextRaw.equals(currentRaw))
        ) {
          db.prepare(
            "UPDATE conversation_summaries SET agent_name = ?, workspace_uris = ?, raw_summary = ? WHERE conversation_id = ?",
          ).run(nextAgentName, nextWorkspaceUris, nextRaw ?? null, conversationId);
          modified = true;
        }
      }
    } catch {
      // Best-effort
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  // 3. Strip from cache/conversation_metadata.json
  const metadataPath = agyConversationMetadataPath(homeDirectory);
  if (existsSync(metadataPath)) {
    try {
      const parsed = JSON.parse(readFileSync(metadataPath, "utf-8")) as Record<string, unknown>;
      const conversations = record(parsed.conversations);
      const entry = record(conversations?.[conversationId]);
      const summary = record(entry?.summary) ?? entry;
      if (summary) {
        let jsonChanged = false;
        if (isPiToolsAgentName(summary.AgentName)) {
          summary.AgentName = "";
          jsonChanged = true;
        }
        if (Array.isArray(summary.WorkspaceURIs)) {
          const filtered = summary.WorkspaceURIs.filter(
            (u): u is string => typeof u === "string" && !isBridgeWorkspaceUri(u),
          );
          if (filtered.length !== summary.WorkspaceURIs.length) {
            summary.WorkspaceURIs = filtered;
            jsonChanged = true;
          }
        }
        if (jsonChanged) {
          writeFileSync(metadataPath, JSON.stringify(parsed), "utf-8");
          modified = true;
        }
      }
    } catch {
      // Best-effort
    }
  }

  return modified;
}

/**
 * Clean up any conversations left bound to a dead `pi-tools-<pid>-*` process or
 * a removed `/antigravity/bridges/<instance>` directory so they can be resumed
 * in standalone `agy`.
 */
export function sweepStalePiToolsConversations(
  homeDirectory = os.homedir(),
  currentPid = process.pid,
): number {
  const summariesDbPath = path.join(
    homeDirectory,
    ".gemini",
    "antigravity-cli",
    "conversation_summaries.db",
  );
  const candidates = new Set<string>();

  if (existsSync(summariesDbPath)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(summariesDbPath, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 2000;");
      const rows = db
        .prepare(
          "SELECT conversation_id, agent_name, workspace_uris FROM conversation_summaries WHERE agent_name LIKE 'pi-tools-%' OR workspace_uris LIKE '%/antigravity/bridges/%'",
        )
        .all() as Array<{
        conversation_id?: string;
        agent_name?: string;
        workspace_uris?: string;
      }>;
      for (const row of rows) {
        const cid = row.conversation_id;
        if (!cid) continue;
        const agentMatch = /^pi-tools-(\d+)-/.exec(row.agent_name ?? "");
        if (agentMatch) {
          const ownerPid = Number(agentMatch[1]);
          if (ownerPid !== currentPid && !isPidAlive(ownerPid)) {
            candidates.add(cid);
            continue;
          }
        }
        if (row.workspace_uris?.includes("/antigravity/bridges/")) {
          try {
            const uris = JSON.parse(row.workspace_uris);
            if (
              Array.isArray(uris) &&
              uris.some(
                (u) =>
                  typeof u === "string" &&
                  isBridgeWorkspaceUri(u) &&
                  !bridgeDirStillExists(u),
              )
            ) {
              candidates.add(cid);
            }
          } catch {
            // Ignore malformed JSON
          }
        }
      }
    } catch {
      // Best-effort
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore
      }
    }
  }

  let cleaned = 0;
  for (const cid of candidates) {
    if (detachAgyConversationBridgeMetadata(cid, homeDirectory)) {
      cleaned += 1;
    }
  }
  return cleaned;
}

