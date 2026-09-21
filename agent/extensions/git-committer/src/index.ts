/**
 * git-committer — /git-committer popup for staging, AI-generated commit
 * messages, committing and pushing.
 *
 * Two-column overlay (~30% actions | ~70% files + commit input):
 *   s Stage  u Unstage  g Generate  c Commit  P Push  Tab Switch  Enter Run  Esc Close
 * Space toggles staging of the selected file in the files pane.
 * Shortcut: ctrl+shift+g
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  Loader,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";

// ── Git helpers ──

interface FileItem {
  path: string;
  stagedStatus: string;
  unstagedStatus: string;
}

interface GitFiles {
  staged: FileItem[];
  unstaged: FileItem[];
  untracked: FileItem[];
}

/** Parse `git status --porcelain` lines into staged/unstaged/untracked groups. */
export function parseStatus(out: string): GitFiles {
  const files: GitFiles = { staged: [], unstaged: [], untracked: [] };
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const stagedStatus = line[0]!;
    const unstagedStatus = line[1]!;
    const raw = line.slice(3);
    // Renames arrive as "old -> new"; the new path is the one add/reset accept.
    const path = raw.includes(" -> ") ? raw.split(" -> ").pop()! : raw;
    const item: FileItem = { path, stagedStatus, unstagedStatus };
    if (stagedStatus === "?") {
      files.untracked.push(item);
      continue;
    }
    if (stagedStatus !== " ") files.staged.push(item);
    if (unstagedStatus !== " ") files.unstaged.push(item);
  }
  return files;
}

export async function getStatus(pi: ExtensionAPI): Promise<GitFiles> {
  const r = await pi.exec("git", ["status", "--porcelain"]);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || "git status failed");
  return parseStatus(r.stdout);
}

/** Context for AI message generation: staged diff, else unstaged diff, plus status. */
const MAX_DIFF = 12000;

export async function getDiffForPrompt(pi: ExtensionAPI): Promise<string> {
  let diff = (await pi.exec("git", ["diff", "--cached"])).stdout;
  if (!diff.trim()) diff = (await pi.exec("git", ["diff"])).stdout;
  if (diff.length > MAX_DIFF) diff = `${diff.slice(0, MAX_DIFF)}\n... (truncated)`;
  const status = (await pi.exec("git", ["status", "--porcelain"])).stdout;
  return `git status:\n${status || "(clean)"}\n\ngit diff:\n${diff || "(empty)"}`;
}

// ── Constants ──

const GEN_PROMPT =
  "You are a commit message generator. Generate a conventional commit message (type: subject) with optional body. " +
  "Use diff and status provided. Return ONLY the commit message, no explanation.";

const ACTIONS: { label: string; description: string }[] = [
  { label: "Stage all", description: "git add -A" },
  { label: "Unstage all", description: "git reset" },
  { label: "Generate commit message", description: "write a commit message from the diff" },
  { label: "Commit", description: "commit staged changes" },
  { label: "Commit & Push", description: "commit staged changes, then git push" },
];

const FOOTER =
  "s Stage  u Unstage  g Generate  c Commit  P Push  Tab Switch  Enter Run  Esc Close";

type Pane = "actions" | "files" | "input";
type CommitterResult = { committed: string; pushed: boolean } | null;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Overlay component ──

