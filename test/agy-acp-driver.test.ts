import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai";
import { AgyAcpDriverSession } from "../lib/agy-acp-driver.ts";
import {
  ACP_AUTH_REQUIRED_CODE,
  AgyAcpClient,
  AgyAcpRpcError,
  acpUsageToAgyUsage,
  buildAcpAgyArgs,
  buildAcpChildEnvironment,
  decodeAcpSessionState,
  extractAcpQuotaSnapshot,
  formatAcpStopError,
  modelsFromAcpSessionState,
  readAcpMcpServersFromDirectory,
  selectAcpPermissionOutcome,
  type AcpChildProcess,
} from "../lib/agy-acp-client.ts";
import { AgyPiBridge } from "../lib/bridge.ts";
import { createAgyTurnExecutor } from "../lib/agy-driver.ts";
import { createPrivateMcpConfig } from "../lib/mcp-config.ts";
import { AgyReplayStore } from "../lib/replay.ts";
import { isBridgedMcpStep, streamAntigravity } from "../src/provider.ts";
import { AntigravityRuntime, createAntigravityRuntime, runAntigravity } from "../src/runtime.ts";

interface MockRpcCall {
  id?: number | string;
  method: string;
  params: Record<string, unknown>;
}

function createFakeAcpSpawn(options?: {
  missingSessionId?: string;
  hangPromptUntilCancel?: boolean;
  requestPermissionOnPrompt?: boolean;
  refusalOnPrompt?: { text: string; resetTime?: string };
}) {
  let spawnCount = 0;
  let nextSessionSeq = 1;
  const spawnedArgs: string[][] = [];
  const rpcLog: MockRpcCall[] = [];
  const closedSessions: string[] = [];

  const spawnOverride = ((_cmd: string, args: readonly string[]) => {
    spawnCount += 1;
    spawnedArgs.push([...args]);

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const proc = new EventEmitter() as ChildProcess & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: (signal?: NodeJS.Signals | number) => boolean;
    };
    proc.stdin = stdin;
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.pid = 40_000 + spawnCount;
    proc.exitCode = null;
    proc.signalCode = null;
    proc.kill = (sig) => {
      proc.signalCode = typeof sig === "string" ? sig : "SIGTERM";
      proc.exitCode = null;
      queueMicrotask(() => proc.emit("close", null, proc.signalCode));
      return true;
    };

    const sessions = new Map<
      string,
      { model: string; thoughtLevel: string; mode: string; systemPrompt?: string }
    >();
    let pendingCancelPrompt: { id: number; sessionId: string } | undefined;
    let pendingPermissionPrompt:
      | { promptId: number; sessionId: string; permissionReqId: string }
      | undefined;

    const send = (payload: unknown) => {
      stdout.write(`${JSON.stringify(payload)}\n`);
    };

    const buildConfigOptions = (state: {
      model: string;
      thoughtLevel: string;
      mode: string;
    }) => [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: state.model,
        options: [
          { value: "gemini-4-argon", name: "Gemini 4 Argon" },
          { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        ],
      },
      {
        id: "thought_level",
        name: "Thinking Level",
        category: "thought_level",
        type: "select",
        currentValue: state.thoughtLevel,
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: state.mode,
        options: [
          { value: "default", name: "Default" },
          { value: "accept-edits", name: "Accept edits" },
          { value: "plan", name: "Plan" },
        ],
      },
    ];

    let inBuf = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      inBuf += chunk;
      for (;;) {
        const nl = inBuf.indexOf("\n");
        if (nl < 0) break;
        const line = inBuf.slice(0, nl).trim();
        inBuf = inBuf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as {
          id?: number | string;
          method?: string;
          params?: Record<string, unknown>;
          result?: { outcome?: { outcome?: string; optionId?: string } };
        };

        // Client response to server-initiated session/request_permission
        if (msg.id && !msg.method && pendingPermissionPrompt?.permissionReqId === msg.id) {
          const pending = pendingPermissionPrompt;
          pendingPermissionPrompt = undefined;
          const outcomeKind = msg.result?.outcome?.outcome ?? "cancelled";
          const optionId = msg.result?.outcome?.optionId ?? "none";
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: pending.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `perm=${outcomeKind}:${optionId}` },
              },
            },
          });
          send({
            jsonrpc: "2.0",
            id: pending.promptId,
            result: {
              stopReason: "end_turn",
              usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 40, thoughtTokens: 5 },
            },
          });
          continue;
        }

        if (msg.method) {
          rpcLog.push({ id: msg.id, method: msg.method, params: msg.params ?? {} });
        }

        if (msg.method === "session/cancel") {
          if (pendingCancelPrompt) {
            const target = pendingCancelPrompt;
            pendingCancelPrompt = undefined;
            send({
              jsonrpc: "2.0",
              id: target.id,
              result: { stopReason: "cancelled" },
            });
          }
          continue;
        }

        const id = msg.id as number;
        const params = msg.params ?? {};

        if (msg.method === "initialize") {
          // Emit non-JSON stdout startup noise first to verify compatibility filtering.
          stdout.write("Opening Antigravity session helper...\n");
          send({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: 1,
              agentInfo: { name: "Antigravity ACP Server", version: "1.5.0" },
              authMethods: [
                { id: "oauth-personal", name: "Log in with Google" },
                { id: "gemini-api-key", name: "Use Gemini API Key" },
              ],
              agentCapabilities: {
                loadSession: true,
                promptCapabilities: { image: true, audio: false, embeddedContext: true },
                sessionCapabilities: {
                  resume: {},
                  close: {},
                  load: {},
                  additionalDirectories: {},
                },
                _meta: {
                  antigravity: { tier: true, systemPrompt: { append: true } },
                },
              },
            },
          });
        } else if (msg.method === "authenticate") {
          send({
            jsonrpc: "2.0",
            id,
            result: {},
          });
        } else if (msg.method === "session/new") {
          const sid = `acp-conv-${nextSessionSeq++}`;
          const meta = params._meta as
            | { antigravity?: { systemPrompt?: { append?: string } } }
            | undefined;
          const state = {
            model: "gemini-4-argon",
            thoughtLevel: "medium",
            mode: "default",
            systemPrompt: meta?.antigravity?.systemPrompt?.append,
          };
          sessions.set(sid, state);
          send({
            jsonrpc: "2.0",
            id,
            result: {
              sessionId: sid,
              configOptions: buildConfigOptions(state),
            },
          });
        } else if (msg.method === "session/resume" || msg.method === "session/load") {
          const sid = String(params.sessionId ?? "");
          if (options?.missingSessionId && sid === options.missingSessionId) {
            send({
              jsonrpc: "2.0",
              id,
              error: {
                code: -32603,
                message:
                  msg.method === "session/resume"
                    ? `Failed to read session ${sid}; retry, or load it with session/load`
                    : `Session ${sid} not found on disk`,
              },
            });
            continue;
          }
          const meta = params._meta as
            | { antigravity?: { systemPrompt?: { append?: string } } }
            | undefined;
          const existing = sessions.get(sid) ?? {
            model: "gemini-4-argon",
            thoughtLevel: "medium",
            mode: "default",
          };
          existing.systemPrompt = meta?.antigravity?.systemPrompt?.append;
          sessions.set(sid, existing);
          send({
            jsonrpc: "2.0",
            id,
            result: {
              configOptions: buildConfigOptions(existing),
            },
          });
        } else if (msg.method === "session/close") {
          const sid = String(params.sessionId ?? "");
          closedSessions.push(sid);
          send({ jsonrpc: "2.0", id, result: {} });
        } else if (msg.method === "session/set_config_option") {
          const sid = String(params.sessionId ?? "");
          const state = sessions.get(sid)!;
          const cfgId = String(params.configId ?? "");
          const val = String(params.value ?? "");
          if (cfgId === "model") state.model = val;
          else if (cfgId === "thought_level") state.thoughtLevel = val;
          else if (cfgId === "mode") state.mode = val;
          send({
            jsonrpc: "2.0",
            id,
            result: { configOptions: buildConfigOptions(state) },
          });
        } else if (msg.method === "session/prompt") {
          const sid = String(params.sessionId ?? "");
          const state = sessions.get(sid)!;
          const blocks = (params.prompt as Array<Record<string, unknown>>) ?? [];
          const textPrompt = blocks
            .filter((b) => b.type === "text")
            .map((b) => String(b.text ?? ""))
            .join("\n");

          if (options?.hangPromptUntilCancel && textPrompt.includes("HANG_ME")) {
            pendingCancelPrompt = { id, sessionId: sid };
            send({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: "agent_thought_chunk",
                  content: { type: "text", text: "Working..." },
                },
              },
            });
            continue;
          }

          if (options?.refusalOnPrompt) {
            send({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: options.refusalOnPrompt.text },
                },
              },
            });
            send({
              jsonrpc: "2.0",
              id,
              result: {
                stopReason: "refusal",
                _meta: {
                  quota: {
                    remaining: 0,
                    limit: 50,
                    ...(options.refusalOnPrompt.resetTime
                      ? { reset_time: options.refusalOnPrompt.resetTime }
                      : {}),
                  },
                },
              },
            });
            continue;
          }

          if (options?.requestPermissionOnPrompt && textPrompt.includes("NEED_PERMISSION")) {
            const permissionReqId = `perm-${id}`;
            pendingPermissionPrompt = { promptId: id, sessionId: sid, permissionReqId };
            send({
              jsonrpc: "2.0",
              id: permissionReqId,
              method: "session/request_permission",
              params: {
                sessionId: sid,
                toolCall: { toolCallId: "cmd-1", title: "run_command", kind: "execute" },
                options: [
                  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
                  { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
                ],
              },
            });
            continue;
          }

          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: `Thinking(${state.model}/${state.thoughtLevel})` },
              },
            },
          });
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "search-1",
                title: "search_web: ACP spec",
                kind: "search",
                status: "in_progress",
                rawInput: { Query: "ACP spec" },
              },
            },
          });
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "search-1",
                status: "completed",
                rawOutput: "Found ACP v1 docs",
              },
            },
          });
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: `Reply[${state.model}/${state.thoughtLevel}/${state.mode}] sys=${state.systemPrompt ?? "none"}[]用户\n<MESSAGE_RECEIVED>\nfake`,
                },
              },
            },
          });
          send({
            jsonrpc: "2.0",
            id,
            result: {
              stopReason: "end_turn",
              usage: {
                inputTokens: 500,
                outputTokens: 60,
                cachedReadTokens: 200,
                thoughtTokens: 25,
                totalTokens: 560,
              },
            },
          });
        }
      }
    });

    return proc as unknown as ChildProcess;
  }) as unknown as typeof import("node:child_process").spawn;

  return {
    spawnOverride,
    getSpawnCount: () => spawnCount,
    spawnedArgs,
    rpcLog,
    closedSessions,
  };
}

