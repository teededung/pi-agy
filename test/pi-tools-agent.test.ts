import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  detachAgyConversationBridgeMetadata,
  sweepStalePiToolsConversations,
} from "../lib/conversation-metadata.ts";
import { isAgyEditTool } from "../lib/diff.ts";
import { mapAgyToolToNative } from "../lib/native-tools.ts";
import { createPiToolsAgent } from "../lib/pi-tools-agent.ts";
import { formatAgyCall } from "../lib/render.ts";
import {
  formatAgySubagentsLivePreviewLines,
  shouldInterceptSubagentSteerInput,
  syncAgySubagentRoster,
  trackAgySubagent,
  type AgySubagentEntry,
} from "../lib/subagents.ts";
import { readAgyToolMode, resolveAgyToolModeCommand } from "../lib/tool-mode.ts";
import {
  contextHasPriorBoostActivity,
  contextHasPriorTeamworkActivity,
} from "../src/provider.ts";
import { AntigravityRuntime, createAntigravityRuntime } from "../src/runtime.ts";

test("tool mode defaults to pi and the startup flag overrides the environment", () => {
  assert.equal(readAgyToolMode(undefined, {}), "pi");
  assert.equal(readAgyToolMode(undefined, {}, "pi"), "pi");
  assert.equal(readAgyToolMode(undefined, { PI_ANTIGRAVITY_TOOLS: "native" }, "pi"), "native");
  assert.equal(readAgyToolMode("pi", { PI_ANTIGRAVITY_TOOLS: "native" }, "native"), "pi");
  assert.equal(readAgyToolMode(undefined, { PI_ANTIGRAVITY_TOOLS: "pi" }), "pi");
  assert.equal(readAgyToolMode("native", { PI_ANTIGRAVITY_TOOLS: "pi" }), "native");
  assert.equal(readAgyToolMode(" pi ", {}), "pi");
  for (const flag of ["", "unknown", true, 1]) {
    assert.throws(() => readAgyToolMode(flag, {}), /native.*pi/);
  }
});

test("slash command toggles or resolves explicit on/off/status without accepting invalid input", () => {
  assert.equal(resolveAgyToolModeCommand("", "native"), "pi");
  assert.equal(resolveAgyToolModeCommand("  ", "pi"), "native");
  for (const mode of ["native", "pi"] as const) {
    assert.equal(resolveAgyToolModeCommand("on", mode), "pi");
    assert.equal(resolveAgyToolModeCommand(" OFF ", mode), "native");
    assert.equal(resolveAgyToolModeCommand("status", mode), "status");
    assert.equal(resolveAgyToolModeCommand("on off", mode), undefined);
  }
});

test("Pi tool agent scopes MCP to its bridge and removes only its own configuration", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agy-pi-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "existing-agent.md"), "keep");
  const agent = createPiToolsAgent(root);
  const other = createPiToolsAgent(root);
  assert.notEqual(agent.name, other.name);
  assert.equal(agent.isPrepared(), false);
  const bridge = {
    serverName: "pi-bridge-123",
    url: "http://127.0.0.1:1234/mcp",
    token: "test-token",
  };
  await agent.prepare(bridge);
  assert.equal(agent.isPrepared(), true);
  const agentFile = path.join(root, agent.name, "agent.md");
  const definition = JSON.parse((await readFile(agentFile, "utf8")).split("---\n")[1]);
  assert.deepEqual(definition.tools, []);
  assert.equal(definition.mainAgent, true);
  assert.equal(definition.inheritCustomizations, false);
  assert.deepEqual(definition.mcpServers, [
    {
      name: bridge.serverName,
      serverUrl: bridge.url,
      headers: { "x-pi-bridge-token": bridge.token },
    },
  ]);
  if (process.platform !== "win32") {
    assert.equal((await stat(agentFile)).mode & 0o777, 0o600);
  }
  await agent.prepare({ ...bridge, url: "http://127.0.0.1:5678/mcp" });
  assert.match(await readFile(agentFile, "utf8"), /5678/);
  agent.removeSync();
  await agent.remove();
  assert.equal(agent.isPrepared(), false);
  assert.deepEqual(await readdir(root), ["existing-agent.md"]);
});

function pbField(fieldNumber: number, payload: string | Buffer): Buffer {
  const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const tag = (fieldNumber << 3) | 2;
  const encodeVarint = (n: number): Buffer => {
    const out: number[] = [];
    let v = n >>> 0;
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v);
    return Buffer.from(out);
  };
  return Buffer.concat([encodeVarint(tag), encodeVarint(bytes.length), bytes]);
}

