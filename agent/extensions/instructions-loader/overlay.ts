/**
 * overlay.ts — simple single-pane TUI overlay listing all instructions with
 * origin, effective state, session override, and shadowed badges.
 *
 * Rows are re-read via getRows() on every render, so index.ts doesn't need
 * refresh plumbing: mutate state, requestRender, the view is current.
 */

import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { InstructionRow, SessionOverride } from "./core.js";

export interface Theme {
  accent(t: string): string;
  dim(t: string): string;
  muted(t: string): string;
  on(t: string): string;
  off(t: string): string;
  bold(t: string): string;
}

/** Adapt pi's theme. Same approach as skill-gate's makeTheme. */
export function makeTheme(t: any): Theme {
  return {
    accent: (s) => t.fg("accent", s),
    dim: (s) => t.fg("dim", s),
    muted: (s) => t.fg("muted", s),
    on: (s) => t.fg("success", s),
    off: (s) => t.fg("error", s),
    bold: t.bold ? (s) => t.bold(s) : (s) => s,
  };
}

export interface OverlayCallbacks {
  onClose(): void;
  onToggle(row: InstructionRow): void;
  onCycleSession(row: InstructionRow): void;
}

const NAME_CAP = 28;

const HELP_LINES = [
  ["↑ ↓ / k j", "Move between instructions"],
  ["space", "Toggle enable/disable (persisted in the file's own scope)"],
  ["s", "Cycle session override: unset → on → off (this conversation only)"],
  ["?", "Toggle this help"],
  ["esc", "Close"],
];

export class InstructionsOverlay {
  private sel = 0;
  private scroll = 0;
  private showHelp = false;

  constructor(
    private getRows: () => InstructionRow[],
    private getSession: (row: InstructionRow) => SessionOverride,
    private getTerminalRows: () => number,
    private T: Theme,
    private cb: OverlayCallbacks,
  ) {}

  handleInput(data: string): void {
    const rows = this.getRows();
    if (data === "?") {
      this.showHelp = !this.showHelp;
      return;
    }
    if (this.showHelp) {
      // While help is open: esc/q goes back to the list, everything else ignored.
      if (matchesKey(data, Key.escape) || data === "q") this.showHelp = false;
      return;
    }
    if (rows.length === 0) return;
    if (matchesKey(data, Key.up) || data === "k") {
      this.sel = (this.sel - 1 + rows.length) % rows.length;
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.sel = (this.sel + 1) % rows.length;
      return;
    }
    if (matchesKey(data, Key.escape) || data === "q") {
      this.cb.onClose();
      return;
    }
    const row = rows[this.sel];
    if (!row) return;
    if (matchesKey(data, Key.space)) {
      this.cb.onToggle(row);
      return;
    }
    if (data === "s") {
      this.cb.onCycleSession(row);
      return;
    }
  }

  render(width: number): string[] {
    const T = this.T;
    const inner = Math.max(width - 2, 30);
    const lines: string[] = [];

    lines.push(T.dim("┌" + "─".repeat(inner) + "┐"));
    const line = (content: string) => {
      const vw = visibleWidth(content);
      const padded = vw < inner ? content + " ".repeat(inner - vw) : truncateToWidth(content, inner);
      lines.push(T.dim("│") + padded + T.dim("│"));
    };

    if (this.showHelp) {
      line(" " + T.accent(T.bold("Instructions — keybindings")));
      line("");
      for (const [k, d] of HELP_LINES) {
        const pad = " ".repeat(Math.max(1, 12 - visibleWidth(k)));
        line(" " + T.accent(k) + pad + T.muted(d));
      }
      line("");
      line(" " + T.dim("? / esc — back"));
      lines.push(T.dim("└" + "─".repeat(inner) + "┘"));
      return lines;
    }

    const rows = this.getRows();
    const active = rows.filter((r) => {
      const s = this.getSession(r);
      return !r.shadowed && (s === "force-on" || (s === "unset" && r.persistedOn));
    }).length;
    const title = " Instructions" + T.dim(` ── ${active}/${rows.length} active`);
    line(" " + T.accent(T.bold(title)));

    if (rows.length === 0) {
      line("");
      line(" " + T.muted("No instruction files found."));
      line(" " + T.muted("Add *.md files to ~/.pi/agent/instructions/ or .pi/instructions/."));
    } else {
      // Rescan may have shrunk the list below the stored selection.
      if (this.sel >= rows.length) this.sel = rows.length - 1;
      // Clamp selection window to available height: chrome = 4 borders/title + desc(2) + footer(1).
      const maxRows = Math.max(1, Math.floor(this.getTerminalRows() * 0.8) - 8);
      this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.sel - (maxRows - 1))));
      if (this.sel < this.scroll) this.scroll = this.sel;
      if (this.sel > this.scroll + maxRows - 1) this.scroll = this.sel - maxRows + 1;

      const nameW = Math.min(Math.max(...rows.map((r) => r.name.length), 4), NAME_CAP);
      const end = Math.min(this.scroll + maxRows, rows.length);
      for (let i = this.scroll; i < end; i++) {
        const r = rows[i];
        const cur = i === this.sel;
        const arrow = cur ? T.accent("▶ ") : "  ";
        const name = T.bold(r.name) + (r.name.length > nameW ? "" : " ".repeat(nameW - r.name.length));
        const scope = r.scope === "global" ? T.dim("global ") : T.accent("project");
        const session = this.getSession(r);
        const effOn = session === "force-on" || (session === "unset" && r.persistedOn);
        const state = effOn ? T.on("● on ") : T.off("○ off");
        const badges = [
          session !== "unset" ? T.accent(`session:${session === "force-on" ? "on" : "off"}`) : "",
          r.shadowed ? T.dim("shadowed") : "",
        ].filter(Boolean).join(T.dim(" · "));
        line(" " + arrow + name + "  " + scope + "  " + state + (badges ? "  " + T.dim("· ") + badges : ""));
      }

      // Selected row: description preview (up to 2 lines)
      const sel = rows[this.sel];
      const desc = sel.description || "(no description)";
      line("");
      for (const l of wrapTextWithAnsi(desc, inner - 6).slice(0, 2)) {
        line("   " + T.muted(l));
      }
      if (rows.length > maxRows) {
        line(" " + T.dim(`[${this.sel + 1}/${rows.length}]`));
      }
    }

    const footer = " ↑↓ move · space toggle · s session · ? help · esc close";
    line(" " + T.dim(truncateToWidth(footer, inner - 1)));
    lines.push(T.dim("└" + "─".repeat(inner) + "┘"));
    return lines;
  }

  invalidate(): void {
    // No cached render state — nothing to do.
  }
}
