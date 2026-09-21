import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  MAIN_MODEL_MODES,
  parseMainModelConfig,
  resolveMainModelString,
  type MainModelConfig,
  type MainModelMode,
} from "./mainModel";
import {
  THINKING_LEVELS,
  type ModelInfo,
  type Profile,
  type ProfileIssue,
  type ProfileRule,
  type ThinkingLevel,
} from "./types";

export { formatMainModelConfig, hasMainModelModes, resolveMainModelString } from "./mainModel";

// pi-subagents stores its JSON profiles under <agentDir>/profiles/pi-subagents/.
// The extension reads the same store: the routing block belongs to pi-subagents,
// while mainModel/mainThinking are extension-owned fields pi-subagents tolerates
// and ignores (its validator only inspects the `subagents` object).
export const PI_SUBAGENTS_PROFILES_DIRNAME = "pi-subagents";

export function piSubagentsProfilesDirectory(agentDir: string): string {
  return join(agentDir, "profiles", PI_SUBAGENTS_PROFILES_DIRNAME);
}

export function jsonProfilePath(agentDir: string, name: string): string {
  return join(piSubagentsProfilesDirectory(agentDir), `${name}.json`);
}

export function jsonProfileExists(agentDir: string, name: string): boolean {
  return existsSync(jsonProfilePath(agentDir, name));
}

export interface ParsedJsonProfile {
  profile: Profile;
  /** Raw `subagents` block, passed through verbatim when writing pi-subagents settings. */
  subagentsBlock: Record<string, unknown>;
}

