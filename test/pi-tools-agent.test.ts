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
import { createPiToolsAgent } from "../lib/pi-tools-agent.ts";
import { readAgyToolMode, resolveAgyToolModeCommand } from "../lib/tool-mode.ts";

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
  await agent.remove();
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
