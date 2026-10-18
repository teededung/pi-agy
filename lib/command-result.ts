import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AgyCommandInspection {
  exitCode?: number;
  isError: boolean;
}

/**
 * Inspect agy run_command result for exit code and error state.
 * First probes the conversation transcript log written by agy, which records
 * the precise exit code (e.g. "The command exited with code 1.").
 * Falls back to output inspection when transcript log is not reachable.
 */
export function inspectAgyCommandResult(
  conversationId: string | undefined,
  stepId: number | undefined,
  output: string | undefined,
): AgyCommandInspection {
  // 1. Try reading the exact exit code from agy's transcript.jsonl
  if (conversationId && typeof stepId === "number") {
    try {
      const transcriptPath = path.join(
        os.homedir(),
        ".gemini",
        "antigravity-cli",
        "brain",
        conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      if (fs.existsSync(transcriptPath)) {
        const text = fs.readFileSync(transcriptPath, "utf8");
        const lines = text.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          const obj = JSON.parse(line);
          if (obj.step_index === stepId || Math.abs(obj.step_index - stepId) <= 1) {
            const content = typeof obj.content === "string" ? obj.content : "";
            const m = content.match(/(?:The\s+)?command\s+exited\s+with\s+code\s+(-?\d+)/i);
            if (m) {
              const code = parseInt(m[1], 10);
              return { exitCode: code, isError: code !== 0 };
            }
          }
        }
      }
    } catch {
      // Transcript unavailable; fall back to output inspection below
    }
  }

  // 2. Check if output itself mentions an exit code
  if (output) {
    const m =
      output.match(/(?:The\s+)?command\s+exited\s+with\s+code\s+(-?\d+)/i) ??
      output.match(/exited\s+with\s+code\s+(-?\d+)/i);
    if (m) {
      const code = parseInt(m[1], 10);
      return { exitCode: code, isError: code !== 0 };
    }

    // 3. Common fatal error patterns in command output
    const isErrorPattern =
      /\b(?:SyntaxError|TypeError|ReferenceError|RangeError):/i.test(output) ||
      /\b(?:zsh|bash|sh):\s+(?:command not found|no such file or directory|permission denied)/i.test(
        output,
      ) ||
      /\bFullyQualifiedErrorId\s*:/i.test(output) ||
      /^fatal:\s+/im.test(output) ||
      /^FAILED:\s+/im.test(output);

    if (isErrorPattern) {
      return { isError: true };
    }
  }

  return { isError: false };
}
