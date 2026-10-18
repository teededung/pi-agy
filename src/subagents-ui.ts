/**
 * /agy-subagents UI — full-screen overlay dashboard over observed and
 * filesystem-synced agy subagents (plus nested Boost workers such as
 * DeepInvestigatorWorkerL0 and DeepCoderWorkerL0), mirroring the /agy-tasks
 * dashboard interaction model: arrow/jk selection, `enter` for a live
 * auto-refreshing transcript progress view, `r` to rescan, `esc` to close
 * (or return from detail view).
 */

import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  formatSubagentElapsed,
  readAgySubagentProgressLog,
  type AgySubagentEntry,
  type AgySubagentStatus,
  type AgySubagentWorkerEntry,
} from "../lib/subagents.ts";

function wrapStyledLines(lines: ReadonlyArray<string>, maxWidth: number): string[] {
  const limit = Math.max(16, maxWidth);
  const out: string[] = [];
  for (const line of lines) {
    if (!line) {
      out.push("");
      continue;
    }
    if (visibleWidth(line) <= limit) {
      out.push(line);
      continue;
    }
    const wrapped = wrapTextWithAnsi(line, limit);
    if (wrapped.length === 0) {
      out.push("");
    } else {
      out.push(...wrapped);
    }
  }
  return out.length > 0 ? out : ["(no output)"];
}

export interface AgySubagentRowItem {
  id: string;
  name: string;
  conversationId?: string;
  status: AgySubagentStatus;
  startedAtMs: number;
  durationSeconds?: number;
  lastActivity?: string;
  lastStepIndex?: number;
  detail?: string;
  error?: string;
  messages?: number;
  isWorker: boolean;
  treePrefix?: string;
  parentName?: string;
  workers?: AgySubagentWorkerEntry[];
}

export function flattenAgySubagentRows(
  entries: ReadonlyArray<AgySubagentEntry>,
): AgySubagentRowItem[] {
  const rows: AgySubagentRowItem[] = [];
  for (const entry of entries) {
    rows.push({
      id: entry.conversationId ?? entry.key,
      name: entry.name,
      conversationId: entry.conversationId,
      status: entry.status,
      startedAtMs: entry.startedAtMs,
      durationSeconds: entry.durationSeconds,
      lastActivity: entry.lastActivity,
      lastStepIndex: entry.lastStepIndex,
      detail: entry.detail,
      error: entry.error,
      messages: entry.messages,
      isWorker: false,
      workers: entry.workers,
    });
    if (entry.workers && entry.workers.length > 0) {
      for (let i = 0; i < entry.workers.length; i++) {
        const w = entry.workers[i]!;
        const isLast = i === entry.workers.length - 1;
        rows.push({
          id: `${entry.conversationId ?? entry.key}/${w.conversationId}`,
          name: w.name,
          conversationId: w.conversationId,
          status: w.status,
          startedAtMs: w.startedAtMs,
          durationSeconds: w.durationSeconds,
          lastActivity: w.lastActivity,
          lastStepIndex: w.lastStepIndex,
          isWorker: true,
          treePrefix: isLast ? "└─" : "├─",
          parentName: entry.name,
        });
      }
    }
  }
  return rows;
}

function statusGlyph(status: AgySubagentStatus, theme: Theme): string {
  switch (status) {
    case "running":
      return theme.fg("warning", "◆");
    case "done":
      return theme.fg("success", "◆");
    case "error":
      return theme.fg("error", "◆");
    case "killed":
      return theme.fg("muted", "◇");
  }
}

