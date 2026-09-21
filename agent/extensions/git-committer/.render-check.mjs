const NM = "/Users/gialynguyen/.pi/agent/extensions/pi-subagent-profiles/node_modules";
const PCA = `${NM}/@earendil-works/pi-coding-agent`;
const { createJiti } = await import(`file://${PCA}/node_modules/jiti/lib/jiti.mjs`);
const piTui = await import(`file://${NM}/@earendil-works/pi-tui/dist/index.js`);
const { createRequire } = await import("node:module");
const require = createRequire(`${PCA}/node_modules/`);
const pca = require(`${PCA}/dist/index.js`);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  virtualModules: { "@earendil-works/pi-tui": piTui, "@earendil-works/pi-coding-agent": pca },
});
const ns = await jiti.import(new URL("./src/index.ts", import.meta.url).pathname);
const assert = (await import("node:assert")).strict;
const vw = piTui.visibleWidth;

// Fake git: in-work-tree, one staged + one untracked file; stage/unstage succeed
const gitState = { porcelain: "M  src/a.ts\n?? dir/\n", pushes: 0, commits: [] };
const fakeExec = async (cmd, args) => {
  if (cmd !== "git") return { stdout: "", stderr: "not git", code: 1, killed: false };
  const a = args.join(" ");
  if (a === "rev-parse --is-inside-work-tree") return { stdout: "true\n", stderr: "", code: 0, killed: false };
  if (a === "status --porcelain") return { stdout: gitState.porcelain, stderr: "", code: 0, killed: false };
  if (a.startsWith("diff")) return { stdout: "diff --git a/src/a.ts b/src/a.ts\n+hello\n", stderr: "", code: 0, killed: false };
  if (a === "add -A") { gitState.porcelain = "M  src/a.ts\nA  dir/\n"; return { stdout: "", stderr: "", code: 0, killed: false }; }
  if (a === "reset") { gitState.porcelain = " M src/a.ts\n?? dir/\n"; return { stdout: "", stderr: "", code: 0, killed: false }; }
  if (a.startsWith("commit -m")) { gitState.commits.push(args[2]); gitState.porcelain = "?? dir/\n"; return { stdout: "[main abc123] msg\n", stderr: "", code: 0, killed: false }; }
  if (a === "push") { gitState.pushes++; return { stdout: "", stderr: "", code: 0, killed: false }; }
  return { stdout: "", stderr: "", code: 0, killed: false };
};

// Real dark theme
const themeMod = await import(`file://${PCA}/dist/modes/interactive/theme/theme.js`);
const theme = themeMod.getThemeByName("dark");
assert.ok(theme, "dark theme loaded");

const fakeTui = { terminal: { rows: 40, columns: 120 }, requestRender: () => {} };
const fakeKb = {
  matches: (data, binding) => ({ "tui.select.up": "\x1b[A", "tui.select.down": "\x1b[B", "tui.select.confirm": "\r", "tui.select.cancel": "\x1b" }[binding] === data),
};
const notifications = [];
let doneVal = "unset";
let resolveCustom;
let popup;
const ctx = {
  mode: "tui",
  hasUI: true,
  ui: {
    notify: (m, t) => notifications.push([t, m]),
    custom: async (factory, opts) => {
      assert.deepEqual(opts, { overlay: true, overlayOptions: { width: "80%", maxHeight: "75%", anchor: "center" } });
      popup = factory(fakeTui, theme, fakeKb, (v) => { doneVal = v; resolveCustom?.(v); });
      return new Promise((res) => (resolveCustom = res));
    },
  },
  model: undefined,
  modelRegistry: { complete: async () => { throw new Error("no model in test"); } },
};

// Register + invoke the command through the real entry
let command;
const pi = {
  registerCommand: (name, opts) => (command = { name, ...opts }),
  registerShortcut: () => {},
  exec: fakeExec,
};
ns.default(pi);
assert.equal(command.name, "git-committer");
await command.handler("", ctx);
assert.ok(popup, "popup created through entry");

// Render checks at multiple sizes
for (const [w, rows] of [[100, 40], [80, 24], [60, 50], [120, 10]]) {
  fakeTui.terminal.rows = rows;
  const lines = popup.render(w);
  for (const line of lines) assert.ok(vw(line) <= w, `line exceeds width ${w}`);
  assert.ok(lines.length <= Math.floor(rows * 0.75), `too tall at rows=${rows}: ${lines.length}`);
}
fakeTui.terminal.rows = 40;
const lines = popup.render(100);
assert.ok(lines.some((l) => l.includes("Git Committer")), "title");
assert.ok(lines.some((l) => l.includes("Actions")), "actions pane");
assert.ok(lines.some((l) => l.includes("Stage all")), "action item");
assert.ok(lines.some((l) => l.includes("Staged (1)")), "staged header");
assert.ok(lines.some((l) => l.includes("Untracked (1)")), "untracked header");
assert.ok(lines.some((l) => l.includes("Commit message")), "input label");
assert.ok(lines.some((l) => l.includes("Esc Close")), "footer");

// Interaction: files pane, space toggle (fake git), then input typing
popup.handleInput("\t");        // actions -> files
popup.handleInput("\x1b[B");    // move selection
popup.handleInput(" ");         // toggle stage (async, fake git)
await new Promise((r) => setTimeout(r, 50));
popup.handleInput("\t");        // files -> input
popup.handleInput("f");         // type a char
popup.handleInput("e"); 
popup.handleInput("a"); 
popup.handleInput("t"); 
await new Promise((r) => setTimeout(r, 20));
assert.ok(popup.render(100).some((l) => l.includes("feat")), "typed text visible");

// Ctrl+Enter commit from input pane (fake git succeeds)
popup.handleInput("\x1b[13;5u"); // ctrl+enter kitty sequence
const result = await Promise.race([new Promise((r) => setTimeout(() => r("timeout"), 500)), new Promise((r) => setTimeout(() => r(doneVal), 300))]);
await new Promise((r) => setTimeout(r, 100));
console.log("done value:", JSON.stringify(doneVal));
assert.deepEqual(doneVal, { committed: "feat", pushed: false });
assert.deepEqual(gitState.commits, ["feat"]);

// Dispose should not throw
popup.dispose?.();
console.log("notifications:", JSON.stringify(notifications));
console.log("ALL CHECKS PASSED");
console.log("--- render sample (width 100, ANSI stripped) ---");
console.log(popup.render(100).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_pi:c\x07/g, "@")).join("\n"));
