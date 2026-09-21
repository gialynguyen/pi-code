import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { allAgentFiles } from "./agents";
import { atomicWriteFileSync } from "./fsutil";
import { activateProfile, deactivateProfile } from "./activate";
import { hasMainModelModes, MAIN_MODEL_MODES, type MainModelMode } from "./mainModel";
import {
  jsonProfilePath,
  parseJsonProfile,
  piSubagentsProfilesDirectory,
  serializeJsonProfile,
  validateProfile,
} from "./profile";
import { pickModels } from "./picker";
import { loadGlobalState, loadProjectActive, resolveActiveName, resolveActiveScope } from "./state";
import { THINKING_LEVELS, type Profile, type ThinkingLevel } from "./types";

// The profile console manages the pi-subagents JSON store only. Legacy YAML
// profiles stay on disk and remain loadable through `/profiles use <name>`.

type MainModelConfig = string | Partial<Record<MainModelMode, string>>;

interface WizardDraft {
  name: string;
  description?: string;
  subagentsBlock: Record<string, unknown>;
  mainModel?: MainModelConfig;
  mainThinking?: ThinkingLevel;
}

export interface ManagerResult {
  kind: "activate-project" | "activate-global" | "edit" | "delete" | "new" | "off";
  profile?: string;
}

function notify(ctx: { hasUI: boolean; ui: { notify(message: string, level?: "info" | "warning" | "error"): void } }, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(`profiles: ${message}`, level);
}

