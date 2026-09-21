/**
 * Self-check for core.ts (scan, frontmatter, persisted state, session
 * resolution, shadowing, prompt block). Run: node test.ts
 * (node ≥23 strips types natively.)
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildUserInstructionsBlock,
  cycleSession,
  effectiveOn,
  ensureDirs,
  parseFrontmatter,
  readDisabled,
  scanDirs,
  sessionKey,
  setPersisted,
  writeDisabled,
  type InstructionRow,
  type SessionOverride,
} from "./core.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "instructions-loader-test-"));
const globalDir = path.join(tmp, "global");
const projectDir = path.join(tmp, "project");
const dirs = { global: globalDir, project: projectDir };

// ── frontmatter ──
const fm = parseFrontmatter("---\ndescription: \"Auth rules\"\nother: x\n---\n\nBody here\n");
assert.equal(fm.description, "Auth rules");
assert.equal(fm.body, "Body here");
assert.deepEqual(parseFrontmatter("Just body"), { description: "", body: "Just body" });

// ── dirs + scan ──
ensureDirs(dirs);
assert.ok(fs.existsSync(projectDir));
assert.equal(fs.readFileSync(path.join(projectDir, ".gitignore"), "utf-8"), "state.json\n");

fs.writeFileSync(path.join(globalDir, "a.md"), "---\ndescription: Alpha\n---\nAlpha body\n");
fs.writeFileSync(path.join(globalDir, "b.md"), "Global B body\n");
fs.writeFileSync(path.join(projectDir, "b.md"), "Project B body\n");
fs.writeFileSync(path.join(projectDir, "c.md"), "C body\n");

let rows = scanDirs(dirs, true);
assert.deepEqual(rows.map((r) => [r.name, r.scope, r.persistedOn, r.shadowed]), [
  ["a", "global", true, false],
  ["b", "global", true, true],   // shadowed by project b
  ["b", "project", true, false],
  ["c", "project", true, false],
]);
assert.equal(rows[0].description, "Alpha");

// Untrusted project → global only, nothing shadowed.
rows = scanDirs(dirs, false);
assert.deepEqual(rows.map((r) => r.name), ["a", "b"]);
assert.ok(rows.every((r) => !r.shadowed));

// ── persisted state ──
setPersisted(globalDir, "a", false);
assert.deepEqual(readDisabled(globalDir), ["a"]);
rows = scanDirs(dirs, true);
assert.equal(rows[0].persistedOn, false);
setPersisted(globalDir, "a", true);
assert.deepEqual(readDisabled(globalDir), []);
writeDisabled(projectDir, ["c"]);
assert.deepEqual(readDisabled(projectDir), ["c"]);

// ── session resolution ──
const rowA: InstructionRow = { name: "a", scope: "global", filePath: "/x/a.md", description: "", body: "A", persistedOn: false, shadowed: false };
const rowC: InstructionRow = { name: "c", scope: "project", filePath: "/x/c.md", description: "", body: "C", persistedOn: false, shadowed: false };
assert.equal(effectiveOn(rowA, "unset"), false);
assert.equal(effectiveOn(rowA, "force-on"), true);
assert.equal(effectiveOn(rowC, "force-off"), false);
assert.equal(cycleSession("unset"), "force-on");
assert.equal(cycleSession("force-on"), "force-off");
assert.equal(cycleSession("force-off"), "unset");
assert.equal(sessionKey(rowC), "project:c");

// ── prompt block ──
const overrides = new Map<string, SessionOverride>();
rows = scanDirs(dirs, true); // a on, b shadowed (project b active), c persisted-off
assert.equal(
  buildUserInstructionsBlock(rows, overrides),
  `<user_instruction source="${path.join(globalDir, "a.md")}">\nAlpha body\n</user_instruction>\n` +
    `<user_instruction source="${path.join(projectDir, "b.md")}">\nProject B body\n</user_instruction>`,
);
// Session force-on resurrects the disabled c; force-off hides a.
overrides.set(sessionKey(rows[3]), "force-on");
overrides.set(sessionKey(rows[0]), "force-off");
const block = buildUserInstructionsBlock(rows, overrides)!;
assert.ok(block.includes("C body"));
assert.ok(!block.includes("Alpha body"));
assert.ok(!block.includes("Global B body")); // shadowed (project copy is the active one)
// Nothing active → null.
assert.equal(buildUserInstructionsBlock([], overrides), null);

console.log("instructions-loader core: all checks passed");
fs.rmSync(tmp, { recursive: true, force: true });
