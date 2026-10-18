import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateDiffString, renderDiff, type Theme } from "@earendil-works/pi-coding-agent";

function resolvePath(filePath: string, cwd: string): string {
  if (filePath.startsWith("~/") || filePath === "~") {
    const home = os.homedir();
    return home ? path.join(home, filePath.slice(1)) : path.resolve(cwd, filePath);
  }
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

/** agy file mutation tools that should display a diff like native edit. */
const EDIT_TOOLS = new Set([
  "replace_file_content",
  "multi_replace_file_content",
  "write_to_file",
  "sed_file",
]);

export function isAgyEditTool(tool: string): boolean {
  return EDIT_TOOLS.has(tool);
}

function cleanQuotes(val: string): string {
  let s = val.trim();
  while (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export function isCorruptedArg(val: unknown): boolean {
  if (typeof val !== "string") return false;
  return /<truncated \d+ bytes>/i.test(val);
}

export function unwrapAgyArg(val: unknown): unknown {
  if (typeof val === "string") {
    const s = val.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      try {
        return JSON.parse(s);
      } catch {
        const unquoted = s.slice(1, -1);
        try {
          return JSON.parse(`"${unquoted.replace(/"/g, '\\"')}"`);
        } catch {
          return unquoted
            .replace(/\\n/g, "\n")
            .replace(/\\r/g, "\r")
            .replace(/\\t/g, "\t")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
        }
      }
    }
  }
  return val;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const val = record[key];
    if (typeof val === "string") {
      const unwrapped = unwrapAgyArg(val);
      if (typeof unwrapped === "string") {
        const cleaned = cleanQuotes(unwrapped);
        if (cleaned || unwrapped === "") return cleaned;
      }
    }
  }
  return undefined;
}

function pickFilePath(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const val = record[key];
    if (typeof val === "string") {
      const s = cleanQuotes(val);
      if (s) return s;
    }
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const val = record[key];
    if (typeof val === "number" && Number.isFinite(val)) return val;
    if (typeof val === "string") {
      const s = cleanQuotes(val);
      const parsed = parseInt(s, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

const FILE_PATH_KEYS = [
  "TargetFile",
  "target_file",
  "path",
  "Path",
  "FilePath",
  "file_path",
  "AbsolutePath",
  "absolute_path",
];

const TARGET_CONTENT_KEYS = [
  "TargetContent",
  "target_content",
  "oldText",
  "old_text",
  "oldContent",
  "old_content",
];

const REPLACEMENT_CONTENT_KEYS = [
  "ReplacementContent",
  "replacement_content",
  "newText",
  "new_text",
  "newContent",
  "new_content",
  "CodeContent",
  "code_content",
  "content",
  "Content",
];

const START_LINE_KEYS = ["StartLine", "start_line", "startLine"];

/**
 * Retrieve the full model arguments for an agy tool call from conversation transcript logs.
 * Print-mode stream-json truncates large parameter values (leaving only TargetFile, etc.),
 * but the conversation transcript contains the complete parameters.
 */
export function resolveFullAgyToolArgs(
  conversationId: string | undefined,
  stepId: number | undefined,
  toolName: string,
): Record<string, unknown> | null {
  if (!conversationId) return null;
  const logDir = path.join(
    os.homedir(),
    ".gemini",
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
  );
  // Prioritize transcript_full.jsonl for complete, untruncated model arguments.
  const candidates = [
    path.join(logDir, "transcript_full.jsonl"),
    path.join(logDir, "transcript.jsonl"),
  ];

  for (const transcriptPath of candidates) {
    if (!fs.existsSync(transcriptPath)) continue;
    try {
      const text = fs.readFileSync(transcriptPath, "utf8");
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        const obj = JSON.parse(line);
        // Look for a preceding planner step that initiated this tool call
        if (
          (typeof stepId !== "number" || obj.step_index < stepId) &&
          Array.isArray(obj.tool_calls)
        ) {
          const found = obj.tool_calls.find(
            (c: { name: string; args?: Record<string, unknown> }) => c.name === toolName,
          );
          if (found && found.args) {
            let hasTruncation = false;
            const unwrapped: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(found.args)) {
              if (isCorruptedArg(v)) {
                hasTruncation = true;
                break;
              }
              unwrapped[k] = unwrapAgyArg(v);
            }
            if (!hasTruncation) {
              return unwrapped;
            }
          }
        }
      }
    } catch {}
  }
  return null;
}

/**
 * Extract unified diff block produced by agy tool execution if present in text.
 */
export function extractDiffBlock(text: string | undefined): string | null {
  if (!text) return null;
  const m = text.match(/\[diff_block_start\]\n([\s\S]*?)\n\[diff_block_end\]/);
  return m ? m[1].trim() : null;
}

/**
 * Extract unified diff block produced by agy tool execution if recorded in the transcript.
 */
export function extractTranscriptDiffBlock(
  conversationId: string | undefined,
  stepId: number | undefined,
): string | null {
  if (!conversationId) return null;
  const logDir = path.join(
    os.homedir(),
    ".gemini",
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
  );
  const candidates = [
    path.join(logDir, "transcript_full.jsonl"),
    path.join(logDir, "transcript.jsonl"),
  ];

  for (const transcriptPath of candidates) {
    if (!fs.existsSync(transcriptPath)) continue;
    try {
      const text = fs.readFileSync(transcriptPath, "utf8");
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        const obj = JSON.parse(line);
        if (
          (typeof stepId !== "number" ||
            obj.step_index === stepId ||
            Math.abs(obj.step_index - stepId) <= 1) &&
          typeof obj.content === "string"
        ) {
          const block = extractDiffBlock(obj.content);
          if (block) return block;
        }
      }
    } catch {}
  }
  return null;
}

/**
 * Convert standard unified diff hunks (e.g. from agy diff_block or git) into
 * Pi's line-numbered diff format matching renderDiff with ellipsis markers.
 */
export function formatUnifiedDiffAsPiDiff(unifiedDiff: string): string | null {
  const lines = unifiedDiff.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const hunks: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: string[];
  }> = [];
  let currentHunk: (typeof hunks)[0] | null = null;

  for (const line of lines) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      currentHunk = {
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
        newStart: parseInt(m[3], 10),
        newCount: m[4] !== undefined ? parseInt(m[4], 10) : 1,
        lines: [],
      };
      hunks.push(currentHunk);
    } else if (currentHunk) {
      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
        currentHunk.lines.push(line);
      } else if (line === "") {
        let oldCountSoFar = 0;
        for (const l of currentHunk.lines) {
          if (!l.startsWith("+")) oldCountSoFar++;
        }
        if (oldCountSoFar < currentHunk.oldCount) {
          currentHunk.lines.push(" ");
        }
      }
    }
  }

  if (hunks.length === 0) return null;

  let maxLine = 0;
  for (const h of hunks) {
    maxLine = Math.max(maxLine, h.oldStart + (h.oldCount || 0), h.newStart + (h.newCount || 0));
  }
  const width = Math.max(String(maxLine).length, 2);
  const ellipsis = ` ${"".padStart(width, " ")} ...`;
  const result: string[] = [];

  let lastOldEnd = 0;
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    if (i === 0) {
      if (h.oldStart > 1 || h.newStart > 1) {
        result.push(ellipsis);
      }
    } else if (h.oldStart > lastOldEnd + 1) {
      result.push(ellipsis);
    }

    let curOld = h.oldStart;
    let curNew = h.newStart;

    for (const line of h.lines) {
      if (line.startsWith("-")) {
        const num = String(curOld).padStart(width, " ");
        result.push(`-${num} ${line.slice(1)}`);
        curOld++;
      } else if (line.startsWith("+")) {
        const num = String(curNew).padStart(width, " ");
        result.push(`+${num} ${line.slice(1)}`);
        curNew++;
      } else {
        const num = String(curOld).padStart(width, " ");
        const content = line.startsWith(" ") ? line.slice(1) : line;
        result.push(` ${num} ${content}`);
        curOld++;
        curNew++;
      }
    }
    lastOldEnd = curOld;
  }

  result.push(ellipsis);
  return result.join("\n");
}

