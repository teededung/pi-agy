import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai";
import { AgyAcpDriverSession } from "../lib/agy-acp-driver.ts";
import {
  ACP_AUTH_REQUIRED_CODE,
  AcpTurnNormalizer,
  AgyAcpClient,
  AgyAcpRpcError,
  acpEmptyTurnApiFailure,
  acpUsageToAgyUsage,
  buildAcpAgyArgs,
  buildAcpChildEnvironment,
  decodeAcpSessionState,
  extractAcpQuotaSnapshot,
  formatAcpStopError,
  modelsFromAcpSessionState,
  normalizeAcpTurnUsageForStepCount,
  readAcpMcpServersFromDirectory,
  selectAcpPermissionOutcome,
  type AcpChildProcess,
} from "../lib/agy-acp-client.ts";
import {
  AgyThoughtTracker,
  extractUsageFromStepPayload,
  formatAgyLiveRetryLine,
  formatAgyRetryStatus,
} from "../lib/agy-thoughts.ts";
import { AGY_COMPACTION_ENTRY, AGY_STALL_ENTRY, formatAgyStallSummary } from "../lib/agy-compaction.ts";
import { AgyStallError } from "../lib/agy-client.ts";
import { newTurnOutcome, type AgyActivity } from "../lib/reducer.ts";
import { AgyPiBridge } from "../lib/bridge.ts";
import { createAgyTurnExecutor } from "../lib/agy-driver.ts";
import { createPrivateMcpConfig } from "../lib/mcp-config.ts";
import { formatAgyCall } from "../lib/render.ts";
import { AgyReplayStore } from "../lib/replay.ts";
import {
  AGY_TOOL_SUMMARIES_ENTRY,
  ToolSummaryTracker,
  createSummaryToolRendererResolver,
} from "../lib/tool-summary.ts";
import { Text } from "@earendil-works/pi-tui";
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
  BTW_COMMANDS,
  BtwOverlayComponent,
  buildOverlayTranscript,
  formatInlineBtwToolLine,
  parseOverlayBtwCommand,
  resolveBtwOverlayPalette,
} from "../extensions/btw.ts";
import {
  formatIsolatedToolLine,
  isBridgedMcpStep,
  streamAntigravity,
} from "../src/provider.ts";
import {
  AntigravityRuntime,
  DEFAULT_STALL_MAX_RETRIES,
  DEFAULT_STALL_RETRY_BACKOFF_MS,
  computeStallRetryBackoffMs,
  createAntigravityRuntime,
  runAntigravity,
} from "../src/runtime.ts";

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
  // 1a. acpUsageToAgyUsage subtracts cachedReadTokens when inputTokens is inclusive (1000 + 120 === 1120)
  const inclusiveUsage = acpUsageToAgyUsage({
    stopReason: "end_turn",
    usage: {
      inputTokens: 1_000,
      cachedReadTokens: 600,
      outputTokens: 120,
      thoughtTokens: 30,
      totalTokens: 1_120,
    },
  });
  assert.deepEqual(inclusiveUsage, {
    input_tokens: 400,
    cache_read_tokens: 600,
    output_tokens: 120,
    thinking_tokens: 30,
    total_tokens: 1_120,
  });

  // 1b. acpUsageToAgyUsage preserves already-uncached inputTokens from live agy acp 1.5.0 (2716 + 8013 + 430 === 11159)
  const uncachedUsage = acpUsageToAgyUsage({
    stopReason: "end_turn",
    usage: {
      inputTokens: 2_716,
      cachedReadTokens: 8_013,
      outputTokens: 430,
      thoughtTokens: 225,
      totalTokens: 11_159,
    },
  });
  assert.deepEqual(uncachedUsage, {
    input_tokens: 2_716,
    cache_read_tokens: 8_013,
    output_tokens: 430,
    thinking_tokens: 225,
    total_tokens: 11_159,
  });

  // 1c. normalizeAcpTurnUsageForStepCount prevents multi-step 3.38M cachedRead sums from looking like single-call overflow
  const normalizedMultiStep = normalizeAcpTurnUsageForStepCount(
    {
      input_tokens: 76_000,
      cache_read_tokens: 3_388_516,
      output_tokens: 14_583,
      thinking_tokens: 6_862,
      total_tokens: 3_479_099,
    },
    19,
  );
  assert.equal(normalizedMultiStep.input_tokens, 4_000);
  assert.equal(normalizedMultiStep.cache_read_tokens, Math.round(3_388_516 / 19));
  assert.equal(normalizedMultiStep.output_tokens, 14_583);
  assert.ok((normalizedMultiStep.input_tokens ?? 0) + (normalizedMultiStep.cache_read_tokens ?? 0) < 200_000);

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

  // 4. AcpTurnNormalizer + isBridgedMcpStep strip `agy acp`'s "Run " title prefix so bridged tools never emit duplicate cards
  const normOutcome = newTurnOutcome();
  const norm = new AcpTurnNormalizer(normOutcome);
  const bridgedActs = norm.consumeUpdate({
    sessionId: "s1",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tc-bridge-1",
      title: "Run mcp_pi-123_pi__read",
      status: "in_progress",
      rawInput: { path: "/tmp/x", toolSummary: "Read file" },
    },
  });
  assert.equal(bridgedActs[0]?.type, "tool_start");
  if (bridgedActs[0]?.type === "tool_start") {
    assert.equal(bridgedActs[0].name, "mcp_pi-123_pi__read");
    assert.equal(isBridgedMcpStep(bridgedActs[0], "pi-123"), true);
  }
  assert.equal(isBridgedMcpStep({ name: "Run mcp_pi-123_pi__read", args: {} }, "pi-123"), true);
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

test("streamAntigravity animates text smoothly in acp mode by default and honors PI_ANTIGRAVITY_THINKING_PACE=0", async () => {
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
  const prevPaceEnv = process.env.PI_ANTIGRAVITY_THINKING_PACE;

  try {
    delete process.env.PI_ANTIGRAVITY_THINKING_PACE;
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

    const animatedDeltas: string[] = [];
    for await (const ev of streamFn(model, ctx)) {
      if (ev.type === "text_delta" && ev.delta) {
        animatedDeltas.push(ev.delta);
      }
    }
    assert.equal(animatedDeltas.join(""), "perm=selected:allow-once");
    assert.ok(animatedDeltas.length > 1, "expected smooth multi-tick animation by default");

    // Verify PI_ANTIGRAVITY_THINKING_PACE=0 disables pacing cleanly
    process.env.PI_ANTIGRAVITY_THINKING_PACE = "0";
    const ctx2 = {
      messages: [{ role: "user", content: "NEED_PERMISSION unpaced check", timestamp: 2 }],
    } as unknown as TranscriptContext;
    const unpacedDeltas: string[] = [];
    for await (const ev of streamFn(model, ctx2)) {
      if (ev.type === "text_delta" && ev.delta) {
        unpacedDeltas.push(ev.delta);
      }
    }
    assert.deepEqual(unpacedDeltas, ["perm=selected:allow-once"]);
  } finally {
    if (prevPaceEnv === undefined) delete process.env.PI_ANTIGRAVITY_THINKING_PACE;
    else process.env.PI_ANTIGRAVITY_THINKING_PACE = prevPaceEnv;
    await runAntigravity(runtime, service.close);
  }
});