class GitCommitterPopup implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: (result: CommitterResult) => void;
  private readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionContext;
  private readonly input = new Input();
  private readonly loader: Loader;
  private files: GitFiles;
  private selectedAction = 0;
  private selectedFile = 0;
  private focusedPane: Pane = "actions";
  private busy = false;
  private generating = false;
  private genAbort: AbortController | null = null;
  private _focused = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: CommitterResult) => void,
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    initialFiles: GitFiles,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.pi = pi;
    this.ctx = ctx;
    this.files = initialFiles;
    this.loader = new Loader(
      tui,
      (s) => theme.fg("accent", s),
      (s) => theme.fg("muted", s),
      "",
    );
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.focusedPane === "input";
  }

  invalidate(): void {
    this.input.invalidate();
    this.tui.requestRender();
  }

  dispose(): void {
    this.loader.stop();
    this.genAbort?.abort();
  }

  // ── Input handling ──

  handleInput(data: string): void {
    const kb = this.keybindings;
    if (this.generating) {
      if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) {
        this.genAbort?.abort();
      }
      return;
    }
    if (this.busy) return;

    if (this.focusedPane === "input") {
      if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.tab)) {
        this.setFocusedPane("actions");
        return;
      }
      if (matchesKey(data, Key.ctrl("enter")) || kb.matches(data, "tui.select.confirm")) {
        void this.commitAndMaybePush(false);
        return;
      }
      const before = this.input.getValue();
      this.input.handleInput(data);
      if (this.input.getValue() !== before) this.invalidate();
      return;
    }

    if (this.focusedPane === "actions") {
      if (kb.matches(data, "tui.select.up")) {
        this.selectedAction = (this.selectedAction - 1 + ACTIONS.length) % ACTIONS.length;
        this.invalidate();
        return;
      }
      if (kb.matches(data, "tui.select.down")) {
        this.selectedAction = (this.selectedAction + 1) % ACTIONS.length;
        this.invalidate();
        return;
      }
      if (matchesKey(data, Key.tab)) {
        this.setFocusedPane("files");
        return;
      }
      if (kb.matches(data, "tui.select.cancel")) {
        this.done(null);
        return;
      }
      if (kb.matches(data, "tui.select.confirm")) {
        this.runSelectedAction();
        return;
      }
      if (data === "s") {
        void this.stageAll();
        return;
      }
      if (data === "u") {
        void this.unstageAll();
        return;
      }
      if (data === "g") {
        void this.generate();
        return;
      }
      if (data === "c") {
        void this.commitAndMaybePush(false);
        return;
      }
      if (data === "P") {
        void this.commitAndMaybePush(true);
        return;
      }
      return;
    }

    // files pane
    if (matchesKey(data, Key.tab)) {
      this.setFocusedPane("input");
      return;
    }
    if (kb.matches(data, "tui.select.cancel")) {
      this.done(null);
      return;
    }
    const count = this.flatFiles().length;
    if (count === 0) return;
    if (kb.matches(data, "tui.select.up")) {
      this.selectedFile = (this.selectedFile - 1 + count) % count;
      this.invalidate();
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.selectedFile = (this.selectedFile + 1) % count;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.space) || kb.matches(data, "tui.select.confirm")) {
      void this.toggleStage();
      return;
    }
  }

  private setFocusedPane(pane: Pane): void {
    this.focusedPane = pane;
    this.input.focused = this._focused && pane === "input";
    this.invalidate();
  }

  private runSelectedAction(): void {
    switch (this.selectedAction) {
      case 0:
        void this.stageAll();
        break;
      case 1:
        void this.unstageAll();
        break;
      case 2:
        void this.generate();
        break;
      case 3:
        void this.commitAndMaybePush(false);
        break;
      case 4:
        void this.commitAndMaybePush(true);
        break;
    }
  }

  // ── Actions ──

  /** Run a git mutation with loader feedback, then refresh status. */
  private async run(message: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy || this.generating) return;
    this.busy = true;
    this.loader.setMessage(message);
    this.loader.start();
    this.invalidate();
    try {
      await fn();
    } catch (err) {
      this.ctx.ui.notify(errorMessage(err), "error");
    } finally {
      this.busy = false;
      this.loader.stop();
      this.invalidate();
    }
  }

  private async refresh(): Promise<void> {
    this.files = await getStatus(this.pi);
    const count = this.flatFiles().length;
    if (this.selectedFile >= count) this.selectedFile = Math.max(0, count - 1);
  }

  private async stageAll(): Promise<void> {
    await this.run("Staging all changes...", async () => {
      const r = await this.pi.exec("git", ["add", "-A"]);
      if (r.code !== 0) this.ctx.ui.notify(r.stderr || r.stdout, "error");
      await this.refresh();
    });
  }

  private async unstageAll(): Promise<void> {
    await this.run("Unstaging all changes...", async () => {
      const r = await this.pi.exec("git", ["reset"]);
      if (r.code !== 0) this.ctx.ui.notify(r.stderr || r.stdout, "error");
      await this.refresh();
    });
  }

  private async toggleStage(): Promise<void> {
    const file = this.flatFiles()[this.selectedFile];
    if (!file) return;
    const isStaged = file.stagedStatus !== " " && file.stagedStatus !== "?";
    await this.run(`${isStaged ? "Unstaging" : "Staging"} ${file.path}...`, async () => {
      const r = isStaged
        ? await this.pi.exec("git", ["reset", "--", file.path])
        : await this.pi.exec("git", ["add", "--", file.path]);
      if (r.code !== 0) this.ctx.ui.notify(r.stderr || r.stdout, "error");
      await this.refresh();
    });
  }

  private async commitAndMaybePush(push: boolean): Promise<void> {
    const message = this.input.getValue();
    if (!message.trim()) {
      this.ctx.ui.notify("Commit message is empty", "warning");
      this.setFocusedPane("input");
      return;
    }
    if (this.files.staged.length === 0) {
      this.ctx.ui.notify("No staged files to commit", "warning");
      return;
    }
    await this.run(push ? "Committing & pushing..." : "Committing...", async () => {
      const c = await this.pi.exec("git", ["commit", "-m", message]);
      if (c.code !== 0) {
        this.ctx.ui.notify(c.stderr || c.stdout, "error");
        return;
      }
      let pushed = false;
      if (push) {
        const p = await this.pi.exec("git", ["push"]);
        if (p.code !== 0) this.ctx.ui.notify(p.stderr || p.stdout, "error");
        else pushed = true;
      }
      this.done({ committed: message.trim(), pushed });
    });
  }

  private async generate(): Promise<void> {
    if (this.generating || this.busy) return;
    const model = this.ctx.model;
    if (!model) {
      this.ctx.ui.notify("No model selected", "error");
      return;
    }
    this.generating = true;
    this.genAbort = new AbortController();
    this.loader.setMessage(`Generating commit message with ${model.id}...`);
    this.loader.start();
    this.invalidate();
    try {
      const diffContext = await getDiffForPrompt(this.pi);
      const response = await this.ctx.modelRegistry.complete(
        model,
        {
          systemPrompt: GEN_PROMPT,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: diffContext }],
              timestamp: Date.now(),
            },
          ],
        },
        { signal: this.genAbort.signal },
      );
      if (response.stopReason === "aborted") return;
      const text = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
      if (text) {
        this.input.setValue(text);
        this.setFocusedPane("input");
      } else {
        this.ctx.ui.notify("Model returned an empty commit message", "warning");
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) {
        this.ctx.ui.notify(errorMessage(err), "error");
      }
    } finally {
      this.generating = false;
      this.genAbort = null;
      this.loader.stop();
      this.invalidate();
    }
  }

  // ── Rendering ──

  private flatFiles(): FileItem[] {
    return [...this.files.staged, ...this.files.unstaged, ...this.files.untracked];
  }

  render(width: number): string[] {
    const T = this.theme;
    const safeWidth = Math.max(24, width);
    const innerW = safeWidth - 2;
    const leftW = Math.max(18, Math.min(28, Math.floor(safeWidth * 0.30)));
    const rightW = Math.max(20, innerW - leftW - 1);

    // Overlay is capped at 75% of terminal height; mirror that budget here
    // so the footer is never sliced off.
    const totalH = Math.max(14, Math.floor(this.tui.terminal.rows * 0.75));
    const chrome = 5; // top border, title, separator, footer, bottom border
    const bodyH = Math.max(7, totalH - chrome);
    const fileRows = Math.min(Math.max(3, Math.floor(bodyH * 0.70)), bodyH - 2);

    const row = (content: string): string => {
      const vw = visibleWidth(content);
      const padded = vw < innerW ? content + " ".repeat(innerW - vw) : truncateToWidth(content, innerW);
      return T.fg("dim", "│") + padded + T.fg("dim", "│");
    };
    const fit = (content: string, w: number): string => {
      const vw = visibleWidth(content);
      return vw < w ? content + " ".repeat(w - vw) : truncateToWidth(content, w);
    };

    const lines: string[] = [];
    lines.push(T.fg("dim", "┌" + "─".repeat(innerW) + "┐"));

    const title = T.fg("accent", T.bold(" Git Committer"));
    const counts = T.fg(
      "dim",
      `${this.files.staged.length} staged · ${this.files.unstaged.length + this.files.untracked.length} unstaged `,
    );
    const countsVw = visibleWidth(counts);
    const titleGap = Math.max(1, innerW - visibleWidth(title) - countsVw);
    lines.push(row(title + " ".repeat(titleGap) + counts));

    lines.push(T.fg("dim", "├" + "─".repeat(innerW) + "┤"));

    const leftLines = this.renderActions(leftW);
    const rightLines = this.renderRight(rightW, bodyH, fileRows);
    for (let i = 0; i < bodyH; i++) {
      const left = fit(leftLines[i] ?? "", leftW);
      const right = fit(rightLines[i] ?? "", rightW);
      lines.push(T.fg("dim", "│") + left + T.fg("dim", "│") + right + T.fg("dim", "│"));
    }

    lines.push(row(" " + T.fg("dim", FOOTER)));
    lines.push(T.fg("dim", "└" + "─".repeat(innerW) + "┘"));
    return lines.map((l) => truncateToWidth(l, safeWidth));
  }

  private renderActions(width: number): string[] {
    const T = this.theme;
    const lines: string[] = [];
    lines.push(" " + (this.focusedPane === "actions"
      ? T.fg("accent", T.bold("Actions"))
      : T.fg("muted", "Actions")));
    for (let i = 0; i < ACTIONS.length; i++) {
      const selected = this.focusedPane === "actions" && i === this.selectedAction;
      const prefix = selected ? "> " : "  ";
      const label = selected ? T.fg("accent", ACTIONS[i]!.label) : T.fg("dim", ACTIONS[i]!.label);
      lines.push(prefix + label);
    }
    if (this.focusedPane === "actions") {
      lines.push(" " + T.fg("dim", ACTIONS[this.selectedAction]!.description));
    }
    return lines.map((l) => truncateToWidth(l, width));
  }

  private renderRight(width: number, bodyH: number, fileRows: number): string[] {
    const T = this.theme;
    const lines: string[] = [];
    lines.push(" " + (this.focusedPane === "files"
      ? T.fg("accent", T.bold("Changes"))
      : T.fg("muted", "Changes")));

    // Grouped file list with a scroll window anchored on the selection.
    const display: string[] = [];
    const fileLines: number[] = [];
    const flat = this.flatFiles();
    const groups: [string, FileItem[], "success" | "warning" | "dim"][] = [
      ["Staged", this.files.staged, "success"],
      ["Unstaged", this.files.unstaged, "warning"],
      ["Untracked", this.files.untracked, "dim"],
    ];
    for (const [name, items, color] of groups) {
      if (items.length === 0) continue;
      display.push(T.fg("muted", `${name} (${items.length})`));
      for (const file of items) {
        fileLines.push(display.length);
        const selected = this.focusedPane === "files" && fileLines.length - 1 === this.selectedFile;
        const text = `${selected ? "> " : "  "}${file.stagedStatus}${file.unstagedStatus} ${file.path}`;
        display.push(selected ? T.fg("accent", text) : T.fg(color, text));
      }
    }
    if (flat.length === 0) display.push(T.fg("dim", "  (no changes)"));

    const listH = Math.max(1, fileRows - 1); // one line is the header
    const selLine = fileLines[Math.min(this.selectedFile, flat.length - 1)] ?? 0;
    const maxStart = Math.max(0, display.length - listH);
    const start = Math.max(0, Math.min(selLine - Math.floor(listH / 2), maxStart));
    for (const line of display.slice(start, start + listH)) lines.push(line);
    while (lines.length < fileRows) lines.push("");

    // Commit input area (~30% of the right column).
    const label = this.focusedPane === "input" ? " Commit message " : " Commit message ";
    const labelVw = visibleWidth(label);
    const rule = T.fg("dim", "─".repeat(Math.max(1, width - labelVw - 2)));
    lines.push(" " + (this.focusedPane === "input"
      ? T.fg("accent", label) + rule
      : T.fg("dim", label) + rule));

    if (this.busy || this.generating) {
      for (const line of this.loader.render(Math.max(10, width - 2))) lines.push(" " + line);
    } else {
      let inputLine = this.input.render(Math.max(10, width - 2))[0] ?? "";
      if (this.input.getValue() === "") inputLine += T.fg("muted", "Commit message...");
      lines.push(" " + inputLine);
    }
    return lines.map((l) => truncateToWidth(l, width));
  }
}