/**
 * Render a diff string using Pi's renderDiff if available, with a resilient
 * fallback to theme-colored lines if theme initialization is missing.
 */
export function safeRenderDiff(diffText: string, theme: Theme): string {
  let cleanDiff = diffText.replace(/\r/g, "");
  if (/^@@ -\d+/m.test(cleanDiff)) {
    const formatted = formatUnifiedDiffAsPiDiff(cleanDiff);
    if (formatted) cleanDiff = formatted;
  }

  try {
    return renderDiff(cleanDiff);
  } catch {
    return cleanDiff
      .split("\n")
      .map((line) => {
        if (line.startsWith("-")) return theme.fg("error", line);
        if (line.startsWith("+")) return theme.fg("success", line);
        if (line.startsWith("@@")) return theme.fg("muted", line);
        return theme.fg("dim", line);
      })
      .join("\n");
  }
}

/** Compute display-ready numbered diff for an agy file mutation tool. */
export async function computeAgyToolDiff(
  tool: string,
  input: unknown,
  cwd = process.cwd(),
  conversationId?: string,
  stepId?: number,
  output?: string,
): Promise<string | undefined> {
  const baseArgs =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const fullArgs = resolveFullAgyToolArgs(conversationId, stepId, tool) ?? {};
  const args: Record<string, unknown> = { ...fullArgs, ...baseArgs };
  for (const [k, v] of Object.entries(fullArgs)) {
    if (args[k] === undefined || args[k] === "" || args[k] === null) {
      args[k] = v;
    }
  }

  const filePath = pickFilePath(args, FILE_PATH_KEYS);
  const targetContent = pickString(args, TARGET_CONTENT_KEYS);
  const replacementContent = pickString(args, REPLACEMENT_CONTENT_KEYS);
  const startLine = pickNumber(args, START_LINE_KEYS);

  if (tool === "replace_file_content" || tool === "sed_file") {
    // 1. Try computing precise diff from full file on disk
    const diskDiff = await computeSingleReplaceDiff(
      filePath,
      targetContent ?? "",
      replacementContent ?? "",
      cwd,
    );
    if (diskDiff) return diskDiff;

    // 2. Try extracting unified diff block produced by agy tool execution
    const block = extractDiffBlock(output) ?? extractTranscriptDiffBlock(conversationId, stepId);
    if (block) {
      const formatted = formatUnifiedDiffAsPiDiff(block);
      if (formatted) return formatted;
    }

    // 3. Fallback: direct diff if target and replacement are clean (not corrupted)
    if (targetContent !== undefined && replacementContent !== undefined) {
      return computeDirectReplaceDiff(targetContent, replacementContent, startLine);
    }
  }

  if (tool === "multi_replace_file_content") {
    const edits = (args.replacements ?? args.chunks ?? args.edits) as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(edits)) {
      const diskDiff = await computeMultiEditDiff(filePath, edits, cwd);
      if (diskDiff) return diskDiff;
    } else if (targetContent !== undefined || replacementContent !== undefined) {
      const diskDiff = await computeSingleReplaceDiff(
        filePath,
        targetContent ?? "",
        replacementContent ?? "",
        cwd,
      );
      if (diskDiff) return diskDiff;
    }

    const block = extractDiffBlock(output) ?? extractTranscriptDiffBlock(conversationId, stepId);
    if (block) {
      const formatted = formatUnifiedDiffAsPiDiff(block);
      if (formatted) return formatted;
    }

    if (targetContent !== undefined && replacementContent !== undefined) {
      return computeDirectReplaceDiff(targetContent, replacementContent, startLine);
    }
  }

  if (tool === "write_to_file") {
    if (replacementContent !== undefined) {
      const diskDiff = await computeWriteToFileDiff(
        filePath,
        replacementContent,
        Boolean(args.Append ?? args.append),
        cwd,
      );
      if (diskDiff) return diskDiff;
    }

    const block = extractDiffBlock(output) ?? extractTranscriptDiffBlock(conversationId, stepId);
    if (block) {
      const formatted = formatUnifiedDiffAsPiDiff(block);
      if (formatted) return formatted;
    }
  }

  return undefined;
}