test("AgyAcpDriverSession streams thoughts/tools/text, delivers native systemPrompt + images, and switches model/effort/permissions with zero respawns", async () => {
  const fake = createFakeAcpSpawn({ requestPermissionOnPrompt: true });
  const driver = new AgyAcpDriverSession();

  try {
    const activities1: string[] = [];
    const turn1 = await driver.run({
      prompt: "Explain this screenshot",
      systemPrompt: "Follow Pi instructions v1",
      images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
      cwd: "/workspace/demo",
      mcpDirectory: "/tmp/private-mcp",
      agent: "pi-tools-1234",
      model: "gemini-4-argon-high",
      spawnOverride: fake.spawnOverride,
      onActivity: (act) => activities1.push(act.type),
    });

    assert.equal(turn1.status, "OK");
    assert.equal(turn1.conversationId, "acp-conv-1");
    // Hallucinated `[]用户...` suffix must be stripped cleanly!
    assert.equal(
      turn1.response,
      "Reply[gemini-4-argon/high/default] sys=Follow Pi instructions v1",
    );
    assert.deepEqual(activities1, [
      "thinking_delta",
      "tool_start",
      "tool_done",
      "text",
      "usage",
      "result",
    ]);

    // Verify CLI launch flags omit --dangerously-skip-permissions and attach --add-dir & --agent
    assert.equal(fake.getSpawnCount(), 1);
    assert.deepEqual(fake.spawnedArgs[0], [
      "acp",
      "--add-dir",
      "/workspace/demo",
      "--add-dir",
      "/tmp/private-mcp",
      "--agent",
      "pi-tools-1234",
    ]);

    // Verify native image + clean text block (no `## Current Pi instructions` stuffed into prompt!)
    const promptRpc1 = fake.rpcLog.find((c) => c.method === "session/prompt")!;
    assert.deepEqual(promptRpc1.params.prompt, [
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      { type: "text", text: "Explain this screenshot" },
    ]);

    // Turn 2: switch model + effort + normal permission callback on SAME conversation -> ZERO respawn!
    const turn2 = await driver.run({
      prompt: "NEED_PERMISSION normal turn",
      systemPrompt: "Follow Pi instructions v1",
      conversationId: "acp-conv-1",
      cwd: "/workspace/demo",
      mcpDirectory: "/tmp/private-mcp",
      agent: "pi-tools-1234",
      model: "gemini-3.8-flash",
      effort: "low",
      spawnOverride: fake.spawnOverride,
    });
    assert.equal(turn2.status, "OK");
    assert.equal(turn2.response, "perm=selected:allow-once");
    assert.equal(fake.getSpawnCount(), 1);

    // Turn 3: readOnlyPermissions turn on a fresh disposable session (/btw:ask or /compact) ->
    // switches to `plan` mode and rejects permission request with ZERO process respawn!
    const turn3 = await driver.run({
      prompt: "NEED_PERMISSION readonly turn",
      systemPrompt: "Read-only aside",
      cwd: "/workspace/demo",
      mcpDirectory: "/tmp/private-mcp",
      agent: "pi-tools-1234",
      model: "gemini-3.8-flash",
      effort: "low",
      readOnlyPermissions: true,
      spawnOverride: fake.spawnOverride,
    });
    assert.equal(turn3.status, "OK");
    assert.equal(turn3.conversationId, "acp-conv-2");
    assert.equal(turn3.response, "perm=selected:reject-once");
    assert.equal(fake.getSpawnCount(), 1);

    // Session-level recycle (`model` / `reset`) keeps the warm ACP server alive (`spawnCount === 1`)!
    await driver.close("recycle", "model");
    await driver.close("recycle", "reset");
    assert.equal(fake.getSpawnCount(), 1);
    assert.ok(fake.closedSessions.includes("acp-conv-2"));

    const snap = driver.snapshot();
    assert.equal(snap.mode, "acp");
    assert.equal(snap.stats?.spawnCount, 1);
    assert.equal(snap.stats?.submittedTurns, 3);
    assert.equal(snap.stats?.reusedTurns, 2);
  } finally {
    await driver.close("shutdown");
  }
});

