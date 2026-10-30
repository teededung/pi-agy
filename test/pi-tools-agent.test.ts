import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  AGY_CONVERSATION_STATE_ENTRY,
  restorableAgyConversation,
} from "../lib/conversation-state.ts";
import {
  buildPiToolsTrajectoryMetadataFields,
  deleteAgyConversationsForSessionFile,
  deleteDisposableAgyConversation,
  detachAgyConversationBridgeMetadata,
  extractAgyConversationIdsFromSessionFile,
  renameAgyConversationsForSessionFile,
  sweepStalePiToolsConversations,
} from "../lib/conversation-metadata.ts";
import { RECOMMENDED_AGY_VERSION } from "../lib/agy-diagnostics.ts";
import { reduceAgyStream, stripHallucinatedTurnSuffix } from "../lib/reducer.ts";
import {
  installModelSelectorSelectionPatch,
  installSessionSelectorDeletePatch,
  toProviderModel,
} from "../index.ts";
import { parseAgyUsageJson } from "../lib/usage.ts";
import { isAgyEditTool } from "../lib/diff.ts";
import { mapAgyToolToNative } from "../lib/native-tools.ts";
import {
  createPiToolsAgent,
  EAGER_PI_BRIDGE_TOOLS_CONFIG,
  PI_TOOLS_AGENT_NATIVE_TOOLS,
} from "../lib/pi-tools-agent.ts";
import {
  AGY_CLAUDE_CONTEXT_LIMIT,
  AGY_EFFECTIVE_CONTEXT_LIMIT,
  computeSessionUsageSnapshot,
  renderFooterLines,
  resolveAgyBranchContextTokens,
  resolveAgyEffectiveContextLimit,
  resolveBranchContextFootprint,
} from "../lib/footer.ts";
import { formatAgyCall } from "../lib/render.ts";
import {
  formatAgySubagentsLivePreviewLines,
  shouldInterceptSubagentSteerInput,
  syncAgySubagentRoster,
  trackAgySubagent,
  type AgySubagentEntry,
} from "../lib/subagents.ts";
import { readAgyToolMode, resolveAgyToolModeCommand } from "../lib/tool-mode.ts";
import { AGY_COMPACTION_ENTRY } from "../lib/agy-compaction.ts";
import {
  ALL_FALLBACK_MODELS,
  getAgyConsultCompletions,
  resolveAgyConsultSpec,
} from "../lib/models.ts";
import {
  contextHasPriorBoostActivity,
  contextHasPriorTeamworkActivity,
  isBridgedMcpStep,
  latestUserPrompt,
  mapUsage,
  piHistoryBootstrap,
  streamAntigravity,
  type AgySettledTurnOutcome,
} from "../src/provider.ts";
import {
  buildGoalContinuationPrompt,
  decideGoalSettlement,
  formatGoalElapsed,
  GOAL_CANCELLED_MARKER,
  GOAL_COMPLETE_MARKER,
  GOAL_INITIAL_PROMPT,
  inspectGoalResponseMarkers,
} from "../lib/prompt.ts";
import { AgyPiBridge } from "../lib/bridge.ts";
import { AgyReplayStore } from "../lib/replay.ts";
import { AgyStallError } from "../lib/agy-client.ts";
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
  assert.deepEqual(definition.tools, [...PI_TOOLS_AGENT_NATIVE_TOOLS]);
  assert.equal(EAGER_PI_BRIDGE_TOOLS_CONFIG.pi__web_search?.eager, true);
  assert.equal(EAGER_PI_BRIDGE_TOOLS_CONFIG.pi__fetch_content?.eager, true);
  assert.equal(EAGER_PI_BRIDGE_TOOLS_CONFIG.pi__grep?.eager, true);
  assert.equal(definition.mainAgent, true);
  assert.equal(definition.inheritCustomizations, false);
  assert.deepEqual(definition.mcpServers, [
    {
      name: bridge.serverName,
      url: bridge.url,
      serverUrl: bridge.url,
      headers: { "x-pi-bridge-token": bridge.token },
      tools: EAGER_PI_BRIDGE_TOOLS_CONFIG,
    },
  ]);
  assert.equal(
    isBridgedMcpStep(
      { name: "call_mcp_tool", args: { ServerName: bridge.serverName, ToolName: "pi__read" } },
      bridge.serverName,
    ),
    true,
  );
  assert.equal(
    isBridgedMcpStep(
      { name: `mcp_${bridge.serverName}_pi__read`, args: { path: "/tmp/file" } },
      bridge.serverName,
    ),
    true,
  );
  assert.equal(
    isBridgedMcpStep(
      { name: "mcp_other-server_some_tool", args: {} },
      bridge.serverName,
    ),
    false,
  );
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

