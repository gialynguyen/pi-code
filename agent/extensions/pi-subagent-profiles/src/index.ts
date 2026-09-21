import { statSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyMainSessionConfig,
  cycleMainModelMode,
  listProfileNames,
  readProfile,
  refreshStatus,
  resolveProfilePath,
} from "./activate";
import { hasMainModelModes, MAIN_MODEL_MODE_SHORTCUT } from "./mainModel";
import { makeAgentToolCallHandler } from "./inject";
import { isGitRepo } from "./fsutil";
import { loadGlobalState, loadProjectActive, resolveActiveName, resolveMainModelMode } from "./state";
import { handleCommand } from "./ui";
import type { Profile } from "./types";

function notify(ctx: Pick<ExtensionContext, "hasUI" | "ui">, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(`profiles: ${message}`, level);
}

// ponytail: per-process gate — the main session_start fires first in the process;
// subagent session_starts follow and must NOT re-apply mainModel/mainThinking, or
// they overwrite the profile-injected subagent model (the "deepseek then glm-5.2"
// flip). Ceiling: assumes the main session_start is first; if a child session ever
// starts before the main, switch to pi-subagents' inChildSessionContext() check.
let mainSessionConfigAppliedThisProcess = false;

export default function profileExtension(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  let latestContext: ExtensionContext | undefined;
  let cache:
    | {
        key: string;
        profile: Profile;
      }
    | undefined;
  const reportedFailures = new Set<string>();

  const getActiveProfile = (): Profile | undefined => {
    const ctx = latestContext;
    if (ctx === undefined) return undefined;
    const name = resolveActiveName(ctx.cwd, agentDir);
    if (name === null) return undefined;
    const resolved = resolveProfilePath(agentDir, name);
    if (resolved === undefined) return undefined;
    let mtime = -1;
    try {
      mtime = statSync(resolved.path).mtimeMs;
    } catch {
      mtime = -1;
    }
    const key = `${ctx.cwd}:${name}:${resolved.kind}:${mtime}`;
    if (cache?.key === key) return cache.profile;
    try {
      const profile = readProfile(agentDir, name).profile;
      cache = { key, profile };
      return profile;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!reportedFailures.has(key)) {
        reportedFailures.add(key);
        notify(ctx, message, "error");
      }
      return undefined;
    }
  };

  const agentToolHandler = makeAgentToolCallHandler({
    getActiveProfile,
    canIsolate: isGitRepo,
    log: (message) => {
      if (latestContext?.hasUI) latestContext.ui.notify(`profiles: ${message}`, "warning");
    },
  });

  // Profile-owned spawn injection (model/thinking/isolation) serves legacy YAML
  // routing. A profile with `inject: false` hands routing to pi-subagents'
  // agentOverrides and keeps only mainModel/mainThinking here.
  const injectionEnabled = (): boolean => getActiveProfile()?.inject !== false;

  const refreshForContext = (ctx: ExtensionContext): void => {
    latestContext = ctx;
    const active = resolveActiveName(ctx.cwd, agentDir);
    let mainModelMode: ReturnType<typeof resolveMainModelMode> | undefined;
    if (active !== null) {
      try {
        const profile = readProfile(agentDir, active).profile;
        if (hasMainModelModes(profile.mainModel)) mainModelMode = resolveMainModelMode(ctx.cwd, agentDir);
      } catch {
        // Lifecycle refresh is intentionally quiet when the active profile cannot be read.
      }
    }
    refreshStatus(ctx, active, mainModelMode);
  };

  const applyActiveProfileMainSession = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
    // determine scope: project value wins when the project key exists
    const projectName = loadProjectActive(ctx.cwd);
    let name: string | null;
    let scope: "global" | "project";
    if (projectName !== undefined) { name = projectName; scope = "project"; }
    else { name = loadGlobalState(agentDir).active; scope = "global"; }
    if (name === null) return;
    try {
      const profile = readProfile(agentDir, name).profile;
      const mode = resolveMainModelMode(ctx.cwd, agentDir);
      const applied = await applyMainSessionConfig(pi, ctx, profile, scope, mode);
      if (applied.model !== undefined || applied.thinking !== undefined) {
        notify(ctx, `applied active profile '${name}' main session settings`, "info");
      }
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
    }
  };

  pi.registerShortcut(MAIN_MODEL_MODE_SHORTCUT, {
    description: "Cycle main model mode (cheap → default → slow)",
    handler: async (ctx) => {
      latestContext = ctx;
      cache = undefined;
      await cycleMainModelMode(pi, ctx);
    },
  });

  pi.registerCommand("profiles", {
    description: "Manage named subagent model and thinking profiles",
    getArgumentCompletions: (argumentPrefix) => {
      const subcommands = ["list", "use", "off", "show", "validate", "strip", "create", "delete"];
      const trimmed = argumentPrefix.trim();
      const trailingSpace = /\s$/.test(argumentPrefix);
      const parts = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
      if (parts.length === 0 || (parts.length === 1 && !trailingSpace)) {
        const prefix = parts[0] ?? "";
        return subcommands
          .filter((command) => command.startsWith(prefix))
          .map((command) => ({ value: command, label: command }));
      }
      const command = parts[0];
      if (command !== "use") return null;
      const prefix = trailingSpace ? "" : parts[parts.length - 1];
      return listProfileNames(agentDir)
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ value: `use ${name}`, label: name }));
    },
    handler: async (args, ctx) => {
      latestContext = ctx;
      await handleCommand(pi, args, ctx);
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    latestContext = ctx;
    if (!injectionEnabled()) return;
    await agentToolHandler(event, ctx);
  });
  pi.on("session_start", async (_event, ctx) => {
    refreshForContext(ctx);
    if (mainSessionConfigAppliedThisProcess) return;
    // pi-subagents sets PI_SUBAGENT_CHILD=1 in its detached runner, whose first
    // session_start is a background child. Never stomp a child's resolved model.
    if (process.env.PI_SUBAGENT_CHILD === "1") return;
    mainSessionConfigAppliedThisProcess = true;
    await applyActiveProfileMainSession(pi, ctx);
  });
  pi.on("resources_discover", async (_event, ctx) => {
    refreshForContext(ctx);
  });
}
