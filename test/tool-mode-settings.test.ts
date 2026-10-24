import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readAgyFooterMode, resolveAgyFooterModeCommand } from "../lib/footer.ts";
import {
  loadSavedAgyFooterMode,
  loadSavedAgyToolMode,
  saveAgyFooterMode,
  saveAgyToolMode,
} from "../lib/tool-mode-settings.ts";

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