test("AntigravityRuntime keeps the same conversationId and attaches/detaches pi-tools metadata when switching between pi-tools custom agent and Boost/Teamwork default agent", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-agy-switch-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  const convDir = path.join(home, ".gemini", "antigravity-cli", "conversations");
  await mkdir(convDir, { recursive: true });
  const conv1 = "11111111-2222-4333-8444-555555555555";
  const convDbPath = path.join(convDir, `${conv1}.db`);

  const readHasPiTools = (): boolean => {
    const db = new DatabaseSync(convDbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'")
        .get() as { data?: Uint8Array } | undefined;
      return row?.data ? Buffer.from(row.data).includes("pi-tools-test") : false;
    } finally {
      db.close();
    }
  };

  const seenRequests: Array<{
    conversationId?: string;
    agent?: string;
    prompt: string;
    hasPiToolsInDb: boolean;
  }> = [];

  const runtime = createAntigravityRuntime(async (request) => {
    const cid = request.conversationId ?? conv1;
    if (!request.conversationId) {
      const db = new DatabaseSync(convDbPath);
      db.exec("CREATE TABLE IF NOT EXISTS trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB)");
      const initialBlob = Buffer.concat([
        pbField(1, "file:///Users/test/repo/lani-web"),
        pbField(4, "pi-tools-test"),
        pbField(6, cid),
        pbField(10, "file:///Users/test/.agents/agents/pi-tools-test/agent.md"),
      ]);
      db.prepare("INSERT OR REPLACE INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(
        initialBlob,
      );
      db.close();
    }
    seenRequests.push({
      conversationId: request.conversationId,
      agent: request.agent,
      prompt: request.prompt,
      hasPiToolsInDb: readHasPiTools(),
    });
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

    // Turn 1: normal pi-tools custom agent turn creates conv1
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
    assert.equal(readHasPiTools(), false);

    // Turn 1b: continuing with the same pi-tools agent reuses conv1 and re-attaches metadata
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
    assert.equal(readHasPiTools(), false);

    // Turn 2: /boost turn drops custom agent (agent: undefined) while keeping conv1
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
    assert.equal(readHasPiTools(), false);

    // Turn 3: next normal turn restores pi-tools custom agent on conv1 with metadata re-attached
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
    assert.equal(readHasPiTools(), false);

    assert.equal(seenRequests.length, 4);
    assert.equal(seenRequests[0].conversationId, undefined);
    assert.equal(seenRequests[0].agent, "pi-tools-test");
    assert.equal(seenRequests[0].hasPiToolsInDb, true);

    assert.equal(seenRequests[1].conversationId, conv1);
    assert.equal(seenRequests[1].agent, "pi-tools-test");
    assert.equal(seenRequests[1].prompt.includes("HIST_1B"), false);
    assert.equal(seenRequests[1].hasPiToolsInDb, true);

    assert.equal(seenRequests[2].conversationId, conv1);
    assert.equal(seenRequests[2].agent, undefined);
    assert.equal(seenRequests[2].prompt.includes("HIST_BEFORE_BOOST"), false);
    assert.equal(seenRequests[2].hasPiToolsInDb, false);

    assert.equal(seenRequests[3].conversationId, conv1);
    assert.equal(seenRequests[3].agent, "pi-tools-test");
    assert.equal(seenRequests[3].prompt.includes("HIST_AFTER_BOOST"), false);
    assert.equal(seenRequests[3].hasPiToolsInDb, true);
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

test("installSessionSelectorDeletePatch and deleteAgyConversationsForSessionFile delete linked agy conversations on /resume Ctrl+D", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-agy-resume-del-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const cid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const agyBase = path.join(home, ".gemini", "antigravity-cli");
  await mkdir(path.join(agyBase, "conversations"), { recursive: true });
  await mkdir(path.join(agyBase, "annotations"), { recursive: true });
  await mkdir(path.join(agyBase, "presence"), { recursive: true });
  await mkdir(path.join(agyBase, "implicit"), { recursive: true });
  await mkdir(path.join(agyBase, "brain", cid), { recursive: true });
  await mkdir(path.join(agyBase, "cache"), { recursive: true });

  await writeFile(path.join(agyBase, "conversations", `${cid}.db`), "db");
  await writeFile(path.join(agyBase, "annotations", `${cid}.pbtxt`), 'title:"test"');
  await writeFile(path.join(agyBase, "presence", `${cid}.lock`), "lock");
  await writeFile(path.join(agyBase, "implicit", `${cid}.pb`), "pb");
  await writeFile(path.join(agyBase, "brain", cid, "task.md"), "task");
  await writeFile(
    path.join(agyBase, "cache", "conversation_metadata.json"),
    JSON.stringify({ conversations: { [cid]: { summary: { Title: "test" } } } }),
  );

  const summariesDbPath = path.join(agyBase, "conversation_summaries.db");
  const db = new DatabaseSync(summariesDbPath);
  db.exec(
    "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, raw_summary BLOB)",
  );
  db.prepare(
    "INSERT INTO conversation_summaries (conversation_id, title, raw_summary) VALUES (?, ?, ?)",
  ).run(cid, "test", null);
  db.close();

  const sessionPath = path.join(home, "session.jsonl");
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      type: "custom",
      customType: "pi-agy-conversation-state",
      data: { version: 1, kind: "conversation", conversationId: cid },
    })}\n`,
  );

  assert.deepEqual(extractAgyConversationIdsFromSessionFile(sessionPath), [cid]);

  const eventsOrder: string[] = [];
  class FakeSessionSelector {
    sessionList = {
      onDeleteSession: async (targetPath: string) => {
        eventsOrder.push(`pi-delete:${targetPath}`);
        await rm(targetPath, { force: true });
      },
    };
    renameSession = async (targetPath: string, nextName: string) => {
      eventsOrder.push(`pi-rename:${targetPath}:${nextName}`);
    };
    handleInput(_data: string): void {}
    cancelLoads(): void {}
  }

  installSessionSelectorDeletePatch(
    FakeSessionSelector,
    async (targetPath) => {
      eventsOrder.push(`agy-delete:${targetPath}`);
      await deleteAgyConversationsForSessionFile(targetPath, home);
    },
    async (targetPath, nextName) => {
      eventsOrder.push(`agy-rename:${targetPath}:${nextName}`);
      await renameAgyConversationsForSessionFile(targetPath, nextName, home);
    },
  );

  const selector = new FakeSessionSelector();
  selector.handleInput("\x12");
  await selector.renameSession(sessionPath, "Renamed From Resume");

  assert.deepEqual(eventsOrder, [
    `pi-rename:${sessionPath}:Renamed From Resume`,
    `agy-rename:${sessionPath}:Renamed From Resume`,
  ]);
  const renamedPbtxt = await readFile(path.join(agyBase, "annotations", `${cid}.pbtxt`), "utf8");
  assert.match(renamedPbtxt, /title:"Renamed From Resume"/);
  const renamedDb = new DatabaseSync(summariesDbPath, { readOnly: true });
  const renamedRow = renamedDb
    .prepare("SELECT title FROM conversation_summaries WHERE conversation_id = ?")
    .get(cid) as { title: string };
  renamedDb.close();
  assert.equal(renamedRow.title, "Renamed From Resume");
  const renamedMetaJson = JSON.parse(
    await readFile(path.join(agyBase, "cache", "conversation_metadata.json"), "utf8"),
  ) as { conversations: Record<string, { summary?: { Title?: string } }> };
  assert.equal(renamedMetaJson.conversations[cid]?.summary?.Title, "Renamed From Resume");

  eventsOrder.length = 0;
  selector.handleInput("\x04");
  await selector.sessionList.onDeleteSession(sessionPath);

  assert.deepEqual(eventsOrder, [`agy-delete:${sessionPath}`, `pi-delete:${sessionPath}`]);
  await assert.rejects(stat(path.join(agyBase, "conversations", `${cid}.db`)));
  await assert.rejects(stat(path.join(agyBase, "annotations", `${cid}.pbtxt`)));
  await assert.rejects(stat(path.join(agyBase, "presence", `${cid}.lock`)));
  await assert.rejects(stat(path.join(agyBase, "implicit", `${cid}.pb`)));
  await assert.rejects(stat(path.join(agyBase, "brain", cid)));

  const checkDb = new DatabaseSync(summariesDbPath, { readOnly: true });
  const remaining = checkDb
    .prepare("SELECT count(*) as c FROM conversation_summaries WHERE conversation_id = ?")
    .get(cid) as { c: number };
  checkDb.close();
  assert.equal(remaining.c, 0);

  const metaJson = JSON.parse(
    await readFile(path.join(agyBase, "cache", "conversation_metadata.json"), "utf8"),
  ) as { conversations: Record<string, unknown> };
  assert.equal(cid in metaJson.conversations, false);
});

test("installModelSelectorSelectionPatch preserves user selection when background model catalog refresh completes", () => {
  class FakeModelSelector {
    allModels = [
      { provider: "antigravity", id: "gemini-3-flash" },
      { provider: "antigravity", id: "claude-sonnet-4-6" },
      { provider: "antigravity", id: "claude-opus-4-6" },
    ];
    filteredModels = [...this.allModels];
    selectedIndex = 0;
    lastRenderedIndex = 0;

    constructor() {
      this.loadModelsFromSnapshot();
      this.updateList();
    }

    loadModelsFromSnapshot(): void {
      this.filteredModels = [...this.allModels];
      // Simulate Pi's built-in reset to currentModel (index 0)
      this.selectedIndex = 0;
    }

    filterModels(query: string): void {
      this.filteredModels = query
        ? this.allModels.filter((m) => m.id.includes(query))
        : [...this.allModels];
      // Simulate Pi's built-in reset when query is non-empty or clamped
      this.selectedIndex = query
        ? 0
        : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
      this.updateList();
    }

    updateList(): void {
      this.lastRenderedIndex = this.selectedIndex;
    }
  }

  installModelSelectorSelectionPatch(FakeModelSelector);

  // 1. Browsing without search query: user moves down to index 2, then background refresh finishes
  const selector = new FakeModelSelector();
  assert.equal(selector.selectedIndex, 0);
  selector.selectedIndex = 2; // User moved cursor to claude-opus-4-6
  selector.loadModelsFromSnapshot();
  selector.filterModels("");
  assert.equal(selector.selectedIndex, 2);
  assert.equal(selector.lastRenderedIndex, 2);
  assert.equal(selector.filteredModels[selector.selectedIndex]?.id, "claude-opus-4-6");

  // 2. Browsing with search query: user filters "claude" and moves down to index 1, then refresh finishes
  selector.filterModels("claude");
  assert.equal(selector.selectedIndex, 0); // Typing a new query moves to top match
  selector.selectedIndex = 1; // User moves down to second "claude" model (claude-opus-4-6)
  selector.loadModelsFromSnapshot();
  selector.filterModels("claude");
  assert.equal(selector.selectedIndex, 1);
  assert.equal(selector.lastRenderedIndex, 1);
  assert.equal(selector.filteredModels[selector.selectedIndex]?.id, "claude-opus-4-6");
});

test("renderFooterLines renders 2-row footer with agy 300k context bar and filters redundant agy-context status", () => {
  const plainTheme = {
    fg: (_color: string, text: string) => text,
  };
  const branch = [
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "antigravity",
        usage: { input: 2_000, output: 500, cacheRead: 226_000, cost: { total: 11.138 } },
      },
    },
    // Multi-step final delta with cacheRead subtracted to 0 must not overwrite the 228k footprint.
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "antigravity",
        usage: { input: 1_500, output: 300, cacheRead: 0, cost: { total: 0.02 } },
      },
    },
  ];
  const agyTokens = resolveAgyBranchContextTokens(branch);
  assert.equal(agyTokens, 228_000);
  assert.equal(AGY_EFFECTIVE_CONTEXT_LIMIT, 300_000);

  const snapshot = computeSessionUsageSnapshot(branch);
  const statuses = new Map<string, string>([
    ["0-tps", "[42.0 tok/s]"],
    ["agy-context", "agy context ~228k"],
    ["antigravity", "pi-tools:on"],
    ["ponytail", "○ 🐴 ponytail: 🌱 LITE"],
  ]);

  const lines = renderFooterLines({
    width: 120,
    cwd: "/Users/rongmauhong/Documents/Repo/ragnarok",
    home: "/Users/rongmauhong",
    gitBranch: "main",
    sessionName: "pi-agy",
    provider: "antigravity",
    modelId: "gemini-4-argon",
    reasoning: true,
    thinkingLevel: "medium",
    availableProviderCount: 2,
    agyContextTokens: agyTokens,
    usageTotals: snapshot.usageTotals,
    latestCacheHitRate: 98.7,
    extensionStatuses: statuses,
    theme: plainTheme,
  });

  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /~\/Documents\/Repo\/ragnarok \(⎇ main\) • pi-agy/);
  assert.match(lines[0]!, /\(antigravity\) gemini-4-argon • medium$/);
  assert.match(lines[1]!, /^\[█+░+\] ~228k\/300k \(76%\) │ ↑3\.5k ↓800 R226k CH98\.7% \$11\.16/);
  assert.match(lines[1]!, /\[42\.0 tok\/s\] pi-tools:on ○ 🐴 ponytail: 🌱 LITE$/);
  assert.equal(lines[1]!.includes("agy context"), false);

  // Antigravity Claude Sonnet 5.5 and Opus 5.5 models render against their 1.0M context window,
  // while Gemini models continue to use the 300k effective ceiling.
  assert.equal(resolveAgyEffectiveContextLimit("gemini-4-argon"), AGY_EFFECTIVE_CONTEXT_LIMIT);
  assert.equal(resolveAgyEffectiveContextLimit("gemini-3.8-flash"), AGY_EFFECTIVE_CONTEXT_LIMIT);
  assert.equal(resolveAgyEffectiveContextLimit("claude-sonnet-5-5"), AGY_CLAUDE_CONTEXT_LIMIT);
  assert.equal(resolveAgyEffectiveContextLimit("claude-opus-5-5"), AGY_CLAUDE_CONTEXT_LIMIT);
  const agyClaudeLines = renderFooterLines({
    width: 120,
    cwd: "/Users/rongmauhong/Documents/Repo/ragnarok",
    home: "/Users/rongmauhong",
    gitBranch: "main",
    sessionName: "pi-agy",
    provider: "antigravity",
    modelId: "claude-opus-5-5",
    reasoning: true,
    thinkingLevel: "high",
    availableProviderCount: 2,
    agyContextTokens: agyTokens,
    modelContextWindow: 1_000_000,
    usageTotals: snapshot.usageTotals,
    latestCacheHitRate: 98.7,
    extensionStatuses: statuses,
    theme: plainTheme,
  });
  assert.match(agyClaudeLines[0]!, /\(antigravity\) claude-opus-5-5 • high$/);
  assert.match(agyClaudeLines[1]!, /^\[█+░+\] ~228k\/1\.0M \(23%\) │ ↑3\.5k ↓800 R226k CH98\.7% \$11\.16/);

  // Switching mid-session from antigravity (300k) to kiro (1M) updates the footer limit to 1.0M
  // and preserves the 228k branch context footprint even when Pi's last-message totalTokens was 1.8k.
  const footprint = resolveBranchContextFootprint(branch);
  assert.equal(footprint.nonAgyFallbackTokens, 228_000);
  const kiroLines = renderFooterLines({
    width: 120,
    cwd: "/Users/rongmauhong/Documents/Repo/ragnarok",
    home: "/Users/rongmauhong",
    gitBranch: "main",
    sessionName: "pi-agy",
    provider: "kiro",
    modelId: "claude-opus-5-5",
    reasoning: true,
    thinkingLevel: "high",
    availableProviderCount: 2,
    agyContextTokens: footprint.nonAgyFallbackTokens,
    modelContextWindow: 1_000_000,
    contextUsage: {
      tokens: 1_800,
      contextWindow: 1_000_000,
      percent: 0.18,
    },
    usageTotals: snapshot.usageTotals,
    latestCacheHitRate: 98.7,
    extensionStatuses: statuses,
    theme: plainTheme,
  });

  assert.equal(kiroLines.length, 2);
  assert.match(kiroLines[0]!, /\(kiro\) claude-opus-5-5 • high$/);
  assert.match(kiroLines[1]!, /^\[█+░+\] 228k\/1\.0M \(23%\) │ ↑3\.5k ↓800 R226k CH98\.7% \$11\.16/);

  // Routed physical model contextWindow in contextUsage takes precedence over virtual modelContextWindow.
  const routedKiroLines = renderFooterLines({
    width: 120,
    cwd: "/Users/rongmauhong/Documents/Repo/ragnarok",
    home: "/Users/rongmauhong",
    provider: "kiro",
    modelId: "auto",
    modelContextWindow: 1_000_000,
    contextUsage: {
      tokens: 100_000,
      contextWindow: 200_000,
      percent: 50,
    },
    usageTotals: snapshot.usageTotals,
    theme: plainTheme,
  });
  assert.match(routedKiroLines[1]!, /^\[█+░+\] 100k\/200k \(50%\)/);

  // One-shot /m consult on antigravity (truncated 51k bootstrap) after a 549k kiro turn keeps 549k floor.
  const consultBranch = [
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "kiro",
        usage: { input: 548_686, output: 799, totalTokens: 549_485 },
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "antigravity",
        usage: { input: 2_254, output: 716, cacheRead: 48_958 },
      },
    },
  ];
  assert.equal(resolveBranchContextFootprint(consultBranch).nonAgyFallbackTokens, 549_485);

  // Compaction resets prior branch context tokens, and mapUsage includes cache_read_tokens in totalTokens.
  assert.equal(resolveAgyBranchContextTokens([...branch, { type: "compaction" }]), undefined);
  // A stale pi-agy-conversation-state marker re-anchored right after /compact without a post-compaction
  // assistant turn must not resurrect the 314k pre-compaction red context bar.
  const stalePostCompactBranch = [
    ...branch,
    {
      type: "custom",
      customType: AGY_CONVERSATION_STATE_ENTRY,
      data: { kind: "conversation", conversationId: "pre-compact-conv", contextTokens: 314_326 },
    },
    { type: "compaction", tokensBefore: 315_421, summary: "## Goal\nContinue..." },
    {
      type: "custom",
      customType: AGY_CONVERSATION_STATE_ENTRY,
      data: { kind: "conversation", conversationId: "pre-compact-conv", contextTokens: 314_326 },
    },
  ];
  const staleFootprint = resolveBranchContextFootprint(stalePostCompactBranch);
  assert.equal(staleFootprint.agyTokens, undefined);
  assert.equal(staleFootprint.awaitingPostCompactionTurn, true);

  // Once a new assistant turn completes after compaction, its context footprint becomes authoritative.
  const postCompactTurnBranch = [
    ...stalePostCompactBranch,
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "antigravity",
        usage: { input: 3_200, output: 400, cacheRead: 28_000 },
      },
    },
  ];
  const postCompactFootprint = resolveBranchContextFootprint(postCompactTurnBranch);
  assert.equal(postCompactFootprint.agyTokens, 31_200);
  assert.equal(postCompactFootprint.awaitingPostCompactionTurn, undefined);

  assert.equal(
    mapUsage({
      input_tokens: 2_000,
      output_tokens: 500,
      cache_read_tokens: 226_000,
      total_tokens: 2_500,
    }).totalTokens,
    228_500,
  );
});

test("restorableAgyConversation restores pi tool-mode conversations across bridge server rotation", () => {
  const sessionId = "session-123";
  const cwd = "/Users/test/repo/ragnarok";
  const piMarker = {
    type: "custom",
    customType: AGY_CONVERSATION_STATE_ENTRY,
    data: {
      version: 1,
      kind: "conversation",
      sessionId,
      conversationId: "c4098627-f3db-4e14-92df-90df43d7b3a9",
      cwd,
      modelId: "gemini-4-argon",
      toolMode: "pi",
      bridgeServer: "pi-676687f0606b",
      turns: 27,
      usage: { input_tokens: 1_579, output_tokens: 204, cache_read_tokens: 20_026 },
      contextTokens: 20_026,
    },
  } as const;

  const branch = [
    { type: "message", message: { role: "user", content: "hello" } },
    piMarker,
    // Non-context-changing custom entries (such aspi-agy-compaction) may follow the state marker.
    {
      type: "custom",
      customType: "pi-agy-compaction",
      data: { version: 1, tokensBefore: 299_135, tokensAfter: 20_026 },
    },
  ] as unknown as Parameters<typeof restorableAgyConversation>[0];

  // Restores in pi mode even when /reload or session resume creates a new bridgeServer name.
  const restored = restorableAgyConversation(branch, sessionId, cwd, "pi", "pi-c95c4c4c57c2");
  assert.equal(restored?.conversationId, "c4098627-f3db-4e14-92df-90df43d7b3a9");
  assert.equal(restored?.contextTokens, 20_026);

  // Rejects when toolMode mismatches or when the bridge is disabled.
  assert.equal(restorableAgyConversation(branch, sessionId, cwd, "native", "pi-c95c4c4c57c2"), undefined);
  assert.equal(restorableAgyConversation(branch, sessionId, cwd, "pi", undefined), undefined);

  // Native mode still requires matching bridgeServer.
  const nativeBranch = [
    {
      type: "custom",
      customType: AGY_CONVERSATION_STATE_ENTRY,
      data: {
        ...piMarker.data,
        toolMode: "native",
      },
    },
  ] as unknown as Parameters<typeof restorableAgyConversation>[0];
  assert.equal(
    restorableAgyConversation(nativeBranch, sessionId, cwd, "native", "pi-676687f0606b")?.conversationId,
    "c4098627-f3db-4e14-92df-90df43d7b3a9",
  );
  assert.equal(
    restorableAgyConversation(nativeBranch, sessionId, cwd, "native", "pi-c95c4c4c57c2"),
    undefined,
  );

  // Rejects a state marker persisted right after /compact without any post-compaction message turn.
  const compactedBranch = [
    { type: "message", message: { role: "user", content: "hello" } },
    piMarker,
    { type: "compaction", tokensBefore: 315_421, summary: "## Goal\n..." },
    piMarker,
  ] as unknown as Parameters<typeof restorableAgyConversation>[0];
  assert.equal(
    restorableAgyConversation(compactedBranch, sessionId, cwd, "pi", "pi-c95c4c4c57c2"),
    undefined,
  );
});

test("resolveAgyConsultSpec supports model/thinking switch when allowEmptyPrompt is set", () => {
  const rejected = resolveAgyConsultSpec("flash3", ALL_FALLBACK_MODELS);
  assert.equal(rejected.ok, false);

  const switchedFlash = resolveAgyConsultSpec("flash3", ALL_FALLBACK_MODELS, {
    allowEmptyPrompt: true,
  });
  assert.equal(switchedFlash.ok, true);
  if (switchedFlash.ok) {
    assert.equal(switchedFlash.model.id, "gemini-3.8-flash");
    assert.equal(switchedFlash.effort, "high");
    assert.equal(switchedFlash.prompt, "");
  }

  const switchedOpus = resolveAgyConsultSpec("opus", ALL_FALLBACK_MODELS, {
    allowEmptyPrompt: true,
  });
  assert.equal(switchedOpus.ok, true);
  if (switchedOpus.ok) {
    assert.equal(switchedOpus.model.id, "claude-opus-5-5");
    assert.equal(switchedOpus.effort, undefined);
    assert.equal(switchedOpus.prompt, "");
  }

  const completions = getAgyConsultCompletions(
    "opus",
    ALL_FALLBACK_MODELS,
    "claude-opus-5-5",
    "high",
  );
  assert.ok(completions && completions.length > 0);
  const opus2 = completions.find((item) => item.label === "opus2");
  const opus3 = completions.find((item) => item.label === "opus3");
  assert.ok(opus2);
  assert.equal(opus3, undefined);
});

test("piHistoryBootstrap slices pre-compaction messages when branch contains pi-agy-compaction", () => {
  const turn1User = { role: "user", content: "turn 1 old question" };
  const turn1Assistant = { role: "assistant", content: [{ type: "text", text: "turn 1 old answer" }] };
  const turn2User = { role: "user", content: "turn 2 question that compacted mid-turn" };
  const turn2PreStep = {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "old.ts" } }],
  };
  const turn2PreTool = { role: "toolResult", toolName: "read", content: "old file contents" };
  const turn2PostAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "turn 2 final answer after compaction" }],
  };
  const turn3User = { role: "user", content: "turn 3 follow-up" };

  const context = {
    messages: [
      turn1User,
      turn1Assistant,
      turn2User,
      turn2PreStep,
      turn2PreTool,
      turn2PostAssistant,
      turn3User,
    ],
  } as unknown as Parameters<typeof piHistoryBootstrap>[0];

  const branch = [
    { type: "message", message: turn1User },
    { type: "message", message: turn1Assistant },
    { type: "message", message: turn2User },
    { type: "message", message: turn2PreStep },
    { type: "message", message: turn2PreTool },
    {
      type: "custom",
      customType: AGY_COMPACTION_ENTRY,
      data: { version: 1, beforeTokens: 299_135, afterTokens: 20_026 },
    },
    { type: "message", message: turn2PostAssistant },
    { type: "message", message: turn3User },
  ];

  const restored = piHistoryBootstrap(context, 0, branch);
  assert.ok(restored);
  assert.ok(restored.includes("[Earlier history compacted]"));
  assert.ok(!restored.includes("turn 1 old question"));
  assert.ok(!restored.includes("turn 1 old answer"));
  assert.ok(!restored.includes("old.ts"));
  assert.ok(!restored.includes("old file contents"));
  assert.ok(restored.includes("turn 2 question that compacted mid-turn"));
  assert.ok(restored.includes("turn 2 final answer after compaction"));
});

test("deleteDisposableAgyConversation recursively deletes subagent trees and cleans last_conversations.json", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-agy-subagent-delete-"));
  try {
    const agyBase = path.join(home, ".gemini", "antigravity-cli");
    await mkdir(path.join(agyBase, "conversations"), { recursive: true });
    await mkdir(path.join(agyBase, "annotations"), { recursive: true });
    await mkdir(path.join(agyBase, "cache"), { recursive: true });

    const rootCid = "11111111-1111-4111-8111-111111111111";
    const childCid = "22222222-2222-4222-8222-222222222222";
    const nestedWorkerCid = "33333333-3333-4333-8333-333333333333";
    const unrelatedCid = "44444444-4444-4444-8444-444444444444";

    for (const cid of [rootCid, childCid, nestedWorkerCid, unrelatedCid]) {
      await writeFile(path.join(agyBase, "conversations", `${cid}.db`), "db", "utf8");
      await writeFile(path.join(agyBase, "annotations", `${cid}.pbtxt`), `title:"${cid}"`, "utf8");
      await mkdir(path.join(agyBase, "brain", cid), { recursive: true });
    }

    // root -> child via brain/.system_generated/subagents/*.json
    const rootSubDir = path.join(agyBase, "brain", rootCid, ".system_generated", "subagents");
    await mkdir(rootSubDir, { recursive: true });
    await writeFile(
      path.join(rootSubDir, `${childCid}.json`),
      JSON.stringify({ conversationId: childCid, state: "SUBAGENT_STATE_ALIVE" }),
      "utf8",
    );

    // child -> nestedWorker via conversation_summaries.db parent_conversation_id
    const summariesDbPath = path.join(agyBase, "conversation_summaries.db");
    const db = new DatabaseSync(summariesDbPath);
    db.exec(
      "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '')",
    );
    db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, parent_conversation_id, title) VALUES (?, ?, ?)",
    ).run(rootCid, "", "Root");
    db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, parent_conversation_id, title) VALUES (?, ?, ?)",
    ).run(childCid, rootCid, "DeepCoder");
    db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, parent_conversation_id, title) VALUES (?, ?, ?)",
    ).run(nestedWorkerCid, childCid, "DeepCoderWorkerL0");
    db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, parent_conversation_id, title) VALUES (?, ?, ?)",
    ).run(unrelatedCid, "", "Keep Me");
    db.close();

    await writeFile(
      path.join(agyBase, "cache", "conversation_metadata.json"),
      JSON.stringify({
        conversations: {
          [rootCid]: { summary: { ID: rootCid } },
          [childCid]: { summary: { ID: childCid } },
          [nestedWorkerCid]: { summary: { ID: nestedWorkerCid } },
          [unrelatedCid]: { summary: { ID: unrelatedCid } },
        },
      }),
      "utf8",
    );

    const missingBridgeDir = path.join(home, ".pi", "agent", "antigravity", "bridges", "dead-bridge");
    await writeFile(
      path.join(agyBase, "cache", "last_conversations.json"),
      JSON.stringify({
        "/repo/root": rootCid,
        "/repo/subagent": childCid,
        [missingBridgeDir]: unrelatedCid,
        "/repo/keep": unrelatedCid,
      }),
      "utf8",
    );

    await deleteDisposableAgyConversation(rootCid, home);

    for (const deletedId of [rootCid, childCid, nestedWorkerCid]) {
      await assert.rejects(stat(path.join(agyBase, "conversations", `${deletedId}.db`)));
      await assert.rejects(stat(path.join(agyBase, "annotations", `${deletedId}.pbtxt`)));
      await assert.rejects(stat(path.join(agyBase, "brain", deletedId)));
    }
    await stat(path.join(agyBase, "conversations", `${unrelatedCid}.db`));

    const verifyDb = new DatabaseSync(summariesDbPath, { readOnly: true });
    const rows = verifyDb
      .prepare("SELECT conversation_id FROM conversation_summaries")
      .all() as Array<{ conversation_id: string }>;
    verifyDb.close();
    assert.deepEqual(
      rows.map((r) => r.conversation_id),
      [unrelatedCid],
    );

    const lastConvs = JSON.parse(
      await readFile(path.join(agyBase, "cache", "last_conversations.json"), "utf8"),
    ) as Record<string, string>;
    assert.deepEqual(lastConvs, { "/repo/keep": unrelatedCid });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reduceAgyStream strips invisible U+FFF9-U+FFFB chars without truncating subsequent deltas and RECOMMENDED_AGY_VERSION is 1.4.9", () => {
  assert.equal(RECOMMENDED_AGY_VERSION, "1.4.9");
  assert.equal(stripHallucinatedTurnSuffix("hello \uFFF9code\uFFFA\uFFFB world"), "hello code world");

  const stream = [
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        step_type: "agent_response",
        state: "ACTIVE",
        text_delta: "First \uFFF9chunk\uFFFA, ",
      },
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        step_type: "agent_response",
        state: "DONE",
        text_delta: "second \uFFFBchunk!",
      },
    }),
    JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "First \uFFF9chunk\uFFFA, second \uFFFBchunk!",
      },
    }),
  ].join("\n");

  const outcome = reduceAgyStream(stream);
  assert.equal(outcome.response, "First chunk, second chunk!");
  const streamedText = outcome.activities
    .filter((a): a is Extract<typeof a, { type: "text" }> => a.type === "text")
    .map((a) => a.delta)
    .join("");
  assert.equal(streamedText, "First chunk, second chunk!");
});

test("buildPiToolsTrajectoryMetadataFields encodes native specialty tools and latestUserPrompt materializes base64 images", async (t) => {
  const mcpDir = await mkdtemp(path.join(tmpdir(), "pi-agy-meta-tools-"));
  t.after(() => rm(mcpDir, { recursive: true, force: true }));
  const agent = createPiToolsAgent(path.join(mcpDir, ".agents", "agents"));
  await agent.prepare({
    serverName: "pi-bridge-test",
    url: "http://127.0.0.1:4321/mcp",
    token: "secret",
  });

  const blob = buildPiToolsTrajectoryMetadataFields(agent.name, mcpDir);
  for (const nativeTool of PI_TOOLS_AGENT_NATIVE_TOOLS) {
    // Each tool in DeclarativeComponentConfig (f18.1.3) must include field 1 (name) + field 2 (builtin: true = 0x10 0x01).
    const expectedEntry = Buffer.concat([
      pbField(1, nativeTool),
      Buffer.from([0x10, 0x01]),
    ]);
    assert.equal(blob.includes(expectedEntry), true);
  }
  assert.equal(blob.includes(Buffer.from("pi__web_search", "utf8")), true);
  assert.equal(blob.includes(Buffer.from("pi__fetch_content", "utf8")), true);

  // 1x1 transparent PNG in base64
  const tinyPngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const contextWithImage = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this screenshot?" },
          { type: "image", mimeType: "image/png", data: tinyPngBase64 },
          { type: "image" }, // bare image stub without data falls back to omittedImagesPrompt
        ],
      },
    ],
  } as unknown as Parameters<typeof latestUserPrompt>[0];

  const { prompt, images } = latestUserPrompt(contextWithImage);
  assert.equal(images, 2);
  assert.match(prompt, /What is in this screenshot\?/);
  assert.match(prompt, /Attached user image\(s\) saved to disk/);
  assert.match(prompt, /\(1 image\(s\) omitted — the agy print interface is text-only\)/);

  const pathMatch = prompt.match(/^- Image 1: (.+\.png)$/m);
  assert.ok(pathMatch?.[1]);
  const savedFilePath = pathMatch[1];
  t.after(() => rm(savedFilePath, { force: true }));
  const savedBytes = await readFile(savedFilePath);
  assert.deepEqual(savedBytes, Buffer.from(tinyPngBase64, "base64"));
});

test("AntigravityRuntime resends user prompt when a resumed conversation stalls before init, and uses continuation prompt only after init", async (t) => {
  const prevBackoff = process.env.AGY_STALL_RETRY_BACKOFF_MS;
  process.env.AGY_STALL_RETRY_BACKOFF_MS = "1";
  t.after(() => {
    if (prevBackoff === undefined) delete process.env.AGY_STALL_RETRY_BACKOFF_MS;
    else process.env.AGY_STALL_RETRY_BACKOFF_MS = prevBackoff;
  });

  const prompts: string[] = [];
  let attempt = 0;
  const runtime = createAntigravityRuntime(async (request) => {
    attempt += 1;
    prompts.push(request.prompt);
    if (attempt === 1) {
      // Stalled during silent auth BEFORE init/onConversation: agy never recorded the user prompt.
      throw new AgyStallError(90_000, false);
    }
    if (attempt === 2) {
      // Reached init (onConversation), so agy recorded the prompt, then stalled mid-turn.
      request.onConversation?.("ebb9b188-f5d6-42e9-bc50-7a01c3089a3b");
      throw new AgyStallError(90_000, false);
    }
    request.onConversation?.("ebb9b188-f5d6-42e9-bc50-7a01c3089a3b");
    const result = {
      type: "result" as const,
      status: "OK" as const,
      response: "handled injected context",
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    };
    request.onActivity?.(result);
    return {
      conversationId: "ebb9b188-f5d6-42e9-bc50-7a01c3089a3b",
      status: "OK",
      response: "handled injected context",
      activities: [result],
      usage: result.usage,
      finished: true,
    };
  });
  t.after(() => runtime.dispose());

  const service = runtime.runSync(AntigravityRuntime);
  await runtime.runPromise(
    service.restoreConversation({
      conversationId: "ebb9b188-f5d6-42e9-bc50-7a01c3089a3b",
      modelId: "gemini-4-argon",
      cwd: "/tmp/ws",
      turns: 3,
      usage: {},
    }),
  );

  const injectedPrompt =
    "Here is a side conversation I had for additional context:\n\nUser: can we safe-refactor?";
  const controller = await runtime.runPromise(
    service.beginStreamTurn({
      prompt: injectedPrompt,
      systemPrompt: "Instructions",
      modelId: "gemini-4-argon",
    }),
  );
  while ((await controller.next()) !== null) {
    // consume activities
  }
  await runtime.runPromise(service.finishTurn);

  assert.equal(prompts.length, 3);
  // Attempt 1 (initial) and Attempt 2 (retry after pre-init stall) both carry the injected user prompt.
  assert.match(prompts[0]!, /Here is a side conversation I had for additional context/);
  assert.match(prompts[1]!, /Here is a side conversation I had for additional context/);
  assert.doesNotMatch(prompts[1]!, /The stream was interrupted before your previous turn completed/);
  // Attempt 3 (retry after post-init stall) uses the continuation prompt without duplicating the user prompt.
  assert.match(prompts[2]!, /The stream was interrupted before your previous turn completed/);
  assert.doesNotMatch(prompts[2]!, /Here is a side conversation I had for additional context/);
});

test("/goal prompt helpers format elapsed time, continuation checklist, and response markers", () => {
  assert.equal(formatGoalElapsed(0), "0s");
  assert.equal(formatGoalElapsed(45_900), "45s");
  assert.equal(formatGoalElapsed(120_000), "2m");
  assert.equal(formatGoalElapsed(750_000), "12m 30s");
  assert.equal(formatGoalElapsed(3_600_000), "1h");
  assert.equal(formatGoalElapsed(3_900_000), "1h 5m");

  const cont = buildGoalContinuationPrompt("Ship full test suite and docs", 750_000, 3);
  assert.match(cont, /You are still working toward the user's goal\./);
  assert.match(cont, /Time spent so far: 12m 30s/);
  assert.match(cont, /Continuation: #3/);
  assert.match(cont, /include <!-- GOAL_COMPLETE --> in your response/);
  assert.match(cont, /include <!-- GOAL_CANCELLED --> in your response/);
  assert.match(cont, /Original request: Ship full test suite and docs$/);

  assert.equal(inspectGoalResponseMarkers("Still working on step 2..."), undefined);
  assert.equal(
    inspectGoalResponseMarkers(`All deliverables verified.\n${GOAL_COMPLETE_MARKER}`),
    "complete",
  );
  assert.equal(
    inspectGoalResponseMarkers(`Stopping as requested.\n${GOAL_CANCELLED_MARKER}`),
    "cancelled",
  );

  // decideGoalSettlement covers complete, cancelled, Esc abort during toolUse, subagent wait, max continuations, and continue
  assert.equal(
    decideGoalSettlement({
      settled: true,
      stopReason: "stop",
      responseText: `Done ${GOAL_COMPLETE_MARKER}`,
      continuations: 0,
    }),
    "complete",
  );
  assert.equal(
    decideGoalSettlement({
      settled: true,
      stopReason: "stop",
      responseText: `Stopped ${GOAL_CANCELLED_MARKER}`,
      continuations: 1,
    }),
    "cancelled",
  );
  assert.equal(
    decideGoalSettlement({
      aborted: true,
      settled: false,
      stopReason: "toolUse",
      responseText: "Running slow bash command...",
      continuations: 2,
    }),
    "aborted",
  );
  assert.equal(
    decideGoalSettlement({
      settled: true,
      stopReason: "error",
      responseText: "Partial text",
      continuations: 0,
    }),
    "aborted",
  );
  assert.equal(
    decideGoalSettlement({
      settled: true,
      stopReason: "stop",
      responseText: "Spawned DeepCoder subagent.",
      hadSubagentActivity: true,
      continuations: 0,
    }),
    "wait",
  );
  assert.equal(
    decideGoalSettlement({
      settled: true,
      stopReason: "stop",
      responseText: "Still working...",
      continuations: 50,
    }),
    "max_continuations",
  );
  assert.equal(
    decideGoalSettlement({
      settled: true,
      stopReason: "stop",
      responseText: "Finished phase 1, moving to phase 2.",
      continuations: 2,
    }),
    "continue",
  );
});

test("streamAntigravity expands /goal, notifies onGoalStarted, and reports settled outcome", async (t) => {
  const seenRequests: Array<{ prompt: string; agent?: string; timeoutMs?: number }> = [];
  const runtime = createAntigravityRuntime(async (request) => {
    seenRequests.push({
      prompt: request.prompt,
      agent: request.agent,
      timeoutMs: request.timeoutMs,
    });
    request.onConversation?.("goal-conv-1");
    const result = {
      type: "result" as const,
      status: "OK" as const,
      response: "Completed all checks. <!-- GOAL_COMPLETE -->",
      usage: { input_tokens: 50, output_tokens: 15, total_tokens: 65 },
    };
    request.onActivity?.(result);
    return {
      conversationId: "goal-conv-1",
      status: "OK",
      response: result.response,
      activities: [result],
      usage: result.usage,
      finished: true,
    };
  });
  t.after(() => runtime.dispose());

  const service = runtime.runSync(AntigravityRuntime);
  const replay = new AgyReplayStore();
  const bridge = new AgyPiBridge("pi-test");

  const startedGoals: Array<{ request: string; boost?: boolean }> = [];
  const settledOutcomes: Array<AgySettledTurnOutcome | undefined> = [];

  const streamFn = streamAntigravity(
    runtime,
    service,
    replay,
    bridge,
    (outcome) => settledOutcomes.push(outcome),
    undefined,
    () => true,
    undefined,
    createAntigravityRuntime,
    () => undefined,
    () => ({ mode: "agent", agent: "pi-tools" }),
    () => undefined,
    () => "Relayed instructions",
    () => false,
    () => undefined,
    () => ALL_FALLBACK_MODELS,
    undefined,
    () => false,
    () => undefined,
    () => true,
    (request, options) => startedGoals.push({ request, boost: options?.boost }),
  );

  const model = {
    id: "gemini-4-argon",
    name: "Gemini",
    api: "antigravity-stream-json",
    provider: "antigravity",
    baseUrl: "agy://local-stream-json",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  };

  const eventStream = streamFn(model, {
    messages: [{ role: "user", content: "/goal /boost Refactor auth and run all tests" }],
  });
  for await (const _event of eventStream) {
    // consume stream
  }

  assert.equal(startedGoals.length, 1);
  assert.deepEqual(startedGoals[0], {
    request: "Refactor auth and run all tests",
    boost: true,
  });
  assert.equal(seenRequests.length, 1);
  assert.ok(seenRequests[0]!.prompt.includes(GOAL_INITIAL_PROMPT));
  assert.ok(seenRequests[0]!.prompt.includes("Refactor auth and run all tests"));
  assert.equal(seenRequests[0]!.agent, undefined); // bypassed custom agent because /boost was combined
  assert.equal(seenRequests[0]!.timeoutMs, 7_200_000);
  assert.equal(settledOutcomes.length, 1);
  assert.equal(settledOutcomes[0]?.stopReason, "stop");
  assert.equal(settledOutcomes[0]?.responseText, "Completed all checks. <!-- GOAL_COMPLETE -->");
  assert.equal(
    inspectGoalResponseMarkers(settledOutcomes[0]?.responseText ?? ""),
    "complete",
  );
});

test("finished_reason handling preserves partial text without swallowing print_timeout/interrupted/hook errors, and models declare image input", async (t) => {
  // 1. toProviderModel enables text + image input
  const providerModel = toProviderModel(ALL_FALLBACK_MODELS[0]!);
  assert.deepEqual(providerModel.input, ["text", "image"]);

  // 2. reduceAgyStream turns status: SUCCESS + finished_reason: print_timeout into ERROR
  const partialTimeoutOutcome = reduceAgyStream(
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conv-timeout",
        status: "SUCCESS",
        response: "Half of an answer...",
        finished_reason: "print_timeout",
      },
    }),
  );
  assert.equal(partialTimeoutOutcome.status, "ERROR");
  assert.equal(partialTimeoutOutcome.finishedReason, "print_timeout");
  assert.equal(partialTimeoutOutcome.response, "Half of an answer...");
  assert.match(partialTimeoutOutcome.error ?? "", /timed out/);

  // 3. parseAgyUsageJson surfaces print_timeout instead of "no quota groups returned"
  assert.throws(
    () =>
      parseAgyUsageJson(
        JSON.stringify({
          status: "SUCCESS",
          finished_reason: "print_timeout",
        }),
      ),
    /quota command timed out/,
  );

  // 4. streamAntigravity: verify partial cut-off, hook error, interrupted, and transient tail recovery
  const runScenario = async (resultEvent: {
    status: "OK" | "ERROR";
    finishedReason?: string;
    response: string;
    error?: string;
  }) => {
    const runtime = createAntigravityRuntime(async (request) => {
      request.onConversation?.("conv-fr");
      const activity = {
        type: "result" as const,
        ...resultEvent,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      };
      request.onActivity?.(activity);
      return {
        conversationId: "conv-fr",
        status: resultEvent.status,
        finishedReason: resultEvent.finishedReason,
        response: resultEvent.response,
        error: resultEvent.error,
        activities: [activity],
        usage: activity.usage,
        finished: true,
      };
    });
    t.after(() => runtime.dispose());

    const service = runtime.runSync(AntigravityRuntime);
    const settled: Array<AgySettledTurnOutcome | undefined> = [];
    const streamFn = streamAntigravity(
      runtime,
      service,
      new AgyReplayStore(),
      new AgyPiBridge("pi-test"),
      (o) => settled.push(o),
    );
    const model = {
      id: "gemini-4-argon",
      name: "Gemini",
      api: "antigravity-stream-json",
      provider: "antigravity",
      baseUrl: "agy://local-stream-json",
      reasoning: true,
      input: ["text", "image"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    };

    const events: Array<{ type: string; reason?: string; error?: { errorMessage?: string; content?: unknown[] }; message?: { content?: unknown[] } }> = [];
    for await (const ev of streamFn(model, {
      messages: [{ role: "user", content: "test", timestamp: Date.now() }],
    })) {
      events.push(ev as (typeof events)[number]);
    }
    return { events, settled: settled[0] };
  };

  // 4a. print_timeout with partial text -> stopReason "error", partial text preserved
  const timeoutRun = await runScenario({
    status: "ERROR",
    finishedReason: "print_timeout",
    response: "Partial output before timeout",
    error: "agy turn timed out (--print-timeout expired); response is partial.",
  });
  assert.equal(timeoutRun.settled?.stopReason, "error");
  assert.equal(timeoutRun.settled?.responseText, "Partial output before timeout");
  assert.equal(timeoutRun.events.at(-1)?.type, "error");

  // 4b. Hook/fatal error after partial text -> NOT swallowed, stopReason "error"
  const hookErrorRun = await runScenario({
    status: "ERROR",
    finishedReason: "error",
    response: "Some partial text",
    error: "Blocked sensitive prompt",
  });
  assert.equal(hookErrorRun.settled?.stopReason, "error");
  assert.equal(hookErrorRun.settled?.responseText, "Some partial text");
  assert.equal(hookErrorRun.events.at(-1)?.error?.errorMessage, "Blocked sensitive prompt");

  // 4c. Interrupted turn -> stopReason "aborted"
  const interruptedRun = await runScenario({
    status: "ERROR",
    finishedReason: "interrupted",
    response: "Interrupted mid-sentence",
    error: "agy turn was interrupted before completion.",
  });
  assert.equal(interruptedRun.settled?.stopReason, "aborted");
  assert.equal(interruptedRun.events.at(-1)?.reason, "aborted");

  // 4d. Genuine transient tail transport interruption with full text -> still recovered as "stop"
  const recoveredRun = await runScenario({
    status: "ERROR",
    finishedReason: "error",
    response: "Complete answer before EOF",
    error: "stream was interrupted: unexpected EOF",
  });
  assert.equal(recoveredRun.settled?.stopReason, "stop");
  assert.equal(recoveredRun.events.at(-1)?.type, "done");
});



