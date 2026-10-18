import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

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