test("detachAgyConversationBridgeMetadata and sweepStalePiToolsConversations strip dead pi-tools agent and bridge workspace URIs", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "agy-meta-detach-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const baseDir = path.join(home, ".gemini", "antigravity-cli");
  await mkdir(path.join(baseDir, "conversations"), { recursive: true });
  await mkdir(path.join(baseDir, "cache"), { recursive: true });

  const cid = "b601fe33-2c2f-4f36-98d4-9a92d54f714b";
  const bridgeUri = "file:///tmp/nonexistent/.pi/agent/antigravity/bridges/f0c64fa8-ffcb-44b8-a4de-4a4a1777eea4";
  const projectUri = "file:///Users/test/repo/lani-web";
  const deadAgent = "pi-tools-99999999-8d849ac9-c732-4555-b139-2840083b7bf0";

  const trajectoryBlob = Buffer.concat([
    pbField(1, bridgeUri),
    pbField(1, projectUri),
    pbField(4, deadAgent),
    pbField(6, cid),
    pbField(7, bridgeUri),
    pbField(7, projectUri),
    pbField(10, `file:///Users/test/.gemini/config/agents/${deadAgent}/agent.md`),
  ]);

  const convDb = new DatabaseSync(path.join(baseDir, "conversations", `${cid}.db`));
  convDb.exec("CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB)");
  convDb.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(trajectoryBlob);
  convDb.close();

  const summaryBlob = Buffer.concat([
    pbField(1, "migrate sveltekit 3"),
    pbField(9, bridgeUri),
    pbField(9, projectUri),
    pbField(17, trajectoryBlob),
  ]);
  const sumDb = new DatabaseSync(path.join(baseDir, "conversation_summaries.db"));
  sumDb.exec(
    "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, agent_name TEXT, workspace_uris TEXT, raw_summary BLOB)",
  );
  sumDb
    .prepare(
      "INSERT INTO conversation_summaries (conversation_id, agent_name, workspace_uris, raw_summary) VALUES (?, ?, ?, ?)",
    )
    .run(cid, deadAgent, JSON.stringify([bridgeUri, projectUri]), summaryBlob);
  sumDb.close();

  const metaJsonPath = path.join(baseDir, "cache", "conversation_metadata.json");
  await writeFile(
    metaJsonPath,
    JSON.stringify({
      conversations: {
        [cid]: {
          summary: {
            ID: cid,
            Title: "migrate sveltekit 3",
            AgentName: deadAgent,
            WorkspaceURIs: [bridgeUri, projectUri],
          },
        },
      },
    }),
  );

  assert.equal(sweepStalePiToolsConversations(home), 1);
  assert.equal(detachAgyConversationBridgeMetadata(cid, home), false);

  const checkConvDb = new DatabaseSync(path.join(baseDir, "conversations", `${cid}.db`), {
    readOnly: true,
  });
  const cleanedBlob = Buffer.from(
    (
      checkConvDb
        .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'")
        .get() as { data: Uint8Array }
    ).data,
  );
  checkConvDb.close();
  assert.equal(cleanedBlob.includes("pi-tools-"), false);
  assert.equal(cleanedBlob.includes("/antigravity/bridges/"), false);
  assert.equal(cleanedBlob.includes(projectUri), true);

  const checkSumDb = new DatabaseSync(path.join(baseDir, "conversation_summaries.db"), {
    readOnly: true,
  });
  const sumRow = checkSumDb
    .prepare("SELECT agent_name, workspace_uris, raw_summary FROM conversation_summaries WHERE conversation_id = ?")
    .get(cid) as { agent_name: string; workspace_uris: string; raw_summary: Uint8Array };
  checkSumDb.close();
  assert.equal(sumRow.agent_name, "");
  assert.deepEqual(JSON.parse(sumRow.workspace_uris), [projectUri]);
  assert.equal(Buffer.from(sumRow.raw_summary).includes("pi-tools-"), false);
  assert.equal(Buffer.from(sumRow.raw_summary).includes("/antigravity/bridges/"), false);

  const cleanedJson = JSON.parse(await readFile(metaJsonPath, "utf8"));
  assert.equal(cleanedJson.conversations[cid].summary.AgentName, "");
  assert.deepEqual(cleanedJson.conversations[cid].summary.WorkspaceURIs, [projectUri]);
});