function listJsonProfiles(agentDir: string): string[] {
  try {
    return readdirSync(piSubagentsProfilesDirectory(agentDir), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

// --- multi-pane console widget -----------------------------------------------

const PROFILE_ACTIONS = ["Activate (project)", "Activate (global)", "Edit", "Delete"] as const;
const GLOBAL_ACTIONS = ["New profile", "Deactivate (off)", "Close"] as const;

class ProfileManager implements Component, Focusable {
  private readonly topBorder: DynamicBorder;
  private readonly bottomBorder: DynamicBorder;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: (result: ManagerResult | null) => void;
  private readonly names: string[];
  private readonly activeName: string | null;
  private focus: "list" | "actions" = "list";
  private listIndex = 0;
  private actionIndex = 0;
  private _focused = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    options: { names: string[]; activeName: string | null },
    done: (result: ManagerResult | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.names = options.names;
    this.activeName = options.activeName;
    this.topBorder = new DynamicBorder((text: string) => theme.fg("accent", text));
    this.bottomBorder = new DynamicBorder((text: string) => theme.fg("accent", text));
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    const lines: string[] = [];
    const append = (line: string): void => {
      lines.push(truncateToWidth(line, safeWidth));
    };
    for (const line of this.topBorder.render(safeWidth)) append(line);
    append(this.theme.bold(this.theme.fg("accent", "Subagent profiles (pi-subagents JSON)")));

    const left = this.renderProfiles();
    const right = this.renderActions();
    const columnWidth = Math.max(10, Math.floor(safeWidth / 2) - 2);
    const rowCount = Math.max(left.length, right.length);
    for (let index = 0; index < rowCount; index += 1) {
      const leftLine = (left[index] ?? "").padEnd(columnWidth, " ");
      const rightLine = right[index] ?? "";
      append(this.padVisible(leftLine, columnWidth) + rightLine);
    }
    append(this.theme.fg("dim", "up/down move | tab switch pane | enter run | esc close"));
    for (const line of this.bottomBorder.render(safeWidth)) append(line);
    return lines;
  }

  private padVisible(line: string, width: number): string {
    const pad = Math.max(0, width - visibleWidth(line));
    return line + " ".repeat(pad);
  }

  private renderProfiles(): string[] {
    const lines = [this.theme.fg("muted", "profiles")];
    if (this.names.length === 0) {
      lines.push(this.theme.fg("warning", "  (none — pick New profile)"));
      return lines;
    }
    this.names.forEach((name, index) => {
      const marker = name === this.activeName ? " *" : "  ";
      const selected = this.focus === "list" && index === this.listIndex;
      const text = `${marker} ${name}`;
      lines.push(selected ? this.theme.fg("accent", `> ${text}`) : `  ${text}`);
    });
    return lines;
  }

  private actions(): readonly string[] {
    return [...PROFILE_ACTIONS, ...GLOBAL_ACTIONS];
  }

  private renderActions(): string[] {
    const lines = [this.theme.fg("muted", `actions${this.names.length === 0 ? "" : ` — for: ${this.names[this.listIndex] ?? ""}`}`)];
    this.actions().forEach((label, index) => {
      const selected = this.focus === "actions" && index === this.actionIndex;
      lines.push(selected ? this.theme.fg("accent", `> ${label}`) : `  ${label}`);
    });
    return lines;
  }

  handleInput(data: string): void {
    const kb = this.keybindings;
    if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) {
      this.done(null);
      return;
    }
    if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
      const delta = kb.matches(data, "tui.select.up") ? -1 : 1;
      if (this.focus === "list") {
        if (this.names.length > 0) {
          this.listIndex = (this.listIndex + delta + this.names.length) % this.names.length;
        }
      } else {
        const count = this.actions().length;
        this.actionIndex = (this.actionIndex + delta + count) % count;
      }
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.focus = this.focus === "list" ? "actions" : "list";
      this.tui.requestRender();
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      this.runAction();
      return;
    }
    if (matchesKey(data, "n")) {
      this.done({ kind: "new" });
      return;
    }
  }

  private runAction(): void {
    const label = this.actions()[this.actionIndex];
    if (label === undefined) return;
    if (label === "New profile") {
      this.done({ kind: "new" });
      return;
    }
    if (label === "Deactivate (off)") {
      this.done({ kind: "off" });
      return;
    }
    if (label === "Close") {
      this.done(null);
      return;
    }
    const profile = this.names[this.listIndex];
    if (profile === undefined) return;
    if (label === "Activate (project)") this.done({ kind: "activate-project", profile });
    else if (label === "Activate (global)") this.done({ kind: "activate-global", profile });
    else if (label === "Edit") this.done({ kind: "edit", profile });
    else if (label === "Delete") this.done({ kind: "delete", profile });
  }
}

// --- console loop -------------------------------------------------------------

function knownAgentNames(ctx: ExtensionContext): string[] {
  const agentDir = getAgentDir();
  const values = new Set(allAgentFiles(ctx.cwd, agentDir).map((file) => file.name));
  for (const builtIn of ["general-purpose", "Explore", "Plan"]) values.add(builtIn);
  return [...values].sort();
}

async function deleteFromConsole(ctx: ExtensionCommandContext, name: string): Promise<void> {
  const agentDir = getAgentDir();
  const globalActive = loadGlobalState(agentDir).active;
  const projectActive = loadProjectActive(ctx.cwd);
  if (globalActive === name || projectActive === name) {
    notify(ctx, `cannot delete the active profile '${name}'`, "error");
    return;
  }
  if (!(await ctx.ui.confirm("Delete profile?", `Delete '${name}'?`))) return;
  try {
    unlinkSync(jsonProfilePath(agentDir, name));
    notify(ctx, `deleted profile '${name}'`);
  } catch (error) {
    notify(ctx, `could not delete '${name}': ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

/** Notify validation issues; save always succeeds, activation is blocked by activateProfile. */
function reportValidation(ctx: ExtensionCommandContext, profile: Profile): void {
  const available = ctx.modelRegistry.getAvailable().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
  }));
  const scoped = ctx.scopedModels.map((entry) => ({
    provider: entry.model.provider,
    id: entry.model.id,
    name: entry.model.name,
  }));
  const issues = validateProfile(profile, available, scoped);
  for (const issue of issues) notify(ctx, issue.message, issue.level);
}

async function runProfileWizard(ctx: ExtensionCommandContext, editName?: string): Promise<void> {
  const agentDir = getAgentDir();
  let draft: WizardDraft;
  if (editName !== undefined) {
    const path = jsonProfilePath(agentDir, editName);
    if (!existsSync(path)) {
      notify(ctx, `unknown profile '${editName}'`, "error");
      return;
    }
    const parsed = parseJsonProfile(readFileSync(path, "utf8"), editName);
    draft = {
      name: editName,
      ...(parsed.profile.description !== undefined ? { description: parsed.profile.description } : {}),
      subagentsBlock: structuredClone(parsed.subagentsBlock),
      ...(parsed.profile.mainModel !== undefined ? { mainModel: parsed.profile.mainModel } : {}),
      ...(parsed.profile.mainThinking !== undefined ? { mainThinking: parsed.profile.mainThinking } : {}),
    };
  } else {
    const existing = new Set(listJsonProfiles(agentDir));
    let name = "";
    while (true) {
      const entered = await ctx.ui.input("Profile name (Esc = cancel)", "lowercase-name");
      if (entered === undefined) return;
      name = entered.trim();
      if (!/^[a-z0-9][a-z0-9-_]*$/.test(name)) {
        notify(ctx, "name must match /^[a-z0-9][a-z0-9-_]*$/", "error");
        continue;
      }
      if (existing.has(name)) {
        notify(ctx, `profile '${name}' already exists`, "error");
        continue;
      }
      break;
    }
    draft = { name, subagentsBlock: {} };
  }

  const descriptionInput = await ctx.ui.input("Description (Esc = keep)", draft.description ?? "optional description");
  if (descriptionInput === undefined) return;
  if (descriptionInput.trim() !== "") draft.description = descriptionInput.trim();

  const available = ctx.modelRegistry.getAvailable().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
  }));
  if (available.length === 0) {
    notify(ctx, "no available models to choose from", "error");
    return;
  }

  const inheritPseudo = [{ value: "inherit", label: "inherit", description: "Use the caller's model at spawn time" }];
  const block: Record<string, unknown> = {};
  const defaultModel = await pickModels(ctx, {
    title: "Default model (agents without an override)",
    mode: "single",
    models: available,
    pseudoEntries: inheritPseudo,
  });
  if (defaultModel === null) return;
  if (defaultModel !== "inherit") block.defaultModel = defaultModel;
  const defaultThinking = await ctx.ui.select("Default thinking", ["omit", ...THINKING_LEVELS]);
  if (defaultThinking === undefined) return;
  if (defaultThinking !== "omit") block.defaultThinking = defaultThinking as ThinkingLevel;

  const agentOverrides: Record<string, Record<string, unknown>> = {};
  const previousOverrides = (draft.subagentsBlock.agentOverrides as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [agent, entry] of Object.entries(previousOverrides)) agentOverrides[agent] = { ...entry };
  const agents = knownAgentNames(ctx);
  while (true) {
    const remainingAgents = agents.filter((agent) => !Object.prototype.hasOwnProperty.call(agentOverrides, agent));
    if (remainingAgents.length === 0) break;
    const add = await ctx.ui.select("Add per-agent override? (Esc = done)", ["no", "yes"]);
    if (add === undefined || add !== "yes") break;
    const agent = await ctx.ui.select("Agent (Esc = cancel)", remainingAgents);
    if (agent === undefined) return;
    const model = await pickModels(ctx, {
      title: `Model for '${agent}'`,
      mode: "single",
      models: available,
      pseudoEntries: inheritPseudo,
    });
    if (model === null) continue;
    const entry: Record<string, unknown> = {};
    if (model !== "inherit") entry.model = model;
    const thinking = await ctx.ui.select(`Thinking for '${agent}' (Esc = cancel)`, ["omit", ...THINKING_LEVELS]);
    if (thinking === undefined) return;
    if (thinking !== "omit") entry.thinking = thinking as ThinkingLevel;
    if (Object.keys(entry).length > 0) agentOverrides[agent] = entry;
    else delete agentOverrides[agent];
  }
  if (Object.keys(agentOverrides).length > 0) block.agentOverrides = agentOverrides;
  draft.subagentsBlock = block;

  const mainShape = await ctx.ui.select("Main session model", ["keep current", "none", "single", "tiers"]);
  if (mainShape === undefined) return;
  if (mainShape === "none") {
    delete draft.mainModel;
  } else if (mainShape === "single") {
    const picked = await pickModels(ctx, { title: "Main model", mode: "single", models: available });
    if (picked === null) return;
    draft.mainModel = picked;
  } else if (mainShape === "tiers") {
    const tiers: Partial<Record<MainModelMode, string>> = {};
    for (const mode of MAIN_MODEL_MODES) {
      const picked = await pickModels(ctx, {
        title: `Main model tier: ${mode}`,
        mode: "single",
        models: available,
        pseudoEntries: [{ value: "skip", label: "skip", description: "Do not set this tier" }],
      });
      if (picked === null) return;
      if (picked !== "skip") tiers[mode] = picked;
    }
    if (Object.keys(tiers).length > 0) draft.mainModel = tiers;
    else delete draft.mainModel;
  }
  const mainThinkingChoice = await ctx.ui.select("Main thinking (applied to the main session)", ["omit", ...THINKING_LEVELS]);
  if (mainThinkingChoice === undefined) return;
  if (mainThinkingChoice === "omit") delete draft.mainThinking;
  else draft.mainThinking = mainThinkingChoice as ThinkingLevel;

  const path = jsonProfilePath(agentDir, draft.name);
  mkdirSync(piSubagentsProfilesDirectory(agentDir), { recursive: true });
  atomicWriteFileSync(
    path,
    serializeJsonProfile({
      name: draft.name,
      ...(draft.description !== undefined ? { description: draft.description } : {}),
      subagentsBlock: draft.subagentsBlock,
      ...(draft.mainModel !== undefined ? { mainModel: draft.mainModel } : {}),
      ...(draft.mainThinking !== undefined ? { mainThinking: draft.mainThinking } : {}),
    }),
  );
  notify(ctx, `saved profile '${draft.name}' (pi-subagents JSON)`);
  const saved = parseJsonProfile(readFileSync(path, "utf8"), draft.name);
  reportValidation(ctx, saved.profile);
  if (hasMainModelModes(saved.profile.mainModel)) {
    notify(ctx, "activate from the console to apply routing and the main model tiers", "info");
  }
}

export async function openProfileManager(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    notify(ctx, "the profile console requires the TUI", "warning");
    return;
  }
  const agentDir = getAgentDir();
  while (true) {
    const result = await ctx.ui.custom<ManagerResult | null>(
      (tui, theme, keybindings, done) =>
        new ProfileManager(tui, theme, keybindings, {
          names: listJsonProfiles(agentDir),
          activeName: resolveActiveName(ctx.cwd, agentDir),
        }, done),
      { overlay: true, overlayOptions: { width: "80%", maxHeight: "70%", anchor: "center" } },
    );
    if (result === null) return;
    switch (result.kind) {
      case "activate-project":
        await activateProfile(pi, ctx, result.profile!, "project");
        break;
      case "activate-global":
        await activateProfile(pi, ctx, result.profile!, "global");
        break;
      case "edit":
        await runProfileWizard(ctx, result.profile);
        break;
      case "new":
        await runProfileWizard(ctx);
        break;
      case "delete":
        await deleteFromConsole(ctx, result.profile!);
        break;
      case "off": {
        const scope = await ctx.ui.select("Deactivation scope", ["project", "global"]);
        if (scope === "project" || scope === "global") await deactivateProfile(pi, ctx, scope);
        break;
      }
    }
  }
}