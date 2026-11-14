import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  AgyStallError,
  buildDriverAgyArgs,
  buildOneShotAgyArgs,
  resetLegacyEffortSuffixCache,
  runAgyTurn,
} from "../lib/agy-client.ts";
import {
  AgyDriverSession,
  normalizeAgyDriverMode,
  resolveAgyDriverMode,
  SwitchableAgyTurnExecutor,
} from "../lib/agy-driver.ts";
import { extractToolCallsFromStepPayload } from "../lib/agy-thoughts.ts";
import { ToolSummaryTracker } from "../lib/tool-summary.ts";
import { readAgyFooterMode, resolveAgyFooterModeCommand } from "../lib/footer.ts";
import {
  loadSavedAgyDriverMode,
  loadSavedAgyFooterMode,
  loadSavedAgyToolMode,
  saveAgyDriverMode,
  saveAgyFooterMode,
  saveAgyToolMode,
} from "../lib/tool-mode-settings.ts";
import { AntigravityRuntime, createAntigravityRuntime, runAntigravity } from "../src/runtime.ts";

test("saved tool mode survives new readers and Pi's own settings writes", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-tool-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "settings.json");
  assert.equal(loadSavedAgyToolMode(file), undefined);
  await writeFile(file, JSON.stringify({ theme: "dark", antigravity: { keep: true } }));
  const piSettings = SettingsManager.create(dir, dir);
  await saveAgyToolMode("pi", file);
  assert.equal(loadSavedAgyToolMode(file), "pi");
  piSettings.setTheme("light");
  await piSettings.flush();
  assert.deepEqual(piSettings.drainErrors(), []);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    theme: "light",
    antigravity: { keep: true, toolMode: "pi" },
  });
  await Promise.all([saveAgyToolMode("native", file), saveAgyToolMode("pi", file)]);
  assert.equal(loadSavedAgyToolMode(file), "pi");
  assert.deepEqual(await readdir(dir), ["settings.json"]);
});

test("malformed settings are preserved when saving fails", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-tool-settings-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "settings.json");
  for (const text of ["{broken", "[]", '{"antigravity":"broken"}']) {
    await writeFile(file, text);
    assert.throws(() => loadSavedAgyToolMode(file));
    await assert.rejects(saveAgyToolMode("pi", file));
    assert.equal(await readFile(file, "utf8"), text);
    assert.deepEqual(await readdir(dir), ["settings.json"]);
  }
  await writeFile(file, '{"antigravity":{"toolMode":"broken"}}');
  assert.throws(() => loadSavedAgyToolMode(file), /antigravity.toolMode/);
});

test("footer mode defaults to on, respects CLI/env/saved precedence, and persists in settings.json", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-footer-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "settings.json");

  assert.equal(loadSavedAgyFooterMode(file), undefined);
  assert.equal(readAgyFooterMode(undefined, {}, undefined), "on");
  assert.equal(readAgyFooterMode(undefined, {}, "off"), "off");
  assert.equal(readAgyFooterMode(undefined, { PI_ANTIGRAVITY_FOOTER: "off" }, "on"), "off");
  assert.equal(readAgyFooterMode(undefined, { PI_ANTIGRAVITY_CUSTOM_FOOTER: "0" }, "on"), "off");
  assert.equal(readAgyFooterMode("on", { PI_ANTIGRAVITY_FOOTER: "off" }, "off"), "on");

  assert.equal(resolveAgyFooterModeCommand("", "on"), "off");
  assert.equal(resolveAgyFooterModeCommand("", "off"), "on");
  assert.equal(resolveAgyFooterModeCommand("on", "off"), "on");
  assert.equal(resolveAgyFooterModeCommand("off", "on"), "off");
  assert.equal(resolveAgyFooterModeCommand("status", "on"), "status");
  assert.equal(resolveAgyFooterModeCommand("invalid", "on"), undefined);

  await saveAgyToolMode("pi", file);
  await saveAgyFooterMode("off", file);
  assert.equal(loadSavedAgyFooterMode(file), "off");
  assert.equal(loadSavedAgyToolMode(file), "pi");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    antigravity: { toolMode: "pi", footer: "off" },
  });
});