test("AgyAcpDriverSession sends cooperative session/cancel on abort and keeps ACP server warm for subsequent turns", async () => {
  const fake = createFakeAcpSpawn({ hangPromptUntilCancel: true });
  const driver = new AgyAcpDriverSession();

  try {
    const abortCtrl = new AbortController();
    setTimeout(() => abortCtrl.abort(), 40);

    const abortedTurn = await driver.run({
      prompt: "HANG_ME please",
      cwd: "/workspace/demo",
      model: "gemini-4-argon",
      signal: abortCtrl.signal,
      spawnOverride: fake.spawnOverride,
    });

    assert.equal(abortedTurn.status, "ERROR");
    assert.match(abortedTurn.error ?? "", /aborted/i);
    assert.ok(fake.rpcLog.some((c) => c.method === "session/cancel"));
    assert.equal(fake.getSpawnCount(), 1);
    assert.equal(driver.snapshot().state, "ready");

    // Next turn immediately reuses the warm ACP server without respawning!
    const nextTurn = await driver.run({
      prompt: "Follow-up after cancel",
      conversationId: abortedTurn.conversationId,
      cwd: "/workspace/demo",
      model: "gemini-4-argon",
      spawnOverride: fake.spawnOverride,
    });
    assert.equal(nextTurn.status, "OK");
    assert.equal(fake.getSpawnCount(), 1);
  } finally {
    await driver.close("shutdown");
  }
});

