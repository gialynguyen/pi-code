import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./fsutil";
import { canonicalizeMainModelMode, type MainModelMode } from "./mainModel";
import { THINKING_LEVELS, type ThinkingLevel } from "./types";

// state.ts intentionally has no pi imports; this is the coding-agent project config directory.
const CONFIG_DIR_NAME = ".pi";

export interface MainModelBackup {
  provider: string;
  id: string;
}

export interface MainModelApplied extends MainModelBackup {
  scope: "global" | "project";
}

export interface GlobalState {
  active: string | null;
  mainModelMode?: MainModelMode;
  mainModelBackup?: MainModelBackup | null;
  mainModelApplied?: MainModelApplied | null;
  mainThinkingBackup?: ThinkingLevel | null;
  mainThinkingApplied?: { level: ThinkingLevel; scope: "global" | "project" } | null;
}

export interface ProjectState {
  active?: string | null;
  mainModelMode?: MainModelMode;
}

function globalStatePath(agentDir: string): string {
  return join(agentDir, "subagent-profiles", "state.json");
}

function projectStatePath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "subagent-profiles.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function parseThinkingBackup(value: unknown): ThinkingLevel | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return isThinkingLevel(value) ? value : undefined;
}

function parseThinkingApplied(
  value: unknown,
): { level: ThinkingLevel; scope: "global" | "project" } | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isRecord(value) || !isThinkingLevel(value.level) || (value.scope !== "global" && value.scope !== "project")) {
    return undefined;
  }
  return { level: value.level, scope: value.scope };
}

function parseMainModelMode(value: unknown): MainModelMode | undefined {
  return typeof value === "string" ? canonicalizeMainModelMode(value) : undefined;
}

function parseProjectState(parsed: Record<string, unknown>): ProjectState {
  const state: ProjectState = {};
  if ("active" in parsed) {
    const active = parsed.active;
    if (active === null || typeof active === "string") state.active = active;
  }
  const mainModelMode = parseMainModelMode(parsed.mainModelMode);
  if (mainModelMode !== undefined) state.mainModelMode = mainModelMode;
  return state;
}

function parseModelBackup(value: unknown): MainModelBackup | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.provider !== "string" ||
    typeof value.id !== "string" ||
    value.provider.length === 0 ||
    value.id.length === 0
  ) {
    return undefined;
  }
  return { provider: value.provider, id: value.id };
}

function parseModelApplied(value: unknown): MainModelApplied | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.provider !== "string" ||
    typeof value.id !== "string" ||
    value.provider.length === 0 ||
    value.id.length === 0 ||
    (value.scope !== "global" && value.scope !== "project")
  ) {
    return undefined;
  }
  return { provider: value.provider, id: value.id, scope: value.scope };
}

export function loadGlobalState(agentDir: string): GlobalState {
  const path = globalStatePath(agentDir);
  if (!existsSync(path)) return { active: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) return { active: null };
    const active = parsed.active;
    if (active !== null && typeof active !== "string") return { active: null };

    const state: GlobalState = { active: active as string | null };
    const mainModelMode = parseMainModelMode(parsed.mainModelMode);
    if (mainModelMode !== undefined) state.mainModelMode = mainModelMode;
    const backup = parseModelBackup(parsed.mainModelBackup);
    if (backup !== undefined) state.mainModelBackup = backup;
    const applied = parseModelApplied(parsed.mainModelApplied);
    if (applied !== undefined) state.mainModelApplied = applied;
    const thinkingBackup = parseThinkingBackup(parsed.mainThinkingBackup);
    if (thinkingBackup !== undefined) state.mainThinkingBackup = thinkingBackup;
    const thinkingApplied = parseThinkingApplied(parsed.mainThinkingApplied);
    if (thinkingApplied !== undefined) state.mainThinkingApplied = thinkingApplied;
    return state;
  } catch {
    return { active: null };
  }
}

export function saveGlobalState(agentDir: string, state: GlobalState): void {
  const path = globalStatePath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function loadProjectState(cwd: string): ProjectState | undefined {
  const path = projectStatePath(cwd);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) return undefined;
    return parseProjectState(parsed);
  } catch {
    return undefined;
  }
}

export function loadProjectActive(cwd: string): string | null | undefined {
  const project = loadProjectState(cwd);
  if (project === undefined || !("active" in project)) return undefined;
  return project.active ?? null;
}

export function resolveActiveScope(cwd: string): "global" | "project" {
  return loadProjectState(cwd)?.active !== undefined ? "project" : "global";
}

export function resolveMainModelMode(cwd: string, agentDir: string): MainModelMode {
  const project = loadProjectState(cwd);
  if (project?.mainModelMode !== undefined) return project.mainModelMode;
  const global = loadGlobalState(agentDir);
  if (global.mainModelMode !== undefined) return global.mainModelMode;
  return "default";
}

export function saveMainModelMode(cwd: string, agentDir: string, scope: "global" | "project", mode: MainModelMode): void {
  if (scope === "project") {
    const path = projectStatePath(cwd);
    let object: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (isRecord(parsed)) object = { ...parsed };
      } catch {
        object = {};
      }
    }
    object.mainModelMode = mode;
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${JSON.stringify(object, null, 2)}\n`);
    return;
  }
  const state = loadGlobalState(agentDir);
  state.mainModelMode = mode;
  saveGlobalState(agentDir, state);
}

export function saveProjectActive(cwd: string, name: string | null): void {
  const path = projectStatePath(cwd);
  let object: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (isRecord(parsed)) object = { ...parsed };
    } catch {
      object = {};
    }
  }
  if (name === null) {
    delete object.active;
    delete object.mainModelMode;
  } else {
    object.active = name;
    object.mainModelMode = "default";
  }
  if (Object.keys(object).length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(object, null, 2)}\n`);
}

export function resolveActiveName(cwd: string, agentDir: string): string | null {
  const project = loadProjectActive(cwd);
  if (project !== undefined) return project;
  return loadGlobalState(agentDir).active;
}