test("AgyAcpDriverSession reads exact single-step usage from SQLite PLANNER_RESPONSE protobuf instead of multi-step cumulative sums", async () => {
  const encodeVarint = (n: number): number[] => {
    const out: number[] = [];
    let v = n;
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v);
    return out;
  };
  const encodeSubmsg = (fieldNo: number, body: number[]): number[] => [
    ...encodeVarint((fieldNo << 3) | 2),
    ...encodeVarint(body.length),
    ...body,
  ];
  const encodeVarintField = (fieldNo: number, val: number): number[] => [
    ...encodeVarint((fieldNo << 3) | 0),
    ...encodeVarint(val),
  ];

  // Build CortexStep protobuf: field 5 (metadata) -> field 9 (generator_metadata):
  // f2=4319 (input), f3=353 (output), f5=107684 (cache_read), f9=237 (thinking)
  const genMeta = [
    ...encodeVarintField(2, 4_319),
    ...encodeVarintField(3, 353),
    ...encodeVarintField(5, 107_684),
    ...encodeVarintField(9, 237),
  ];
  const stepPayload = Buffer.from(encodeSubmsg(5, encodeSubmsg(9, genMeta)));
  assert.deepEqual(extractUsageFromStepPayload(stepPayload), {
    input_tokens: 4_319,
    output_tokens: 353,
    cache_read_tokens: 107_684,
    thinking_tokens: 237,
    total_tokens: 112_356,
  });

  const convDir = mkdtempSync(path.join(tmpdir(), "pi-agy-acp-sqlite-usage-"));
  const driver = new AgyAcpDriverSession({ conversationsDir: convDir });
  try {
    // Prepare `<sessionId>.db` matching fake spawn's `acp-conv-1`
    const dbPath = path.join(convDir, "acp-conv-1.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)");
    db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?)").run(0, 14, 3, Buffer.alloc(0));
    db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?)").run(1, 15, 3, stepPayload);
    db.close();

    const fake = createFakeAcpSpawn();
    const outcome = await driver.run({
      prompt: "Check SQLite per-step usage",
      model: "gemini-4-argon",
      cwd: "/tmp/pi-agy-sqlite-test",
      spawnOverride: fake.spawnOverride,
    });

    assert.deepEqual(outcome.usage, {
      input_tokens: 4_319,
      output_tokens: 353,
      cache_read_tokens: 107_684,
      thinking_tokens: 237,
      total_tokens: 112_356,
    });
    const usageActs = outcome.activities.filter((a) => a.type === "usage");
    assert.equal(usageActs.length, 1);
    assert.deepEqual(usageActs[0]?.usage, outcome.usage);
  } finally {
    await driver.close("shutdown");
    rmSync(convDir, { recursive: true, force: true });
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

  // ACP thought_level options for active gemini-4-hydrogen (including xhigh) must NOT leak onto other models
  const acpHydrogenModels = modelsFromAcpSessionState(
    decodeAcpSessionState({
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "gemini-4-hydrogen",
          options: [
            { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
            { value: "gemini-4-argon", name: "Gemini 4 Argon" },
          ],
        },
        {
          id: "thought_level",
          category: "thought_level",
          type: "select",
          currentValue: "xhigh",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
            { value: "xhigh", name: "Extra" },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(
    acpHydrogenModels?.find((m) => m.id === "gemini-4-hydrogen")?.supportedEfforts,
    ["low", "medium", "high", "xhigh"],
  );
  assert.equal(
    acpHydrogenModels?.find((m) => m.id === "gemini-4-hydrogen")?.defaultEffort,
    "xhigh",
  );
  assert.deepEqual(
    acpHydrogenModels?.find((m) => m.id === "gemini-4-argon")?.supportedEfforts,
    [],
  );

  const authErr = new AgyAcpRpcError(
    "session/prompt",
    ACP_AUTH_REQUIRED_CODE,
    "Antigravity authentication required",
  );
  assert.equal(authErr.isAuthRequired, true);
  assert.match(authErr.message, /\/agy-login/);
});

test("ToolSummaryTracker + createSummaryToolRendererResolver render muted toolSummary titles on bridged Pi cards while leaving Codex cards untouched", () => {
  const tracker = new ToolSummaryTracker();
  const serverName = "pi-0d291d88a423";

  // 1. Parallel out-of-order read calls match deterministically by canonical args
  tracker.recordToolStart(
    {
      name: `Run mcp_${serverName}_pi__read`,
      args: { path: "/repo/a.ts", offset: 1, limit: 50, toolSummary: "Read header of a.ts" },
    },
    serverName,
  );
  tracker.recordToolStart(
    {
      name: `Run mcp_${serverName}_pi__read`,
      args: { path: "/repo/b.ts", offset: 10, limit: 20, toolSummary: "Read helper in b.ts" },
    },
    serverName,
  );

  // Bridge calls arrive in reverse order (#2 before #1)
  const cleanB = tracker.recordBridgeCall({
    id: "pi-bridge-2",
    tool: "read",
    args: { limit: 20, offset: 10, path: "/repo/b.ts" },
  });
  const cleanA = tracker.recordBridgeCall({
    id: "pi-bridge-1",
    tool: "read",
    args: { limit: 50, offset: 1, path: "/repo/a.ts", toolSummary: "Read header of a.ts" },
  });

  // Strict-schema safety: toolSummary is stripped from returned bridge args unless
  // the bridged tool's own schema explicitly declares that parameter (agy 1.5.2+).
  assert.deepEqual(cleanA, { limit: 50, offset: 1, path: "/repo/a.ts" });
  assert.deepEqual(cleanB, { limit: 20, offset: 10, path: "/repo/b.ts" });
  assert.equal(tracker.get("pi-bridge-1"), "Read header of a.ts");
  assert.equal(tracker.get("pi-bridge-2"), "Read helper in b.ts");

  const cleanDeclared = tracker.recordBridgeCall(
    {
      id: "pi-bridge-declared",
      tool: "custom_mcp_tool",
      args: {
        query: "status",
        toolSummary: "Custom declared summary",
        waitForPreviousTools: true,
        toolAction: "unrequested-meta",
      },
    },
    {
      type: "object",
      properties: {
        query: { type: "string" },
        toolSummary: { type: "string" },
        waitForPreviousTools: { type: "boolean" },
      },
    },
  );
  assert.deepEqual(cleanDeclared, {
    query: "status",
    toolSummary: "Custom declared summary",
    waitForPreviousTools: true,
  });
  assert.equal(tracker.get("pi-bridge-declared"), "Custom declared summary");

  // 2. Late tool_start (after bridge_call) binds summary and invalidates live TUI card
  tracker.recordBridgeCall({
    id: "pi-bridge-3",
    tool: "bash",
    args: { command: "git status -s" },
  });
  let invalidated = 0;
  const mockTheme = {
    fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    bg: (color: string, text: string) => `[bg:${color}]${text}[/bg:${color}]`,
    bold: (text: string) => `<b>${text}</b>`,
    italic: (text: string) => `<i>${text}</i>`,
  } as unknown as Theme;

  let innerRenderReused = false;
  const resolver = createSummaryToolRendererResolver(tracker);
  const bashRenderer = resolver("bash", () => ({
    renderCall(args, theme, context) {
      if (context.lastComponent instanceof Text) innerRenderReused = true;
      const t = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      t.setText(theme.fg("toolTitle", theme.bold(`$ ${(args as { command: string }).command}`)));
      return t;
    },
    renderResult(result, _options, theme) {
      const txt = result.content[0]?.type === "text" ? result.content[0].text : "";
      return new Text(theme.fg("toolOutput", txt), 0, 0);
    },
  }))!;
  assert.equal(bashRenderer.renderShell, "self");

  type RenderCallCtx = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
  const sharedState: Record<string, unknown> = {};
  const mkCtx = (
    toolCallId: string,
    lastComponent: unknown,
    isPartial = true,
  ): RenderCallCtx =>
    ({
      args: { command: "git status -s" },
      toolCallId,
      invalidate: () => {
        invalidated += 1;
      },
      lastComponent,
      state: sharedState,
      cwd: "/repo",
      executionStarted: true,
      argsComplete: true,
      isPartial,
      expanded: false,
      showImages: false,
      isError: false,
      durationMs: undefined,
      outputPad: 1,
      keyText: (k: string) => k,
      keyHint: (k: string) => k,
    }) as unknown as RenderCallCtx;

  // Before tool_start arrives (or on a Codex call with no summary): renders ONLY the native Box (no outside caption)
  const firstComp = bashRenderer.renderCall!(
    { command: "git status -s" },
    mockTheme,
    mkCtx("pi-bridge-3", undefined, true),
  );
  const firstLines = firstComp.render(60);
  assert.equal(firstLines.length, 3, "top pad + $ command + bottom pad inside Box");
  assert.ok(firstLines.every((l) => l.startsWith("[bg:toolPendingBg]")), "entire Codex/no-summary card stays inside Box");
  assert.ok(firstLines[1]!.includes("[toolTitle]<b>$ git status -s</b>[/toolTitle]"));

  // Now tool_start arrives on stdout -> triggers live invalidate and renders Codex-style caption OUTSIDE the Box
  tracker.recordToolStart(
    {
      name: `Run mcp_${serverName}_pi__bash`,
      args: {
        command: "git status -s",
        toolSummary: "Check git status across both repos",
      },
    },
    serverName,
  );
  assert.equal(invalidated, 1);

  const wrappedComp = bashRenderer.renderCall!(
    { command: "git status -s" },
    mockTheme,
    mkCtx("pi-bridge-3", firstComp, false),
  );
  const resultCarrier = bashRenderer.renderResult!(
    { content: [{ type: "text", text: "M lib/tool-summary.ts" }], details: {} },
    { expanded: false, isPartial: false },
    mockTheme,
    mkCtx("pi-bridge-3", undefined, false) as any,
  );
  assert.equal(innerRenderReused, true);
  assert.deepEqual(resultCarrier.render(60), [], "result carrier renders inside sharedBox without duplicate rows");

  const wrappedLines = wrappedComp.render(120);
  // Row 0: Codex-style bold+italic thinkingText caption OUTSIDE the tool box (no [bg:...], 1-space outputPad)
  assert.equal(
    wrappedLines[0]!.trimEnd(),
    " <b><i>[thinkingText]Check git status across both repos[/thinkingText]</i></b>",
  );
  assert.ok(!wrappedLines[0]!.includes("[bg:"), "caption sits on main chat canvas outside tool box");
  // Row 1: 1 blank spacer row on main chat canvas before the green tool box
  assert.equal(wrappedLines[1], "", "1 blank row separates caption from green tool box");
  // Rows 2..5: single unified toolSuccessBg Box containing both call and result
  const boxLines = wrappedLines.slice(2);
  assert.equal(boxLines.length, 4, "top pad + call + result + bottom pad in one unified Box");
  assert.ok(boxLines.every((l) => l.startsWith("[bg:toolSuccessBg]")), "tool box uses toolSuccessBg");
  assert.ok(boxLines[1]!.includes("[toolTitle]<b>$ git status -s</b>[/toolTitle]"));
  assert.ok(boxLines[2]!.includes("[toolOutput]M lib/tool-summary.ts[/toolOutput]"));

  // Persistence round-trip across session reload
  const dirty = tracker.flushDirty();
  assert.ok(dirty);
  const restored = new ToolSummaryTracker();
  restored.restoreFromEntries([
    { type: "custom", customType: AGY_TOOL_SUMMARIES_ENTRY, data: { version: 1, summaries: dirty } },
  ]);
  assert.equal(restored.get("pi-bridge-3"), "Check git status across both repos");

  // Historical / native formatAgyCall also renders toolSummary cleanly and normalizes Run mcp_..._pi__bash
  assert.equal(
    formatAgyCall(
      `Run mcp_${serverName}_pi__bash`,
      { command: "npm test", toolSummary: "Run full test suite" },
      mockTheme,
    ),
    "[muted]Run full test suite[/muted]\n[toolTitle]<b>bash</b>[/toolTitle] [accent]npm test[/accent]",
  );
});

test("/btw isolated tool lines prioritize toolSummary and normalize agy 1.5.0 native Path tools", () => {
  // 1. Long multi-line bun/bash commands show toolSummary instead of truncated CommandLine
  assert.equal(
    formatIsolatedToolLine(
      {
        name: "run_command",
        args: {
          CommandLine:
            "cd /Users/rongmauhong/Documents/Repo/ragnarok/lani-web && bun -e 'import { getDb } from \"#lib/db\"; console.log(await getDb());'",
          WaitMsBeforeAsync: 5000,
          toolSummary: "Query dagger job mask in lani-web DB",
        },
      },
      "/Users/rongmauhong/Documents/Repo/ragnarok",
    ),
    "🔧 `bash` · Query dagger job mask in lani-web DB",
  );

  // 2. Native agy 1.5.0 `File <path>` (kind="read", Path/StartLine/EndLine) normalizes to `read_file` -> `read` with relative path:range
  const normalizer = new AcpTurnNormalizer(newTurnOutcome());
  const immediateActs = normalizer.consumeUpdate({
    sessionId: "conv-1",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tc-read-1",
      title: "File lani-web/scripts/item-import-verify.ts",
      kind: "read",
      status: "in_progress",
      rawInput: {
        Path: "/Users/rongmauhong/Documents/Repo/ragnarok/lani-web/scripts/item-import-verify.ts",
        StartLine: 1,
        EndLine: 80,
      },
    },
  });
  assert.equal(immediateActs.length, 1);
  assert.equal(immediateActs[0]?.type, "tool_start");
  if (immediateActs[0]?.type === "tool_start") {
    assert.equal(immediateActs[0].name, "read_file");
    assert.equal(
      formatIsolatedToolLine(immediateActs[0], "/Users/rongmauhong/Documents/Repo/ragnarok"),
      "🔧 `read` · lani-web/scripts/item-import-verify.ts:1-80",
    );
  }

  // 3. Delayed rawInput on tool_call_update also refines `File <path>` to `read_file`
  normalizer.consumeUpdate({
    sessionId: "conv-1",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tc-read-2",
      title: "File package.json",
      kind: "read",
      status: "pending",
    },
  });
  const delayedActs = normalizer.consumeUpdate({
    sessionId: "conv-1",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-read-2",
      status: "in_progress",
      rawInput: { Path: "/repo/package.json", StartLine: 1, EndLine: 25 },
    },
  });
  assert.equal(delayedActs[0]?.type, "tool_start");
  if (delayedActs[0]?.type === "tool_start") {
    assert.equal(delayedActs[0].name, "read_file");
    assert.equal(
      formatIsolatedToolLine(delayedActs[0], "/repo"),
      "🔧 `read` · package.json:1-25",
    );
  }

  // 4. MCP calls format server/tool cleanly and prefer toolSummary
  assert.equal(
    formatIsolatedToolLine({
      name: "call_mcp_tool",
      args: {
        ServerName: "lani-admin",
        ToolName: "item_lookup",
        toolSummary: "Look up Moonlight Dagger metadata",
      },
    }),
    "🔧 `lani-admin/item_lookup` · Look up Moonlight Dagger metadata",
  );
  assert.equal(
    formatIsolatedToolLine({
      name: "Run mcp_fsearch_grep",
      args: {
        query: "Moonlight_Dagger",
        toolSummary: "Search Moonlight_Dagger across scripts",
      },
    }),
    "🔧 `fsearch/grep` · Search Moonlight_Dagger across scripts",
  );
  assert.equal(
    formatIsolatedToolLine({
      name: "mcp_pi-3e5c4d388aa7_pi__read",
      args: {
        path: "/var/folders/kx/pt4lx4qd77qczv985n2_75c40000gn/T/orca-paste-1793888860381-c0ece01f-5baa-41c0-9830-15507a63a16b.png",
      },
    }),
    "🔧 `read` · $TMPDIR/orca-paste-1793888860381-c0ece01f-5baa-41c0-9830-15507a63a16b.png",
  );
});