// ── Entry ──

async function openCommitter(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("git-committer requires TUI", "warning");
    return;
  }
  const probe = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
  if (probe.code !== 0 || probe.stdout.trim() !== "true") {
    ctx.ui.notify("git-committer: not inside a git work tree", "error");
    return;
  }
  let files: GitFiles;
  try {
    files = await getStatus(pi);
  } catch (err) {
    ctx.ui.notify(errorMessage(err), "error");
    return;
  }
  const result = await ctx.ui.custom<CommitterResult>(
    (tui, theme, keybindings, done) =>
      new GitCommitterPopup(tui, theme, keybindings, done, pi, ctx, files),
    { overlay: true, overlayOptions: { width: "80%", maxHeight: "75%", anchor: "center" } },
  );
  if (!result) return;
  const subject = result.committed.split("\n")[0] ?? result.committed;
  ctx.ui.notify(
    result.pushed ? `Committed & pushed: ${subject}` : `Committed: ${subject}`,
    "info",
  );
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("git-committer", {
    description: "Open git committer — stage, generate message, commit & push",
    handler: async (_args, ctx) => openCommitter(pi, ctx),
  });
  pi.registerShortcut("ctrl+shift+g", {
    description: "Open git committer",
    handler: async (ctx) => openCommitter(pi, ctx),
  });
}
