/**
 * Native re-execution mapping — agy read-only tools whose work pi can redo
 * cheaply and safely with its own builtins. The provider emits these as
 * native pi toolCalls (real builtin name, pi-schema args); pi executes the
 * real builtin, so cards render with pi's own renderers and show live,
 * accurate output instead of agy's summary text.
 *
 * Mutating tools (commands, edits, writes) and agy-specialty tools are
 * never re-executed — they replay through the display-only `antigravity`
 * wrapper tool instead.
 */
import type { JsonObject } from "@earendil-works/pi-ai";

export interface NativeToolCall {
  /** pi builtin tool name (`read`, `ls`, `grep`, `find`). */
  tool: string;
  /** Arguments conforming to the builtin's schema. */
  args: JsonObject;
}

function cleanStr(val: string): string {
  let s = val.trim();
  while (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/** First non-empty string among the given keys (agy mixes key casings). */
function str(input: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") {
      const s = cleanStr(value);
      if (s) return s;
    }
  }
  return undefined;
}

function num(input: JsonObject, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    if (typeof value === "string") {
      const s = cleanStr(value);
      const parsed = parseInt(s, 10);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return undefined;
}

function onlyKeys(input: JsonObject, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.entries(input).every(
    ([key, value]) => value === undefined || value === null || accepted.has(key),
  );
}

const AGY_METADATA_KEYS = [
  "toolAction",
  "tool_action",
  "toolSummary",
  "tool_summary",
  "ContentOffset",
  "content_offset",
] as const;

const VIEW_PATH_KEYS = [
  "path",
  "Path",
  "AbsolutePath",
  "absolute_path",
  "TargetFile",
  "target_file",
  "FilePath",
  "file_path",
] as const;
const START_LINE_KEYS = ["StartLine", "start_line", "startLine", "offset"] as const;
const END_LINE_KEYS = ["EndLine", "end_line", "endLine"] as const;
const LIMIT_KEYS = ["limit", "Limit"] as const;

/**
 * Map an agy tool step to a native pi toolCall when re-execution is safe.
 * Returns undefined for everything that must stay on the replay wrapper.
 */
export function mapAgyToolToNative(tool: string, args: JsonObject): NativeToolCall | undefined {
  switch (tool) {
    case "view_file":
    case "read_file": {
      if (
        !onlyKeys(args, [
          ...VIEW_PATH_KEYS,
          ...START_LINE_KEYS,
          ...END_LINE_KEYS,
          ...LIMIT_KEYS,
          ...AGY_METADATA_KEYS,
        ])
      ) {
        return undefined;
      }
      const path = str(args, [...VIEW_PATH_KEYS]);
      const startArg = num(args, [...START_LINE_KEYS]);
      const end = num(args, [...END_LINE_KEYS]);
      const limitArg = num(args, [...LIMIT_KEYS]);
      if (!path) {
        return undefined;
      }
      const start = startArg ?? (end !== undefined ? 1 : undefined);
      if (start !== undefined && end !== undefined && end < start) {
        return undefined;
      }
      const limit =
        limitArg ?? (start !== undefined && end !== undefined ? end - start + 1 : undefined);
      return {
        tool: "read",
        args: {
          path,
          ...(start === undefined ? {} : { offset: start }),
          ...(limit === undefined ? {} : { limit }),
        },
      };
    }
    case "list_dir": {
      const keys = ["path", "Path", "DirectoryPath", "directory", "Directory"];
      if (!onlyKeys(args, [...keys, ...AGY_METADATA_KEYS])) return undefined;
      const path = str(args, keys);
      return path ? { tool: "ls", args: { path } } : undefined;
    }
    case "grep_search": {
      const patternKeys = ["query", "Query", "pattern", "Pattern"];
      const pathKeys = ["search_path", "SearchPath", "path", "Path"];
      if (!onlyKeys(args, [...patternKeys, ...pathKeys, ...AGY_METADATA_KEYS])) return undefined;
      const pattern = str(args, patternKeys);
      const path = str(args, pathKeys);
      return pattern ? { tool: "grep", args: path ? { pattern, path } : { pattern } } : undefined;
    }
    case "find_by_name": {
      const patternKeys = ["pattern", "Pattern", "glob", "name"];
      const pathKeys = ["search_directory", "SearchDirectory", "path", "Path", "directory"];
      if (!onlyKeys(args, [...patternKeys, ...pathKeys, ...AGY_METADATA_KEYS])) return undefined;
      const pattern = str(args, patternKeys);
      const path = str(args, pathKeys);
      return pattern ? { tool: "find", args: path ? { pattern, path } : { pattern } } : undefined;
    }
    default:
      return undefined;
  }
}
