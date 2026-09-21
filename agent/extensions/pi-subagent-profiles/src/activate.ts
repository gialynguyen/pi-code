import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { atomicWriteFileSync } from "./fsutil";
import { hasMainModelModes, MAIN_MODEL_MODES, nextMainModelMode } from "./mainModel";
import {
  isRecord,
  jsonProfilePath,
  parseJsonProfile,
  parseProfile,
  piSubagentsProfilesDirectory,
  resolveMainSession,
  resolveModel,
  splitModelThinking,
  validateProfile,
} from "./profile";
import {
  loadGlobalState,
  resolveActiveName,
  resolveActiveScope,
  resolveMainModelMode,
  saveGlobalState,
  saveMainModelMode,
  saveProjectActive,
} from "./state";
import type { MainModelMode } from "./mainModel";
import type { ModelInfo, Profile, ProfileRule, ThinkingLevel } from "./types";

const PROFILE_DIRECTORY_NAME = "subagent-profiles";
const PROFILES_DIRECTORY_NAME = "profiles";

type StatusContext = Pick<ExtensionContext, "hasUI" | "ui">;

function notify(ctx: StatusContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(`profiles: ${message}`, level);
}

export function profilesDirectory(agentDir: string): string {
  return join(agentDir, PROFILE_DIRECTORY_NAME, PROFILES_DIRECTORY_NAME);
}

export function profilePath(agentDir: string, name: string): string {
  return join(profilesDirectory(agentDir), `${name}.yaml`);
}

export type ProfileKind = "json" | "yaml";

export interface ProfileSource {
  profile: Profile;
  path: string;
  kind: ProfileKind;
  /** Raw pi-subagents `subagents` block; only set for JSON profiles. */
  subagentsBlock?: Record<string, unknown>;
}

function safeProfileName(name: string): boolean {
  return name.length > 0 && basename(name) === name && name !== "." && name !== "..";
}

/** JSON profiles (pi-subagents store) win over same-named YAML profiles. */
export function resolveProfilePath(agentDir: string, name: string): { path: string; kind: ProfileKind } | undefined {
  if (!safeProfileName(name)) return undefined;
  const jsonPath = jsonProfilePath(agentDir, name);
  if (existsSync(jsonPath)) return { path: jsonPath, kind: "json" };
  const yamlPath = profilePath(agentDir, name);
  if (existsSync(yamlPath)) return { path: yamlPath, kind: "yaml" };
  return undefined;
}

export function listProfileNames(agentDir: string): string[] {
  const names = new Set<string>();
  try {
    for (const entry of readdirSync(piSubagentsProfilesDirectory(agentDir), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json")) names.add(basename(entry.name, ".json"));
    }
  } catch {
    // pi-subagents store absent
  }
  try {
    for (const entry of readdirSync(profilesDirectory(agentDir), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".yaml")) names.add(basename(entry.name, ".yaml"));
    }
  } catch {
    // legacy YAML store absent
  }
  return [...names].sort();
}

export function readProfile(agentDir: string, name: string): ProfileSource {
  if (!safeProfileName(name)) throw new Error(`invalid profile name '${name}'`);
  const resolved = resolveProfilePath(agentDir, name);
  if (resolved === undefined) throw new Error(`profile '${name}' does not exist`);
  const text = readFileSync(resolved.path, "utf8");
  if (resolved.kind === "json") {
    const parsed = parseJsonProfile(text, name);
    return { ...parsed, path: resolved.path, kind: resolved.kind };
  }
  return { profile: parseProfile(text, name), path: resolved.path, kind: resolved.kind };
}

// --- pi-subagents settings integration --------------------------------------

const ROUTING_KEYS = ["defaultModel", "defaultThinking", "agentOverrides"] as const;

function canonicalRoutingValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRoutingValue);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      // machine placement is not a model-routing choice (pi-subagents preserves
      // machine pins across profile switches), so it never affects matching
      if (key === "machine") continue;
      const canonical = canonicalRoutingValue(value[key]);
      // machine-only override entries (e.g. {machine:"pin"}) carry no routing
      // opinion and are dropped so they cannot break an exact match
      if (isRecord(canonical) && Object.keys(canonical).length === 0) continue;
      out[key] = canonical;
    }
    return out;
  }
  return value;
}