test("formatAgySubagentsLivePreviewLines renders multi-line stack for running /teamwork and /boost subagents", async (t) => {
  const brainDir = await mkdtemp(path.join(tmpdir(), "pi-agy-subagents-preview-"));
  t.after(() => rm(brainDir, { recursive: true, force: true }));

  const parentCid = "4103eeef-1a66-4109-a152-81ae20e913f6";
  const rootCid = "6c181934-1ede-42ae-8aa0-e05325b687ba";
  const orchCid = "7d95d907-757c-4fc3-b421-379835d6c306";
  const explorerCid = "8e06e018-868d-4ad4-c532-480946e7d417";

  await mkdir(path.join(brainDir, parentCid, ".system_generated", "subagents"), { recursive: true });
  await mkdir(path.join(brainDir, rootCid, ".system_generated", "subagents"), { recursive: true });
  await mkdir(path.join(brainDir, rootCid, ".system_generated", "logs"), { recursive: true });
  await mkdir(path.join(brainDir, orchCid, ".system_generated", "subagents"), { recursive: true });
  await mkdir(path.join(brainDir, orchCid, ".system_generated", "logs"), { recursive: true });
  await mkdir(path.join(brainDir, explorerCid, ".system_generated", "logs"), { recursive: true });

  await writeFile(
    path.join(brainDir, parentCid, ".system_generated", "subagents", `${rootCid}.json`),
    JSON.stringify({
      conversationId: rootCid,
      subagentDescriptor: {
        typeName: "teamwork_preview",
        role: "Sveltekit 3 & Auth/Launcher Audit Team",
      },
      state: "SUBAGENT_STATE_ALIVE",
      spawnStepIndex: 12,
    }),
  );
  await writeFile(
    path.join(brainDir, rootCid, ".system_generated", "logs", "transcript.jsonl"),
    `${JSON.stringify({
      step_index: 5,
      created_at: "2026-10-23T08:00:00Z",
      tool_calls: [{ name: "invoke_subagent", args: { toolSummary: "Check orchestrator progress" } }],
    })}\n`,
  );

  await writeFile(
    path.join(brainDir, rootCid, ".system_generated", "subagents", `${orchCid}.json`),
    JSON.stringify({
      conversationId: orchCid,
      subagentDescriptor: {
        typeName: "teamwork_preview_orchestrator",
        role: "Project Orchestrator",
      },
      state: "SUBAGENT_STATE_ALIVE",
      spawnStepIndex: 10,
    }),
  );
  await writeFile(
    path.join(brainDir, orchCid, ".system_generated", "logs", "transcript.jsonl"),
    `${JSON.stringify({
      step_index: 3,
      created_at: "2026-10-23T08:01:00Z",
    })}\n`,
  );

  await writeFile(
    path.join(brainDir, orchCid, ".system_generated", "subagents", `${explorerCid}.json`),
    JSON.stringify({
      conversationId: explorerCid,
      subagentDescriptor: {
        typeName: "teamwork_preview_explorer",
        role: "Remediation Explorer",
      },
      state: "SUBAGENT_STATE_ALIVE",
      spawnStepIndex: 14,
    }),
  );
  await writeFile(
    path.join(brainDir, explorerCid, ".system_generated", "logs", "transcript.jsonl"),
    `${JSON.stringify({
      step_index: 7,
      created_at: "2026-10-23T09:30:00Z",
      tool_calls: [{ name: "run_command", args: { CommandLine: "bun run check" } }],
    })}\n`,
  );

  const roster = new Map<string, AgySubagentEntry>();
  trackAgySubagent(
    roster,
    {
      type: "tool_start",
      stepId: 12,
      name: "invoke_subagent",
      args: { TypeName: "teamwork_preview", Role: "Sveltekit 3 & Auth/Launcher Audit Team" },
    },
    Date.parse("2026-10-23T08:00:00Z"),
  );
  await syncAgySubagentRoster(roster, parentCid, brainDir);

  const now = Date.parse("2026-10-23T09:42:19Z");
  const lines = formatAgySubagentsLivePreviewLines(roster, now);
  assert.deepEqual(lines, [
    "• Agent(teamwork_preview_explorer: Remediation Explorer) bun run check • 12m19s",
    "• Agent(teamwork_preview_orchestrator: Project Orchestrator) Working • 1h41m",
    "• Agent(teamwork_preview: Sveltekit 3 & Auth/Launcher Audit Team) Check orchestrator progress • 1h42m",
  ]);
});