async function computeSingleReplaceDiff(
  filePath: string | undefined,
  targetContent: string,
  replacementContent: string,
  cwd = process.cwd(),
): Promise<string | undefined> {
  if (isCorruptedArg(targetContent) || isCorruptedArg(replacementContent)) {
    return undefined;
  }
  if (!targetContent && !replacementContent) return undefined;

  let fileOnDisk: string | undefined;
  if (filePath) {
    const resolved = resolvePath(filePath, cwd);
    try {
      fileOnDisk = await fs.promises.readFile(resolved, "utf-8");
    } catch {
      // file might not exist or unreadable
    }
  }

  if (fileOnDisk !== undefined) {
    const normalizedFile = fileOnDisk.replace(/\r\n/g, "\n");
    const normalizedTarget = targetContent.replace(/\r\n/g, "\n");
    const normalizedReplacement = replacementContent.replace(/\r\n/g, "\n");

    // Case 1: agy already replaced targetContent with replacementContent in the file
    const repIdx = normalizedFile.indexOf(normalizedReplacement);
    if (repIdx !== -1 && normalizedReplacement.length > 0) {
      const oldFile =
        normalizedFile.slice(0, repIdx) +
        normalizedTarget +
        normalizedFile.slice(repIdx + normalizedReplacement.length);
      try {
        const diffResult = generateDiffString(oldFile, normalizedFile);
        if (diffResult?.diff) return diffResult.diff;
      } catch {}
    }

    // Case 2: File currently still contains targetContent (read before write)
    const tgtIdx = normalizedFile.indexOf(normalizedTarget);
    if (tgtIdx !== -1 && normalizedTarget.length > 0) {
      const newFile =
        normalizedFile.slice(0, tgtIdx) +
        normalizedReplacement +
        normalizedFile.slice(tgtIdx + normalizedTarget.length);
      try {
        const diffResult = generateDiffString(normalizedFile, newFile);
        if (diffResult?.diff) return diffResult.diff;
      } catch {}
    }
  }

  return undefined;
}