/** Keep only the keys pi-subagents profiles own; everything else is unrelated settings. */
function routingOwnedKeys(block: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ROUTING_KEYS) {
    if (block[key] !== undefined) out[key] = block[key];
  }
  return out;
}

export interface EffectiveRouting {
  /** Merged user+project routing keys; null when neither settings file has a subagents block. */
  block: Record<string, unknown> | null;
  paths: string[];
}

/**
 * Read the routing pi-subagents will use: `subagents` from user settings merged
 * with project settings (project wins per key; agentOverrides merge per agent).
 */
export function readEffectiveSubagentRouting(agentDir: string, cwd: string): EffectiveRouting {
  let merged: Record<string, unknown> = {};
  const paths: string[] = [];
  for (const path of [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")]) {
    if (!existsSync(path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.subagents)) continue;
    paths.push(path);
    merged = { ...merged, ...routingOwnedKeys(parsed.subagents as Record<string, unknown>) };
  }
  return { block: Object.keys(merged).length > 0 ? merged : null, paths };
}

/** True when the profile's routing block equals the effective settings routing. */
export function profileMatchesRouting(subagentsBlock: Record<string, unknown>, routing: EffectiveRouting): boolean {
  if (routing.block === null) return false;
  return (
    JSON.stringify(canonicalRoutingValue(routingOwnedKeys(subagentsBlock))) ===
    JSON.stringify(canonicalRoutingValue(routingOwnedKeys(routing.block)))
  );
}

/**
 * The JSON profile whose routing block matches the effective pi-subagents
 * settings, when exactly one matches. This is how the extension sees which
 * profile pi-subagents is actually running after /subagents-load-profile.
 */
export function detectSettingsProfile(agentDir: string, cwd: string): string | null {
  const routing = readEffectiveSubagentRouting(agentDir, cwd);
  if (routing.block === null) return null;
  const matches: string[] = [];
  for (const name of listProfileNames(agentDir)) {
    const resolved = resolveProfilePath(agentDir, name);
    if (resolved === undefined || resolved.kind !== "json") continue;
    try {
      const parsed = parseJsonProfile(readFileSync(resolved.path, "utf8"), name);
      if (profileMatchesRouting(parsed.subagentsBlock, routing)) matches.push(name);
    } catch {
      continue;
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Write a routing block into the scope's settings file — user settings for
 * "global", the project's .pi/settings.json for "project" — mirroring
 * pi-subagents' applySubagentProfile: the block owns defaultModel/
 * defaultThinking/agentOverrides (machine pins preserved), unrelated existing
 * subagent settings (disableBuiltins, modelScope, watchdog, ...) survive.
 */
export function applyRoutingFromProfile(
  agentDir: string,
  subagentsBlock: Record<string, unknown>,
  scope: "global" | "project",
  cwd: string,
): string {
  const settingsPath =
    scope === "project" ? join(cwd, ".pi", "settings.json") : join(agentDir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    if (isRecord(parsed)) settings = parsed;
  }
  const existing = isRecord(settings.subagents) ? settings.subagents : {};
  const existingOverrides = isRecord(existing.agentOverrides) ? existing.agentOverrides : {};
  const blockOverrides = isRecord(subagentsBlock.agentOverrides) ? subagentsBlock.agentOverrides : {};
  const agentOverrides: Record<string, unknown> = { ...blockOverrides };
  for (const [name, value] of Object.entries(existingOverrides)) {
    const machine = isRecord(value) ? value.machine : undefined;
    const target = agentOverrides[name];
    if (typeof machine === "string" && (!isRecord(target) || target.machine === undefined)) {
      agentOverrides[name] = { ...(isRecord(target) ? target : {}), machine };
    }
  }
  settings.subagents = { ...existing, ...subagentsBlock, agentOverrides };
  mkdirSync(dirname(settingsPath), { recursive: true });
  atomicWriteFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settingsPath;
}

/**
 * Derive a pi-subagents routing block from a YAML profile's rules, mirroring the
 * old injection semantics: the first resolvable non-inherit chain entry wins
 * (inherit = no model opinion), the rule's thinking is always an opinion, and a
 * rule with neither resolves to nothing. Unresolvable models are skipped instead
 * of written, so a later pi-subagents launch cannot hard-fail on them.
 */
export function routingFromYamlProfile(profile: Profile, available: ModelInfo[]): Record<string, unknown> {
  const firstResolvable = (rule: ProfileRule): string | undefined => {
    for (const entry of rule.models) {
      const { model } = splitModelThinking(entry);
      if (model === "inherit") return undefined;
      if (resolveModel(model, available) !== undefined) return entry;
    }
    return undefined;
  };
  const block: Record<string, unknown> = {};
  const defaultModel = firstResolvable(profile.default);
  if (defaultModel !== undefined) block.defaultModel = defaultModel;
  if (profile.default.thinking !== undefined) block.defaultThinking = profile.default.thinking;
  const agentOverrides: Record<string, unknown> = {};
  for (const [agent, rule] of Object.entries(profile.overrides)) {
    const model = firstResolvable(rule);
    const entry: Record<string, unknown> = {};
    if (model !== undefined) entry.model = model;
    if (rule.thinking !== undefined) entry.thinking = rule.thinking;
    if (Object.keys(entry).length > 0) agentOverrides[agent] = entry;
  }
  if (Object.keys(agentOverrides).length > 0) block.agentOverrides = agentOverrides;
  return block;
}

/**
 * Remove the routing keys profiles own (defaultModel, defaultThinking,
 * agentOverrides) from one settings file, leaving everything else
 * (disableBuiltins, modelScope, watchdog, machine pins, ...) untouched.
 * Returns the path when something was removed, null when there was nothing.
 */
export function clearRoutingFromSettings(settingsPath: string): string | null {
  if (!existsSync(settingsPath)) return null;
  let settings: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.subagents)) return null;
    settings = parsed;
  } catch {
    return null;
  }
  const subagents = { ...(settings.subagents as Record<string, unknown>) };
  let removed = false;
  for (const key of ["defaultModel", "defaultThinking", "agentOverrides"]) {
    if (key in subagents) {
      delete subagents[key];
      removed = true;
    }
  }
  if (!removed) return null;
  if (Object.keys(subagents).length === 0) delete settings.subagents;
  else settings.subagents = subagents;
  atomicWriteFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settingsPath;
}

function modelInfo(model: { provider: string; id: string; name: string }): ModelInfo {
  return { provider: model.provider, id: model.id, name: model.name };
}

function scoped(model: ModelInfo, models: ModelInfo[]): boolean {
  return models.length === 0 || models.some((entry) => entry.provider === model.provider && entry.id === model.id);
}

function setActiveState(agentDir: string, cwd: string, name: string, scope: "global" | "project"): void {
  if (scope === "global") {
    const state = loadGlobalState(agentDir);
    state.active = name;
    state.mainModelMode = "default";
    saveGlobalState(agentDir, state);
  } else {
    saveProjectActive(cwd, name);
  }
}

export interface MainSessionApplication {
  model?: { provider: string; id: string };
  thinking?: ThinkingLevel;
}

export async function applyMainSessionConfig(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  profile: Profile,
  scope: "global" | "project",
  mainModelMode: MainModelMode = resolveMainModelMode(ctx.cwd, getAgentDir()),
): Promise<MainSessionApplication> {
  const agentDir = getAgentDir();
  const available = ctx.modelRegistry.getAvailable().map(modelInfo);
  const scopedModels = ctx.scopedModels.map((entry) => modelInfo(entry.model));
  const applied: MainSessionApplication = {};
  const globalState = loadGlobalState(agentDir);
  let stateDirty = false;
  const resolved = resolveMainSession(profile, mainModelMode);
  if (resolved.model !== undefined) {
    const mainModel = resolveModel(resolved.model, available);
    if (mainModel !== undefined && scoped(mainModel, scopedModels)) {
      const targetModel = ctx.modelRegistry.find(mainModel.provider, mainModel.id);
      if (targetModel === undefined) {
        notify(ctx, `main model '${mainModel.provider}/${mainModel.id}' is unavailable`, "warning");
      } else {
        const currentModel = ctx.model;
        try {
          const changed = await pi.setModel(targetModel);
          if (!changed) {
            notify(ctx, `could not switch main model to '${mainModel.provider}/${mainModel.id}'`, "warning");
          } else {
            if (globalState.mainModelBackup === undefined || globalState.mainModelBackup === null) {
              globalState.mainModelBackup =
                currentModel === undefined ? null : { provider: currentModel.provider, id: currentModel.id };
            }
            globalState.mainModelApplied = { provider: mainModel.provider, id: mainModel.id, scope };
            stateDirty = true;
            applied.model = { provider: mainModel.provider, id: mainModel.id };
          }
        } catch (error) {
          notify(ctx, `could not switch main model: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
      }
    }
  }

  if (resolved.thinking !== undefined) {
    if (globalState.mainThinkingBackup === undefined || globalState.mainThinkingBackup === null) {
      globalState.mainThinkingBackup = pi.getThinkingLevel();
    }
    pi.setThinkingLevel(resolved.thinking);
    globalState.mainThinkingApplied = { level: pi.getThinkingLevel(), scope };
    stateDirty = true;
    applied.thinking = pi.getThinkingLevel();
  }

  if (stateDirty) saveGlobalState(agentDir, globalState);
  return applied;
}

export async function activateProfile(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  name: string,
  scope: "global" | "project",
): Promise<boolean> {
  const agentDir = getAgentDir();
  let source: ProfileSource;
  try {
    source = readProfile(agentDir, name);
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
    return false;
  }
  const profile = source.profile;

  const available = ctx.modelRegistry.getAvailable().map(modelInfo);
  const scopedModels = ctx.scopedModels.map((entry) => modelInfo(entry.model));
  const issues = validateProfile(profile, available, scopedModels);
  for (const issue of issues) notify(ctx, issue.message, issue.level);
  if (issues.some((issue) => issue.level === "error")) return false;

  if (source.kind === "json" && source.subagentsBlock !== undefined) {
    const settingsPath = applyRoutingFromProfile(agentDir, source.subagentsBlock, scope, ctx.cwd);
    notify(ctx, `routing written to ${settingsPath}; /reload applies it to running sessions`, "info");
    if (scope === "global") notifyProjectRoutingPin(ctx);
  } else {
    const block = routingFromYamlProfile(profile, available);
    if (Object.keys(block).length > 0) {
      const settingsPath = applyRoutingFromProfile(agentDir, block, scope, ctx.cwd);
      notify(ctx, `routing derived from chains written to ${settingsPath}; /reload applies it to running sessions`, "info");
      if (scope === "global") notifyProjectRoutingPin(ctx);
    }
  }

  setActiveState(agentDir, ctx.cwd, name, scope);
  const mode = resolveMainModelMode(ctx.cwd, agentDir);
  await applyMainSessionConfig(pi, ctx, profile, scope, mode);
  refreshStatus(ctx, name, hasMainModelModes(profile.mainModel) ? mode : undefined);
  notify(ctx, `activated profile '${name}' (${scope}, ${source.kind})`);
  return true;
}

export async function cycleMainModelMode(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
  const agentDir = getAgentDir();
  const name = resolveActiveName(ctx.cwd, agentDir);
  if (name === null) {
    notify(ctx, "no active profile", "warning");
    return false;
  }
  let profile: Profile;
  try {
    profile = readProfile(agentDir, name).profile;
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
    return false;
  }
  if (!hasMainModelModes(profile.mainModel)) {
    notify(ctx, `active profile has no main model modes (${MAIN_MODEL_MODES.join("/")})`, "warning");
    return false;
  }
  const scope = resolveActiveScope(ctx.cwd);
  const next = nextMainModelMode(resolveMainModelMode(ctx.cwd, agentDir));
  saveMainModelMode(ctx.cwd, agentDir, scope, next);
  await applyMainSessionConfig(pi, ctx, profile, scope, next);
  refreshStatus(ctx, name, next);
  notify(ctx, `main model mode: ${next}`);
  return true;
}

function sameModel(
  model: { provider: string; id: string } | undefined,
  target: { provider: string; id: string },
): boolean {
  return model !== undefined && model.provider === target.provider && model.id === target.id;
}

function notifyProjectRoutingPin(ctx: ExtensionContext): void {
  const projectSettingsPath = join(ctx.cwd, ".pi", "settings.json");
  if (!existsSync(projectSettingsPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(projectSettingsPath, "utf8")) as unknown;
    if (isRecord(parsed) && isRecord(parsed.subagents)) {
      notify(ctx, `project routing pins exist at ${projectSettingsPath}; they win over user settings in this project`, "warning");
    }
  } catch {
    // unreadable project settings are not this command's problem
  }
}

export async function deactivateProfile(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  scope: "global" | "project",
): Promise<void> {
  const thinkingBeforeRestore = pi.getThinkingLevel();
  const agentDir = getAgentDir();
  const state = loadGlobalState(agentDir);
  if (scope === "project") {
    saveProjectActive(ctx.cwd, null);
  } else {
    state.active = null;
  }

  let stateDirty = false;
  if (state.mainModelApplied?.scope === scope) {
    const applied = state.mainModelApplied;
    if (sameModel(ctx.model, applied) && state.mainModelBackup !== undefined && state.mainModelBackup !== null) {
      const backup = state.mainModelBackup;
      const model = ctx.modelRegistry.find(backup.provider, backup.id);
      if (model === undefined) {
        notify(ctx, `backup main model '${backup.provider}/${backup.id}' is unavailable`, "warning");
      } else {
        try {
          const restored = await pi.setModel(model);
          if (!restored) notify(ctx, `could not restore main model '${backup.provider}/${backup.id}'`, "warning");
        } catch (error) {
          notify(ctx, `could not restore main model: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
      }
    }
    state.mainModelApplied = null;
    state.mainModelBackup = null;
    stateDirty = true;
  }

  if (state.mainThinkingApplied?.scope === scope) {
    const applied = state.mainThinkingApplied;
    const backup = state.mainThinkingBackup;
    if (backup !== undefined && backup !== null && thinkingBeforeRestore === applied.level) {
      try {
        pi.setThinkingLevel(backup);
      } catch (error) {
        notify(ctx, `could not restore main thinking: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    }
    state.mainThinkingApplied = null;
    state.mainThinkingBackup = null;
    stateDirty = true;
  }

  if (stateDirty || scope === "global") saveGlobalState(agentDir, state);

  const routingPath =
    scope === "project" ? join(ctx.cwd, ".pi", "settings.json") : join(agentDir, "settings.json");
  const cleared = clearRoutingFromSettings(routingPath);
  if (cleared !== null) {
    notify(ctx, `routing removed from ${cleared}; /reload returns spawns to defaults`, "info");
  }

  const active = resolveActiveName(ctx.cwd, agentDir);
  refreshStatus(ctx, active, activeMainModelMode(ctx, agentDir, active));
  notify(ctx, `deactivated ${scope} profile${active === null ? "" : `; active profile '${active}' remains`}`);
}

function activeMainModelMode(ctx: ExtensionContext, agentDir: string, name: string | null): MainModelMode | undefined {
  if (name === null) return undefined;
  try {
    const profile = readProfile(agentDir, name).profile;
    return hasMainModelModes(profile.mainModel) ? resolveMainModelMode(ctx.cwd, agentDir) : undefined;
  } catch {
    return undefined;
  }
}

export function refreshStatus(ctx: StatusContext, name: string | null, mainModelMode?: MainModelMode): void {
  if (!ctx.hasUI) return;
  if (name === null) {
    ctx.ui.setStatus("subagent-profiles", undefined);
    return;
  }
  const suffix = mainModelMode === undefined ? "" : ` · main:${mainModelMode}`;
  ctx.ui.setStatus("subagent-profiles", `profile: ${name}${suffix}`);
}