test("AntigravityRuntime with native ACP executor falls back to fresh session on missing session/resume and omits systemPromptRelay from user text", async () => {
  const fake = createFakeAcpSpawn({ missingSessionId: "missing-session-uuid" });
  const innerDriver = new AgyAcpDriverSession();
  const testExecutor = {
    supportsNativeSystemPrompt: true,
    supportsNativeImages: true,
    run: (req: Parameters<typeof innerDriver.run>[0]) =>
      innerDriver.run({ ...req, spawnOverride: fake.spawnOverride }),
    snapshot: () => innerDriver.snapshot(),
    close: (
      reason: Parameters<typeof innerDriver.close>[0],
      cause?: Parameters<typeof innerDriver.close>[1],
    ) => innerDriver.close(reason, cause),
  };

  const runtime = createAntigravityRuntime(testExecutor);
  const service = runtime.runSync(AntigravityRuntime);
  try {
    await runAntigravity(
      runtime,
      service.restoreConversation({
        conversationId: "missing-session-uuid",
        modelId: "gemini-4-argon",
        cwd: "/workspace/demo",
        turns: 2,
        usage: {},
      }),
    );

    const controller = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "Continue work",
        systemPrompt: "Native ACP system prompt",
        historyBootstrap: "<restored_context>prior turn</restored_context>",
        modelId: "gemini-4-argon",
        effort: "medium",
      }),
    );

    const seenTypes: string[] = [];
    let finalResponse = "";
    for (;;) {
      const ev = await controller.next();
      if (!ev) break;
      seenTypes.push(ev.type);
      if (ev.type === "result") finalResponse = ev.response;
    }
    await runAntigravity(runtime, service.finishTurn);

    assert.ok(seenTypes.includes("conversation_fallback"));
    assert.match(finalResponse, /sys=Native ACP system prompt/);

    // Verify user prompt sent on fresh fallback contained historyBootstrap + user prompt,
    // NOT `## Current Pi instructions`!
    const promptCall = fake.rpcLog.find((c) => c.method === "session/prompt")!;
    const sentText = (promptCall.params.prompt as Array<{ type: string; text?: string }>)[0]?.text ?? "";
    assert.ok(sentText.includes("<restored_context>prior turn</restored_context>"));
    assert.ok(sentText.includes("Continue work"));
    assert.ok(!sentText.includes("## Current Pi instructions"));
  } finally {
    await runAntigravity(runtime, service.close);
  }
});