test("/btw overlay palette and transcript render crisp thinking/tool colors and elevated card backgrounds without warning yellow", async () => {
  const noop = (s: string) => s;
  const mdTheme = {
    heading: noop,
    link: noop,
    linkUrl: noop,
    code: noop,
    codeBlock: noop,
    codeBlockBorder: noop,
    quote: noop,
    quoteBorder: noop,
    hr: () => "",
    listBullet: noop,
    bold: noop,
    italic: noop,
    strikethrough: noop,
    underline: noop,
  };

  const mockTheme = {
    appearance: "dark",
    colors: {
      text: { kind: "rgb", r: 222, g: 224, b: 225 },
      thinkingText: { kind: "rgb", r: 157, g: 165, b: 170 },
    },
    getColorMode: () => "truecolor",
    getBgAnsi: (token: string) =>
      token === "toolPendingBg"
        ? "\x1b[48;2;63;69;71m"
        : token === "customMessageBg"
          ? "\x1b[48;2;71;58;106m"
          : "\x1b[48;2;37;72;90m",
    getFgAnsi: (token: string) =>
      token === "thinkingText" ? "\x1b[38;2;157;165;170m" : "\x1b[39m",
    fg: (token: string, text: string) => `<fg:${token}>${text}</fg:${token}>`,
    bg: (token: string, text: string) => `\x1b[48;2;37;72;90m${text}\x1b[49m`,
    bold: (text: string) => `<b>${text}</b>`,
  } as unknown as Theme;

  const palette = resolveBtwOverlayPalette(mockTheme as any);
  // Distinct truecolor surfaces for header, transcript body, and input row
  assert.match(palette.surfaceBg, /^\x1b\[48;2;\d+;\d+;\d+m$/);
  assert.match(palette.headerBg, /^\x1b\[48;2;\d+;\d+;\d+m$/);
  assert.match(palette.inputBg, /^\x1b\[48;2;\d+;\d+;\d+m$/);
  assert.notEqual(palette.surfaceBg, palette.headerBg);
  assert.notEqual(palette.surfaceBg, "\x1b[48;2;52;58;67m");

  // Inline tool line splits path and :start-end range with mdLink + text + syntaxNumber
  const formattedTool = formatInlineBtwToolLine(
    "🔧 `read` · lani-shield/docs/client-2026-10-21-migration-plan.md:20-50",
    mockTheme as any,
  );
  assert.equal(
    formattedTool,
    "<fg:accent>▸</fg:accent> <fg:mdLink><b>read</b></fg:mdLink><fg:borderMuted> · </fg:borderMuted><fg:text>lani-shield/docs/client-2026-10-21-migration-plan.md</fg:text><fg:syntaxNumber>:20-50</fg:syntaxNumber>",
  );

  // Narrow width middle-truncates single-token paths while preserving :start-end range
  const compactedTool = formatInlineBtwToolLine(
    "🔧 `read` · $TMPDIR/orca-paste-1793888860381-c0ece01f-5baa-41c0-9830-15507a63a16b.png:10-20",
    mockTheme as any,
    48,
  );
  assert.ok(compactedTool?.includes("…"), "middle-truncates long path to fit single line");
  assert.ok(compactedTool?.includes("<fg:syntaxNumber>:10-20</fg:syntaxNumber>"), "preserves line range suffix");

  // Thinking transcript uses cool blended thinkingText + `│` rail, zero `<fg:warning>`,
  // and 1-row top/bottom padding around thinking prose blocks relative to tool calls
  const transcript = buildOverlayTranscript(
    [
      { id: 1, turnId: 1, type: "user-message", text: "Check RVA shift" },
      {
        id: 2,
        turnId: 1,
        type: "thinking",
        streaming: true,
        text: "The core question is whether hex tracking is version-specific.\n🔧 `read` · lani-shield/docs/plan.md:20-50\n🔧 `bash` · Search RVA symbols\nInitial analysis reveals shifted RVAs.",
      },
      { id: 3, turnId: 1, type: "assistant-text", streaming: false, text: "Confirmed." },
    ],
    mockTheme as any,
    mdTheme as any,
    72,
    palette,
  );
  const joined = transcript.join("\n");
  assert.ok(!joined.includes("<fg:warning>"), "must not paint thinking or tools in warning yellow");
  assert.ok(joined.includes("<fg:borderMuted>│ </fg:borderMuted>"), "thinking prose has left rail");
  assert.ok(joined.includes("<fg:mdLink><b>read</b></fg:mdLink>"), "inline tool row is structured");
  assert.ok(joined.includes("<fg:syntaxNumber>:20-50</fg:syntaxNumber>"), "line range is highlighted");
  const readIdx = transcript.findIndex((row) => row.includes("<fg:mdLink><b>read</b></fg:mdLink>"));
  const bashIdx = transcript.findIndex((row) => row.includes("<fg:mdLink><b>bash</b></fg:mdLink>"));
  assert.equal(transcript[readIdx - 1], "", "blank row separates preceding thinking prose from first tool call");
  assert.equal(bashIdx, readIdx + 1, "consecutive tool calls stay grouped together");
  assert.equal(transcript[bashIdx + 1], "", "blank row separates last tool call from next thinking prose block");

  // Full BtwOverlayComponent render: rounded borderAccent when focused, borderMuted when unfocused, surfaceBg intact
  const ansiTheme = {
    appearance: "dark",
    colors: {
      text: { kind: "rgb", r: 222, g: 224, b: 225 },
      thinkingText: { kind: "rgb", r: 157, g: 165, b: 170 },
    },
    getColorMode: () => "truecolor",
    getBgAnsi: (token: string) =>
      token === "toolPendingBg"
        ? "\x1b[48;2;63;69;71m"
        : token === "customMessageBg"
          ? "\x1b[48;2;71;58;106m"
          : "\x1b[48;2;37;72;90m",
    getFgAnsi: () => "\x1b[38;2;168;153;215m",
    fg: (token: string, text: string) =>
      token === "borderAccent"
        ? `\x1b[38;2;168;153;215m${text}\x1b[39m`
        : token === "borderMuted"
          ? `\x1b[38;2;126;136;142m${text}\x1b[39m`
          : `\x1b[38;2;200;205;210m${text}\x1b[39m`,
    bg: (_token: string, text: string) => `\x1b[48;2;37;72;90m${text}\x1b[49m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  } as unknown as Theme;

  // Initialize global theme for getMarkdownTheme() inside BtwOverlayComponent constructor
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark");

  const overlay = new BtwOverlayComponent(
    { mode: "fullscreen", requestRender() {} } as any,
    ansiTheme as any,
    { matches: () => false } as any,
    () => [
      {
        id: 1,
        turnId: 1,
        type: "user-message",
        text: "xem cái nào đúng /var/folders/kx/pt4lx4qd77qczv985n2_75c40000gn/T/orca-paste-1793888860381-c0ece01f-5baa-41c0-9830-15507a63a16b.png",
      },
      {
        id: 2,
        turnId: 1,
        type: "thinking",
        streaming: true,
        text: "Analyzing RVA shift.\n🔧 `read` · lani-shield/docs/plan.md:20-50",
      },
    ],
    () => "⏳ 🔧 `read` · lani-shield/docs/plan.md:20-50",
    () => "readonly",
    () => "window",
    () => {},
    () => {},
    () => {},
    () => {},
  );
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b_pi:[^\x07]*\x07/g, "");
  overlay.focused = true;
  const focusedRows = overlay.render(80);
  const plainFocused = focusedRows.map(stripAnsi);
  assert.ok(focusedRows[0]!.includes("╭") && focusedRows[0]!.includes("╮"));
  assert.ok(focusedRows[focusedRows.length - 1]!.includes("╰") && focusedRows[focusedRows.length - 1]!.includes("╯"));
  assert.ok(focusedRows[0]!.includes("\x1b[38;2;168;153;215m"), "focused border uses borderAccent");

  // Header summary puts `● streaming` first with zero `· ●` double-dot collision, plus 1-space inner padding
  assert.match(plainFocused[1]!, /^│ BTW ask · read-only/);
  assert.match(plainFocused[2]!, /^│ ● streaming · 0 exchanges/);
  assert.ok(!plainFocused[2]!.includes("· ●"), "no double bullet in header summary");

  // Wrapped user continuation line keeps hanging indent instead of slamming against `│`
  const youContinuation = plainFocused.find((row) => row.includes("15507a63a16b.png"));
  assert.ok(youContinuation, "renders wrapped tail of user message");
  assert.match(youContinuation!, /^│     /, "wrapped user continuation preserves 1-space margin + 4-space hanging indent");

  // Focused empty composer shows `❯` prompt + fake cursor + streaming placeholder
  const focusedInputRow = focusedRows[focusedRows.length - 3]!;
  assert.ok(focusedInputRow.includes("\x1b_pi:fc\x07"), "focused composer emits fake cursor");
  assert.match(stripAnsi(focusedInputRow), /^│ ❯ Ask a follow-up to queue/);

  overlay.focused = false;
  const unfocusedRows = overlay.render(80);
  assert.ok(unfocusedRows[0]!.includes("\x1b[38;2;126;136;142m"), "unfocused border dims to borderMuted");
  const unfocusedInputRow = unfocusedRows[unfocusedRows.length - 3]!;
  assert.ok(!unfocusedInputRow.includes("\x1b_pi:fc\x07"), "unfocused composer hides fake cursor");
  assert.match(stripAnsi(unfocusedInputRow), /^│ ❯ Press .* to focus BTW input/);

  // Main session command registrations remain /btw:* (plus /btw and /side)
  assert.ok(
    BTW_COMMANDS.every((c) => c.name === "btw" || c.name === "side" || c.name.startsWith("btw:")),
    "main session commands keep /btw: prefix",
  );

  // Overlay command parser accepts both unprefixed and /btw: commands inside modal
  assert.deepEqual(parseOverlayBtwCommand("/new check this"), { name: "btw:new", args: "check this" });
  assert.deepEqual(parseOverlayBtwCommand("/clear"), { name: "btw:clear", args: "" });
  assert.deepEqual(parseOverlayBtwCommand("/model argon"), { name: "btw:model", args: "argon" });
  assert.deepEqual(parseOverlayBtwCommand("/thinking high"), { name: "btw:thinking", args: "high" });
  assert.deepEqual(parseOverlayBtwCommand("/btw:model sonnet"), { name: "btw:model", args: "sonnet" });
  assert.deepEqual(parseOverlayBtwCommand("/btw hello"), { name: "btw", args: "hello" });
  assert.equal(parseOverlayBtwCommand("/side hello"), null);
  assert.equal(parseOverlayBtwCommand("/unknown"), null);

  // Overlay completions suggest unprefixed commands on `/m`, `/model `, `/thinking `, and prefixed on `/btw:m`
  overlay.focused = true;
  overlay.setDraft("/m");
  const slashMPlain = overlay.render(80).map(stripAnsi).join("\n");
  assert.match(slashMPlain, /→ \/minimize/);
  assert.match(slashMPlain, /\/model/);
  assert.doesNotMatch(slashMPlain, /\/btw:model/);

  overlay.setDraft("/btw:m");
  const slashBtwMPlain = overlay.render(80).map(stripAnsi).join("\n");
  assert.match(slashBtwMPlain, /→ \/btw:minimize/);
  assert.match(slashBtwMPlain, /\/btw:model/);

  overlay.setDraft("/model argon");
  const modelArgPlain = overlay.render(80).map(stripAnsi).join("\n");
  assert.match(modelArgPlain, /→ \/model argon/);

  overlay.setDraft("/thinking h");
  const thinkingArgPlain = overlay.render(80).map(stripAnsi).join("\n");
  assert.match(thinkingArgPlain, /\/thinking high/);
});

test("AgyAcpDriverSession rejects stalls with AgyStallError and AgyThoughtTracker binds acp-server-*.log", async () => {
  const fake = createFakeAcpSpawn({ hangPromptUntilCancel: true });
  const driver = new AgyAcpDriverSession({
    probeSubagents: async () => ({
      hasAlive: false,
      aliveCount: 0,
      aliveConversationIds: [],
      newestUpdateMs: 0,
    }),
    probeToolProcess: async () => false,
  });
  try {
    await assert.rejects(
      driver.run({
        binary: "agy",
        prompt: "HANG_ME stall check",
        inactivityTimeoutMs: 40,
        spawnOverride: fake.spawnOverride,
      }),
      (err: unknown) => {
        assert.ok(
          err instanceof AgyStallError,
          `expected AgyStallError instead of ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
        );
        return true;
      },
    );
    // First stall cancels cooperatively via `session/cancel`, keeping the ACP server warm!
    assert.equal(driver.snapshot().state, "ready");
    assert.equal(fake.getSpawnCount(), 1);
    assert.ok(fake.rpcLog.some((c) => c.method === "session/cancel"));

    // Subsequent normal turn reuses the warm ACP server with zero respawn:
    const recovered = await driver.run({
      binary: "agy",
      prompt: "recover after cooperative stall cancel",
      conversationId: "acp-conv-1",
      inactivityTimeoutMs: 200,
      spawnOverride: fake.spawnOverride,
    });
    assert.equal(recovered.status, "OK");
    assert.equal(fake.getSpawnCount(), 1);

    // Two consecutive stalls without progress recycle the process on the 2nd stall
    // so wedged HTTP/2 pools inside `agy acp` still get refreshed cleanly:
    await assert.rejects(
      driver.run({
        binary: "agy",
        prompt: "HANG_ME consecutive #1",
        conversationId: "acp-conv-1",
        inactivityTimeoutMs: 40,
        spawnOverride: fake.spawnOverride,
      }),
      (err: unknown) => err instanceof AgyStallError,
    );
    assert.equal(driver.snapshot().state, "ready");
    await assert.rejects(
      driver.run({
        binary: "agy",
        prompt: "HANG_ME consecutive #2",
        conversationId: "acp-conv-1",
        inactivityTimeoutMs: 40,
        spawnOverride: fake.spawnOverride,
      }),
      (err: unknown) => err instanceof AgyStallError,
    );
    assert.equal(driver.snapshot().state, "idle");
  } finally {
    await driver.close("shutdown");
  }

  // Verify AgyThoughtTracker binds `acp-server-*.log` and grants compaction/prefill grace at >=100k tokens
  const tmpDir = mkdtempSync(path.join(tmpdir(), "agy-acp-thought-log-"));
  try {
    const cid = "249d10c0-4398-4fdb-8073-f2dad87d030b";
    const dbPath = path.join(tmpDir, `${cid}.db`);
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)",
    );
    const encodeVarint = (value: number): number[] => {
      const out: number[] = [];
      let v = value;
      while (v >= 0x80) {
        out.push((v & 0x7f) | 0x80);
        v = Math.floor(v / 128);
      }
      out.push(v);
      return out;
    };
    const genMeta = Buffer.from([
      0x10,
      ...encodeVarint(3_397),
      0x18,
      ...encodeVarint(3_156),
      0x28,
      ...encodeVarint(171_912),
    ]);
    const stepMeta = Buffer.from([0x4a, ...encodeVarint(genMeta.length), ...genMeta]);
    const stepPayload = Buffer.from([0x2a, ...encodeVarint(stepMeta.length), ...stepMeta]);
    db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)").run(
      544,
      15,
      3,
      stepPayload,
    );
    db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)").run(
      545,
      132,
      3,
      Buffer.from("edit output"),
    );
    db.close();

    const acpLogPath = path.join(tmpDir, "acp-server-20261107_130400-77287.log");
    writeFileSync(
      acpLogPath,
      [
        `I1107 13:07:40.000000 1 server.go:1826] Sending user message to conversation ${cid} (items=1, media=0)`,
        `I1107 13:07:45.000000 2 http_helpers.go:403] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x1`,
        "",
      ].join("\n"),
      "utf8",
    );

    let nowMs = new Date(2026, 10, 7, 13, 7, 47, 0).getTime();
    const tracker = new AgyThoughtTracker(undefined, tmpDir, {
      logDir: tmpDir,
      now: () => nowMs,
      emitThinkingDeltas: false,
    });
    tracker.sync(cid, () => {});
    assert.equal(tracker.isLikelyCompacting(false), true);
    nowMs += 2_000;
    const pollRes = tracker.poll();
    assert.equal(pollRes.lastContextTokens, 175_309);
    assert.equal(pollRes.isCompacting, true);

    // If a normal PLANNER_RESPONSE (step_type = 15) and fast tool step (step_type = 132)
    // complete within the same 250ms poll interval as their http_helpers.go:403 line,
    // tracker must NOT falsely report isCompacting = true while waiting on the next step.
    const db2 = new DatabaseSync(dbPath);
    db2
      .prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)")
      .run(
        546,
        15,
        3,
        Buffer.concat([stepPayload, Buffer.from(" ResponseID: resp-step-546 ")]),
      );
    db2
      .prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)")
      .run(547, 132, 3, Buffer.from("git log -n 1 --stat"));
    db2.close();
    writeFileSync(
      acpLogPath,
      [
        `I1107 13:07:40.000000 1 server.go:1826] Sending user message to conversation ${cid} (items=1, media=0)`,
        `I1107 13:07:45.000000 2 http_helpers.go:403] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x1`,
        `I1107 13:07:50.000000 3 http_helpers.go:403] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x2 ResponseID: resp-step-546`,
        "",
      ].join("\n"),
      "utf8",
    );
    nowMs = new Date(2026, 10, 7, 13, 7, 50, 100).getTime();
    assert.equal(tracker.poll().isCompacting, false);
    nowMs += 3_000;
    tracker.sync(cid, () => {});
    // When >=100k context is simply waiting on the next planner request (e.g. hung upstream
    // before HTTP headers arrive), isLikelyCompacting MUST be false so 90s stall detection fires.
    assert.equal(tracker.isLikelyCompacting(false), false);

    // And if an active stream logs `retrying in 4s`, isCompacting resets to false and isRetrying turns true
    writeFileSync(
      acpLogPath,
      [
        `I1107 13:07:40.000000 1 server.go:1826] Sending user message to conversation ${cid} (items=1, media=0)`,
        `I1107 13:07:45.000000 2 http_helpers.go:403] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x1`,
        `I1107 13:07:50.000000 3 http_helpers.go:403] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x2 ResponseID: resp-step-546`,
        `I1107 13:07:55.000000 4 http_helpers.go:403] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x3 ResponseID: resp-unindexed`,
        `I1107 13:07:56.000000 5 run.go:307] Run: attempt 1 failed (INTERNAL (code 500): Internal error encountered.), retrying in 4s`,
        "",
      ].join("\n"),
      "utf8",
    );
    nowMs = new Date(2026, 10, 7, 13, 7, 58, 0).getTime();
    const retryPoll = tracker.poll();
    assert.equal(retryPoll.isCompacting, false);
    assert.equal(retryPoll.isRetrying, true);

    tracker.close();

    // Direct PID binding (`acp-server-*-<pid>.log`) stays bound even after >128KB of monitor logs
    const filler = "I1107 13:08:00.000000 9 runner.go:453] Monitor severe_internal_risks_agy SKIPPED\n".repeat(
      2_000,
    );
    writeFileSync(
      acpLogPath,
      `I1107 13:07:40.000000 1 server.go:1826] Sending user message to conversation ${cid} (items=1, media=0)\n${filler}`,
      "utf8",
    );
    const pidTracker = new AgyThoughtTracker(cid, tmpDir, {
      logDir: tmpDir,
      pid: 77287,
      now: () => nowMs,
      emitThinkingDeltas: false,
    });
    pidTracker.sync(cid, () => {});
    assert.equal(pidTracker.isLikelyCompacting(false), false);
    writeFileSync(
      acpLogPath,
      `I1107 13:07:40.000000 1 server.go:1826] Sending user message to conversation ${cid} (items=1, media=0)\n${filler}` +
        `I1107 13:08:05.000000 10 http_helpers.go:653] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x9 ResponseID: resp-compact\n`,
      "utf8",
    );
    nowMs = new Date(2026, 10, 7, 13, 8, 5, 0).getTime();
    pidTracker.sync(cid, () => {});
    nowMs += 2_000;
    pidTracker.sync(cid, () => {});
    assert.equal(pidTracker.isLikelyCompacting(false), true);
    pidTracker.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // Verify AcpTurnNormalizer strips internal CortexStepErrorMessage (`\n⚠ ...\n`) chunks
  // from assistant prose and emits `stream_retry` when interrupted mid-sentence
  const normOutcome = newTurnOutcome();
  const normalizer = new AcpTurnNormalizer(normOutcome);
  // Pre-text API retry warning is suppressed from text and recorded as lastWarningText
  const preRetryActs = normalizer.consumeUpdate({
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "\n⚠ API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable.\n",
      },
    },
  });
  assert.deepEqual(preRetryActs, []);
  assert.equal(
    normalizer.lastWarningText(),
    "API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable.",
  );

  // Partial prose arrives, then mid-stream interruption (`step_type = 17`)
  const textAct1 = normalizer.consumeUpdate({
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "*Skipped: Giữ nguyên `Vị trí: ^777777Trang sức (trái)^000000`",
      },
    },
  });
  assert.equal(textAct1.length, 1);
  assert.equal(textAct1[0]!.type, "text");
  assert.equal(normalizer.lastWarningText(), undefined);

  const interruptActs = normalizer.consumeUpdate({
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "\n⚠ The stream was interrupted. Please continue the task you were working on.\n",
      },
    },
  });
  assert.deepEqual(interruptActs, [
    {
      type: "stream_retry",
      message: "agy stream was interrupted upstream — continuing the turn automatically",
    },
  ]);

  // Retry step continues with a new stepId and never contains "Please continue the task you were working on."
  const textAct2 = normalizer.consumeUpdate({
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "Tất cả các thay đổi đã được xác thực sạch sẽ.",
      },
    },
  });
  assert.equal(textAct2.length, 1);
  assert.equal(textAct2[0]!.type, "text");
  assert.notEqual(
    (textAct2[0] as Extract<typeof textAct2[0], { type: "text" }>).stepId,
    (textAct1[0] as Extract<typeof textAct1[0], { type: "text" }>).stepId,
  );
  assert.equal(normalizer.finalResponseText(), "Tất cả các thay đổi đã được xác thực sạch sẽ.");
  assert.doesNotMatch(normalizer.finalResponseText(), /Please continue the task you were working on/);

  // Verify AntigravityRuntime resets consecutive stall counter (`retry 1 of 3` -> `retry 2 of 3` -> recovers -> `retry 1 of 3`)
  const prevBackoff = process.env.AGY_STALL_RETRY_BACKOFF_MS;
  process.env.AGY_STALL_RETRY_BACKOFF_MS = "1";
  try {
    let callIdx = 0;
    const seenPrompts: string[] = [];
    const stallRetries: number[] = [];
    const runtime = createAntigravityRuntime(async (req) => {
      callIdx += 1;
      seenPrompts.push(req.prompt);
      req.onConversation?.("conv-reset-stall");
      if (callIdx === 1 || callIdx === 2) {
        throw new AgyStallError(90_000, false);
      }
      if (callIdx === 3) {
        // Agent recovers and completes a step (`usage` / `tool_done`), then stalls later in the turn!
        req.onActivity?.({
          type: "usage",
          usage: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050 },
        });
        throw new AgyStallError(90_000, false);
      }
      const resAct = {
        type: "result" as const,
        status: "OK" as const,
        response: "recovered after second stall wave",
      };
      req.onActivity?.(resAct);
      return {
        conversationId: "conv-reset-stall",
        status: "OK",
        response: "recovered after second stall wave",
        activities: [resAct],
        usage: undefined,
        finished: true,
      };
    });
    try {
      const svc = runtime.runSync(AntigravityRuntime);
      const ctrl = await runtime.runPromise(
        svc.beginStreamTurn({
          prompt: "Initial user question",
          systemPrompt: "Sys",
          modelId: "gemini-4-argon",
        }),
      );
      for (;;) {
        const act = await ctrl.next();
        if (act === null) break;
        if (act.type === "stall") {
          stallRetries.push(act.retry);
        }
      }
      await runtime.runPromise(svc.finishTurn);
    } finally {
      await runtime.dispose();
    }
    // Stalls 1 & 2 increment (1, 2); after callIdx=3 recovers and emits usage, the next stall resets to 1!
    assert.deepEqual(stallRetries, [1, 2, 1]);
    // Call 4 still uses stallContinuationPrompt() rather than resending the initial user question
    assert.match(seenPrompts[3]!, /The stream was interrupted before your previous turn completed/);
  } finally {
    if (prevBackoff === undefined) delete process.env.AGY_STALL_RETRY_BACKOFF_MS;
    else process.env.AGY_STALL_RETRY_BACKOFF_MS = prevBackoff;
  }
});