test("model and effort default to base model + --effort and fall back to legacy model-effort suffix", async (t) => {
  resetLegacyEffortSuffixCache();
  t.after(() => resetLegacyEffortSuffixCache());

  // 1. Default args pass `--model <base> --effort <level>`
  const oneShotDefault = buildOneShotAgyArgs({
    prompt: "hello",
    model: "gemini-3.8-flash",
    effort: "high",
  });
  assert.ok(oneShotDefault.includes("--model"));
  assert.equal(oneShotDefault[oneShotDefault.indexOf("--model") + 1], "gemini-3.8-flash");
  assert.equal(oneShotDefault[oneShotDefault.indexOf("--effort") + 1], "high");

  // Even if caller passed a suffixed model id, default normalizes to base + `--effort`
  const driverFromSuffixed = buildDriverAgyArgs({
    model: "gemini-3.8-flash-medium",
  });
  assert.equal(driverFromSuffixed[driverFromSuffixed.indexOf("--model") + 1], "gemini-3.8-flash");
  assert.equal(driverFromSuffixed[driverFromSuffixed.indexOf("--effort") + 1], "medium");

  // Explicit legacy fallback folds effort into `<base>-<effort>` and omits `--effort`
  const legacyArgs = buildDriverAgyArgs({
    model: "gemini-3.8-flash",
    effort: "high",
    legacyEffortSuffix: true,
  });
  assert.equal(legacyArgs[legacyArgs.indexOf("--model") + 1], "gemini-3.8-flash-high");
  assert.equal(legacyArgs.includes("--effort"), false);

  // 2. Runtime automatic fallback in persistent driver and one-shot client
  const spawnedArgs: string[][] = [];
  const fakeSpawn = ((_cmd: string, args: readonly string[]) => {
    const argv = [...args];
    spawnedArgs.push(argv);
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: () => boolean;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;

    const hasEffortFlag = argv.includes("--effort");
    queueMicrotask(() => {
      if (hasEffortFlag) {
        const errLine = JSON.stringify({
          event: "result",
          result: {
            conversation_id: "",
            status: "ERROR",
            response: "",
            error:
              'invalid model selection (--model "gemini-3.8-flash" --effort "high"): --effort is not supported for model "gemini-3.8-flash"',
          },
        });
        child.stderr.write('error: invalid model selection (--model "gemini-3.8-flash" --effort "high")\n');
        child.stdout.write(`${errLine}\n`);
        child.exitCode = 1;
        child.emit("close", 1, null);
      } else {
        const okLine = JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-legacy-ok",
            status: "OK",
            response: "fallback succeeded",
          },
        });
        child.stdout.write(`${okLine}\n`);
      }
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  const driver = new AgyDriverSession();
  t.after(() => driver.close("shutdown"));
  const activities: unknown[] = [];
  const outcome = await driver.run({
    prompt: "hi",
    model: "gemini-3.8-flash",
    effort: "high",
    binary: "agy",
    spawnOverride: fakeSpawn,
    onActivity: (a) => activities.push(a),
  });
  assert.equal(outcome.status, "OK");
  assert.equal(outcome.response, "fallback succeeded");
  assert.equal(spawnedArgs.length, 2);
  // First attempt: `--model gemini-3.8-flash --effort high`
  assert.equal(spawnedArgs[0]![spawnedArgs[0]!.indexOf("--model") + 1], "gemini-3.8-flash");
  assert.equal(spawnedArgs[0]![spawnedArgs[0]!.indexOf("--effort") + 1], "high");
  // Fallback attempt: `--model gemini-3.8-flash-high` without `--effort`
  assert.equal(spawnedArgs[1]![spawnedArgs[1]!.indexOf("--model") + 1], "gemini-3.8-flash-high");
  assert.equal(spawnedArgs[1]!.includes("--effort"), false);
  // Failed first attempt did not leak an ERROR activity to onActivity
  assert.equal(
    activities.some((a) => (a as { type?: string; status?: string }).status === "ERROR"),
    false,
  );

  // Subsequent one-shot turn for the same model uses the cached legacy suffix immediately
  const oneShotOutcome = await runAgyTurn({
    prompt: "hi again",
    model: "gemini-3.8-flash",
    effort: "low",
    binary: "agy",
    spawnOverride: fakeSpawn,
  });
  assert.equal(oneShotOutcome.status, "OK");
  assert.equal(spawnedArgs.length, 3);
  assert.equal(spawnedArgs[2]![spawnedArgs[2]!.indexOf("--model") + 1], "gemini-3.8-flash-low");
  assert.equal(spawnedArgs[2]!.includes("--effort"), false);
});

test("AgyDriverSession rejects cleanly with AgyStallError without unhandledRejection when a >64KB stdin write stalls before drain", async (t) => {
  const { spawn } = await import("node:child_process");
  const driver = new AgyDriverSession();
  t.after(() => driver.close("shutdown"));

  let unhandled: unknown;
  const onUnhandled = (reason: unknown) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  await assert.rejects(
    () =>
      driver.run({
        prompt: "x".repeat(75_000),
        binary: process.execPath,
        inactivityTimeoutMs: 80,
        spawnOverride: () =>
          spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
          }),
      }),
    (err: unknown) => err instanceof AgyStallError && err.stalledMs === 80,
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(unhandled, undefined);
});