export function resolveMainSession(
  profile: Profile,
  mode: MainModelMode,
): { model?: string; thinking?: ThinkingLevel } {
  const entry = resolveMainModelString(profile.mainModel, mode);
  if (entry === undefined) return { thinking: profile.mainThinking };
  const { model, thinking } = splitModelThinking(entry);
  return { model, thinking: thinking ?? profile.mainThinking };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

// Split an optional per-model thinking suffix from a models-chain entry. The
// suffix is the last ':'-separated segment when it is a valid ThinkingLevel;
// otherwise the whole string is the model id, so model ids that already contain
// ':' (e.g. "deepseek-v4-flash:0731") are preserved unless a valid level is
// appended after them (e.g. "deepseek-v4-flash:0731:max"). The "inherit"
// sentinel never carries a thinking override.
export function splitModelThinking(entry: string): { model: string; thinking?: ThinkingLevel } {
  if (entry === "inherit") return { model: "inherit" };
  const colon = entry.lastIndexOf(":");
  if (colon <= 0) return { model: entry };
  const suffix = entry.slice(colon + 1);
  if (!isThinkingLevel(suffix)) return { model: entry };
  return { model: entry.slice(0, colon), thinking: suffix };
}

function parseRule(value: unknown, label: string): ProfileRule {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  const models = value.models;
  if (
    !Array.isArray(models) ||
    models.length === 0 ||
    models.some((model) => typeof model !== "string" || model.trim().length === 0)
  ) {
    throw new Error(`${label}.models must be a non-empty string array`);
  }
  const thinking = value.thinking;
  if (thinking !== undefined && !isThinkingLevel(thinking)) {
    throw new Error(`${label}.thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  const isolation = value.isolation;
  if (isolation !== undefined && typeof isolation !== "boolean") {
    throw new Error(`${label}.isolation must be a boolean`);
  }
  return {
    models: [...models] as string[],
    ...(thinking === undefined ? {} : { thinking }),
    ...(isolation === undefined ? {} : { isolation }),
  };
}

export function parseProfile(yamlText: string, fallbackName: string): Profile {
  let value: unknown;
  try {
    value = parse(yamlText) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid profile YAML: ${message}`);
  }
  if (!isRecord(value)) {
    throw new Error("Profile must be a YAML mapping");
  }

  const rawName = value.name;
  if (rawName !== undefined && (typeof rawName !== "string" || rawName.trim().length === 0)) {
    throw new Error("Profile name must be a non-empty string");
  }
  const name = rawName === undefined ? fallbackName : rawName;
  const description = value.description;
  if (description !== undefined && typeof description !== "string") {
    throw new Error("Profile description must be a string");
  }
  const inject = value.inject;
  if (inject !== undefined && typeof inject !== "boolean") {
    throw new Error("inject must be a boolean");
  }

  const defaultRule = parseRule(value.default, "default");
  const rawOverrides = value.overrides;
  if (rawOverrides !== undefined && !isRecord(rawOverrides)) {
    throw new Error("overrides must be a mapping");
  }
  const overrides: Record<string, ProfileRule> = {};
  if (rawOverrides !== undefined) {
    for (const [agent, rule] of Object.entries(rawOverrides)) {
      overrides[agent] = parseRule(rule, `overrides.${agent}`);
    }
  }

  const mainModel = parseMainModelConfig(value.mainModel);
  const mainThinking = value.mainThinking;
  if (mainThinking !== undefined && !isThinkingLevel(mainThinking)) {
    throw new Error(`mainThinking must be one of: ${THINKING_LEVELS.join(", ")}`);
  }

  return {
    name,
    ...(description === undefined ? {} : { description }),
    ...(inject === undefined ? {} : { inject }),
    default: defaultRule,
    overrides,
    ...(mainModel === undefined ? {} : { mainModel }),
    ...(mainThinking === undefined ? {} : { mainThinking }),
  };
}

function serializeRule(rule: ProfileRule): Record<string, unknown> {
  return {
    models: [...rule.models],
    ...(rule.thinking === undefined ? {} : { thinking: rule.thinking }),
    ...(rule.isolation === undefined ? {} : { isolation: rule.isolation }),
  };
}

export function serializeProfile(profile: Profile): string {
  const overrides: Record<string, Record<string, unknown>> = {};
  for (const [agent, rule] of Object.entries(profile.overrides)) {
    overrides[agent] = serializeRule(rule);
  }
  const value: Record<string, unknown> = {
    name: profile.name,
  };
  if (profile.description !== undefined) value.description = profile.description;
  if (profile.inject !== undefined) value.inject = profile.inject;
  value.default = serializeRule(profile.default);
  value.overrides = overrides;
  if (profile.mainModel !== undefined) value.mainModel = profile.mainModel;
  if (profile.mainThinking !== undefined) value.mainThinking = profile.mainThinking;
  return stringify(value, { lineWidth: 0 });
}

/**
 * Parse a pi-subagents JSON profile. The `subagents` block stays raw for routing
 * writes; the returned Profile maps it onto rules for show/validate/mainModel so
 * the existing machinery works unchanged. JSON profiles never spawn-inject.
 */
export function parseJsonProfile(jsonText: string, fallbackName: string): ParsedJsonProfile {
  let value: unknown;
  try {
    value = JSON.parse(jsonText) as unknown;
  } catch (error) {
    throw new Error(`Invalid profile JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error("Profile must be a JSON object");
  const subagents = value.subagents;
  if (!isRecord(subagents)) throw new Error("Profile must contain a 'subagents' object");
  const rawOverrides = subagents.agentOverrides;
  if (!isRecord(rawOverrides)) {
    throw new Error("Profile must contain 'subagents.agentOverrides' as an object");
  }
  const overrides: Record<string, ProfileRule> = {};
  for (const [agent, entry] of Object.entries(rawOverrides)) {
    if (!isRecord(entry)) throw new Error(`Profile has invalid override '${agent}'; expected an object.`);
    if (entry.fallbackModels !== undefined) {
      throw new Error(`Profile uses removed field fallbackModels for '${agent}'; configure one model instead.`);
    }
    if (entry.model !== undefined && (typeof entry.model !== "string" || entry.model.trim().length === 0)) {
      throw new Error(`Profile has invalid model for '${agent}'; expected a string.`);
    }
    const thinking = entry.thinking;
    // thinking:false is a pi-subagents opt-out the display mapping cannot express;
    // the raw block keeps it verbatim, the mapped rule carries no thinking opinion.
    if (thinking !== undefined && thinking !== false && !isThinkingLevel(thinking)) {
      throw new Error(`Profile has invalid thinking for '${agent}'; expected one of: ${THINKING_LEVELS.join(", ")}`);
    }
    const models = typeof entry.model === "string" ? [entry.model] : ["inherit"];
    overrides[agent] = { models, ...(typeof thinking === "string" ? { thinking } : {}) };
  }
  const defaultModel = subagents.defaultModel;
  if (defaultModel !== undefined && (typeof defaultModel !== "string" || defaultModel.trim().length === 0)) {
    throw new Error("Profile has invalid 'subagents.defaultModel'; expected a non-empty string.");
  }
  const defaultThinking = subagents.defaultThinking;
  if (defaultThinking !== undefined && defaultThinking !== false && !isThinkingLevel(defaultThinking)) {
    throw new Error(`Profile has invalid 'subagents.defaultThinking'; expected one of: ${THINKING_LEVELS.join(", ")}`);
  }
  const disableBuiltins = subagents.disableBuiltins;
  if (disableBuiltins !== undefined && typeof disableBuiltins !== "boolean") {
    throw new Error("Profile has invalid 'subagents.disableBuiltins'; expected a boolean.");
  }
  const mainModel = parseMainModelConfig(value.mainModel);
  const mainThinking = value.mainThinking;
  if (mainThinking !== undefined && !isThinkingLevel(mainThinking)) {
    throw new Error(`mainThinking must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  const description = value.description;
  if (description !== undefined && typeof description !== "string") {
    throw new Error("Profile description must be a string");
  }
  const name = typeof value.name === "string" && value.name.trim().length > 0 ? value.name : fallbackName;
  const profile: Profile = {
    name,
    ...(description !== undefined && description.trim().length > 0 ? { description } : {}),
    // JSON profiles never inject: routing is owned by pi-subagents settings.
    inject: false,
    default: {
      models: [typeof defaultModel === "string" ? defaultModel : "inherit"],
      ...(typeof defaultThinking === "string" ? { thinking: defaultThinking } : {}),
    },
    overrides,
    ...(mainModel === undefined ? {} : { mainModel }),
    ...(mainThinking === undefined ? {} : { mainThinking }),
  };
  return { profile, subagentsBlock: subagents };
}

/** Serialize a pi-subagents JSON profile (extension field order: name, description, subagents, mainModel, mainThinking). */
export function serializeJsonProfile(input: {
  name: string;
  description?: string;
  subagentsBlock: Record<string, unknown>;
  mainModel?: MainModelConfig;
  mainThinking?: ThinkingLevel;
}): string {
  const value: Record<string, unknown> = { name: input.name };
  if (input.description !== undefined && input.description.trim().length > 0) value.description = input.description;
  value.subagents = input.subagentsBlock;
  if (input.mainModel !== undefined) value.mainModel = input.mainModel;
  if (input.mainThinking !== undefined) value.mainThinking = input.mainThinking;
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isInScope(model: ModelInfo, scoped: ModelInfo[]): boolean {
  return scoped.length === 0 || scoped.some((entry) => entry.provider === model.provider && entry.id === model.id);
}

function validateMainModelEntry(
  label: string,
  entry: string,
  available: ModelInfo[],
  scoped: ModelInfo[],
): ProfileIssue[] {
  const { model: fuzzy } = splitModelThinking(entry);
  const model = resolveModel(fuzzy, available);
  if (model === undefined) {
    return [{ level: "error", message: `${label} '${entry}' does not resolve` }];
  }
  if (!isInScope(model, scoped)) {
    return [{ level: "error", message: `${label} '${entry}' is outside the model scope` }];
  }
  return [];
}

export function resolveModel(fuzzy: string, available: ModelInfo[]): ModelInfo | undefined {
  if (fuzzy === "inherit") return undefined;
  const exactReference = available.filter((model) => `${model.provider}/${model.id}` === fuzzy);
  if (exactReference.length > 1) return undefined;
  if (exactReference.length === 1) return exactReference[0];

  const exactId = available.filter((model) => model.id === fuzzy);
  if (exactId.length > 1) return undefined;
  if (exactId.length === 1) return exactId[0];

  const lower = fuzzy.toLocaleLowerCase();
  const idSubstring = available.filter((model) => model.id.toLocaleLowerCase().includes(lower));
  if (idSubstring.length > 1) return undefined;
  if (idSubstring.length === 1) return idSubstring[0];

  const nameSubstring = available.filter((model) => model.name.toLocaleLowerCase().includes(lower));
  if (nameSubstring.length !== 1) return undefined;
  return nameSubstring[0];
}

export function pickModel(
  ruleOrModels: ProfileRule | readonly string[],
  available: ModelInfo[],
): { model: ModelInfo; thinking?: ThinkingLevel } | "inherit" | undefined {
  const models: readonly string[] = Array.isArray(ruleOrModels) ? ruleOrModels : (ruleOrModels as ProfileRule).models;
  for (const entry of models) {
    const { model: fuzzy, thinking } = splitModelThinking(entry);
    if (fuzzy === "inherit") return "inherit";
    const model = resolveModel(fuzzy, available);
    if (model !== undefined) return { model, thinking };
  }
  return undefined;
}

function validateRule(label: string, rule: ProfileRule, available: ModelInfo[]): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  if (!Array.isArray(rule.models) || rule.models.length === 0) {
    issues.push({ level: "error", message: `${label} has no models` });
  }
  if (!isThinkingLevel(rule.thinking) && rule.thinking !== undefined) {
    issues.push({ level: "error", message: `${label}.thinking is invalid` });
  }
  if (rule.isolation !== undefined && typeof rule.isolation !== "boolean") {
    issues.push({ level: "error", message: `${label}.isolation is invalid` });
  }
  let hasInherit = false;
  for (const entry of rule.models) {
    const { model: fuzzy } = splitModelThinking(entry);
    if (fuzzy === "inherit") {
      hasInherit = true;
      continue;
    }
    if (resolveModel(fuzzy, available) === undefined) {
      issues.push({ level: "warning", message: `${label} model '${entry}' does not resolve` });
    }
  }
  if (!hasInherit && pickModel(rule, available) === undefined) {
    issues.push({ level: "error", message: `${label} has no resolvable model` });
  }
  return issues;
}

export function validateProfile(profile: Profile, available: ModelInfo[], scoped: ModelInfo[]): ProfileIssue[] {
  const issues = validateRule("default", profile.default, available);
  for (const [agent, rule] of Object.entries(profile.overrides)) {
    issues.push(...validateRule(`override '${agent}'`, rule, available));
  }
  if (profile.mainModel !== undefined) {
    if (typeof profile.mainModel === "string") {
      issues.push(...validateMainModelEntry("mainModel", profile.mainModel, available, scoped));
    } else {
      for (const mode of MAIN_MODEL_MODES) {
        const fuzzy = profile.mainModel[mode];
        if (fuzzy === undefined) continue;
        issues.push(...validateMainModelEntry(`mainModel.${mode}`, fuzzy, available, scoped));
      }
    }
  }
  return issues;
}
