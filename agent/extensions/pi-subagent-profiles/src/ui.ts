import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { activateProfile, deactivateProfile, readProfile } from "./activate";
import { formatMainModelConfig } from "./profile";
import { loadProjectActive, resolveActiveName } from "./state";
import { openProfileManager } from "./manager";
import type { ProfileRule } from "./types";

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) ctx.ui.notify(`profiles: ${message}`, level);
}

function parseScope(args: string[], defaultScope: "global" | "project"): "global" | "project" | undefined {
  if (args.length === 0) return defaultScope;
  if (args.length === 1 && args[0] === "--global") return "global";
  if (args.length === 1 && args[0] === "--project") return "project";
  return undefined;
}

function formatRule(rule: ProfileRule): string {
  const chain = rule.models.join(" -> ");
  const thinking = rule.thinking === undefined ? "" : ` (${rule.thinking})`;
  const isolation = rule.isolation === undefined ? "" : `; isolation: ${rule.isolation ? "on" : "off"}`;
  return `${chain}${thinking}${isolation}`;
}

/** The `show` command prints the active profile only. */
async function showProfile(ctx: ExtensionCommandContext): Promise<void> {
  const name = resolveActiveName(ctx.cwd, getAgentDir());
  if (name === null) {
    notify(ctx, "no active profile", "warning");
    return;
  }
  try {
    const source = readProfile(getAgentDir(), name);
    const kind = source.kind === "json" ? "pi-subagents JSON" : "yaml";
    const mainThinking = source.profile.mainThinking === undefined ? "" : ` (${source.profile.mainThinking})`;
    const lines = [`${name} (${kind})`, `  'main': ${formatMainModelConfig(source.profile.mainModel)}${mainThinking}`];
    if (!(source.profile.default.models.length === 1 && source.profile.default.models[0] === "inherit" && source.profile.default.thinking === undefined)) {
      lines.push(`  'default': ${formatRule(source.profile.default)}`);
    }
    for (const agent of Object.keys(source.profile.overrides).sort()) {
      lines.push(`  '${agent}' (overrided): ${formatRule(source.profile.overrides[agent])}`);
    }
    notify(ctx, lines.join("\n"));
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

export async function handleCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    await openProfileManager(pi, ctx);
    return;
  }
  const command = tokens[0];
  const rest = tokens.slice(1);
  if (command === "use") {
    if (rest.length < 1 || rest.length > 2 || (rest.length === 2 && rest[1] !== "--global" && rest[1] !== "--project")) {
      notify(ctx, "usage: /profiles use <name> [--global|--project]", "error");
      return;
    }
    await activateProfile(pi, ctx, rest[0], rest[1] === "--global" ? "global" : "project");
    return;
  }
  if (command === "off") {
    const defaultScope = loadProjectActive(ctx.cwd) === undefined ? "global" : "project";
    const scope = parseScope(rest, defaultScope);
    if (scope === undefined) {
      notify(ctx, "usage: /profiles off [--global|--project]", "error");
      return;
    }
    await deactivateProfile(pi, ctx, scope);
    return;
  }
  if (command === "show") {
    if (rest.length !== 0) {
      notify(ctx, "usage: /profiles show (shows the active profile)", "error");
      return;
    }
    await showProfile(ctx);
    return;
  }
  notify(ctx, "usage: /profiles (console) | /profiles use <name> [--global|--project] | off [--global|--project] | show", "error");
}