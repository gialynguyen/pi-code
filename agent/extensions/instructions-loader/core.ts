/**
 * core.ts — pure logic + filesystem for the instructions loader.
 * No pi imports, so test.ts can exercise it with plain node.
 *
 * Model:
 *   - Instruction files: flat *.md in ~/.pi/agent/instructions/ (global) and
 *     <project>/.pi/instructions/ (project). Filename sans .md = id.
 *     Optional frontmatter `description:`; body after frontmatter = content.
 *   - Persisted state: <dir>/state.json = { "disabled": ["name", ...] }.
 *     Default is enabled; only disabled names are stored.
 *   - Session state: in-memory 3-valued overlay (force-on/force-off/unset),
 *     owned by index.ts. Dies with the conversation.
 *   - Shadowing: a project file with the same name shadows the global one
 *     (by existence, regardless of enable state).
 *   - Project instructions are only scanned when the project is trusted.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export type Scope = "global" | "project";
export type SessionOverride = "unset" | "force-on" | "force-off";

export interface InstructionRow {
  name: string;
  scope: Scope;
  filePath: string;
  description: string;
  body: string;
  persistedOn: boolean;
  shadowed: boolean;
}

export interface InstructionDirs {
  global: string;
  project: string | null;
}

export function instructionsDirs(cwd: string): InstructionDirs {
  const global = path.join(homedir(), ".pi", "agent", "instructions");
  // skill-gate convention: don't treat $HOME itself as a project.
  const project = cwd !== homedir() ? path.join(cwd, ".pi", "instructions") : null;
  return { global, project };
}

// ── Frontmatter ──

export function parseFrontmatter(raw: string): { description: string; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const description = m
    ? (m[1].match(/^description:\s*(.+)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "")
    : "";
  const body = (m ? raw.slice(m[0].length) : raw).trim();
  return { description, body };
}

// ── Persisted state (state.json, disabled-names-only) ──

export function readDisabled(dir: string): string[] {
  const file = path.join(dir, "state.json");
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(parsed.disabled) ? parsed.disabled.filter((n: unknown) => typeof n === "string") : [];
  } catch {
    console.warn(`[instructions] Failed to parse ${file} — treating as empty`);
    return [];
  }
}

export function writeDisabled(dir: string, disabled: string[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ disabled }, null, 2), "utf-8");
}

/** Enable/disable one instruction in its own scope's state.json. */
export function setPersisted(dir: string, name: string, enabled: boolean): void {
  const disabled = readDisabled(dir).filter((n) => n !== name);
  if (!enabled) disabled.push(name);
  writeDisabled(dir, disabled);
}

// ── Directory setup ──

/** Create both dirs if missing; drop a .gitignore for the project state file
 *  (enable/disable state is personal, not for the repo). */
export function ensureDirs(dirs: InstructionDirs): void {
  fs.mkdirSync(dirs.global, { recursive: true });
  if (dirs.project) {
    fs.mkdirSync(dirs.project, { recursive: true });
    const gi = path.join(dirs.project, ".gitignore");
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, "state.json\n", "utf-8");
  }
}

// ── Scanning ──

function listMd(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function readRow(dir: string, scope: Scope, file: string, disabled: string[]): InstructionRow | null {
  const filePath = path.join(dir, file);
  try {
    const { description, body } = parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
    return {
      name: file.slice(0, -3),
      scope,
      filePath,
      description,
      body,
      persistedOn: !disabled.includes(file.slice(0, -3)),
      shadowed: false,
    };
  } catch (err) {
    console.warn(`[instructions] Skipping unreadable ${filePath}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Scan both scopes. Global rows first (alphabetical), then project rows.
 *  Project rows only when trusted. Global rows shadowed by a project file
 *  with the same name get shadowed: true. */
export function scanDirs(dirs: InstructionDirs, projectTrusted: boolean): InstructionRow[] {
  const rows: InstructionRow[] = [];

  const globalDisabled = readDisabled(dirs.global);
  for (const file of listMd(dirs.global)) {
    const row = readRow(dirs.global, "global", file, globalDisabled);
    if (row) rows.push(row);
  }

  if (dirs.project && projectTrusted) {
    const projectDisabled = readDisabled(dirs.project);
    const projectNames = new Set(listMd(dirs.project).map((f) => f.slice(0, -3)));
    for (const row of rows) row.shadowed = projectNames.has(row.name);
    for (const file of listMd(dirs.project)) {
      const row = readRow(dirs.project, "project", file, projectDisabled);
      if (row) rows.push(row);
    }
  }

  return rows;
}

// ── Effective state ──

export function sessionKey(row: InstructionRow): string {
  return `${row.scope}:${row.name}`;
}

export function sessionOf(row: InstructionRow, overrides: Map<string, SessionOverride>): SessionOverride {
  return overrides.get(sessionKey(row)) ?? "unset";
}

export function effectiveOn(row: InstructionRow, session: SessionOverride): boolean {
  if (session === "force-on") return true;
  if (session === "force-off") return false;
  return row.persistedOn;
}

/** Cycles unset → force-on → force-off → unset. Returns the new value. */
export function cycleSession(current: SessionOverride): SessionOverride {
  return current === "unset" ? "force-on" : current === "force-on" ? "force-off" : "unset";
}

// ── Prompt block ──

/** Build the <user_instruction> block appended to the system prompt.
 *  Skips shadowed, session-forced-off, persisted-disabled, and empty-body
 *  rows. Returns null when nothing is active. */
export function buildUserInstructionsBlock(rows: InstructionRow[], overrides: Map<string, SessionOverride>): string | null {
  const parts: string[] = [];
  for (const row of rows) {
    if (row.shadowed || !row.body) continue;
    if (!effectiveOn(row, sessionOf(row, overrides))) continue;
    parts.push(`<user_instruction source="${row.filePath}">\n${row.body}\n</user_instruction>`);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}