test("contextHasPriorTeamworkActivity and contextHasPriorBoostActivity ignore non-subagent mentions and separate modes", () => {
  const codeEditAndQuestion = [
    {
      role: "user",
      content: "how does teamwork_preview work with prompt_draft.md?",
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "edit",
          arguments: { path: "lib/prompt.ts", newText: "teamwork_preview prompt_draft.md" },
        },
      ],
    },
  ] as unknown as Parameters<typeof contextHasPriorTeamworkActivity>[0];

  assert.equal(contextHasPriorTeamworkActivity(codeEditAndQuestion), false);
  assert.equal(contextHasPriorBoostActivity(codeEditAndQuestion), false);

  const teamworkInvoke = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "antigravity",
          arguments: {
            tool: "invoke_subagent",
            input: { TypeName: "teamwork_preview", Prompt: "Build it" },
          },
        },
      ],
    },
  ] as unknown as Parameters<typeof contextHasPriorTeamworkActivity>[0];

  assert.equal(contextHasPriorTeamworkActivity(teamworkInvoke), true);
  assert.equal(contextHasPriorBoostActivity(teamworkInvoke), false);

  const boostInvoke = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "invoke_subagent",
          arguments: { TypeName: "implementer", Prompt: "Fix bug" },
        },
      ],
    },
  ] as unknown as Parameters<typeof contextHasPriorTeamworkActivity>[0];

  assert.equal(contextHasPriorTeamworkActivity(boostInvoke), false);
  assert.equal(contextHasPriorBoostActivity(boostInvoke), true);
});

test("read_file, edit_file, and write_file render with Pi native read:start-end warning range and edit/write labels", () => {
  const mockTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `<b>${text}</b>`,
  } as unknown as Parameters<typeof formatAgyCall>[2];

  assert.equal(
    formatAgyCall(
      "read_file",
      { EndLine: 490, Path: "/tmp/runtime.ts", StartLine: 390 },
      mockTheme,
    ),
    "<toolTitle><b>read</b></toolTitle> <accent>/tmp/runtime.ts</accent><warning>:390-490</warning>",
  );
  assert.equal(
    formatAgyCall("edit_file", { Path: "/tmp/runtime.ts", Target: "a", Replacement: "b" }, mockTheme),
    "<toolTitle><b>edit</b></toolTitle> <accent>/tmp/runtime.ts</accent>",
  );
  assert.equal(
    formatAgyCall("write_file", { Path: "/tmp/runtime.ts", Content: "abc" }, mockTheme),
    "<toolTitle><b>write</b></toolTitle> <accent>/tmp/runtime.ts</accent>",
  );
  assert.deepEqual(
    mapAgyToolToNative("read_file", { EndLine: 490, Path: "/tmp/runtime.ts", StartLine: 390 }),
    {
      tool: "read",
      args: { path: "/tmp/runtime.ts", offset: 390, limit: 101 },
    },
  );
  assert.equal(isAgyEditTool("edit_file"), true);
  assert.equal(isAgyEditTool("write_file"), true);
});