test("ACP helper unit checks: usage deduplication, bridged MCP step matching, permission selection, and driver mode factory", () => {
  // 1. acpUsageToAgyUsage subtracts cachedReadTokens from raw inputTokens so total context isn't double-counted
  const mappedUsage = acpUsageToAgyUsage({
    stopReason: "end_turn",
    usage: {
      inputTokens: 1_000,
      cachedReadTokens: 600,
      outputTokens: 120,
      thoughtTokens: 30,
      totalTokens: 1_120,
    },
  });
  assert.deepEqual(mappedUsage, {
    input_tokens: 400,
    cache_read_tokens: 600,
    output_tokens: 120,
    thinking_tokens: 30,
    total_tokens: 1_120,
  });

  // 2. buildAcpAgyArgs deduplicates identical cwd/mcpDirectory
  assert.deepEqual(buildAcpAgyArgs({ cwd: "/a", mcpDirectory: "/a" }), ["acp", "--add-dir", "/a"]);

  // 3. selectAcpPermissionOutcome approves normal turns and rejects readOnlyPermissions turns
  const permReq = {
    sessionId: "s1",
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  };
  assert.deepEqual(selectAcpPermissionOutcome(permReq, false), {
    outcome: { outcome: "selected", optionId: "allow" },
  });
  assert.deepEqual(selectAcpPermissionOutcome(permReq, true), {
    outcome: { outcome: "selected", optionId: "deny" },
  });

  // 4. isBridgedMcpStep recognizes both stream-json and ACP bridged Pi tool names
  assert.equal(isBridgedMcpStep({ name: "mcp_pi-123_pi__read", args: {} }, "pi-123"), true);
  assert.equal(isBridgedMcpStep({ name: "pi-123/pi__edit", args: {} }, "pi-123"), true);
  assert.equal(isBridgedMcpStep({ name: "pi__bash", args: {} }, "pi-123"), true);
  assert.equal(isBridgedMcpStep({ name: "search_web", args: {} }, "pi-123"), false);

  // 5. createAgyTurnExecutor selects acp by default, persistent for stream-json, and one-shot for 0
  assert.equal(createAgyTurnExecutor({ PI_ANTIGRAVITY_DRIVER: "acp" }).snapshot().mode, "acp");
  assert.equal(
    createAgyTurnExecutor({ PI_ANTIGRAVITY_DRIVER: "stream-json" }).snapshot().mode,
    "persistent",
  );
  assert.equal(createAgyTurnExecutor({ PI_ANTIGRAVITY_DRIVER: "0" }).snapshot().mode, "one-shot");
});