function statusWord(status: AgySubagentStatus, theme: Theme): string {
  switch (status) {
    case "running":
      return theme.fg("warning", "running");
    case "done":
      return theme.fg("success", "done");
    case "error":
      return theme.fg("error", "error");
    case "killed":
      return theme.fg("muted", "killed");
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
): string {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

export interface AgySubagentsSelection {
  id?: string;
  index: number;
}

export function reconcileAgySubagentsSelection(
  selection: AgySubagentsSelection,
  rows: ReadonlyArray<Pick<AgySubagentRowItem, "id">>,
): void {
  const stableIndex = selection.id ? rows.findIndex((row) => row.id === selection.id) : -1;
  selection.index =
    stableIndex >= 0
      ? stableIndex
      : Math.min(Math.max(0, selection.index), Math.max(0, rows.length - 1));
  selection.id = rows[selection.index]?.id;
}

export interface AgySubagentsModel {
  getRows(): ReadonlyArray<AgySubagentRowItem>;
  refresh(): Promise<void>;
  readProgress(
    row: AgySubagentRowItem,
    options?: { theme?: Theme; width?: number },
  ): Promise<string[]>;
}

/** Entry point: open the subagents dashboard overlay; resolves when it closes. */
export async function openAgySubagentsPicker(
  ctx: ExtensionCommandContext,
  rescan: () => Promise<ReadonlyArray<AgySubagentEntry>>,
): Promise<void> {
  let rows = flattenAgySubagentRows(await rescan());
  if (rows.length === 0) {
    ctx.ui.notify(
      "No subagent activity observed in this conversation yet. Use /boost to run with subagents.",
      "info",
    );
    return;
  }
  const selection: AgySubagentsSelection = { index: 0 };
  const model: AgySubagentsModel = {
    getRows: () => rows,
    refresh: async () => {
      rows = flattenAgySubagentRows(await rescan());
    },
    readProgress: async (row, options) => {
      return readAgySubagentProgressLog(row, {
        includeWorkers: !row.isWorker,
        theme: options?.theme,
        width: options?.width,
      });
    },
  };
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      new AgySubagentsDashboard(tui, theme, keybindings, model, selection, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}

interface AgySubagentDetailView {
  rowId: string;
  lines: string[];
  renderedLineCount?: number;
  scroll: number;
}

const DETAIL_META_LINES = 3;
const LIVE_REFRESH_MS = 1_000;

export class AgySubagentsDashboard implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private model: AgySubagentsModel;
  private selection: AgySubagentsSelection;
  private done: (value: null) => void;

  private closed = false;
  private busy = false;
  private liveRefreshInFlight = false;
  private detail: AgySubagentDetailView | null = null;
  private liveRefreshTimer: ReturnType<typeof setInterval>;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    model: AgySubagentsModel,
    selection: AgySubagentsSelection,
    done: (value: null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.model = model;
    this.selection = selection;
    this.done = done;
    this.liveRefreshTimer = setInterval(() => void this.refreshLiveData(), LIVE_REFRESH_MS);
    this.liveRefreshTimer.unref?.();
  }

  private stopLiveRefresh(): void {
    clearInterval(this.liveRefreshTimer);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopLiveRefresh();
    this.done(null);
  }

  dispose(): void {
    this.closed = true;
    this.stopLiveRefresh();
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.busy) return;
    const rows = this.model.getRows();
    reconcileAgySubagentsSelection(this.selection, rows);

    if (this.detail) {
      this.handleDetailInput(data);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel") || data === "q") {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (rows.length > 0) {
        this.selection.index = (this.selection.index - 1 + rows.length) % rows.length;
        this.selection.id = rows[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (rows.length > 0) {
        this.selection.index = (this.selection.index + 1) % rows.length;
        this.selection.id = rows[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const row = rows[this.selection.index];
      if (row) void this.openDetail(row);
      return;
    }
    if (data === "r") {
      void this.rescan();
      return;
    }
  }

  private detailViewportHeight(): number {
    const rows = this.tui.terminal.rows || 30;
    return Math.max(1, Math.max(6, rows - 5) - DETAIL_META_LINES);
  }

  private detailContentWidth(): number {
    const cols = this.tui.terminal.columns || 100;
    return Math.max(16, cols - 4);
  }

  private handleDetailInput(data: string): void {
    const detail = this.detail;
    if (!detail) return;
    if (this.keybindings.matches(data, "tui.select.cancel") || data === "q") {
      this.detail = null;
      this.tui.requestRender();
      return;
    }
    const viewport = this.detailViewportHeight();
    const totalLines = detail.renderedLineCount ?? detail.lines.length;
    const maxScroll = Math.max(0, totalLines - viewport);
    const scrollTo = (value: number) => {
      detail.scroll = Math.min(Math.max(0, value), maxScroll);
      this.tui.requestRender();
    };
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      scrollTo(detail.scroll - 1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      scrollTo(detail.scroll + 1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      scrollTo(detail.scroll - viewport);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      scrollTo(detail.scroll + viewport);
      return;
    }
    if (data === "g") {
      scrollTo(0);
      return;
    }
    if (data === "G") {
      scrollTo(Number.MAX_SAFE_INTEGER);
      return;
    }
    if (data === "r") {
      void this.reloadDetail();
      return;
    }
  }

  private async refreshLiveData(): Promise<void> {
    if (this.closed || this.busy || this.liveRefreshInFlight) return;
    this.liveRefreshInFlight = true;
    try {
      const detail = this.detail;
      const oldTotal = detail ? (detail.renderedLineCount ?? detail.lines.length) : 0;
      const oldMaxScroll = detail ? Math.max(0, oldTotal - this.detailViewportHeight()) : 0;
      const wasAtEnd = detail ? detail.scroll >= oldMaxScroll : false;
      await this.model.refresh();
      if (detail) {
        const row = this.model.getRows().find((entry) => entry.id === detail.rowId);
        if (row) {
          detail.lines = await this.model.readProgress(row, {
            theme: this.theme,
            width: this.detailContentWidth(),
          });
          if (wasAtEnd) detail.scroll = Number.MAX_SAFE_INTEGER;
        } else {
          this.detail = null;
        }
      }
    } catch {
      // Keep last snapshot on transient read failure
    } finally {
      this.liveRefreshInFlight = false;
      if (!this.closed) this.tui.requestRender();
    }
  }

  private async openDetail(row: AgySubagentRowItem): Promise<void> {
    this.busy = true;
    this.tui.requestRender();
    try {
      const lines = await this.model.readProgress(row, {
        theme: this.theme,
        width: this.detailContentWidth(),
      });
      this.detail = {
        rowId: row.id,
        lines,
        // Start scrolled to the latest progress so running/long transcripts show live tail immediately
        scroll: Number.MAX_SAFE_INTEGER,
      };
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  private async reloadDetail(): Promise<void> {
    const detail = this.detail;
    if (!detail || this.liveRefreshInFlight) return;
    this.busy = true;
    try {
      await this.model.refresh();
      const row = this.model.getRows().find((entry) => entry.id === detail.rowId);
      if (row) {
        detail.lines = await this.model.readProgress(row, {
          theme: this.theme,
          width: this.detailContentWidth(),
        });
      } else {
        this.detail = null;
      }
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  private async rescan(): Promise<void> {
    if (this.liveRefreshInFlight) return;
    this.busy = true;
    try {
      await this.model.refresh();
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  private pad(text: string, width: number): string {
    const truncated = truncateToWidth(text, width);
    return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  }

  private borderSegment(width: number, title: string): string {
    const theme = this.theme;
    const label = title ? ` ${truncateToWidth(title, Math.max(0, width - 3))} ` : "";
    const labelWidth = visibleWidth(label);
    return (
      theme.fg("border", "─") +
      (label ? theme.fg("text", label) : "") +
      theme.fg("border", "─".repeat(Math.max(0, width - 1 - labelWidth)))
    );
  }

  render(width: number): string[] {
    const theme = this.theme;
    const rows = this.model.getRows();
    reconcileAgySubagentsSelection(this.selection, rows);

    const detailRow = this.detail
      ? rows.find((row) => row.id === this.detail?.rowId)
      : undefined;
    if (this.detail && !detailRow) this.detail = null;

    const termRows = this.tui.terminal.rows || 30;
    const bodyHeight = Math.max(6, termRows - 5);
    const innerWidth = Math.max(0, width - 2);

    const lines: string[] = [];

    const topLevel = rows.filter((r) => !r.isWorker);
    const runningTop = topLevel.filter((r) => r.status === "running").length;
    const runningWorkers = rows.filter((r) => r.isWorker && r.status === "running").length;
    const headerLeft = theme.fg("accent", theme.bold("agy subagents"));
    const headerRight = theme.fg(
      "muted",
      `${runningTop} running / ${topLevel.length} subagents${runningWorkers > 0 ? ` (${runningWorkers} active worker${runningWorkers === 1 ? "" : "s"})` : ""}`,
    );
    const headerPad = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4);
    lines.push(truncateToWidth(`  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `, width));

    const shortCid = detailRow?.conversationId ? ` (${detailRow.conversationId.slice(0, 8)})` : "";
    lines.push(
      truncateToWidth(
        theme.fg("border", "╭") +
          this.borderSegment(
            innerWidth,
            this.busy
              ? "working…"
              : detailRow
                ? `${detailRow.name}${shortCid} · ${detailRow.status}`
                : "subagents & workers",
          ) +
          theme.fg("border", "╮"),
        width,
      ),
    );

    const divider = theme.fg("border", "│");
    const rowLines =
      this.detail && detailRow
        ? this.renderDetail(detailRow, this.detail, innerWidth, bodyHeight)
        : this.renderRows(rows, innerWidth, bodyHeight);
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(
        truncateToWidth(divider + this.pad(rowLines[i] ?? "", innerWidth) + divider, width),
      );
    }

    lines.push(
      truncateToWidth(
        theme.fg("border", "╰") +
          theme.fg("border", "─".repeat(Math.max(0, innerWidth))) +
          theme.fg("border", "╯"),
        width,
      ),
    );

    const up = configuredKeys(this.keybindings, "tui.select.up");
    const down = configuredKeys(this.keybindings, "tui.select.down");
    const cancel = configuredKeys(this.keybindings, "tui.select.cancel");
    const hints = this.detail
      ? `  ${up}/${down}/jk scroll · g/G top/end (follow live) · r reload · ${cancel} back`
      : `  ${up}/${down}/jk select · ${configuredKeys(this.keybindings, "tui.select.confirm")} live progress · r rescan · ${cancel} close`;
    lines.push(truncateToWidth(theme.fg("dim", hints), width));

    return lines;
  }

  private renderDetail(
    row: AgySubagentRowItem,
    detail: AgySubagentDetailView,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const dot = theme.fg("dim", " · ");
    const now = Date.now();
    const elapsed =
      row.status === "running"
        ? Math.max(0, (now - row.startedAtMs) / 1000)
        : (row.durationSeconds ?? Math.max(0, (now - row.startedAtMs) / 1000));

    const wrappedLines = wrapStyledLines(detail.lines, Math.max(16, width - 2));
    detail.renderedLineCount = wrappedLines.length;

    const viewport = Math.max(1, height - DETAIL_META_LINES);
    const maxScroll = Math.max(0, wrappedLines.length - viewport);
    detail.scroll = Math.min(Math.max(0, detail.scroll), maxScroll);
    const end = Math.min(detail.scroll + viewport, wrappedLines.length);
    const visible = wrappedLines.slice(detail.scroll, end);
    const isFollowing = detail.scroll >= maxScroll;

    const posLabel =
      wrappedLines.length > viewport
        ? ` ${detail.scroll + 1}–${end}/${wrappedLines.length}${isFollowing && row.status === "running" ? " · live (following)" : ""} `
        : row.status === "running"
          ? " live (following) "
          : "";
    const position = posLabel ? theme.fg("text", posLabel) : "";
    const separator =
      theme.fg("border", "─") +
      position +
      theme.fg("border", "─".repeat(Math.max(0, width - 1 - visibleWidth(position))));

    const activityText = row.lastActivity ? oneLine(row.lastActivity) : "waiting…";
    const cidLabel = row.conversationId ?? "pending";
    const parentInfo = row.parentName ? `worker of ${row.parentName} · ` : "";

    const out = [
      ` ${statusWord(row.status, theme)}${dot}${theme.fg("muted", formatSubagentElapsed(elapsed))}${dot}${theme.fg("accent", activityText)}`,
      ` ${theme.fg("dim", `${parentInfo}cid: ${cidLabel}`)}`,
      separator,
    ];
    for (const line of visible) out.push(` ${line}`);
    return out;
  }

  private renderRows(
    rows: ReadonlyArray<AgySubagentRowItem>,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const out: string[] = [];
    const now = Date.now();

    let start = 0;
    if (rows.length > height) {
      start = Math.min(
        Math.max(0, this.selection.index - Math.floor(height / 2)),
        rows.length - height,
      );
    }
    const visible = rows.slice(start, start + height);

    for (let i = 0; i < visible.length; i++) {
      const row = visible[i]!;
      const index = start + i;
      const isSelected = index === this.selection.index;

      const marker = isSelected ? theme.fg("accent", "❯") : " ";
      const indent = row.isWorker ? theme.fg("dim", `  ${row.treePrefix ?? "└─"} `) : "";
      const titleText = oneLine(row.name);
      const title = isSelected ? theme.fg("accent", titleText) : theme.fg("text", titleText);
      const shortId = row.conversationId ? theme.fg("dim", ` (${row.conversationId.slice(0, 8)})`) : "";
      const activity = row.lastActivity
        ? theme.fg("muted", ` · ${oneLine(row.lastActivity)}`)
        : row.detail
          ? theme.fg("dim", ` · "${oneLine(row.detail)}"`)
          : "";

      const left = ` ${marker} ${indent}${statusGlyph(row.status, theme)} ${title}${shortId}${activity}`;

      const elapsed =
        row.status === "running"
          ? Math.max(0, (now - row.startedAtMs) / 1000)
          : (row.durationSeconds ?? Math.max(0, (now - row.startedAtMs) / 1000));
      const dot = theme.fg("dim", " · ");
      const rightParts = [
        theme.fg("muted", formatSubagentElapsed(elapsed)),
        statusWord(row.status, theme),
      ];
      const right = `${rightParts.join(dot)} `;

      const rightWidth = visibleWidth(right);
      const leftMax = Math.max(0, width - rightWidth - 2);
      out.push(
        truncateToWidth(left, leftMax) +
          " ".repeat(
            Math.max(1, width - visibleWidth(truncateToWidth(left, leftMax)) - rightWidth),
          ) +
          right,
      );
    }
    return out;
  }
}