test("driver mode normalizes aliases, persists under antigravity.driver, and switches live", async (t) => {
  assert.equal(normalizeAgyDriverMode("acp"), "acp");
  assert.equal(normalizeAgyDriverMode("stream-json"), "stream-json");
  assert.equal(normalizeAgyDriverMode("persistent"), "stream-json");
  assert.equal(normalizeAgyDriverMode("legacy"), "stream-json");
  assert.equal(normalizeAgyDriverMode("0"), "one-shot");
  assert.equal(normalizeAgyDriverMode("oneshot"), "one-shot");
  assert.equal(normalizeAgyDriverMode("unknown"), undefined);

  const dir = await mkdtemp(path.join(tmpdir(), "agy-driver-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "settings.json");

  await writeFile(
    file,
    JSON.stringify({ "pi-agy": { turnTimeoutMs: 1000, driver: "legacy" }, antigravity: { toolMode: "pi" } }),
  );
  assert.equal(loadSavedAgyDriverMode(file), "stream-json");
  assert.equal(resolveAgyDriverMode({ PI_CODING_AGENT_DIR: dir }), "stream-json");
  assert.equal(
    resolveAgyDriverMode({ PI_CODING_AGENT_DIR: dir, PI_ANTIGRAVITY_DRIVER: "acp" }),
    "acp",
  );

  await saveAgyDriverMode("acp", file);
  assert.equal(loadSavedAgyDriverMode(file), "acp");
  assert.equal(resolveAgyDriverMode({ PI_CODING_AGENT_DIR: dir }), "acp");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    "pi-agy": { turnTimeoutMs: 1000 },
    antigravity: { toolMode: "pi", driver: "acp" },
  });

  const executor = new SwitchableAgyTurnExecutor("acp");
  t.after(() => executor.close("shutdown"));
  assert.equal(executor.snapshot().mode, "acp");
  await executor.switchMode("stream-json");
  assert.equal(executor.mode, "stream-json");
  assert.equal(executor.snapshot().mode, "persistent");
  await executor.switchMode("one-shot");
  assert.equal(executor.snapshot().mode, "one-shot");

  const runtime = createAntigravityRuntime(new SwitchableAgyTurnExecutor("acp"));
  const service = runtime.runSync(AntigravityRuntime);
  t.after(() => runAntigravity(runtime, service.close));
  await runAntigravity(runtime, service.switchDriverMode("stream-json"));
  const snap = await runAntigravity(runtime, service.snapshot);
  assert.equal(snap.executor.mode, "persistent");
});

test("extractToolCallsFromStepPayload decodes PlannerResponse toolSummary and pairs with bridged Pi call", () => {
  const encodeVarint = (n: number): number[] => {
    const out: number[] = [];
    let v = n >>> 0;
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v);
    return out;
  };
  const encodeFieldBytes = (field: number, data: Uint8Array): Buffer => {
    const tag = Buffer.from(encodeVarint((field << 3) | 2));
    const len = Buffer.from(encodeVarint(data.length));
    return Buffer.concat([tag, len, data]);
  };
  const idBuf = Buffer.from("call_123", "utf8");
  const nameBuf = Buffer.from("mcp_pi-test_pi__read", "utf8");
  const argsBuf = Buffer.from(
    JSON.stringify({
      path: "lani-server/db/re/quest_db.yml",
      offset: 14680,
      limit: 25,
      toolSummary: "Read quest_db.yml around 21712",
    }),
    "utf8",
  );
  const tcMsg = Buffer.concat([
    encodeFieldBytes(1, idBuf),
    encodeFieldBytes(2, nameBuf),
    encodeFieldBytes(3, argsBuf),
  ]);
  const prMsg = encodeFieldBytes(7, tcMsg);
  const stepPayload = encodeFieldBytes(20, prMsg);

  const calls = extractToolCallsFromStepPayload(stepPayload);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.id, "call_123");
  assert.equal(calls[0]?.name, "mcp_pi-test_pi__read");
  assert.equal(calls[0]?.args.toolSummary, "Read quest_db.yml around 21712");

  const tracker = new ToolSummaryTracker();
  tracker.recordBridgeCall({
    id: "pi-bridge-45",
    tool: "read",
    args: { path: "lani-server/db/re/quest_db.yml", offset: 14680, limit: 25 },
  });
  tracker.recordToolStart({ name: calls[0]!.name, args: calls[0]!.args }, "pi-test");
  assert.equal(tracker.get("pi-bridge-45"), "Read quest_db.yml around 21712");
});