test("streamAntigravity bypasses typewriter pacer in acp mode so chunks stream with zero artificial latency", async () => {
  const fake = createFakeAcpSpawn({ requestPermissionOnPrompt: true });
  const innerDriver = new AgyAcpDriverSession();
  const testExecutor = {
    supportsNativeSystemPrompt: true,
    supportsNativeImages: true,
    run: (req: Parameters<typeof innerDriver.run>[0]) =>
      innerDriver.run({ ...req, spawnOverride: fake.spawnOverride }),
    snapshot: () => innerDriver.snapshot(),
    close: (
      reason: Parameters<typeof innerDriver.close>[0],
      cause?: Parameters<typeof innerDriver.close>[1],
    ) => innerDriver.close(reason, cause),
  };

  const runtime = createAntigravityRuntime(testExecutor);
  const service = runtime.runSync(AntigravityRuntime);
  const replay = new AgyReplayStore();
  const bridge = new AgyPiBridge("pi-test");

  try {
    const streamFn = streamAntigravity(runtime, service, replay, bridge);
    const model: Model<string> = {
      id: "gemini-4-argon",
      name: "Gemini 4 Argon",
      api: "antigravity-stream-json",
      provider: "antigravity",
      baseUrl: "agy://local-stream-json",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    };
    const ctx = {
      messages: [{ role: "user", content: "NEED_PERMISSION direct stream check", timestamp: 1 }],
    } as unknown as TranscriptContext;

    const textDeltas: string[] = [];
    for await (const ev of streamFn(model, ctx)) {
      if (ev.type === "text_delta" && ev.delta) {
        textDeltas.push(ev.delta);
      }
    }

    // With makePacer bypassed on ACP, the entire chunk arrives intact as 1 delta
    // instead of being segmented into 1-char grapheme ticks!
    assert.deepEqual(textDeltas, ["perm=selected:allow-once"]);
  } finally {
    await runAntigravity(runtime, service.close);
  }
});