test("AntigravityRuntime keeps the same conversationId when switching between pi-tools custom agent and Boost/Teamwork default agent", async () => {
  const seenRequests: Array<{
    conversationId?: string;
    agent?: string;
    prompt: string;
  }> = [];

  let nextId = 1;
  const runtime = createAntigravityRuntime(async (request) => {
    seenRequests.push({
      conversationId: request.conversationId,
      agent: request.agent,
      prompt: request.prompt,
    });
    const cid = request.conversationId ?? `conv-${nextId++}`;
    request.onConversation?.(cid);
    request.onActivity?.({
      type: "result",
      status: "OK",
      conversationId: cid,
    });
    return {
      status: "OK",
      conversationId: cid,
      text: "done",
      steps: [],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  });

  try {
    const service = runtime.runSync(AntigravityRuntime);

    // Turn 1: normal pi-tools custom agent turn creates conv-1
    const c1 = await runtime.runPromise(
      service.beginStreamTurn({
        prompt: "hello",
        modelId: "claude-opus-4-6-thinking",
        agent: "pi-tools-test",
      }),
    );
    while (!c1.isClosed() || c1.hasPending()) {
      await c1.next();
    }
    await runtime.runPromise(service.finishTurn);

    // Turn 1b: continuing with the same pi-tools agent reuses conv-1
    const c1b = await runtime.runPromise(
      service.beginStreamTurn({
        prompt: "follow up",
        historyBootstrap: "HIST_1B",
        modelId: "claude-opus-4-6-thinking",
        agent: "pi-tools-test",
      }),
    );
    while (!c1b.isClosed() || c1b.hasPending()) {
      await c1b.next();
    }
    await runtime.runPromise(service.finishTurn);

    // Turn 2: /boost turn drops custom agent (agent: undefined) while keeping conv-1
    const c2 = await runtime.runPromise(
      service.beginStreamTurn({
        prompt: "BOOST_PROMPT\n\ninvestigate auth",
        historyBootstrap: "HIST_BEFORE_BOOST",
        modelId: "claude-opus-4-6-thinking",
        agent: undefined,
      }),
    );
    // Re-attaching with identical prompt (simulating mid-turn tool step) returns the same controller
    const c2Reattached = await runtime.runPromise(
      service.beginStreamTurn({
        prompt: "BOOST_PROMPT\n\ninvestigate auth",
        historyBootstrap: "HIST_BEFORE_BOOST",
        modelId: "claude-opus-4-6-thinking",
        agent: undefined,
      }),
    );
    assert.equal(c2Reattached, c2);
    while (!c2.isClosed() || c2.hasPending()) {
      await c2.next();
    }
    await runtime.runPromise(service.finishTurn);

    // Turn 3: next normal turn restores pi-tools custom agent while still keeping conv-1
    const c3 = await runtime.runPromise(
      service.beginStreamTurn({
        prompt: "back to normal",
        historyBootstrap: "HIST_AFTER_BOOST",
        modelId: "claude-opus-4-6-thinking",
        agent: "pi-tools-test",
      }),
    );
    while (!c3.isClosed() || c3.hasPending()) {
      await c3.next();
    }
    await runtime.runPromise(service.finishTurn);

    assert.equal(seenRequests.length, 4);
    assert.equal(seenRequests[0].conversationId, undefined);
    assert.equal(seenRequests[0].agent, "pi-tools-test");

    assert.equal(seenRequests[1].conversationId, "conv-1");
    assert.equal(seenRequests[1].agent, "pi-tools-test");
    assert.equal(seenRequests[1].prompt.includes("HIST_1B"), false);

    assert.equal(seenRequests[2].conversationId, "conv-1");
    assert.equal(seenRequests[2].agent, undefined);
    assert.equal(seenRequests[2].prompt.includes("HIST_BEFORE_BOOST"), false);

    assert.equal(seenRequests[3].conversationId, "conv-1");
    assert.equal(seenRequests[3].agent, "pi-tools-test");
    assert.equal(seenRequests[3].prompt.includes("HIST_AFTER_BOOST"), false);
  } finally {
    await runtime.dispose();
  }
});

test("shouldInterceptSubagentSteerInput routes interactive Enter steer to /btw only during active Boost/Teamwork/subagent turns", () => {
  const base = {
    source: "interactive",
    streamingBehavior: "steer",
    text: "  what does this helper do?  ",
    hasImages: false,
    provider: "antigravity",
    agyAgentActive: true,
    isBoostActive: true,
    isTeamworkActive: false,
    subagentSpawnedThisTurn: false,
  };

  assert.equal(shouldInterceptSubagentSteerInput(base), "what does this helper do?");
  assert.equal(
    shouldInterceptSubagentSteerInput({
      ...base,
      isBoostActive: false,
      isTeamworkActive: true,
    }),
    "what does this helper do?",
  );
  assert.equal(
    shouldInterceptSubagentSteerInput({
      ...base,
      isBoostActive: false,
      subagentSpawnedThisTurn: true,
    }),
    "what does this helper do?",
  );

  // Alt+Enter follow-up still queues for the main session
  assert.equal(
    shouldInterceptSubagentSteerInput({ ...base, streamingBehavior: "followUp" }),
    undefined,
  );
  // Idle submission (streamingBehavior undefined) goes to main session
  assert.equal(
    shouldInterceptSubagentSteerInput({ ...base, streamingBehavior: undefined }),
    undefined,
  );
  // Ordinary non-Boost/non-Teamwork/non-subagent turns keep normal steer behavior
  assert.equal(
    shouldInterceptSubagentSteerInput({ ...base, isBoostActive: false }),
    undefined,
  );
  // Slash commands, bash commands, images, and non-interactive inputs are never intercepted
  assert.equal(
    shouldInterceptSubagentSteerInput({ ...base, text: "/agy-subagents" }),
    undefined,
  );
  assert.equal(
    shouldInterceptSubagentSteerInput({ ...base, text: "!git status" }),
    undefined,
  );
  assert.equal(
    shouldInterceptSubagentSteerInput({ ...base, hasImages: true }),
    undefined,
  );
  assert.equal(
    shouldInterceptSubagentSteerInput({ ...base, source: "extension" }),
    undefined,
  );
});