function computeDirectReplaceDiff(
  targetContent: string,
  replacementContent: string,
  startLine?: number,
): string | undefined {
  if (isCorruptedArg(targetContent) || isCorruptedArg(replacementContent)) {
    return undefined;
  }
  const normTarget = targetContent.replace(/\r\n/g, "\n");
  const normRep = replacementContent.replace(/\r\n/g, "\n");
  if (!normTarget && !normRep) return undefined;

  try {
    let diffStr: string | undefined;
    if (startLine && startLine > 1) {
      const padding = "\n".repeat(startLine - 1);
      const diffResult = generateDiffString(padding + normTarget, padding + normRep);
      diffStr = diffResult?.diff;
    } else {
      const diffResult = generateDiffString(normTarget, normRep);
      diffStr = diffResult?.diff;
    }
    if (!diffStr) return undefined;

    const lines = diffStr.split("\n");
    const cleanLines: string[] = [];
    let skippingPadding = Boolean(startLine && startLine > 1);
    for (const l of lines) {
      if (skippingPadding) {
        if (l.match(/^[+-]/)) {
          skippingPadding = false;
          cleanLines.push(l);
        } else {
          continue;
        }
      } else {
        cleanLines.push(l);
      }
    }

    if (startLine && startLine > 1) {
      cleanLines.unshift("    ...");
    }

    const lastLine = cleanLines[cleanLines.length - 1] ?? "";
    if (!lastLine.trim().startsWith("...")) {
      cleanLines.push("    ...");
    }

    return cleanLines.join("\n");
  } catch {
    return undefined;
  }
}

async function computeWriteToFileDiff(
  filePath: string | undefined,
  content: string,
  isAppend: boolean,
  cwd = process.cwd(),
): Promise<string | undefined> {
  if (!content || isCorruptedArg(content)) return undefined;
  const normContent = content.replace(/\r\n/g, "\n");

  if (isAppend && filePath) {
    const resolved = resolvePath(filePath, cwd);
    try {
      const current = await fs.promises.readFile(resolved, "utf-8");
      const normCurrent = current.replace(/\r\n/g, "\n");
      const oldFile = normCurrent.endsWith(normContent)
        ? normCurrent.slice(0, normCurrent.length - normContent.length)
        : normCurrent;
      const diffResult = generateDiffString(oldFile, normCurrent);
      if (diffResult?.diff) return diffResult.diff;
    } catch {}
  }

  // Newly written or overwritten file: diff against empty
  try {
    const diffResult = generateDiffString("", normContent);
    return diffResult?.diff;
  } catch {
    return undefined;
  }
}

async function computeMultiEditDiff(
  filePath: string | undefined,
  edits: Array<Record<string, unknown>>,
  cwd = process.cwd(),
): Promise<string | undefined> {
  if (!filePath || edits.length === 0) return undefined;
  const resolved = resolvePath(filePath, cwd);
  try {
    const current = await fs.promises.readFile(resolved, "utf-8");
    let oldFile = current.replace(/\r\n/g, "\n");
    const newFile = oldFile;
    for (const edit of edits) {
      const target = pickString(edit, TARGET_CONTENT_KEYS);
      const replacement = pickString(edit, REPLACEMENT_CONTENT_KEYS);
      if (isCorruptedArg(target) || isCorruptedArg(replacement)) {
        return undefined;
      }
      if (target && replacement) {
        const repIdx = oldFile.indexOf(replacement);
        if (repIdx !== -1) {
          oldFile = oldFile.slice(0, repIdx) + target + oldFile.slice(repIdx + replacement.length);
        }
      }
    }
    const diffResult = generateDiffString(oldFile, newFile);
    return diffResult?.diff;
  } catch {
    return undefined;
  }
}
