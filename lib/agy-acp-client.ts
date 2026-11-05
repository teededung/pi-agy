/**
 * Zero-dependency ACP v1 JSON-RPC 2.0 stdio client and protocol mappers for
 * `agy acp` (Antigravity CLI 1.5.0+).
 */

import type { JsonObject } from "@earendil-works/pi-ai";
import { execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { splitAgyModelEffort, type AgyEffort } from "./agy-client.ts";
import type { AgyExecutionMode } from "./agy-profile.ts";
import { mergeAgyModels, type AgyModelInfo } from "./models.ts";
import {
  sanitizeAgentResponseDelta,
  stripHallucinatedTurnSuffix,
  type AgyActivity,
  type AgyTurnOutcome,
  type AgyUsage,
} from "./reducer.ts";

export const ACP_PROTOCOL_VERSION = 1;
export const ACP_AUTH_REQUIRED_CODE = -32000;
const DEFAULT_STDIO_MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_INIT_TIMEOUT_MS = 30_000;
const DEFAULT_RPC_TIMEOUT_MS = 60_000;
const DEFAULT_AUTH_TIMEOUT_MS = 180_000;
const LOOPBACK_NO_PROXY_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;

export type AcpChildProcess = ChildProcess & {
  stdin: NonNullable<ChildProcess["stdin"]>;
  stdout: NonNullable<ChildProcess["stdout"]>;
  stderr: NonNullable<ChildProcess["stderr"]>;
};

export interface AcpPromptImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export interface AcpPromptTextBlock {
  type: "text";
  text: string;
}

export type AcpPromptBlock = AcpPromptTextBlock | AcpPromptImageBlock;

export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string;
}

export interface AcpMcpHttpServer {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export interface AcpQuotaSnapshot {
  remaining?: number;
  limit?: number;
  resetTime?: string;
}

export interface AcpInitializeResponse {
  protocolVersion: number;
  agentInfo?: { name?: string; version?: string };
  authMethods?: AcpAuthMethod[];
  agentCapabilities?: {
    loadSession?: boolean;
    load_session?: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
    sessionCapabilities?: {
      resume?: Record<string, unknown>;
      close?: Record<string, unknown>;
      load?: Record<string, unknown>;
      additionalDirectories?: Record<string, unknown>;
    };
    _meta?: {
      antigravity?: {
        tier?: boolean;
        systemPrompt?: { append?: boolean };
      };
    };
  };
}

export interface AcpConfigSelectOption {
  value: string;
  name: string;
  description?: string;
}

export interface AcpConfigOptionGroup {
  group: string;
  name: string;
  options: AcpConfigSelectOption[];
}

export type AcpSessionConfigOption =
  | {
      id: string;
      name: string;
      category?: string | null;
      type: "select";
      currentValue: string;
      options: Array<AcpConfigSelectOption | AcpConfigOptionGroup>;
    }
  | {
      id: string;
      name: string;
      category?: string | null;
      type: "boolean";
      currentValue: boolean;
    };

export interface AcpSessionModeState {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string; description?: string }>;
}

export interface AcpSessionModelState {
  currentModelId: string;
  availableModels: Array<{ modelId: string; name: string }>;
}

export interface AcpSessionState {
  modes?: AcpSessionModeState;
  models?: AcpSessionModelState;
  configOptions?: AcpSessionConfigOption[];
}

export interface AcpNewSessionResponse extends AcpSessionState {
  sessionId: string;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
  };
  options?: AcpPermissionOption[];
}

export type AcpPermissionResponse = {
  outcome:
    | { outcome: "selected"; optionId: string }
    | { outcome: "cancelled" };
};

export interface AcpSessionNotification {
  sessionId: string;
  update: Record<string, unknown> & { sessionUpdate: string };
}

export interface AcpPromptResponse {
  stopReason: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
  };
  error?: { message?: string } | string;
  _meta?: Record<string, unknown>;
}

export class AgyAcpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly isAuthRequired: boolean;

  constructor(method: string, code: number, message: string, data?: unknown) {
    const detail = extractRpcErrorDetail(data);
    const fullMessage = detail ? `${message}: ${detail}` : message;
    const isAuthRequired =
      code === ACP_AUTH_REQUIRED_CODE ||
      /authentication required|not authenticated|login required/i.test(fullMessage);
    const suffix =
      isAuthRequired && !/\/agy-login|agy login/i.test(fullMessage)
        ? " (run `/agy-login` in Pi or `agy login` in a terminal)"
        : "";
    super(`ACP ${method} error (${code}): ${fullMessage}${suffix}`);
    this.name = "AgyAcpRpcError";
    this.code = code;
    this.data = data;
    this.isAuthRequired = isAuthRequired;
  }
}

