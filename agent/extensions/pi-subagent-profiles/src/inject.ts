import { pickModel } from "./profile";
import type { ModelInfo, Profile, ProfileRule } from "./types";

export interface AgentToolModel {
  provider: string;
  id: string;
  name: string;
}

export interface AgentToolCallContext {
  cwd: string;
  modelRegistry: {
    getAvailable(): readonly AgentToolModel[];
  };
  scopedModels: readonly { model: AgentToolModel }[];
}

interface AgentInput {
  model?: unknown;
  thinking?: unknown;
  isolation?: unknown;
  subagent_type?: unknown;
  [key: string]: unknown;
}

/**
 * A subagent extension's spawn tool, described in the terms this handler needs:
 * the tool it is registered as, which input field names the agent type, and
 * whether the tool accepts an `isolation` value at all.
 */
interface SpawnToolTarget {
  readonly toolName: string;
  readonly typeFields: readonly string[];
  readonly acceptsIsolation: boolean;
}

/**
 * Spawn tools this extension knows how to inject into. `Agent` is pi's own
 * Claude-style subagent tool; `spawn_agent` is wj-pi-subagents, whose agent
 * type is a `template_id`; `subagent` is @arhen/pi-core-subagent, whose agent
 * name is an `agent` field and whose parallel/chain tasks each carry their own
 * `model`/`thinking` in `tasks[]`/`chain[]`. All accept `model` and `thinking`;
 * only `Agent` takes `isolation`.
 */
interface SpawnToolTarget {
  readonly toolName: string;
  readonly typeFields: readonly string[];
  readonly acceptsIsolation: boolean;
  /** Array fields whose items are per-task inputs to also inject into. */
  readonly listFields?: readonly string[];
}

const SPAWN_TOOL_TARGETS: readonly SpawnToolTarget[] = [
  { toolName: "Agent", typeFields: ["subagent_type"], acceptsIsolation: true },
  { toolName: "spawn_agent", typeFields: ["template_id"], acceptsIsolation: false },
  { toolName: "subagent", typeFields: ["agent"], acceptsIsolation: false, listFields: ["tasks", "chain"] },
];

function spawnTargetFor(toolName: unknown): SpawnToolTarget | undefined {
  if (typeof toolName !== "string") return undefined;
  return SPAWN_TOOL_TARGETS.find((target) => target.toolName === toolName);
}

function readAgentType(input: AgentInput, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Task inputs to inject into: the call input itself, plus per-task items for multi-task tools. */
function taskRecords(input: AgentInput, target: SpawnToolTarget): AgentInput[] {
  const records: AgentInput[] = [input];
  for (const field of target.listFields ?? []) {
    const list = input[field];
    if (Array.isArray(list)) {
      for (const item of list) {
        if (isRecord(item)) records.push(item as AgentInput);
      }
    }
  }
  return records;
}

interface EventView {
  toolName?: unknown;
  input?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toModelInfo(model: AgentToolModel): ModelInfo {
  return { provider: model.provider, id: model.id, name: model.name };
}

function matchingRule(profile: Profile, subagentType: string | undefined): ProfileRule {
  if (subagentType !== undefined) {
    const wanted = subagentType.toLocaleLowerCase();
    for (const [agent, rule] of Object.entries(profile.overrides)) {
      if (agent.toLocaleLowerCase() === wanted) return rule;
    }
  }
  return profile.default;
}

/** Inject one task input's model/thinking; returns the type name when no model resolved (for the warning). */
function injectRecord(
  input: AgentInput,
  profile: Profile,
  available: ModelInfo[],
  target: SpawnToolTarget,
): string | undefined {
  try {
    const subagentType = readAgentType(input, target.typeFields);
    const rule = matchingRule(profile, subagentType);
    const picked = pickModel(rule, available);
    if (picked === undefined) {
      if (rule.thinking !== undefined) input.thinking = rule.thinking;
      return subagentType ?? "default";
    }
    if (picked !== "inherit") input.model = `${picked.model.provider}/${picked.model.id}`;
    const effectiveThinking =
      picked === undefined || picked === "inherit" ? rule.thinking : picked.thinking ?? rule.thinking;
    if (effectiveThinking !== undefined) input.thinking = effectiveThinking;
  } catch {
    // A bad record must not break injection into its siblings.
  }
  return undefined;
}

export function makeAgentToolCallHandler(deps: {
  getActiveProfile: () => Profile | undefined;
  log: (msg: string) => void;
  canIsolate: (cwd: string) => boolean;
}): (event: unknown, ctx: AgentToolCallContext) => Promise<void> {
  const warnedNoModel = new Set<string>();
  const warnedNoGit = new Set<string>();
  return async (event, ctx): Promise<void> => {
    try {
      if (!isRecord(event)) return;
      const view = event as EventView;
      const target = spawnTargetFor(view.toolName);
      if (target === undefined || !isRecord(view.input)) return;
      const input = view.input as AgentInput;
      const profile = deps.getActiveProfile();
      if (profile === undefined) return;

      const available = ctx.modelRegistry.getAvailable().map(toModelInfo);
      for (const record of taskRecords(input, target)) {
        const miss = injectRecord(record, profile, available, target);
        if (miss !== undefined) {
          const warningKey = `${profile.name}:${miss}`;
          if (!warnedNoModel.has(warningKey)) {
            warnedNoModel.add(warningKey);
            deps.log(`profile '${profile.name}': no valid model for ${miss}, inheriting parent`);
          }
        }
      }
      const topRule = matchingRule(profile, readAgentType(input, target.typeFields));
      if (topRule.isolation === true && target.acceptsIsolation) {
        if (deps.canIsolate(ctx.cwd)) {
          input.isolation = "worktree";
        } else {
          const warningKey = profile.name;
          if (!warnedNoGit.has(warningKey)) {
            warnedNoGit.add(warningKey);
            deps.log(`profile '${profile.name}': isolation requested but the project is not a git repository; spawning without worktree isolation`);
          }
        }
      }
    } catch (error) {
      try {
        deps.log(`profile injection failed: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // A logging adapter must not make a tool call fail.
      }
    }
  };
}
