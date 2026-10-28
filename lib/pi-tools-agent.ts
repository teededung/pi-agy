import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { PI_TOOLS_AGENT_DESCRIPTION, piToolsAgentPrompt } from "./prompt.ts";

/** Core Pi tools marked eager so agy registers them as direct native tool declarations without lazy schema reads. */
export const EAGER_PI_BRIDGE_TOOLS = [
  "pi__read",
  "pi__bash",
  "pi__edit",
  "pi__write",
  "pi__ask_user_question",
  "pi__grep",
  "pi__find",
  "pi__ls",
  "pi__web_search",
  "pi__fetch_content",
  "pi__get_search_content",
  "pi__source_check",
  "pi__x_search",
] as const;

/**
 * Antigravity-exclusive native tools kept available alongside bridged Pi tools
 * so models retain native image generation and built-in web fallback when Pi
 * web extensions are not installed.
 */
export const PI_TOOLS_AGENT_NATIVE_TOOLS = [
  "generate_image",
  "search_web",
  "read_url_content",
] as const;

export const EAGER_PI_BRIDGE_TOOLS_CONFIG: Record<string, { eager: true }> = Object.fromEntries(
  EAGER_PI_BRIDGE_TOOLS.map((toolName) => [toolName, { eager: true as const }]),
);

export interface PiToolsAgentBridge {
  serverName: string;
  url: string;
  token: string;
}

/** One session-owned agent, discovered by agy without changing the workspace. */
export function createPiToolsAgent(
  agentRoot = path.join(homedir(), ".gemini", "config", "agents"),
) {
  const name = `pi-tools-${process.pid}-${randomUUID()}`;
  const directory = path.join(agentRoot, name);
  let prepared = false;

  return {
    name,
    isPrepared: () => prepared,
    async prepare(bridge: PiToolsAgentBridge): Promise<void> {
      prepared = false;
      const definition = {
        name,
        description: PI_TOOLS_AGENT_DESCRIPTION,
        mainAgent: true,
        subagent: false,
        inheritCustomizations: false,
        tools: [...PI_TOOLS_AGENT_NATIVE_TOOLS],
        mcpServers: [
          {
            name: bridge.serverName,
            url: bridge.url,
            serverUrl: bridge.url,
            headers: { "x-pi-bridge-token": bridge.token },
            tools: EAGER_PI_BRIDGE_TOOLS_CONFIG,
          },
        ],
      };
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // JSON is valid YAML frontmatter and safely quotes the URL, name and token.
      await writeFile(
        path.join(directory, "agent.md"),
        `---
${JSON.stringify(definition, null, 2)}
---

${piToolsAgentPrompt(bridge.serverName)}
`,
        { mode: 0o600 },
      );
      prepared = true;
    },
    async remove(): Promise<void> {
      prepared = false;
      await rm(directory, { recursive: true, force: true });
    },
    removeSync(): void {
      prepared = false;
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup on process exit.
      }
    },
  };
}