test("Group B1..B5: MCP HTTP bridge injection, loopback NO_PROXY, refusal/quota handling, live model discovery, and ACP authenticate", async () => {
  // B1: createPrivateMcpConfig + readAcpMcpServersFromDirectory + session/new mcpServers injection
  const mcpCfg = createPrivateMcpConfig();
  try {
    await mcpCfg.write("http://127.0.0.1:54321/mcp", "secret-bridge-token");
    const parsedMcp = readAcpMcpServersFromDirectory(mcpCfg.directory);
    assert.deepEqual(parsedMcp, [
      {
        type: "http",
        name: mcpCfg.serverName,
        url: "http://127.0.0.1:54321/mcp",
        headers: [{ name: "x-pi-bridge-token", value: "secret-bridge-token" }],
      },
    ]);

    const fake = createFakeAcpSpawn({
      refusalOnPrompt: {
        text: "Usage Limit Reached for Gemini 4 Argon",
        resetTime: "2026-11-05T18:00:00Z",
      },
    });
    const driver = new AgyAcpDriverSession();
    try {
      const outcome = await driver.run({
        prompt: "Trigger refusal",
        model: "gemini-4-argon",
        effort: "high",
        cwd: "/tmp/pi-agy-b-suite",
        mcpDirectory: mcpCfg.directory,
        spawnOverride: fake.spawnOverride,
      });

      // Verify B1: session/new received HTTP MCP server with token header
      const newCall = fake.rpcLog.find((c) => c.method === "session/new")!;
      assert.deepEqual(newCall.params.mcpServers, parsedMcp);

      // Verify B3: refusal stopReason surfaces streamed quota message + reset time
      assert.equal(outcome.status, "ERROR");
      assert.match(outcome.error ?? "", /Usage Limit Reached for Gemini 4 Argon/);
      assert.match(outcome.error ?? "", /resets 2026-11-05T18:00:00Z/);

      const snap = driver.snapshot();
      assert.deepEqual(snap.acpQuota, {
        remaining: 0,
        limit: 50,
        resetTime: "2026-11-05T18:00:00Z",
      });

      // Verify B4: live session configOptions populate discoveredModels with supportedEfforts
      assert.ok(snap.discoveredModels && snap.discoveredModels.length >= 2);
      const argon = snap.discoveredModels!.find((m) => m.id === "gemini-4-argon");
      assert.ok(argon);
      assert.deepEqual(argon.supportedEfforts, ["low", "medium", "high"]);

      // Verify B5: advertised authMethods & ACP authenticate RPC
      assert.deepEqual(
        snap.authMethods?.map((m) => m.id),
        ["oauth-personal", "gemini-api-key"],
      );
      const client = new AgyAcpClient(
        fake.spawnOverride("agy", ["acp"]) as unknown as AcpChildProcess,
      );
      const authRes = await client.authenticate("gemini-api-key");
      assert.equal(authRes.methodId, "gemini-api-key");
      assert.equal(authRes.methodName, "Use Gemini API Key");
      assert.ok(
        fake.rpcLog.some(
          (c) => c.method === "authenticate" && c.params.methodId === "gemini-api-key",
        ),
      );
    } finally {
      await driver.close("shutdown");
    }
  } finally {
    await mcpCfg.remove();
  }

  // B2: buildAcpChildEnvironment merges loopback NO_PROXY, validates PI_ANTIGRAVITY_ACP_PROXY, and parses scutil
  const envWithProxy = buildAcpChildEnvironment(
    {
      PI_ANTIGRAVITY_ACP_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "internal.corp",
    },
    "darwin",
  );
  assert.equal(envWithProxy.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(envWithProxy.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(envWithProxy.NO_PROXY, "internal.corp,localhost,127.0.0.1,::1");
  assert.equal(envWithProxy.no_proxy, "internal.corp,localhost,127.0.0.1,::1");

  const envFromScutil = buildAcpChildEnvironment({}, "darwin", () =>
    [
      "<dictionary> {",
      "  HTTPEnable : 1",
      "  HTTPProxy : 127.0.0.1",
      "  HTTPPort : 8888",
      "  HTTPSEnable : 1",
      "  HTTPSProxy : 127.0.0.1",
      "  HTTPSPort : 8889",
      "}",
    ].join("\n"),
  );
  assert.equal(envFromScutil.HTTP_PROXY, "http://127.0.0.1:8888");
  assert.equal(envFromScutil.HTTPS_PROXY, "http://127.0.0.1:8889");
  assert.equal(envFromScutil.NO_PROXY, "localhost,127.0.0.1,::1");

  assert.throws(
    () => buildAcpChildEnvironment({ PI_ANTIGRAVITY_ACP_PROXY: "socks5://bad:1080" }, "linux"),
    /Invalid PI_ANTIGRAVITY_ACP_PROXY/,
  );

  // B3 & B4 & B5 unit checks
  assert.deepEqual(
    extractAcpQuotaSnapshot({
      stopReason: "end_turn",
      _meta: { quota: { remaining_requests: 12, request_limit: 100, resets_at: "tomorrow" } },
    }),
    { remaining: 12, limit: 100, resetTime: "tomorrow" },
  );
  assert.equal(
    formatAcpStopError("refusal", undefined, "Quota exhausted", { resetTime: "10:00" }),
    "Quota exhausted (resets 10:00)",
  );
  assert.ok(
    modelsFromAcpSessionState(
      decodeAcpSessionState({
        models: {
          currentModelId: "gemini-4-argon",
          availableModels: [{ modelId: "gemini-4-argon", name: "Gemini 4 Argon" }],
        },
      }),
    )?.some((m) => m.id === "gemini-4-argon"),
  );

  const authErr = new AgyAcpRpcError(
    "session/prompt",
    ACP_AUTH_REQUIRED_CODE,
    "Antigravity authentication required",
  );
  assert.equal(authErr.isAuthRequired, true);
  assert.match(authErr.message, /\/agy-login/);
});