test("agy 503 'No capacity' is surfaced on AgyStallError and the runtime fails fast instead of restarting", async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "agy-capacity-"));
  try {
    // Tracker remembers agy's last API error and forgets it once a response arrives.
    const cap =
      "UNAVAILABLE (code 503): No capacity available for model gemini-4-argon-high on the server";
    const logPath = path.join(tmpDir, "acp-server-20261109_220232-4242.log");
    const cid = "conv-capacity";
    writeFileSync(
      logPath,
      `I1109 22:02:34.000000 1 server.go:1826] Sending user message to conversation ${cid} (items=1, media=0)\n`,
      "utf8",
    );
    let nowMs = new Date(2026, 10, 9, 22, 2, 34, 0).getTime();
    const tracker = new AgyThoughtTracker(cid, tmpDir, {
      logDir: tmpDir,
      pid: 4242,
      now: () => nowMs,
      emitThinkingDeltas: false,
    });
    tracker.sync(cid, () => {});
    assert.equal(tracker.lastApiError, undefined);
    writeFileSync(
      logPath,
      `I1109 22:02:34.000000 1 server.go:1826] Sending user message to conversation ${cid} (items=1, media=0)\n` +
        `I1109 22:03:31.000000 402 run.go:315] Run: attempt 1 failed (${cap}), retrying in 4s\n`,
      "utf8",
    );
    nowMs = new Date(2026, 10, 9, 22, 3, 32, 0).getTime();
    tracker.sync(cid, () => {});
    assert.equal(tracker.lastApiError, cap);
    tracker.close();

    const err = new AgyStallError(90_000, false, tracker.lastApiError);
    assert.equal(err.isCapacity, true);
    assert.match(err.message, /No capacity available for model gemini-4-argon-high/);
    assert.equal(new AgyStallError(90_000, false, "INTERNAL (code 500): Internal error").isCapacity, false);
    assert.equal(new AgyStallError(90_000, false).isCapacity, false);

    // Runtime: capacity stall => exactly one executor call, no restart, no fresh-conversation fallback.
    let calls = 0;
    const runtime = createAntigravityRuntime(async (req) => {
      calls += 1;
      req.onConversation?.("conv-capacity-run");
      throw err;
    });
    try {
      const svc = runtime.runSync(AntigravityRuntime);
      const ctrl = await runtime.runPromise(
        svc.beginStreamTurn({ prompt: "hi", systemPrompt: "Sys", modelId: "gemini-4-argon" }),
      );
      const seen: string[] = [];
      await assert.rejects(async () => {
        for (;;) {
          const act = await ctrl.next();
          if (act === null) break;
          seen.push(act.type);
        }
      }, /no capacity for this model right now .*No capacity available/i);
      assert.equal(calls, 1);
      assert.ok(!seen.includes("stall") && !seen.includes("conversation_fallback"));
      await runtime.runPromise(svc.finishTurn);
    } finally {
      await runtime.dispose();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("acpEmptyTurnApiFailure turns agy's silent end_turn after exhausted 503 retries into an error", () => {
  const cap = "UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-medium on the server";
  assert.match(acpEmptyTurnApiFailure("end_turn", "", cap)!, /gave up retrying .*No capacity available/);
  assert.match(acpEmptyTurnApiFailure("end_turn", "  \n", cap)!, /gave up retrying/);
  // Real text, no recorded API error, or non-end_turn reasons keep their normal handling.
  assert.equal(acpEmptyTurnApiFailure("end_turn", "done", cap), undefined);
  assert.equal(acpEmptyTurnApiFailure("end_turn", "", undefined), undefined);
  assert.equal(acpEmptyTurnApiFailure("refusal", "", cap), undefined);
});

test("AgyThoughtTracker waits for its own acp-server-<pid>.log instead of binding a dead log for the same resumed conversation", () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "pi-agy-pid-race-"));
  const cid = "6cfbf1bc-588f-46d5-a25e-ad5b332691d0";
  try {
    const dbPath = path.join(tmpDir, `${cid}.db`);
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)",
    );
    const encodeVarint = (value: number): number[] => {
      const out: number[] = [];
      let v = value;
      while (v >= 0x80) {
        out.push((v & 0x7f) | 0x80);
        v = Math.floor(v / 128);
      }
      out.push(v);
      return out;
    };
    const genMeta = Buffer.from([
      0x10,
      ...encodeVarint(5_251),
      0x18,
      ...encodeVarint(1_200),
      0x28,
      ...encodeVarint(260_000),
    ]);
    const stepMeta = Buffer.from([0x4a, ...encodeVarint(genMeta.length), ...genMeta]);
    const stepPayload = Buffer.from([0x2a, ...encodeVarint(stepMeta.length), ...stepMeta]);
    db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)").run(
      87,
      15,
      3,
      stepPayload,
    );
    db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)").run(
      88,
      132,
      3,
      Buffer.from("Check raw jump table dwords"),
    );
    db.close();

    // Dead ACP server log from the previous killed process already references `cid`.
    const deadLogPath = path.join(tmpDir, "acp-server-20261111_090807-21717.log");
    writeFileSync(
      deadLogPath,
      `I1111 09:08:09.000000 1 server.go:1817] Sending user message to conversation ${cid} (items=1, media=0)\n`,
      "utf8",
    );

    let nowMs = new Date(2026, 10, 11, 9, 12, 59, 0).getTime();
    // Newly spawned process (pid 22847) has NOT opened `acp-server-*-22847.log` yet at t=0ms.
    const tracker = new AgyThoughtTracker(cid, tmpDir, {
      logDir: tmpDir,
      pid: 22847,
      now: () => nowMs,
      emitThinkingDeltas: false,
    });
    const activities: AgyActivity[] = [];
    tracker.sync(cid, (a) => activities.push(a));
    assert.equal(tracker.isLikelyCompacting(false), false);

    // 250ms later, Go creates `acp-server-*-22847.log` (initially empty), then logs compaction HTTP call.
    const liveLogPath = path.join(tmpDir, "acp-server-20261111_091259-22847.log");
    writeFileSync(liveLogPath, "", "utf8");
    nowMs += 250;
    tracker.sync(cid, (a) => activities.push(a));

    writeFileSync(
      liveLogPath,
      [
        `I1111 09:13:01.000000 30 server.go:1817] Sending user message to conversation ${cid} (items=1, media=0)`,
        `I1111 09:13:10.000000 42 http_helpers.go:654] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x1 ResponseID: resp-compact-22847`,
        "",
      ].join("\n"),
      "utf8",
    );
    nowMs = new Date(2026, 10, 11, 9, 13, 10, 0).getTime();
    tracker.sync(cid, (a) => activities.push(a));
    nowMs += 2_500;
    tracker.sync(cid, (a) => activities.push(a));
    assert.equal(tracker.isLikelyCompacting(false), true);
    assert.deepEqual(activities, [
      { type: "compacting", active: true, beforeTokens: 265_251 },
    ]);
    tracker.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AgyThoughtTracker emits native-style retrying status and runtime scales stall retry backoff progressively", () => {
  assert.equal(DEFAULT_STALL_MAX_RETRIES, 9);
  assert.equal(DEFAULT_STALL_RETRY_BACKOFF_MS, 3_000);
  assert.equal(computeStallRetryBackoffMs(3_000, 1), 3_000);
  assert.equal(computeStallRetryBackoffMs(3_000, 2), 6_000);
  assert.equal(computeStallRetryBackoffMs(3_000, 3), 12_000);
  assert.equal(computeStallRetryBackoffMs(3_000, 4), 24_000);
  assert.equal(computeStallRetryBackoffMs(3_000, 5), 30_000);
  assert.equal(computeStallRetryBackoffMs(0, 2), 0);
  assert.equal(
    formatAgyRetryStatus(
      2,
      10,
      3,
      "UNAVAILABLE (code 503): No capacity available for model gemini-4-argon-high on the server",
    ),
    "Model unavailable (attempt 2/10), retrying in 3s",
  );
  assert.equal(
    formatAgyRetryStatus(2, 10, 0),
    "Model unavailable (attempt 2/10), retrying...",
  );
  assert.equal(
    formatAgyRetryStatus(
      2,
      10,
      4,
      "stream reading error: stream idle timeout (5m0s): context deadline exceeded",
    ),
    "Stream interrupted (attempt 2/10), retrying in 4s",
  );
  // Live countdown ticks down every second and switches to active status when remaining <= 0s
  assert.deepEqual(
    formatAgyLiveRetryLine(
      { label: "Model unavailable", attempt: 2, maxAttempts: 10, retryAtMs: 10_000 },
      7_200,
    ),
    { text: "Model unavailable (attempt 2/10), retrying in 3s", countingDown: true },
  );
  assert.deepEqual(
    formatAgyLiveRetryLine(
      { label: "Model unavailable", attempt: 2, maxAttempts: 10, retryAtMs: 10_000 },
      10_000,
    ),
    { text: "Model unavailable (attempt 2/10), retrying...", countingDown: false },
  );
  assert.deepEqual(
    formatAgyLiveRetryLine(
      {
        label: "Stream stalled",
        attempt: 2,
        maxAttempts: 10,
        retryAtMs: 10_000,
        activeSuffix: "restarting turn...",
      },
      10_500,
    ),
    { text: "Stream stalled (attempt 2/10), restarting turn...", countingDown: false },
  );
  assert.deepEqual(
    formatAgyLiveRetryLine(
      {
        label: "Stream interrupted upstream",
        attempt: 0,
        maxAttempts: 0,
        activeSuffix: "continuing...",
      },
      10_500,
    ),
    { text: "Stream interrupted upstream, continuing...", countingDown: false },
  );
  assert.equal(
    formatAgyStallSummary({
      retry: 1,
      maxRetries: 9,
      stalledMs: 90_000,
      toolActive: false,
      backoffMs: 3_000,
    }),
    "agy stream stalled for 90s with no events — restarting the turn (attempt 2/10)",
  );

  const tmpDir = mkdtempSync(path.join(tmpdir(), "pi-agy-retry-ui-"));
  const cid = "22641d79-f551-4439-a03e-63d67f5f1726";
  try {
    const logPath = path.join(tmpDir, "acp-server-20261111_100226-16266.log");
    writeFileSync(logPath, "I1111 10:02:25.000000 1 server.go:100] ACP server ready\n", "utf8");
    let nowMs = new Date(2026, 10, 11, 10, 2, 26, 0).getTime();
    const tracker = new AgyThoughtTracker(cid, tmpDir, {
      logDir: tmpDir,
      pid: 16266,
      now: () => nowMs,
      emitThinkingDeltas: false,
    });
    appendFileSync(
      logPath,
      `I1111 10:02:26.000000 1 server.go:1817] Sending user message to conversation ${cid} (items=1, media=0)\n`,
      "utf8",
    );
    const events: AgyActivity[] = [];
    tracker.sync(cid, (a) => events.push(a));
    // Confirmed `Sending user message` in ACP log sets `isAwaitingUpstreamStream` while waiting for TTFB
    assert.equal(tracker.isAwaitingUpstreamStream, true);

    appendFileSync(
      logPath,
      `W1111 10:02:32.333805 16266 run.go:257] [${cid}] attempt 1 failed (UNAVAILABLE (code 503): No capacity available for model gemini-4-argon-high on the server), retrying in 3.2s\n`,
      "utf8",
    );
    nowMs = new Date(2026, 10, 11, 10, 2, 32, 500).getTime();
    tracker.sync(cid, (a) => events.push(a));
    // Re-polling while the same attempt is still sleeping must not re-emit duplicate events.
    nowMs += 500;
    tracker.sync(cid, (a) => events.push(a));
    assert.equal(events.length, 1);
    const firstRetry = events[0];
    assert.equal(firstRetry?.type, "retrying");
    if (firstRetry?.type === "retrying") {
      assert.equal(firstRetry.active, true);
      assert.equal(firstRetry.label, "Model unavailable");
      assert.equal(firstRetry.attempt, 2);
      assert.equal(firstRetry.maxAttempts, 10);
      assert.equal(firstRetry.delaySeconds, 4);
      assert.equal(firstRetry.message, "Model unavailable (attempt 2/10), retrying in 4s");
      assert.equal(typeof firstRetry.retryAtMs, "number");
    }

    appendFileSync(
      logPath,
      `W1111 10:03:00.289695 16266 run.go:257] [${cid}] attempt 4 failed (UNAVAILABLE (code 503): No capacity available for model gemini-4-argon-high on the server), retrying in 25.1s\n`,
      "utf8",
    );
    nowMs = new Date(2026, 10, 11, 10, 3, 0, 500).getTime();
    tracker.sync(cid, (a) => events.push(a));
    assert.equal(events.length, 2);
    assert.equal(
      events[1]?.type === "retrying" ? events[1].message : "",
      "Model unavailable (attempt 5/10), retrying in 25s",
    );

    // Once upstream responds, `retrying` clears immediately.
    appendFileSync(
      logPath,
      `I1111 10:03:26.000000 16266 http_helpers.go:654] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x2 ResponseID: resp-ok\n`,
      "utf8",
    );
    nowMs = new Date(2026, 10, 11, 10, 3, 26, 100).getTime();
    tracker.sync(cid, (a) => events.push(a));
    assert.deepEqual(events[2], { type: "retrying", active: false });
    assert.equal(tracker.lastApiError, undefined);
    // Open `streamGenerateContent` SSE stream also counts as awaiting upstream until first SQLite step lands
    assert.equal(tracker.isAwaitingUpstreamStream, true);

    // Stale `lastApiError` is cleared both on `stream_retry` and when >45s elapse past retry sleep without a new failure:
    appendFileSync(
      logPath,
      `I1111 10:08:26.000000 16266 run.go:315] Run: attempt 1 failed (stream reading error: stream idle timeout (5m0s): context deadline exceeded), retrying in 4s\n`,
      "utf8",
    );
    nowMs = new Date(2026, 10, 11, 10, 8, 26, 500).getTime();
    tracker.sync(cid, (a) => events.push(a));
    assert.match(tracker.lastApiError ?? "", /stream idle timeout/);
    tracker.prepareStreamActivity(
      { type: "stream_retry", message: "agy stream was interrupted upstream — continuing the turn automatically" },
      cid,
      () => {},
    );
    assert.equal(tracker.lastApiError, undefined);
    assert.equal(tracker.isAwaitingUpstreamStream, true);

    // Also verify 45s expiry prevents a single transient 503 on attempt 1 from triggering `isCapacity` 90s later:
    appendFileSync(
      logPath,
      `W1111 10:09:00.000000 16266 run.go:257] [${cid}] attempt 1 failed (UNAVAILABLE (code 503): No capacity available for model gemini-4-argon-high on the server), retrying in 3s\n`,
      "utf8",
    );
    nowMs = new Date(2026, 10, 11, 10, 9, 1, 0).getTime();
    tracker.sync(cid, () => {});
    assert.match(tracker.lastApiError ?? "", /No capacity available/);
    // 90s later on silent attempt 2 TTFB -> stale attempt-1 capacity error has expired!
    nowMs = new Date(2026, 10, 11, 10, 10, 30, 0).getTime();
    assert.equal(tracker.lastApiError, undefined);
    tracker.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("streamAntigravity keeps pre-compaction stall entries chronologically ahead of [compaction] and post-compaction content", async () => {
  const prevBackoff = process.env.AGY_STALL_RETRY_BACKOFF_MS;
  const prevPace = process.env.PI_ANTIGRAVITY_THINKING_PACE;
  process.env.AGY_STALL_RETRY_BACKOFF_MS = "1";
  process.env.PI_ANTIGRAVITY_THINKING_PACE = "0";

  let attempt = 0;
  const runtime = createAntigravityRuntime(async (request) => {
    attempt += 1;
    request.onConversation?.("conv-stall-compact");
    if (attempt === 1) {
      request.onActivity?.({ type: "thinking_delta", delta: "Initial thought before stall", stepId: 88 });
      request.onActivity?.({
        type: "stream_retry",
        message: "agy stream was interrupted upstream — continuing the turn automatically",
      });
      throw new AgyStallError(90_000, false);
    }
    if (attempt <= 3) {
      throw new AgyStallError(90_000, false);
    }
    request.onActivity?.({
      type: "checkpoint",
      stepId: 89,
      conversationId: "conv-stall-compact",
      beforeTokens: 265_251,
      summary: "Compacted summary",
    });
    request.onActivity?.({ type: "thinking_delta", delta: "Post-compaction thought", stepId: 90 });
    request.onActivity?.({ type: "text", delta: "Resumed answer", stepId: 90 });
    const result: AgyActivity = {
      type: "result",
      status: "OK",
      response: "Resumed answer",
      usage: { input_tokens: 12_000, output_tokens: 40, total_tokens: 12_040 },
    };
    request.onActivity?.(result);
    return {
      conversationId: "conv-stall-compact",
      status: "OK",
      response: "Resumed answer",
      activities: [result],
      usage: result.usage,
      finished: true,
    };
  });

  try {
    const service = runtime.runSync(AntigravityRuntime);
    const sideEvents: Array<{ kind: string; summary?: string }> = [];
    const streamFn = streamAntigravity(
      runtime,
      service,
      new AgyReplayStore(),
      new AgyPiBridge("pi-test"),
      undefined,
      undefined,
      undefined,
      (activity) => {
        if (activity.type === "stream_retry") {
          sideEvents.push({ kind: "stream_retry", summary: activity.message });
        } else if (activity.type === "stall") {
          assert.equal(activity.inline, undefined);
          sideEvents.push({
            kind: AGY_STALL_ENTRY,
            summary: formatAgyStallSummary(activity),
          });
        } else if (activity.type === "checkpoint") {
          sideEvents.push({ kind: AGY_COMPACTION_ENTRY });
        }
      },
    );

    const model: Model<string> = {
      id: "gemini-4-argon",
      name: "Gemini 4 Argon",
      api: "antigravity-stream-json",
      provider: "antigravity",
      baseUrl: "agy://local-stream-json",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    };
    const ctx = {
      messages: [{ role: "user", content: "Continue after bridged tool", timestamp: 1 }],
    } as unknown as TranscriptContext;

    let finalBlocks: Array<{ type: string; thinking?: string; text?: string }> = [];
    for await (const ev of streamFn(model, ctx, {})) {
      if (ev.type === "done") {
        finalBlocks = ev.message.content as Array<{ type: string; thinking?: string; text?: string }>;
      }
    }

    // All transient notices (`stream_retry` + 3 `stall`s) route strictly to `onActivity`
    // in chronological order BEFORE `[compaction]`, while `finalBlocks` stays completely
    // free of frozen `retrying in Ns` / `interrupted upstream` clutter!
    assert.deepEqual(
      sideEvents.map((e) => e.kind),
      ["stream_retry", AGY_STALL_ENTRY, AGY_STALL_ENTRY, AGY_STALL_ENTRY, AGY_COMPACTION_ENTRY],
    );
    assert.match(sideEvents[1]?.summary ?? "", /restarting the turn \(attempt 2\/10\)$/);
    assert.deepEqual(finalBlocks, [
      { type: "thinking", thinking: "Initial thought before stall" },
      { type: "thinking", thinking: "Post-compaction thought" },
      { type: "text", text: "Resumed answer" },
    ]);
  } finally {
    if (prevBackoff === undefined) delete process.env.AGY_STALL_RETRY_BACKOFF_MS;
    else process.env.AGY_STALL_RETRY_BACKOFF_MS = prevBackoff;
    if (prevPace === undefined) delete process.env.PI_ANTIGRAVITY_THINKING_PACE;
    else process.env.PI_ANTIGRAVITY_THINKING_PACE = prevPace;
    await runtime.dispose();
  }
});

test("streamAntigravity sends native ACP images without disk-path instructions and falls back to disk paths on stream-json", async () => {
  const tinyPngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const fake = createFakeAcpSpawn();
  const innerDriver = new AgyAcpDriverSession();
  const acpExecutor = {
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

  const runtime = createAntigravityRuntime(acpExecutor);
  const service = runtime.runSync(AntigravityRuntime);
  const replay = new AgyReplayStore();
  const bridge = new AgyPiBridge("pi-test");
  const prevPaceEnv = process.env.PI_ANTIGRAVITY_THINKING_PACE;
  process.env.PI_ANTIGRAVITY_THINKING_PACE = "0";

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

  try {
    const streamFn = streamAntigravity(runtime, service, replay, bridge);

    // 1. ACP mode with text + image: native image block, no disk-path prompt injection
    const ctxTextAndImage = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this screenshot?" },
            { type: "image", mimeType: "image/png", data: tinyPngBase64 },
          ],
          timestamp: 1,
        },
      ],
    } as unknown as TranscriptContext;
    for await (const _ev of streamFn(model, ctxTextAndImage)) {
      // drain
    }

    // 2. ACP mode with image-only prompt (no text): must not fail and must omit empty text block
    const ctxImageOnly = {
      messages: [
        {
          role: "user",
          content: [{ type: "image", mimeType: "image/png", data: tinyPngBase64 }],
          timestamp: 2,
        },
      ],
    } as unknown as TranscriptContext;
    for await (const _ev of streamFn(model, ctxImageOnly)) {
      // drain
    }

    const promptCalls = fake.rpcLog.filter((c) => c.method === "session/prompt");
    assert.equal(promptCalls.length, 2);
    assert.deepEqual(promptCalls[0]!.params.prompt, [
      { type: "image", data: tinyPngBase64, mimeType: "image/png" },
      { type: "text", text: "What is in this screenshot?" },
    ]);
    assert.deepEqual(promptCalls[1]!.params.prompt, [
      { type: "image", data: tinyPngBase64, mimeType: "image/png" },
    ]);
  } finally {
    if (prevPaceEnv === undefined) delete process.env.PI_ANTIGRAVITY_THINKING_PACE;
    else process.env.PI_ANTIGRAVITY_THINKING_PACE = prevPaceEnv;
    await runAntigravity(runtime, service.close);
  }

  // 3. Legacy stream-json (text-only) mode: persists image to disk and appends attachedImagesPrompt
  const seenRequests: Array<{ prompt: string; images?: unknown }> = [];
  const textOnlyExecutor = {
    run: async (req: Parameters<typeof innerDriver.run>[0]) => {
      seenRequests.push({ prompt: req.prompt, images: req.images });
      req.onActivity?.({ type: "text", delta: "ok" });
      return { ...newTurnOutcome(), finished: true, status: "OK" as const, response: "ok" };
    },
    snapshot: () => ({
      mode: "persistent" as const,
      state: "idle" as const,
      cwd: "/workspace/demo",
      model: "gemini-4-argon",
      openSessions: 0,
      ignoredNoiseLines: 0,
      restartCount: 0,
      stderrTail: [],
      lifecycle: [],
    }),
    close: async () => undefined,
  };
  const legacyRuntime = createAntigravityRuntime(textOnlyExecutor);
  const legacyService = legacyRuntime.runSync(AntigravityRuntime);
  const legacyStream = streamAntigravity(
    legacyRuntime,
    legacyService,
    new AgyReplayStore(),
    new AgyPiBridge("pi-test"),
  );
  try {
    const ctxLegacy = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Check image" },
            { type: "image", mimeType: "image/png", data: tinyPngBase64 },
          ],
          timestamp: 3,
        },
      ],
    } as unknown as TranscriptContext;
    for await (const _ev of legacyStream(model, ctxLegacy)) {
      // drain
    }
    assert.equal(seenRequests.length, 1);
    assert.equal(seenRequests[0]!.images, undefined);
    assert.match(seenRequests[0]!.prompt, /Check image/);
    assert.match(seenRequests[0]!.prompt, /Attached user image\(s\) saved to disk/);
    const pathMatch = seenRequests[0]!.prompt.match(/^- Image 1: (.+\.png)$/m);
    if (pathMatch?.[1]) {
      rmSync(pathMatch[1], { force: true });
    }
  } finally {
    await runAntigravity(legacyRuntime, legacyService.close);
  }
});
