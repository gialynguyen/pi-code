/**
 * instructions-loader — manage markdown instructions injected into the system
 * prompt after the first user message.
 *
 *   Global : ~/.pi/agent/instructions/*.md
 *   Project: <cwd>/.pi/instructions/*.md   (only when the project is trusted)
 *
 * Scopes:
 *   global/project — persisted in <dir>/state.json (disabled-names-only)
 *   session        — in-memory 3-valued overlay, dies with the conversation
 *
 * Mechanism: `before_agent_start` fires on every user prompt (first one =
 * "after the first message"), and the <user_instruction> block is rebuilt from
 * current on-disk state every turn — so toggles apply on the next message and
 * there is nothing to invalidate. Sessions that never send a message never
 * pay for the tokens.
 *
 * Ceiling: instructions do not propagate into Agent-tool subagents (pi does
 * not expose their system prompt to extensions).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { InstructionsOverlay, makeTheme } from "./overlay.js";
import {
  buildUserInstructionsBlock,
  cycleSession,
  effectiveOn,
  ensureDirs,
  instructionsDirs,
  scanDirs,
  sessionKey,
  sessionOf,
  setPersisted,
  type InstructionRow,
  type SessionOverride,
} from "./core.js";

export default function (pi: ExtensionAPI) {
  /** session-scope overrides, keyed by "<scope>:<name>". Ephemeral by design. */
  const sessionOverrides = new Map<string, SessionOverride>();

  // New conversation (also in-process fork/switch) → session overrides die.
  pi.on("session_start", async (event) => {
    if (event.reason !== "reload") sessionOverrides.clear();
  });

  const scan = (ctx: { cwd: string; isProjectTrusted(): boolean }) => {
    const dirs = instructionsDirs(ctx.cwd);
    ensureDirs(dirs);
    return { dirs, rows: scanDirs(dirs, ctx.isProjectTrusted()) };
  };

  const isActive = (row: InstructionRow) =>
    !row.shadowed && effectiveOn(row, sessionOf(row, sessionOverrides));

  pi.on("before_agent_start", async (event, ctx) => {
    const { rows } = scan(ctx);
    const block = buildUserInstructionsBlock(rows, sessionOverrides);
    if (!block) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + block };
  });

  // ── /instructions [enable|disable <name> [--global|--project|--session] | reload] ──

  // With a scope flag: exactly that scope. Without: the effective copy —
  // first non-shadowed match in scan order (global first, project wins collisions).
  const resolveTarget = (rows: InstructionRow[], name: string, scopeFlag?: "global" | "project"): InstructionRow | undefined =>
    scopeFlag
      ? rows.find((r) => r.name === name && r.scope === scopeFlag)
      : rows.find((r) => r.name === name && !r.shadowed);

  const toggle = async (ctx: ExtensionCommandContext, verb: "enable" | "disable", name: string, flags: string[]) => {
    const enabled = verb === "enable";
    const scopeFlag = flags.includes("--global") ? "global" : flags.includes("--project") ? "project" : undefined;
    const sessionFlag = flags.includes("--session");
    const unknown = flags.filter((f) => !["--global", "--project", "--session"].includes(f));
    if (unknown.length > 0) {
      ctx.ui.notify(`Unknown flag ${unknown[0]}`, "warning");
      return;
    }

    const { dirs, rows } = scan(ctx);
    const row = resolveTarget(rows, name, scopeFlag);
    if (!row) {
      const names = rows.map((r) => r.name).join(", ");
      ctx.ui.notify(`No instruction "${name}"${names ? ` (have: ${names})` : " (no instructions found)"}`, "warning");
      return;
    }

    if (sessionFlag) {
      sessionOverrides.set(sessionKey(row), enabled ? "force-on" : "force-off");
      ctx.ui.notify(`${row.name} ${enabled ? "forced on" : "forced off"} for this session`, "info");
    } else {
      setPersisted(row.scope === "global" ? dirs.global : dirs.project!, row.name, enabled);
      ctx.ui.notify(`${row.name} ${enabled ? "enabled" : "disabled"} (${row.scope}) — applies next message`, "info");
    }
  };

  pi.registerCommand("instructions", {
    description: "Manage instructions loaded into the system prompt",
    getArgumentCompletions: (prefix) => {
      const tokens = prefix.split(/\s+/);
      const last = tokens[tokens.length - 1] ?? "";
      const matches = (v: string) => v.toLowerCase().startsWith(last.toLowerCase());
      if (tokens.length <= 1) {
        return ["enable", "disable", "reload"].filter(matches).map((s) => ({ value: s, label: s }));
      }
      // Completing the instruction name — second token.
      if (tokens.length === 2) {
        const dirs = instructionsDirs(process.cwd());
        const names = scanDirs(dirs, true).map((r) => ({ value: r.name, label: r.name, description: r.scope }));
        return names.filter((item, i, arr) => arr.findIndex((x) => x.value === item.value) === i && matches(item.value));
      }
      return null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) {
        await openOverlay(ctx);
        return;
      }
      const [sub, ...rest] = tokens;
      if (sub === "reload") {
        const { rows } = scan(ctx);
        ctx.ui.notify(`Instructions: ${rows.filter(isActive).length} active of ${rows.length}`, "info");
        return;
      }
      if (sub === "enable" || sub === "disable") {
        const name = rest.find((t) => !t.startsWith("--"));
        if (!name) {
          ctx.ui.notify(`Usage: /instructions ${sub} <name> [--global|--project|--session]`, "info");
          return;
        }
        await toggle(ctx, sub, name, rest.filter((t) => t.startsWith("--")));
        return;
      }
      ctx.ui.notify("Usage: /instructions [enable|disable <name> [--global|--project|--session]] | reload", "info");
    },
  });

  // ── Interactive overlay ──

  async function openOverlay(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("/instructions UI needs an interactive session", "warning");
      return;
    }
    await ctx.ui.custom((tui, piTheme, _kb, done) => {
      const overlay = new InstructionsOverlay(
        () => scan(ctx).rows, // fresh scan on every render — no cache to invalidate
        (row) => sessionOf(row, sessionOverrides),
        () => tui.terminal.rows,
        makeTheme(piTheme),
        {
          onClose: () => done(null),
          onToggle: (row) => {
            const { dirs } = scan(ctx);
            setPersisted(row.scope === "global" ? dirs.global : dirs.project!, row.name, !row.persistedOn);
          },
          onCycleSession: (row) => {
            sessionOverrides.set(sessionKey(row), cycleSession(sessionOf(row, sessionOverrides)));
          },
        },
      );
      return {
        render: (w: number) => overlay.render(w),
        invalidate: () => overlay.invalidate(),
        handleInput: (d: string) => {
          overlay.handleInput(d);
          tui.requestRender();
        },
      };
    }, {
      overlay: true,
      overlayOptions: { width: "70%", minWidth: 50, maxHeight: "80%", anchor: "center", margin: 2 },
    });
  }
}