function extractRpcErrorDetail(data: unknown): string | undefined {
  if (typeof data === "string" && data.trim()) return data.trim();
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  for (const key of ["details", "detail", "message", "reason"]) {
    const val = record[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Build CLI arguments for `agy acp`.
 *
 * Notice we intentionally omit `--dangerously-skip-permissions`: in ACP mode,
 * `agy acp` delegates permission checks over JSON-RPC (`session/request_permission`),
 * allowing a single warm `agy acp` process to auto-approve normal turns and
 * strictly reject mutating actions during `readOnlyPermissions` turns without
 * respawning!
 */
export function buildAcpAgyArgs(options: {
  cwd?: string;
  mcpDirectory?: string;
  agent?: string;
}): string[] {
  const args = ["acp"];
  if (options.cwd) {
    args.push("--add-dir", options.cwd);
  }
  if (options.mcpDirectory && options.mcpDirectory !== options.cwd) {
    args.push("--add-dir", options.mcpDirectory);
  }
  if (options.agent) {
    args.push("--agent", options.agent);
  }
  return args;
}

/**
 * Read `<mcpDirectory>/.agents/mcp_config.json` (created by `createPrivateMcpConfig`)
 * and convert any HTTP MCP servers into ACP `McpServerHttp` descriptors for
 * `session/new` and `session/resume`.
 */
export function readAcpMcpServersFromDirectory(mcpDirectory?: string): AcpMcpHttpServer[] {
  if (!mcpDirectory) return [];
  const configPath = path.join(mcpDirectory, ".agents", "mcp_config.json");
  if (!existsSync(configPath)) return [];
  try {
    const parsed = asRecord(JSON.parse(readFileSync(configPath, "utf8")));
    const rawServers = asRecord(parsed?.mcpServers);
    if (!rawServers) return [];
    const servers: AcpMcpHttpServer[] = [];
    for (const [name, rawCfg] of Object.entries(rawServers)) {
      const cfg = asRecord(rawCfg);
      if (!cfg || !name.trim()) continue;
      const url =
        typeof cfg.url === "string" && cfg.url.trim()
          ? cfg.url.trim()
          : typeof cfg.serverUrl === "string" && cfg.serverUrl.trim()
            ? cfg.serverUrl.trim()
            : "";
      if (!url) continue;
      const rawHeaders = asRecord(cfg.headers);
      const headers: Array<{ name: string; value: string }> = [];
      if (rawHeaders) {
        for (const [headerName, headerValue] of Object.entries(rawHeaders)) {
          if (headerName.trim() && headerValue !== undefined && headerValue !== null) {
            headers.push({ name: headerName.trim(), value: String(headerValue) });
          }
        }
      }
      servers.push({ type: "http", name: name.trim(), url, headers });
    }
    return servers;
  } catch {
    return [];
  }
}

function validateHttpProxyUrl(raw: string, source: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid ${source}: expected an http:// or https:// proxy URL.`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw new Error(`Invalid ${source}: expected an http:// or https:// proxy URL.`);
  }
  return raw;
}

function mergeLoopbackNoProxy(existing: string | undefined): string {
  const items = (existing ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const seen = new Set(items.map((entry) => entry.toLowerCase()));
  for (const host of LOOPBACK_NO_PROXY_HOSTS) {
    if (!seen.has(host)) {
      items.push(host);
      seen.add(host);
    }
  }
  return items.join(",");
}

function parseScutilHttpProxies(output: string): { http?: string; https?: string } {
  const kv = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (match) kv.set(match[1]!, match[2]!);
  }
  const build = (enableKey: string, hostKey: string, portKey: string): string | undefined => {
    if (kv.get(enableKey) !== "1") return undefined;
    const host = kv.get(hostKey);
    const port = kv.get(portKey);
    if (!host || !port || !/^\d+$/.test(port)) return undefined;
    const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    const candidate = `http://${formattedHost}:${port}`;
    try {
      return validateHttpProxyUrl(candidate, "macOS scutil proxy");
    } catch {
      return undefined;
    }
  };
  return {
    http: build("HTTPEnable", "HTTPProxy", "HTTPPort"),
    https: build("HTTPSEnable", "HTTPSProxy", "HTTPSPort"),
  };
}

/**
 * Prepare child environment for `agy acp`:
 * - Always merges `localhost,127.0.0.1,::1` into `NO_PROXY` and `no_proxy` so
 *   `agy acp` HTTP requests to the local `AgyPiBridge` never route through a proxy.
 * - Honors `PI_ANTIGRAVITY_ACP_PROXY` (`http://` or `https://`) when set.
 * - On macOS, falls back to `scutil --proxy` HTTP/HTTPS settings when no proxy
 *   environment variables are configured.
 */
export function buildAcpChildEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readMacSystemProxy?: () => string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const explicit = env.PI_ANTIGRAVITY_ACP_PROXY?.trim();
  if (explicit) {
    const validated = validateHttpProxyUrl(explicit, "PI_ANTIGRAVITY_ACP_PROXY");
    out.HTTP_PROXY = validated;
    out.HTTPS_PROXY = validated;
    out.http_proxy = validated;
    out.https_proxy = validated;
  } else {
    const hasEnvProxy = [
      env.HTTP_PROXY,
      env.HTTPS_PROXY,
      env.ALL_PROXY,
      env.http_proxy,
      env.https_proxy,
      env.all_proxy,
    ].some((val) => Boolean(val?.trim()));
    if (!hasEnvProxy && platform === "darwin") {
      try {
        const raw =
          readMacSystemProxy?.() ??
          execFileSync("scutil", ["--proxy"], {
            encoding: "utf8",
            timeout: 1_500,
            stdio: ["ignore", "pipe", "ignore"],
          });
        const discovered = parseScutilHttpProxies(raw);
        if (discovered.http) {
          out.HTTP_PROXY = discovered.http;
          out.http_proxy = discovered.http;
        }
        if (discovered.https) {
          out.HTTPS_PROXY = discovered.https;
          out.https_proxy = discovered.https;
        }
      } catch {
        // Advisory fallback only.
      }
    }
  }
  out.NO_PROXY = mergeLoopbackNoProxy(out.NO_PROXY ?? out.no_proxy);
  out.no_proxy = mergeLoopbackNoProxy(out.no_proxy ?? out.NO_PROXY);
  return out;
}

/**
 * Choose the ACP permission callback outcome for a turn.
 * - `readOnlyPermissions === true`: select `reject_once` if offered, else `cancelled`.
 * - Normal headless turn: select `allow_once` (or `allow_always`) if offered, else `cancelled`.
 */
export function selectAcpPermissionOutcome(
  request: AcpPermissionRequest,
  readOnlyPermissions = false,
): AcpPermissionResponse {
  const options = Array.isArray(request.options) ? request.options : [];
  if (readOnlyPermissions) {
    const rejectOpt =
      options.find((opt) => opt.kind === "reject_once") ??
      options.find((opt) => opt.kind === "reject_always");
    if (rejectOpt && typeof rejectOpt.optionId === "string" && rejectOpt.optionId) {
      return { outcome: { outcome: "selected", optionId: rejectOpt.optionId } };
    }
    return { outcome: { outcome: "cancelled" } };
  }
  const allowOpt =
    options.find((opt) => opt.kind === "allow_once") ??
    options.find((opt) => opt.kind === "allow_always") ??
    options.find((opt) => /^allow/i.test(opt.optionId) || /^allow/i.test(opt.name));
  if (allowOpt && typeof allowOpt.optionId === "string" && allowOpt.optionId) {
    return { outcome: { outcome: "selected", optionId: allowOpt.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

/**
 * Convert an ACP `PromptResponse` usage payload into `AgyUsage`.
 * Note: `agy acp` reports total prompt tokens (including cached read tokens) in
 * `inputTokens` / `_meta.quota.token_count.input_tokens`, whereas `pi-agy`'s
 * `AgyUsage` expects uncached `input_tokens` + `cache_read_tokens`.
 */
export function acpUsageToAgyUsage(response: AcpPromptResponse): AgyUsage | undefined {
  const standard = asRecord(response.usage);
  const meta = asRecord(response._meta);
  const quota = asRecord(meta?.quota);
  const tokenCount = asRecord(quota?.token_count);

  const cacheRead = safeNonNegativeInt(standard?.cachedReadTokens);
  const rawInput =
    safeNonNegativeInt(tokenCount?.input_tokens) ?? safeNonNegativeInt(standard?.inputTokens);
  const output =
    safeNonNegativeInt(tokenCount?.output_tokens) ?? safeNonNegativeInt(standard?.outputTokens);
  const thinking = safeNonNegativeInt(standard?.thoughtTokens);
  const explicitTotal = safeNonNegativeInt(standard?.totalTokens);

  if (
    rawInput === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    thinking === undefined &&
    explicitTotal === undefined
  ) {
    return undefined;
  }

  const uncachedInput =
    rawInput !== undefined ? Math.max(0, rawInput - (cacheRead ?? 0)) : undefined;
  const computedTotal = (uncachedInput ?? 0) + (output ?? 0) + (cacheRead ?? 0);

  return {
    ...(uncachedInput !== undefined ? { input_tokens: uncachedInput } : {}),
    ...(output !== undefined ? { output_tokens: output } : {}),
    ...(thinking !== undefined ? { thinking_tokens: thinking } : {}),
    ...(cacheRead !== undefined ? { cache_read_tokens: cacheRead } : {}),
    total_tokens: Math.max(explicitTotal ?? 0, computedTotal),
  };
}

/** Extract lightweight inline quota metadata from ACP `PromptResponse._meta.quota` if present. */
export function extractAcpQuotaSnapshot(response: AcpPromptResponse): AcpQuotaSnapshot | undefined {
  const meta = asRecord(response._meta);
  const quota = asRecord(meta?.quota);
  if (!quota) return undefined;

  const remaining =
    typeof quota.remaining === "number" && Number.isFinite(quota.remaining)
      ? quota.remaining
      : typeof quota.remaining_requests === "number" && Number.isFinite(quota.remaining_requests)
        ? quota.remaining_requests
        : undefined;
  const limit =
    typeof quota.limit === "number" && Number.isFinite(quota.limit)
      ? quota.limit
      : typeof quota.request_limit === "number" && Number.isFinite(quota.request_limit)
        ? quota.request_limit
        : undefined;
  const resetTime =
    typeof quota.reset_time === "string" && quota.reset_time.trim()
      ? quota.reset_time.trim()
      : typeof quota.resetTime === "string" && quota.resetTime.trim()
        ? quota.resetTime.trim()
        : typeof quota.resets_at === "string" && quota.resets_at.trim()
          ? quota.resets_at.trim()
          : undefined;

  if (remaining === undefined && limit === undefined && !resetTime) {
    return undefined;
  }
  return {
    ...(remaining !== undefined ? { remaining } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(resetTime ? { resetTime } : {}),
  };
}

/**
 * Format a clear user-facing error message when an ACP turn stops with a
 * non-`end_turn` reason (e.g. `stopReason === "refusal"` on quota exhaustion).
 */
export function formatAcpStopError(
  stopReason: string,
  rawErr: string | undefined,
  responseText: string,
  quota?: AcpQuotaSnapshot,
): string {
  const appendReset = (msg: string): string =>
    quota?.resetTime && !msg.includes(quota.resetTime)
      ? `${msg} (resets ${quota.resetTime})`
      : msg;

  if (rawErr?.trim()) {
    return appendReset(rawErr.trim());
  }
  const trimmedResponse = responseText.trim();
  if (stopReason === "refusal" && trimmedResponse) {
    return appendReset(trimmedResponse.slice(0, 500));
  }
  if (stopReason === "refusal") {
    return appendReset("Antigravity refused the request or reached its usage quota limit.");
  }
  return appendReset(`agy turn ended early (${stopReason}).`);
}

export function decodeAcpSessionState(raw: unknown): AcpSessionState {
  const record = asRecord(raw);
  if (!record) return {};
  const out: AcpSessionState = {};

  const modes = asRecord(record.modes);
  if (modes && typeof modes.currentModeId === "string" && Array.isArray(modes.availableModes)) {
    out.modes = {
      currentModeId: modes.currentModeId,
      availableModes: modes.availableModes
        .map((m) => asRecord(m))
        .filter((m): m is Record<string, unknown> => Boolean(m && typeof m.id === "string"))
        .map((m) => ({
          id: m.id as string,
          name: typeof m.name === "string" ? m.name : (m.id as string),
          ...(typeof m.description === "string" ? { description: m.description } : {}),
        })),
    };
  }

  const models = asRecord(record.models);
  if (models && typeof models.currentModelId === "string" && Array.isArray(models.availableModels)) {
    out.models = {
      currentModelId: models.currentModelId,
      availableModels: models.availableModels
        .map((m) => asRecord(m))
        .filter((m): m is Record<string, unknown> => Boolean(m && typeof m.modelId === "string"))
        .map((m) => ({
          modelId: m.modelId as string,
          name: typeof m.name === "string" ? m.name : (m.modelId as string),
        })),
    };
  }

  if (Array.isArray(record.configOptions)) {
    const parsedOptions: AcpSessionConfigOption[] = [];
    for (const item of record.configOptions) {
      const opt = asRecord(item);
      if (!opt || typeof opt.id !== "string") continue;
      const name = typeof opt.name === "string" ? opt.name : opt.id;
      const category = typeof opt.category === "string" ? opt.category : null;
      if (opt.type === "boolean" && typeof opt.currentValue === "boolean") {
        parsedOptions.push({ id: opt.id, name, category, type: "boolean", currentValue: opt.currentValue });
      } else if (
        opt.type === "select" &&
        typeof opt.currentValue === "string" &&
        Array.isArray(opt.options)
      ) {
        const selectItems: Array<AcpConfigSelectOption | AcpConfigOptionGroup> = [];
        for (const rawChoice of opt.options) {
          const choice = asRecord(rawChoice);
          if (!choice) continue;
          if (typeof choice.value === "string") {
            selectItems.push({
              value: choice.value,
              name: typeof choice.name === "string" ? choice.name : choice.value,
            });
          } else if (typeof choice.group === "string" && Array.isArray(choice.options)) {
            const groupOpts = choice.options
              .map((g) => asRecord(g))
              .filter((g): g is Record<string, unknown> => Boolean(g && typeof g.value === "string"))
              .map((g) => ({
                value: g.value as string,
                name: typeof g.name === "string" ? g.name : (g.value as string),
              }));
            selectItems.push({
              group: choice.group,
              name: typeof choice.name === "string" ? choice.name : choice.group,
              options: groupOpts,
            });
          }
        }
        parsedOptions.push({
          id: opt.id,
          name,
          category,
          type: "select",
          currentValue: opt.currentValue,
          options: selectItems,
        });
      }
    }
    out.configOptions = parsedOptions;
  }

  return out;
}

type SelectConfigOption = Extract<AcpSessionConfigOption, { type: "select" }>;

export function findAcpSelectOption(
  state: AcpSessionState,
  category: "model" | "thought_level" | "mode",
): SelectConfigOption | undefined {
  if (!state.configOptions) return undefined;
  return state.configOptions.find(
    (opt): opt is SelectConfigOption =>
      opt.type === "select" &&
      (opt.category === category ||
        opt.id === category ||
        (category === "thought_level" && opt.id === "thinking_level")),
  );
}

export function flattenSelectValues(opt: SelectConfigOption): AcpConfigSelectOption[] {
  return opt.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

function asValidAgyEffort(raw: string | undefined): AgyEffort | undefined {
  const normalized = raw?.trim().toLowerCase();
  return normalized === "low" || normalized === "medium" || normalized === "high"
    ? normalized
    : undefined;
}

/**
 * Synthesize normalized `AgyModelInfo[]` from live ACP `configOptions` (or
 * legacy `models` state) so warm ACP sessions can populate/enrich Pi's model
 * and thinking-level catalog without spawning an extra `agy models` process.
 */
export function modelsFromAcpSessionState(state: AcpSessionState): AgyModelInfo[] | undefined {
  const modelOpt = findAcpSelectOption(state, "model");
  const thoughtOpt = findAcpSelectOption(state, "thought_level");

  const supportedEfforts: AgyEffort[] = [];
  if (thoughtOpt) {
    for (const item of flattenSelectValues(thoughtOpt)) {
      const effort = asValidAgyEffort(item.value);
      if (effort && !supportedEfforts.includes(effort)) {
        supportedEfforts.push(effort);
      }
    }
  }
  const defaultEffort =
    asValidAgyEffort(thoughtOpt?.currentValue) ?? supportedEfforts[0];

  const rawEntries: AgyModelInfo[] = [];
  if (modelOpt) {
    for (const choice of flattenSelectValues(modelOpt)) {
      const id = choice.value.trim();
      if (!id) continue;
      rawEntries.push({
        id,
        name: choice.name.trim() || id,
        supportedEfforts: [...supportedEfforts],
        ...(defaultEffort ? { defaultEffort } : {}),
      });
    }
  } else if (state.models?.availableModels?.length) {
    for (const choice of state.models.availableModels) {
      const id = choice.modelId.trim();
      if (!id) continue;
      rawEntries.push({
        id,
        name: choice.name.trim() || id,
        supportedEfforts: [...supportedEfforts],
        ...(defaultEffort ? { defaultEffort } : {}),
      });
    }
  }

  if (rawEntries.length === 0) return undefined;
  const merged = mergeAgyModels(rawEntries);
  return merged.length > 0 ? merged : undefined;
}

const KNOWN_AGY_TOOLS = new Set([
  "run_command",
  "command_status",
  "send_command_input",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "grep_search",
  "find_by_name",
  "list_dir",
  "list_resources",
  "read_resource",
  "search_web",
  "read_url_content",
  "generate_image",
  "browser_subagent",
  "invoke_subagent",
  "send_message",
  "manage_subagents",
  "manage_task",
  "call_mcp_tool",
]);

function inferAcpToolName(
  update: Record<string, unknown>,
  rawArgs: JsonObject,
): string {
  const meta = asRecord(update._meta);
  for (const candidate of [meta?.toolName, meta?.tool_name, meta?.name, update.toolName]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  if (typeof rawArgs.ServerName === "string" && typeof rawArgs.ToolName === "string") {
    return "call_mcp_tool";
  }

  const rawTitle = typeof update.title === "string" ? update.title.trim() : "";
  if (rawTitle) {
    if (/^[A-Za-z0-9_.:/-]+$/.test(rawTitle)) {
      return rawTitle;
    }
    const prefixMatch = /^([A-Za-z0-9_.:/-]+)(?:\s*[:·—(-]|\s+)/.exec(rawTitle);
    if (prefixMatch) {
      const prefix = prefixMatch[1]!;
      if (
        KNOWN_AGY_TOOLS.has(prefix) ||
        prefix.startsWith("mcp_") ||
        prefix.startsWith("pi__") ||
        prefix.includes("/pi__")
      ) {
        return prefix;
      }
    }
  }

  const kind = typeof update.kind === "string" ? update.kind : "";
  if (kind === "execute" || typeof rawArgs.CommandLine === "string") return "run_command";
  if (kind === "read" && typeof rawArgs.AbsolutePath === "string") return "view_file";
  if (kind === "edit" && typeof rawArgs.TargetFile === "string") {
    return Array.isArray(rawArgs.ReplacementChunks)
      ? "multi_replace_file_content"
      : typeof rawArgs.CodeContent === "string"
        ? "write_to_file"
        : "replace_file_content";
  }
  if (kind === "search" && typeof rawArgs.Query === "string") {
    return typeof rawArgs.SearchPath === "string" ? "grep_search" : "search_web";
  }
  if (kind === "fetch" && typeof rawArgs.Url === "string") return "read_url_content";

  return rawTitle ? rawTitle.slice(0, 120) : kind || "tool";
}

function extractToolArgs(update: Record<string, unknown>): JsonObject {
  const rawInput = asRecord(update.rawInput);
  const args: JsonObject = rawInput ? ({ ...rawInput } as JsonObject) : {};

  if (Object.keys(args).length === 0 && Array.isArray(update.locations)) {
    const firstLoc = asRecord(update.locations[0]);
    if (firstLoc && typeof firstLoc.path === "string") {
      args.AbsolutePath = firstLoc.path;
    }
  }
  return args;
}

function extractToolOutputText(update: Record<string, unknown>): string | undefined {
  if (typeof update.rawOutput === "string" && update.rawOutput.trim()) {
    return update.rawOutput;
  }
  const rawOutputObj = asRecord(update.rawOutput);
  if (rawOutputObj) {
    for (const key of ["output", "stdout", "result", "text", "content"]) {
      if (typeof rawOutputObj[key] === "string" && (rawOutputObj[key] as string).trim()) {
        return rawOutputObj[key] as string;
      }
    }
  }
  if (!Array.isArray(update.content)) return undefined;
  const parts: string[] = [];
  for (const item of update.content.slice(0, 16)) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (rec.type === "content") {
      const inner = asRecord(rec.content);
      if (inner?.type === "text" && typeof inner.text === "string" && inner.text) {
        parts.push(inner.text);
      }
    } else if (rec.type === "diff" && typeof rec.path === "string") {
      parts.push(`[diff: ${rec.path}]`);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

interface TrackedAcpToolCall {
  stepId: number;
  name: string;
  args: JsonObject;
  started: boolean;
  finished: boolean;
  startedAtMs: number;
}

/**
 * Stateful per-turn normalizer converting ACP `session/update` notifications
 * into `pi-agy` `AgyActivity` events and accumulating `outcome.response`.
 */
export class AcpTurnNormalizer {
  readonly #outcome: AgyTurnOutcome;
  readonly #tools = new Map<string, TrackedAcpToolCall>();
  #nextToolStepId = 1;
  #responseStepIndex = 0;
  #streamedTextSegments: string[] = [];
  #currentSegment = "";

  constructor(outcome: AgyTurnOutcome) {
    this.#outcome = outcome;
  }

  consumeUpdate(
    notification: AcpSessionNotification,
    onConfigState?: (patch: AcpSessionState) => void,
  ): AgyActivity[] {
    const update = notification.update;
    const kind = update.sessionUpdate;
    const activities: AgyActivity[] = [];

    switch (kind) {
      case "agent_thought_chunk": {
        const content = asRecord(update.content);
        if (content?.type === "text" && typeof content.text === "string" && content.text) {
          const clean = content.text.replace(/[\uFFF9-\uFFFB]/g, "");
          if (clean) {
            activities.push({
              type: "thinking_delta",
              delta: clean,
              stepId: this.#responseStepIndex,
            });
          }
        }
        break;
      }
      case "agent_message_chunk": {
        const content = asRecord(update.content);
        if (content?.type === "text" && typeof content.text === "string" && content.text) {
          const delta = sanitizeAgentResponseDelta(
            this.#outcome,
            this.#responseStepIndex,
            content.text,
          );
          if (delta) {
            this.#currentSegment += delta;
            activities.push({
              type: "text",
              delta,
              stepId: this.#responseStepIndex,
            });
          }
        }
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const toolCallId =
          typeof update.toolCallId === "string" && update.toolCallId
            ? update.toolCallId
            : `tool-${this.#nextToolStepId}`;
        const incomingArgs = extractToolArgs(update);
        let tracked = this.#tools.get(toolCallId);
        if (!tracked) {
          const numericId = /^\d+$/.test(toolCallId) ? Number(toolCallId) : undefined;
          const stepId =
            numericId !== undefined && Number.isSafeInteger(numericId) && numericId > 0
              ? numericId
              : this.#nextToolStepId++;
          tracked = {
            stepId,
            name: inferAcpToolName(update, incomingArgs),
            args: incomingArgs,
            started: false,
            finished: false,
            startedAtMs: Date.now(),
          };
          this.#tools.set(toolCallId, tracked);
        } else {
          if (Object.keys(incomingArgs).length > 0) {
            tracked.args = { ...tracked.args, ...incomingArgs };
          }
          if (tracked.name === "tool" && typeof update.title === "string" && update.title.trim()) {
            tracked.name = inferAcpToolName(update, tracked.args);
          }
        }

        if (this.#currentSegment) {
          this.#streamedTextSegments.push(this.#currentSegment);
          this.#currentSegment = "";
        }
        this.#responseStepIndex += 1;

        const status = typeof update.status === "string" ? update.status : "in_progress";
        const cid = notification.sessionId || this.#outcome.conversationId;

        if (status === "completed") {
          if (!tracked.finished) {
            tracked.finished = true;
            const output = extractToolOutputText(update);
            const durationSeconds = Math.max(0, (Date.now() - tracked.startedAtMs) / 1000);
            activities.push({
              type: "tool_done",
              stepId: tracked.stepId,
              conversationId: cid,
              name: tracked.name,
              args: tracked.args,
              ...(output !== undefined ? { output } : {}),
              durationSeconds,
            });
          }
        } else if (status === "failed") {
          if (!tracked.finished) {
            tracked.finished = true;
            const message =
              extractToolOutputText(update) ??
              (typeof update.title === "string" && update.title.trim()
                ? update.title.trim()
                : "tool error");
            activities.push({
              type: "tool_error",
              stepId: tracked.stepId,
              conversationId: cid,
              name: tracked.name,
              args: tracked.args,
              message: message.replace(/\s+/g, " ").slice(0, 160),
            });
          }
        } else if (!tracked.started) {
          tracked.started = true;
          activities.push({
            type: "tool_start",
            stepId: tracked.stepId,
            conversationId: cid,
            name: tracked.name,
            args: tracked.args,
          });
        }
        break;
      }
      case "config_option_update": {
        if (onConfigState && Array.isArray(update.configOptions)) {
          onConfigState(decodeAcpSessionState({ configOptions: update.configOptions }));
        }
        break;
      }
      case "current_mode_update": {
        if (onConfigState && typeof update.currentModeId === "string") {
          onConfigState({
            modes: { currentModeId: update.currentModeId, availableModes: [] },
          });
        }
        break;
      }
      default:
        break;
    }

    this.#outcome.activities.push(...activities);
    return activities;
  }

  /** Final assistant text assembled from the latest post-tool response segment (or full text). */
  finalResponseText(): string {
    if (this.#currentSegment) {
      return stripHallucinatedTurnSuffix(this.#currentSegment);
    }
    const last = this.#streamedTextSegments.at(-1) ?? "";
    return stripHallucinatedTurnSuffix(last);
  }
}

interface PendingRpc {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export interface AgyAcpClientHandlers {
  onUpdate?: (notification: AcpSessionNotification) => void;
  onPermission?: (request: AcpPermissionRequest) => AcpPermissionResponse | Promise<AcpPermissionResponse>;
  onProtocolWarning?: (line: string) => void;
  onTransportError?: (error: Error) => void;
}

export class AgyAcpClient {
  readonly #child: AcpChildProcess;
  #handlers: AgyAcpClientHandlers;
  #nextId = 1;
  #pending = new Map<number, PendingRpc>();
  #sessions = new Map<string, AcpSessionState>();
  #stdoutBuf = "";
  #closed = false;
  #closeError: Error | undefined;
  #initPromise: Promise<AcpInitializeResponse> | undefined;
  #initResult: AcpInitializeResponse | undefined;
  #ignoredNoiseLines = 0;

  constructor(child: AcpChildProcess, handlers: AgyAcpClientHandlers = {}) {
    this.#child = child;
    this.#handlers = handlers;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onStdoutData(chunk));
    child.stdin.on("error", () => {
      // Observed on close/EPIPE via child exit handler.
    });
  }

  get ignoredNoiseLines(): number {
    return this.#ignoredNoiseLines;
  }

  get initializeResult(): AcpInitializeResponse | undefined {
    return this.#initResult;
  }

  setHandlers(handlers: AgyAcpClientHandlers): void {
    this.#handlers = handlers;
  }

  getSessionState(sessionId: string): AcpSessionState {
    return this.#sessions.get(sessionId) ?? {};
  }

  mergeSessionState(sessionId: string, patch: AcpSessionState): AcpSessionState {
    const prev = this.#sessions.get(sessionId) ?? {};
    const next: AcpSessionState = {
      ...prev,
      ...(patch.configOptions ? { configOptions: patch.configOptions } : {}),
      ...(patch.models ? { models: patch.models } : {}),
      ...(patch.modes
        ? {
            modes: {
              currentModeId: patch.modes.currentModeId,
              availableModes:
                patch.modes.availableModes.length > 0
                  ? patch.modes.availableModes
                  : (prev.modes?.availableModes ?? []),
            },
          }
        : {}),
    };
    this.#sessions.set(sessionId, next);
    return next;
  }

  dropSessionState(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  clearSessions(): void {
    this.#sessions.clear();
  }

  async initialize(
    signal?: AbortSignal,
    timeoutMs = DEFAULT_INIT_TIMEOUT_MS,
  ): Promise<AcpInitializeResponse> {
    if (!this.#initPromise) {
      this.#initPromise = this.request<AcpInitializeResponse>(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: "pi-agy",
            title: "Pi Antigravity Provider",
            version: "1.5.0",
          },
        },
        { timeoutMs },
      ).then((res) => {
        if (res?.protocolVersion !== ACP_PROTOCOL_VERSION) {
          throw new Error(
            `Unsupported agy ACP protocol version: ${String(res?.protocolVersion)}`,
          );
        }
        this.#initResult = res;
        return res;
      });
      void this.#initPromise.catch(() => undefined);
    }
    return this.#withAbort(this.#initPromise, signal);
  }

  supportsSystemPromptAppend(): boolean {
    return Boolean(this.#initResult?.agentCapabilities?._meta?.antigravity?.systemPrompt?.append);
  }

  supportsPromptImages(): boolean {
    return Boolean(this.#initResult?.agentCapabilities?.promptCapabilities?.image);
  }

  supportsAdditionalDirectories(): boolean {
    return Boolean(this.#initResult?.agentCapabilities?.sessionCapabilities?.additionalDirectories);
  }

  supportsSessionClose(): boolean {
    return Boolean(this.#initResult?.agentCapabilities?.sessionCapabilities?.close);
  }

  supportsSessionLoad(): boolean {
    return Boolean(
      this.#initResult?.agentCapabilities?.loadSession ||
        this.#initResult?.agentCapabilities?.load_session ||
        this.#initResult?.agentCapabilities?.sessionCapabilities?.load,
    );
  }

  getAuthMethods(): AcpAuthMethod[] {
    const raw = this.#initResult?.authMethods;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (m): m is AcpAuthMethod =>
        Boolean(m && typeof m.id === "string" && m.id.trim() && typeof m.name === "string"),
    );
  }

  async authenticate(
    methodId?: string,
    signal?: AbortSignal,
  ): Promise<{ methodId: string; methodName?: string; authMethods: AcpAuthMethod[] }> {
    await this.initialize(signal);
    const authMethods = this.getAuthMethods();
    const requested = methodId?.trim();
    let chosenId = requested;
    if (!chosenId) {
      chosenId =
        authMethods.find((m) => m.id === "oauth-personal")?.id ??
        authMethods[0]?.id ??
        "oauth-personal";
    } else if (authMethods.length > 0 && !authMethods.some((m) => m.id === chosenId)) {
      const validIds = authMethods.map((m) => m.id).join(", ");
      throw new Error(`Unknown ACP auth method "${chosenId}". Available methods: ${validIds}`);
    }
    await this.request(
      "authenticate",
      { methodId: chosenId },
      { timeoutMs: DEFAULT_AUTH_TIMEOUT_MS, signal },
    );
    const matched = authMethods.find((m) => m.id === chosenId);
    return {
      methodId: chosenId,
      ...(matched?.name ? { methodName: matched.name } : {}),
      authMethods,
    };
  }

  async newSession(
    options: {
      cwd: string;
      additionalDirectories?: string[];
      systemPromptAppend?: string;
      mcpServers?: AcpMcpHttpServer[];
    },
    signal?: AbortSignal,
  ): Promise<AcpNewSessionResponse> {
    await this.initialize(signal);
    const params: Record<string, unknown> = {
      cwd: options.cwd,
      mcpServers: options.mcpServers ?? [],
    };
    if (options.additionalDirectories?.length && this.supportsAdditionalDirectories()) {
      params.additionalDirectories = options.additionalDirectories;
    }
    if (options.systemPromptAppend && this.supportsSystemPromptAppend()) {
      params._meta = {
        antigravity: {
          systemPrompt: { append: options.systemPromptAppend },
        },
      };
    }
    const raw = await this.request<Record<string, unknown>>("session/new", params, {
      timeoutMs: DEFAULT_RPC_TIMEOUT_MS,
      signal,
    });
    const sessionId = typeof raw?.sessionId === "string" ? raw.sessionId.trim() : "";
    if (!sessionId) {
      throw new Error("Invalid ACP session/new response: missing sessionId");
    }
    const state = this.mergeSessionState(sessionId, decodeAcpSessionState(raw));
    return { sessionId, ...state };
  }

  async resumeSession(
    options: {
      sessionId: string;
      cwd: string;
      additionalDirectories?: string[];
      systemPromptAppend?: string;
      mcpServers?: AcpMcpHttpServer[];
    },
    signal?: AbortSignal,
  ): Promise<AcpSessionState> {
    await this.initialize(signal);
    const params: Record<string, unknown> = {
      sessionId: options.sessionId,
      cwd: options.cwd,
      mcpServers: options.mcpServers ?? [],
    };
    if (options.additionalDirectories?.length && this.supportsAdditionalDirectories()) {
      params.additionalDirectories = options.additionalDirectories;
    }
    if (options.systemPromptAppend && this.supportsSystemPromptAppend()) {
      params._meta = {
        antigravity: {
          systemPrompt: { append: options.systemPromptAppend },
        },
      };
    }
    try {
      const raw = await this.request<Record<string, unknown>>("session/resume", params, {
        timeoutMs: DEFAULT_RPC_TIMEOUT_MS,
        signal,
      });
      return this.mergeSessionState(options.sessionId, decodeAcpSessionState(raw));
    } catch (err) {
      // Fallback to session/load only when session/resume is unsupported (-32601)
      // or explicitly instructs loading with session/load.
      const msg = err instanceof Error ? err.message : String(err);
      const shouldTryLoad =
        this.supportsSessionLoad() &&
        ((err instanceof AgyAcpRpcError && err.code === -32601) ||
          /session\/load/i.test(msg));
      if (!shouldTryLoad) throw err;
      const raw = await this.request<Record<string, unknown>>("session/load", params, {
        timeoutMs: DEFAULT_RPC_TIMEOUT_MS,
        signal,
      });
      return this.mergeSessionState(options.sessionId, decodeAcpSessionState(raw));
    }
  }

  async closeSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    this.dropSessionState(sessionId);
    if (this.#closed || !this.supportsSessionClose()) return;
    try {
      await this.request("session/close", { sessionId }, { timeoutMs: 5_000, signal });
    } catch {
      // Best-effort in-memory handle release.
    }
  }

  /**
   * Dynamically apply `model`, `effort` (`thought_level`), and `mode` to an
   * open ACP session without respawning `agy acp`. Sends RPCs only when the
   * target selector differs from the session's current confirmed value.
   */
  async configureSession(
    sessionId: string,
    options: {
      model?: string;
      effort?: AgyEffort;
      mode?: AgyExecutionMode;
      readOnlyPermissions?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.initialize(signal);

    if (options.model) {
      await this.#applyModelAndEffort(sessionId, options.model, options.effort, signal);
    } else if (options.effort) {
      await this.#applyThoughtLevel(sessionId, options.effort, signal);
    }

    const desiredMode = this.#resolveTargetMode(
      sessionId,
      options.mode,
      options.readOnlyPermissions,
    );
    if (desiredMode) {
      await this.#applyMode(sessionId, desiredMode, signal);
    }
  }

  async prompt(
    sessionId: string,
    blocks: AcpPromptBlock[],
    signal?: AbortSignal,
  ): Promise<AcpPromptResponse> {
    if (signal?.aborted) {
      throw new Error("agy turn was aborted.");
    }
    return this.request<AcpPromptResponse>(
      "session/prompt",
      { sessionId, prompt: blocks },
      { signal },
    );
  }

  cancel(sessionId: string): void {
    if (this.#closed) return;
    this.notify("session/cancel", { sessionId });
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(this.#closeError ?? new Error("ACP connection is closed."));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new Error("agy turn was aborted."));
    }

    const id = this.#nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise<T>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const cleanup = () => {
        if (onAbort && options.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
      };

      const pending: PendingRpc = {
        method,
        resolve: (val) => {
          cleanup();
          resolve(val as T);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };

      if (options.timeoutMs && options.timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(id);
          cleanup();
          reject(new Error(`ACP ${method} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
        pending.timer.unref?.();
      }

      if (options.signal) {
        onAbort = () => {
          const entry = this.#pending.get(id);
          if (!entry) return;
          if (entry.timer) clearTimeout(entry.timer);
          this.#pending.delete(id);
          reject(new Error("agy turn was aborted."));
        };
        // Note: for session/prompt, caller coordinates session/cancel + grace window
        // before rejecting, so only bind immediate rejection on non-prompt RPCs.
        if (method !== "session/prompt") {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      this.#pending.set(id, pending);
      try {
        this.#child.stdin.write(`${payload}\n`);
      } catch (err) {
        if (pending.timer) clearTimeout(pending.timer);
        this.#pending.delete(id);
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.#closed) return;
    try {
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // Ignore write errors during teardown.
    }
  }

  failAll(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeError = error;
    this.#stdoutBuf = "";
    for (const [, pending] of this.#pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #applyModelAndEffort(
    sessionId: string,
    requestedModel: string,
    requestedEffort: AgyEffort | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = this.getSessionState(sessionId);
    const modelSel = findAcpSelectOption(state, "model");
    const split = splitAgyModelEffort(requestedModel, requestedEffort);

    if (modelSel) {
      const available = new Set(flattenSelectValues(modelSel).map((o) => o.value));
      const baseModel = split.baseModel ?? requestedModel;
      const targetModel = available.has(requestedModel)
        ? requestedModel
        : available.has(baseModel)
          ? baseModel
          : requestedModel;

      if (modelSel.currentValue !== targetModel) {
        await this.#setConfigOption(sessionId, modelSel.id, targetModel, signal);
      }

      const effectiveEffort =
        targetModel === baseModel ? (split.effort ?? requestedEffort) : requestedEffort;
      if (effectiveEffort) {
        await this.#applyThoughtLevel(sessionId, effectiveEffort, signal);
      }
      return;
    }

    // Legacy ACP fallback when configOptions lacks a model selector.
    const baseModel = split.baseModel ?? requestedModel;
    const qualifiedModel =
      split.effort && !requestedModel.endsWith(`-${split.effort}`)
        ? `${baseModel}-${split.effort}`
        : requestedModel;
    if (state.models?.currentModelId !== qualifiedModel) {
      await this.request(
        "session/set_model",
        { sessionId, modelId: qualifiedModel },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS, signal },
      );
      if (state.models) {
        this.mergeSessionState(sessionId, {
          models: { ...state.models, currentModelId: qualifiedModel },
        });
      }
    }
  }

  async #applyThoughtLevel(
    sessionId: string,
    effort: AgyEffort,
    signal?: AbortSignal,
  ): Promise<void> {
    const thoughtSel = findAcpSelectOption(this.getSessionState(sessionId), "thought_level");
    if (!thoughtSel) return;
    const supported = flattenSelectValues(thoughtSel).some((o) => o.value === effort);
    if (!supported || thoughtSel.currentValue === effort) return;
    await this.#setConfigOption(sessionId, thoughtSel.id, effort, signal);
  }

  #resolveTargetMode(
    sessionId: string,
    requestedMode: AgyExecutionMode | undefined,
    readOnlyPermissions: boolean | undefined,
  ): string | undefined {
    const state = this.getSessionState(sessionId);
    const modeSel = findAcpSelectOption(state, "mode");
    const availableIds = modeSel
      ? flattenSelectValues(modeSel).map((o) => o.value)
      : (state.modes?.availableModes.map((m) => m.id) ?? []);

    if (readOnlyPermissions) {
      if (availableIds.includes("plan")) return "plan";
      if (availableIds.includes("default")) return "default";
      return undefined;
    }
    const candidate = requestedMode ?? "default";
    if (availableIds.length === 0 || availableIds.includes(candidate)) {
      return candidate;
    }
    return undefined;
  }

  async #applyMode(
    sessionId: string,
    modeId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = this.getSessionState(sessionId);
    const modeSel = findAcpSelectOption(state, "mode");
    if (modeSel) {
      if (modeSel.currentValue === modeId) return;
      await this.#setConfigOption(sessionId, modeSel.id, modeId, signal);
      return;
    }
    if (state.modes && state.modes.currentModeId !== modeId) {
      await this.request(
        "session/set_mode",
        { sessionId, modeId },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS, signal },
      );
      this.mergeSessionState(sessionId, {
        modes: { ...state.modes, currentModeId: modeId },
      });
    }
  }

  async #setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<AcpSessionState> {
    const raw = await this.request<Record<string, unknown>>(
      "session/set_config_option",
      { sessionId, configId, value },
      { timeoutMs: DEFAULT_RPC_TIMEOUT_MS, signal },
    );
    return this.mergeSessionState(sessionId, decodeAcpSessionState(raw));
  }

  #onStdoutData(chunk: string): void {
    if (this.#closed) return;
    this.#stdoutBuf += chunk;
    for (;;) {
      const nl = this.#stdoutBuf.indexOf("\n");
      if (nl < 0) {
        if (Buffer.byteLength(this.#stdoutBuf, "utf8") > DEFAULT_STDIO_MAX_LINE_BYTES) {
          const err = new Error("ACP stdout frame exceeded 8 MiB limit.");
          this.failAll(err);
          this.#handlers.onTransportError?.(err);
        }
        return;
      }
      const rawLine = this.#stdoutBuf.slice(0, nl).replace(/\r$/, "");
      this.#stdoutBuf = this.#stdoutBuf.slice(nl + 1);
      if (Buffer.byteLength(rawLine, "utf8") > DEFAULT_STDIO_MAX_LINE_BYTES) {
        const err = new Error("ACP stdout frame exceeded 8 MiB limit.");
        this.failAll(err);
        this.#handlers.onTransportError?.(err);
        return;
      }
      this.#handleLine(rawLine);
      if (this.#closed) return;
    }
  }

  #handleLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    // Filter stray non-JSON stdout noise (e.g. browser-launch messages during OAuth).
    if (!trimmed.startsWith("{")) {
      this.#ignoredNoiseLines += 1;
      this.#handlers.onProtocolWarning?.(trimmed);
      return;
    }

    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected JSON-RPC object");
      }
      msg = parsed as Record<string, unknown>;
    } catch (cause) {
      const err = new Error(
        `Invalid JSON-RPC frame from agy acp: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      this.failAll(err);
      this.#handlers.onTransportError?.(err);
      return;
    }

    const hasId = "id" in msg && msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === "string" ? msg.method : undefined;

    if (hasId && method) {
      // Server-to-client JSON-RPC request (e.g. session/request_permission).
      void this.#handleInboundRequest(msg.id as string | number, method, msg.params);
      return;
    }

    if (!hasId && method) {
      // Server-to-client JSON-RPC notification (e.g. session/update).
      if (method === "session/update") {
        const params = asRecord(msg.params);
        const update = asRecord(params?.update);
        if (
          params &&
          typeof params.sessionId === "string" &&
          update &&
          typeof update.sessionUpdate === "string"
        ) {
          this.#handlers.onUpdate?.({
            sessionId: params.sessionId,
            update: update as Record<string, unknown> & { sessionUpdate: string },
          });
        }
      }
      return;
    }

    if (hasId && typeof msg.id === "number") {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.#pending.delete(msg.id);

      const rpcErr = asRecord(msg.error);
      if (rpcErr) {
        const code = typeof rpcErr.code === "number" ? rpcErr.code : -32603;
        const errMsg = typeof rpcErr.message === "string" ? rpcErr.message : "ACP RPC error";
        pending.reject(new AgyAcpRpcError(pending.method, code, errMsg, rpcErr.data));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  async #handleInboundRequest(
    id: string | number,
    method: string,
    rawParams: unknown,
  ): Promise<void> {
    if (method === "session/request_permission") {
      const params = (asRecord(rawParams) ?? {}) as unknown as AcpPermissionRequest;
      try {
        const result = this.#handlers.onPermission
          ? await this.#handlers.onPermission(params)
          : selectAcpPermissionOutcome(params, false);
        this.#sendReply(id, { result });
      } catch {
        this.#sendReply(id, { result: { outcome: { outcome: "cancelled" } } });
      }
      return;
    }
    this.#sendReply(id, {
      error: { code: -32601, message: `Unsupported client method: ${method}` },
    });
  }

  #sendReply(
    id: string | number,
    body: { result: unknown } | { error: { code: number; message: string } },
  ): void {
    if (this.#closed) return;
    try {
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
    } catch {
      // Ignore write failures during shutdown.
    }
  }

  async #withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw new Error("agy turn was aborted.");
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Error("agy turn was aborted."));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (val) => {
          signal.removeEventListener("abort", onAbort);
          resolve(val);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }
}
