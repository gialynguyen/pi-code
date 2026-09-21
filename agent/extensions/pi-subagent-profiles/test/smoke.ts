import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { allAgentFiles } from "../src/agents";
import { activateProfile, deactivateProfile } from "../src/activate";
import { makeAgentToolCallHandler } from "../src/inject";
import { parseJsonProfile, parseProfile, pickModel, resolveMainSession, resolveModel, serializeJsonProfile, serializeProfile, splitModelThinking, validateProfile } from "../src/profile";
import { applyRoutingFromProfile, clearRoutingFromSettings, detectSettingsProfile, listProfileNames, profileMatchesRouting, readEffectiveSubagentRouting, resolveProfilePath, readProfile, routingFromYamlProfile } from "../src/activate";
import { canonicalizeMainModelMode, MAIN_MODEL_MODE_SHORTCUT, nextMainModelMode, resolveMainModelString } from "../src/mainModel";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  buildSections,
  computeWindow,
  defaultSelectionIndex,
  filterSections,
  flattenSelectable,
  reanchorIndex,
} from "../src/picker";
import {
  loadGlobalState,
  loadProjectActive,
  resolveActiveName,
  saveGlobalState,
  saveProjectActive,
} from "../src/state";
import { handleCommand } from "../src/ui";
import type { Profile, ThinkingLevel } from "../src/types";

const available = [
  { provider: "anthropic", id: "claude-opus-4", name: "Claude Opus" },
  { provider: "openai", id: "gpt-4o", name: "GPT Four" },
  { provider: "local", id: "tiny-unique-model", name: "Tiny Local" },
  { provider: "vendor", id: "other", name: "Friendly Display" },
  { provider: "ollama-cloud", id: "deepseek-v4-flash:0731", name: "DeepSeek Flash" },
];

const pickerModels = [
  { provider: "openai", id: "gpt-4o", name: "GPT Four" },
  { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet" },
  { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
  { provider: "vendor", id: "other", name: "Friendly Display" },
];
const pickerPseudo = [{ value: "inherit", label: "inherit", description: "Use caller model" }];
const pickerSections = buildSections(pickerModels, pickerPseudo);
assert.equal(pickerSections[0]?.header, null);
assert.deepEqual(pickerSections[0]?.items.map((item) => item.id), ["inherit"]);
assert.deepEqual(pickerSections.slice(1).map((section) => section.header), ["anthropic", "openai", "vendor"]);
assert.deepEqual(pickerSections[1]?.items.map((item) => item.id), ["claude-opus-5", "claude-sonnet-4"]);
assert.deepEqual(flattenSelectable(pickerSections), [
  "inherit",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-4",
  "openai/gpt-4o",
  "vendor/other",
]);
assert.equal(filterSections(pickerSections, ""), pickerSections);
const fuzzySections = filterSections(pickerSections, "clopus");
assert.deepEqual(fuzzySections.map((section) => section.header), [null, "anthropic"]);
assert.deepEqual(flattenSelectable(fuzzySections), [
  "inherit",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-4",
]);
assert.deepEqual(filterSections(pickerSections, "gpt").map((section) => section.header), [null, "openai"]);
assert.deepEqual(flattenSelectable(filterSections(pickerSections, "gpt")), ["inherit", "openai/gpt-4o"]);
assert.deepEqual(filterSections(pickerSections, "friendly").map((section) => section.header), [null, "vendor"]);
assert.deepEqual(filterSections(pickerSections, "zzznomatch").map((section) => section.header), [null]);
assert.deepEqual(flattenSelectable(filterSections(pickerSections, "zzznomatch")), ["inherit"]);
assert.deepEqual(flattenSelectable(filterSections(pickerSections, "anthropic")), [
  "inherit",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-4",
]);
assert.equal(defaultSelectionIndex(pickerSections, ""), 0);
assert.equal(defaultSelectionIndex(filterSections(pickerSections, "gpt"), "gpt"), 1);
assert.equal(reanchorIndex("openai/gpt-4o", flattenSelectable(pickerSections)), 3);
assert.equal(reanchorIndex("missing", ["a", "b"]), 1);
assert.equal(reanchorIndex("missing", []), 0);
assert.deepEqual(computeWindow(20, 0, 10), { start: 0, end: 10 });
assert.deepEqual(computeWindow(20, 19, 10), { start: 10, end: 20 });
assert.deepEqual(computeWindow(20, 10, 10), { start: 5, end: 15 });
assert.deepEqual(computeWindow(3, 1, 10), { start: 0, end: 3 });
assert.deepEqual(computeWindow(0, 0, 10), { start: 0, end: 0 });

const goodYaml = `name: balanced
description: A test profile
default:
  models:
    - anthropic/claude-opus-4
    - gpt-4o
  thinking: medium
overrides:
  Explore:
    models: [tiny-unique-model]
mainModel: anthropic/claude-opus-4
mainThinking: high
`;
const parsed = parseProfile(goodYaml, "fallback");
assert.equal(parsed.name, "balanced");
assert.deepEqual(parsed.default.models, ["anthropic/claude-opus-4", "gpt-4o"]);
assert.equal(parsed.default.thinking, "medium");
assert.equal(parsed.overrides.Explore.models[0], "tiny-unique-model");
assert.equal(parsed.mainThinking, "high");
const multiModeYaml = `name: tiered
default:
  models: [inherit]
mainModel:
  cheap: openai/gpt-4o
  default: anthropic/claude-opus-4
  slow: anthropic/claude-opus-4:high
mainThinking: xhigh
`;
const multiMode = parseProfile(multiModeYaml, "tiered");
assert.deepEqual(multiMode.mainModel, {
  cheap: "openai/gpt-4o",
  default: "anthropic/claude-opus-4",
  slow: "anthropic/claude-opus-4:high",
});
assert.equal(multiMode.mainThinking, "xhigh");
const injectYaml = `name: routed
inject: false
default:
  models: [inherit]
mainModel: openai/gpt-4o
`;
const injectParsed = parseProfile(injectYaml, "routed");
assert.equal(injectParsed.inject, false);
assert.equal(parseProfile(injectYaml.replace("inject: false\n", ""), "routed").inject, undefined);
assert.throws(() => parseProfile("name: x\ndefault: { models: [inherit] }\ninject: maybe\n", "bad"), /inject/);
assert.match(serializeProfile(injectParsed), /inject: false/);
assert.equal(resolveMainModelString(multiMode.mainModel, "slow"), "anthropic/claude-opus-4:high");
assert.equal(nextMainModelMode("cheap"), "default");
assert.equal(nextMainModelMode("slow"), "cheap");
assert.equal(matchesKey("\r", MAIN_MODEL_MODE_SHORTCUT), false);
assert.equal(matchesKey("\n", MAIN_MODEL_MODE_SHORTCUT), false);
assert.deepEqual(resolveMainSession(multiMode, "cheap"), { model: "openai/gpt-4o", thinking: "xhigh" });
assert.deepEqual(resolveMainSession(multiMode, "slow"), { model: "anthropic/claude-opus-4", thinking: "high" });
assert.deepEqual(validateProfile(multiMode, available, []), []);
const aliasedFast = parseProfile(
  "name: aliased\ndefault:\n  models: [inherit]\nmainModel:\n  fast: openai/gpt-4o\n",
  "aliased",
);
assert.deepEqual(aliasedFast.mainModel, { cheap: "openai/gpt-4o" });
assert.equal(canonicalizeMainModelMode("fast"), "cheap");
assert.throws(() => parseProfile("default: { models: [inherit] }\nmainModel: { bad: x }\n", "bad"), /cheap, default, slow/);
assert.throws(() => parseProfile("default: { models: [inherit] }\nmainModel: {}\n", "bad"), /at least one/);
assert.throws(
  () => parseProfile("default: { models: [inherit] }\nmainModel:\n  fast: openai/gpt-4o\n  cheap: openai/gpt-4o\n", "bad"),
  /set more than once/,
);
assert.throws(() => parseProfile("default: { models: [] }", "bad"), /non-empty string array/);
assert.throws(() => parseProfile("default: { models: [gpt-4o], thinking: nope }", "bad"), /thinking/);
assert.throws(() => parseProfile("default: { models: [gpt-4o] }\nmainThinking: nope", "bad"), /mainThinking/);
assert.throws(() => parseProfile("default: { models: gpt-4o }", "bad"), /non-empty string array/);
assert.throws(() => parseProfile("- list item", "bad"), /mapping/);
const roundTrip = parseProfile(serializeProfile(parsed), "fallback");
assert.deepEqual(roundTrip, parsed);
const withoutMainThinking = parseProfile("name: no-main-thinking\ndefault:\n  models: [inherit]\n", "fallback");
assert.equal(withoutMainThinking.mainThinking, undefined);
assert.deepEqual(parseProfile(serializeProfile(withoutMainThinking), "fallback"), withoutMainThinking);
const isolationYaml = `name: isolation
default:
  models: [inherit]
  isolation: true
overrides:
  Explore:
    models: [inherit]
    isolation: false
`;
const isolationParsed = parseProfile(isolationYaml, "isolation");
assert.equal(isolationParsed.default.isolation, true);
assert.equal(isolationParsed.overrides.Explore.isolation, false);
const isolationRoundTrip = parseProfile(serializeProfile(isolationParsed), "isolation");
assert.equal(isolationRoundTrip.default.isolation, true);
assert.equal(isolationRoundTrip.overrides.Explore.isolation, false);
assert.equal(parseProfile(serializeProfile(withoutMainThinking), "fallback").default.isolation, undefined);
assert.throws(() => parseProfile('default: { models: [inherit], isolation: "yes" }', "bad"), /isolation must be a boolean/);

assert.equal(resolveModel("anthropic/claude-opus-4", available)?.provider, "anthropic");
assert.equal(resolveModel("gpt-4o", available)?.provider, "openai");
assert.equal(resolveModel("tiny-unique", available)?.id, "tiny-unique-model");
assert.equal(resolveModel("friendly display", available)?.id, "other");
assert.equal(resolveModel("inherit", [{ provider: "p", id: "inherit-model", name: "Inherit" }]), undefined);
assert.equal(
  resolveModel("shared", [
    { provider: "one", id: "shared", name: "One" },
    { provider: "two", id: "shared", name: "Two" },
  ]),
  undefined,
);
assert.equal(
  resolveModel("fragment", [
    { provider: "one", id: "fragment-a", name: "One" },
    { provider: "two", id: "fragment-b", name: "Two" },
  ]),
  undefined,
);
const chain = { models: ["does-not-exist", "gpt-4o", "anthropic/claude-opus-4"] };
const pickedDefault = pickModel(chain, available);
assert.equal(pickedDefault !== undefined && pickedDefault !== "inherit" ? pickedDefault.model.id : undefined, "gpt-4o");
assert.equal(pickedDefault !== undefined && pickedDefault !== "inherit" ? pickedDefault.thinking : undefined, undefined);
assert.equal(pickModel(["inherit"], available), "inherit");
assert.equal(pickModel(["bad", "inherit"], available), "inherit");
assert.equal(pickModel(["bad"], available), undefined);
const inheritProfile = parseProfile("name: inherit\ndefault:\n  models: [inherit]\n", "inherit");
assert.deepEqual(validateProfile(inheritProfile, available, []), []);

// per-model thinking suffix parsing: last ':' segment is a thinking override
// only when it is a valid ThinkingLevel, otherwise the whole string is the id.
assert.deepEqual(splitModelThinking("anthropic/claude-opus-4-7:medium"), { model: "anthropic/claude-opus-4-7", thinking: "medium" });
assert.deepEqual(splitModelThinking("ollama-cloud/minimax-m3"), { model: "ollama-cloud/minimax-m3" });
assert.deepEqual(splitModelThinking("deepseek-v4-flash:0731"), { model: "deepseek-v4-flash:0731" });
assert.deepEqual(splitModelThinking("deepseek-v4-flash:0731:max"), { model: "deepseek-v4-flash:0731", thinking: "max" });
assert.deepEqual(splitModelThinking("ollama-cloud/deepseek-v4-flash:0731:max"), { model: "ollama-cloud/deepseek-v4-flash:0731", thinking: "max" });
assert.deepEqual(splitModelThinking("inherit"), { model: "inherit" });
assert.deepEqual(splitModelThinking("inherit:medium"), { model: "inherit", thinking: "medium" });
assert.deepEqual(splitModelThinking("anthropic/claude-opus-4:Medum"), { model: "anthropic/claude-opus-4:Medum" });

// pickModel returns the per-model thinking of the resolved entry.
const suffixedPick = pickModel({ models: ["anthropic/claude-opus-4:medium", "openai/gpt-4o"] }, available);
assert.equal(suffixedPick !== undefined && suffixedPick !== "inherit" ? suffixedPick.model.id : undefined, "claude-opus-4");
assert.equal(suffixedPick !== undefined && suffixedPick !== "inherit" ? suffixedPick.thinking : undefined, "medium");

// when the suffixed entry does not resolve, the fallback carries no per-model thinking.
const fallthroughPick = pickModel({ models: ["anthropic/claude-haiku-99:high", "openai/gpt-4o"] }, available);
assert.equal(fallthroughPick !== undefined && fallthroughPick !== "inherit" ? fallthroughPick.model.id : undefined, "gpt-4o");
assert.equal(fallthroughPick !== undefined && fallthroughPick !== "inherit" ? fallthroughPick.thinking : undefined, undefined);

// colon-in-id models resolve bare and with a thinking suffix.
const colonIdPick = pickModel({ models: ["ollama-cloud/deepseek-v4-flash:0731"] }, available);
assert.equal(colonIdPick !== undefined && colonIdPick !== "inherit" ? colonIdPick.model.id : undefined, "deepseek-v4-flash:0731");
assert.equal(colonIdPick !== undefined && colonIdPick !== "inherit" ? colonIdPick.thinking : undefined, undefined);
const colonIdSuffixedPick = pickModel({ models: ["ollama-cloud/deepseek-v4-flash:0731:max"] }, available);
assert.equal(colonIdSuffixedPick !== undefined && colonIdSuffixedPick !== "inherit" ? colonIdSuffixedPick.model.id : undefined, "deepseek-v4-flash:0731");
assert.equal(colonIdSuffixedPick !== undefined && colonIdSuffixedPick !== "inherit" ? colonIdSuffixedPick.thinking : undefined, "max");

// validation: a valid suffix resolves cleanly; a typo'd level stays in the id and warns.
const suffixedValidProfile = parseProfile(
  "name: suffixed\ndefault:\n  models:\n    - anthropic/claude-opus-4:medium\n    - openai/gpt-4o\n  thinking: max\n",
  "suffixed",
);
assert.deepEqual(validateProfile(suffixedValidProfile, available, []), []);
const typoProfile = parseProfile(
  "name: typo\ndefault:\n  models:\n    - anthropic/claude-opus-4:medum\n  thinking: max\n",
  "typo",
);
const typoIssues = validateProfile(typoProfile, available, []);
assert.ok(typoIssues.some((issue) => issue.level === "warning" && /does not resolve/.test(issue.message)));
assert.ok(typoIssues.some((issue) => issue.level === "error" && /no resolvable model/.test(issue.message)));

// serialize round-trip preserves per-model thinking suffixes verbatim.
const suffixedRoundTrip = parseProfile(
  "name: suffixed-rt\ndefault:\n  models:\n    - anthropic/claude-opus-4:medium\n    - ollama-cloud/deepseek-v4-flash:0731:max\n  thinking: max\n",
  "suffixed-rt",
);
assert.deepEqual(suffixedRoundTrip.default.models, ["anthropic/claude-opus-4:medium", "ollama-cloud/deepseek-v4-flash:0731:max"]);
assert.equal(suffixedRoundTrip.default.thinking, "max");
assert.deepEqual(parseProfile(serializeProfile(suffixedRoundTrip), "suffixed-rt"), suffixedRoundTrip);

const handlerContext = {
  cwd: "/",
  modelRegistry: { getAvailable: () => available },
  scopedModels: [],
};
const overrideProfile: Profile = {
  name: "handler",
  default: { models: ["openai/gpt-4o"], thinking: "medium" },
  overrides: { Explore: { models: ["local/tiny-unique-model"], thinking: "low" } },
};
const overrideHandler = makeAgentToolCallHandler({
  getActiveProfile: () => overrideProfile,
  canIsolate: () => true,
  log: () => undefined,
});
const overrideInput: Record<string, unknown> = { subagent_type: "eXpLoRe", model: "caller/model", thinking: "off" };
await overrideHandler({ toolName: "Agent", input: overrideInput }, handlerContext);
assert.equal(overrideInput.model, "local/tiny-unique-model");
assert.equal(overrideInput.thinking, "low");
const defaultInput: Record<string, unknown> = { subagent_type: "other" };
await overrideHandler({ toolName: "Agent", input: defaultInput }, handlerContext);
assert.equal(defaultInput.model, "openai/gpt-4o");
assert.equal(defaultInput.thinking, "medium");

// a per-model thinking suffix overrides the rule thinking for the resolved model.
const perModelProfile: Profile = {
  name: "per-model",
  default: { models: ["anthropic/claude-opus-4:medium", "openai/gpt-4o"], thinking: "max" },
  overrides: {},
};
const perModelHandler = makeAgentToolCallHandler({
  getActiveProfile: () => perModelProfile,
  canIsolate: () => true,
  log: () => undefined,
});
const perModelInput: Record<string, unknown> = { subagent_type: "other", thinking: "off" };
await perModelHandler({ toolName: "Agent", input: perModelInput }, handlerContext);
assert.equal(perModelInput.model, "anthropic/claude-opus-4");
assert.equal(perModelInput.thinking, "medium");

// when the suffixed model does not resolve, the plain fallback uses the rule thinking.
const fallthroughProfile: Profile = {
  name: "fallthrough",
  default: { models: ["anthropic/claude-haiku-99:medium", "openai/gpt-4o"], thinking: "max" },
  overrides: {},
};
const fallthroughHandler = makeAgentToolCallHandler({
  getActiveProfile: () => fallthroughProfile,
  canIsolate: () => true,
  log: () => undefined,
});
const fallthroughInput: Record<string, unknown> = { subagent_type: "other", thinking: "off" };
await fallthroughHandler({ toolName: "Agent", input: fallthroughInput }, handlerContext);
assert.equal(fallthroughInput.model, "openai/gpt-4o");
assert.equal(fallthroughInput.thinking, "max");

// a colon-in-id model with a per-model thinking suffix resolves and overrides.
const colonIdProfile: Profile = {
  name: "colon-id",
  default: { models: ["ollama-cloud/deepseek-v4-flash:0731:max"], thinking: "low" },
  overrides: {},
};
const colonIdHandler = makeAgentToolCallHandler({
  getActiveProfile: () => colonIdProfile,
  canIsolate: () => true,
  log: () => undefined,
});
const colonIdInput: Record<string, unknown> = { subagent_type: "other", thinking: "off" };
await colonIdHandler({ toolName: "Agent", input: colonIdInput }, handlerContext);
assert.equal(colonIdInput.model, "ollama-cloud/deepseek-v4-flash:0731");
assert.equal(colonIdInput.thinking, "max");

const unresolvedLogs: string[] = [];
const unresolvedProfile: Profile = {
  name: "unresolved",
  default: { models: ["bad-model"], thinking: "high" },
  overrides: {},
};
const unresolvedHandler = makeAgentToolCallHandler({
  getActiveProfile: () => unresolvedProfile,
  canIsolate: () => true,
  log: (message) => unresolvedLogs.push(message),
});
const unresolvedInput: Record<string, unknown> = { model: "caller/model", thinking: "off" };
await unresolvedHandler({ toolName: "Agent", input: unresolvedInput }, handlerContext);
await unresolvedHandler({ toolName: "Agent", input: unresolvedInput }, handlerContext);
assert.equal(unresolvedInput.model, "caller/model");
assert.equal(unresolvedInput.thinking, "high");
assert.equal(unresolvedLogs.length, 1);
const inheritLogs: string[] = [];
const inheritHandler = makeAgentToolCallHandler({
  getActiveProfile: () => ({ name: "inherit", default: { models: ["inherit"] }, overrides: {} }),
  canIsolate: () => true,
  log: (message) => inheritLogs.push(message),
});
const inheritInput: Record<string, unknown> = { model: "caller/model" };
await inheritHandler({ toolName: "Agent", input: inheritInput }, handlerContext);
assert.equal(inheritInput.model, "caller/model");
assert.equal(inheritLogs.length, 0);

const isolationLogs: string[] = [];
const isolationHandler = makeAgentToolCallHandler({
  getActiveProfile: () => ({ name: "isolation", default: { models: ["inherit"], isolation: true }, overrides: {} }),
  canIsolate: () => true,
  log: (message) => isolationLogs.push(message),
});
const isolationInput: Record<string, unknown> = { subagent_type: "other" };
await isolationHandler({ toolName: "Agent", input: isolationInput }, handlerContext);
assert.equal(isolationInput.isolation, "worktree");
const untouchedIsolationInput: Record<string, unknown> = { subagent_type: "other", isolation: "worktree" };
const noIsolationHandler = makeAgentToolCallHandler({
  getActiveProfile: () => ({ name: "no-isolation", default: { models: ["inherit"] }, overrides: {} }),
  canIsolate: () => true,
  log: () => undefined,
});
await noIsolationHandler({ toolName: "Agent", input: untouchedIsolationInput }, handlerContext);
assert.equal(untouchedIsolationInput.isolation, "worktree");
const falseIsolationInput: Record<string, unknown> = { subagent_type: "other" };
const falseIsolationHandler = makeAgentToolCallHandler({
  getActiveProfile: () => ({ name: "false-isolation", default: { models: ["inherit"], isolation: false }, overrides: {} }),
  canIsolate: () => true,
  log: () => undefined,
});
await falseIsolationHandler({ toolName: "Agent", input: falseIsolationInput }, handlerContext);
assert.equal(falseIsolationInput.isolation, undefined);
const noGitLogs: string[] = [];
const noGitHandler = makeAgentToolCallHandler({
  getActiveProfile: () => ({ name: "no-git", default: { models: ["inherit"], isolation: true }, overrides: {} }),
  canIsolate: () => false,
  log: (message) => noGitLogs.push(message),
});
const noGitInput: Record<string, unknown> = { subagent_type: "other" };
await noGitHandler({ toolName: "Agent", input: noGitInput }, handlerContext);
assert.equal(noGitInput.isolation, undefined);
await noGitHandler({ toolName: "Agent", input: noGitInput }, handlerContext);
assert.equal(noGitInput.isolation, undefined);
assert.equal(noGitLogs.filter((message) => message.includes("isolation")).length, 1);

// arhen's `subagent` tool: single mode injects top-level, tasks/chain inject per task.
const arhenProfile: Profile = {
  name: "arhen",
  default: { models: ["openai/gpt-4o"], thinking: "medium" },
  overrides: { reviewer: { models: ["anthropic/claude-opus-4"], thinking: "high" } },
};
const arhenHandler = makeAgentToolCallHandler({
  getActiveProfile: () => arhenProfile,
  canIsolate: () => true,
  log: () => undefined,
});
const arhenSingle: Record<string, unknown> = { agent: "reviewer", task: "review the diff", model: "caller/model" };
await arhenHandler({ toolName: "subagent", input: arhenSingle }, handlerContext);
assert.equal(arhenSingle.model, "anthropic/claude-opus-4");
assert.equal(arhenSingle.thinking, "high");
const arhenTasks: Record<string, unknown> = {
  tasks: [
    { agent: "reviewer", task: "a", model: "caller/model", thinking: "off" },
    { agent: "api-mapper", task: "b" },
  ],
  chain: [{ agent: "writer", task: "c" }],
};
await arhenHandler({ toolName: "subagent", input: arhenTasks }, handlerContext);
const arhenTaskList = arhenTasks.tasks as Record<string, unknown>[];
const arhenChainList = arhenTasks.chain as Record<string, unknown>[];
assert.equal(arhenTaskList[0].model, "anthropic/claude-opus-4");
assert.equal(arhenTaskList[0].thinking, "high");
assert.equal(arhenTaskList[1].model, "openai/gpt-4o");
assert.equal(arhenTaskList[1].thinking, "medium");
assert.equal(arhenChainList[0].model, "openai/gpt-4o");
assert.equal(arhenChainList[0].thinking, "medium");

const root = mkdtempSync(join(tmpdir(), "pi-subagent-profiles-smoke-"));
const cwd = join(root, "project");
const agentDir = join(root, "agent");
mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
mkdirSync(join(cwd, ".agents", "agents"), { recursive: true });
mkdirSync(join(agentDir, "agents"), { recursive: true });
const projectAgentPath = join(cwd, ".pi", "agents", "project-agent.md");
const workspaceAgentPath = join(cwd, ".agents", "agents", "workspace-agent.md");
const globalAgentPath = join(agentDir, "agents", "global-agent.md");
const pinnedAgent = "---\nmodel: openai/gpt-4o\nthinking: low\n---\nbody\n";
writeFileSync(projectAgentPath, pinnedAgent, "utf8");
writeFileSync(workspaceAgentPath, pinnedAgent, "utf8");
writeFileSync(globalAgentPath, pinnedAgent, "utf8");
assert.equal(allAgentFiles(cwd, agentDir).length, 3);

process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "subagent-profiles", "profiles"), { recursive: true });
writeFileSync(
  join(agentDir, "subagent-profiles", "profiles", "one.yaml"),
  serializeProfile({ name: "one", default: { models: ["inherit"] }, overrides: {}, mainModel: "anthropic/claude-opus-4" }),
  "utf8",
);
writeFileSync(
  join(agentDir, "subagent-profiles", "profiles", "two.yaml"),
  serializeProfile({ name: "two", default: { models: ["inherit"] }, overrides: {}, mainModel: "openai/gpt-4o" }),
  "utf8",
);

// pi-subagents JSON profiles: parse, dual-store resolution, routing read/write
const jsonProfileText = JSON.stringify({
  name: "routed",
  subagents: {
    defaultModel: "anthropic/claude-opus-4",
    defaultThinking: "high",
    agentOverrides: {
      scout: { model: "openai/gpt-4o", thinking: "low" },
      worker: { model: "openai/gpt-4o:high" },
      legacy: { thinking: false, machine: "box1" },
    },
    disableBuiltins: true,
  },
  mainModel: { cheap: "openai/gpt-4o", default: "anthropic/claude-opus-4:high" },
  mainThinking: "xhigh",
});
const jsonParsed = parseJsonProfile(jsonProfileText, "routed");
assert.equal(jsonParsed.profile.inject, false);
assert.deepEqual(jsonParsed.profile.default, { models: ["anthropic/claude-opus-4"], thinking: "high" });
assert.deepEqual(jsonParsed.profile.overrides.scout, { models: ["openai/gpt-4o"], thinking: "low" });
assert.deepEqual(jsonParsed.profile.overrides.worker, { models: ["openai/gpt-4o:high"] });
assert.equal("thinking" in jsonParsed.profile.overrides.legacy, false);
assert.deepEqual(jsonParsed.profile.mainModel, { cheap: "openai/gpt-4o", default: "anthropic/claude-opus-4:high" });
assert.equal(jsonParsed.profile.mainThinking, "xhigh");
assert.equal(resolveMainSession(jsonParsed.profile, "default")?.thinking, "high");
assert.deepEqual(validateProfile(jsonParsed.profile, available, []), []);
assert.throws(() => parseJsonProfile('{"subagents":{"agentOverrides":{"a":{"fallbackModels":["x"]}}}}', "bad"), /fallbackModels/);
assert.throws(() => parseJsonProfile('{"subagents":{"agentOverrides":{"a":{"thinking":"bogus"}}}}', "bad"), /thinking/);
assert.throws(() => parseJsonProfile('{"subagents":{}}', "bad"), /subagents/);

mkdirSync(join(agentDir, "profiles", "pi-subagents"), { recursive: true });
writeFileSync(join(agentDir, "profiles", "pi-subagents", "routed.json"), `${jsonProfileText}\n`, "utf8");
writeFileSync(join(agentDir, "subagent-profiles", "profiles", "routed.yaml"), serializeProfile({ name: "routed", default: { models: ["inherit"] }, overrides: {} }), "utf8");
assert.deepEqual(resolveProfilePath(agentDir, "routed"), { path: join(agentDir, "profiles", "pi-subagents", "routed.json"), kind: "json" });
assert.deepEqual(listProfileNames(agentDir), ["one", "routed", "two"]);
const routedSource = readProfile(agentDir, "routed");
assert.equal(routedSource.kind, "json");
assert.equal(routedSource.subagentsBlock?.disableBuiltins, true);

writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ subagents: { disableBuiltins: true, agentOverrides: { reviewer: { machine: "pin" }, old: { model: "x" } } } }), "utf8");
applyRoutingFromProfile(agentDir, jsonParsed.subagentsBlock, "global", cwd);
const mergedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
assert.equal(mergedSettings.subagents.disableBuiltins, true);
assert.equal(mergedSettings.subagents.agentOverrides.reviewer.machine, "pin");
assert.equal(mergedSettings.subagents.agentOverrides.scout.model, "openai/gpt-4o");
// the profile owns the complete agent mapping; unrelated previous overrides are dropped
assert.equal("old" in mergedSettings.subagents.agentOverrides, false);

const userRouting = readEffectiveSubagentRouting(agentDir, cwd);
assert.equal(userRouting.paths.length, 1);
assert.equal(profileMatchesRouting(jsonParsed.subagentsBlock, userRouting), true);
assert.equal(detectSettingsProfile(agentDir, cwd), "routed");

// project scope writes the routing into the project's .pi/settings.json
const projectSettingsPath = join(cwd, ".pi", "settings.json");
const beforeProjectRouting = existsSync(projectSettingsPath) ? JSON.parse(readFileSync(projectSettingsPath, "utf8")) : {};
const projectPath = applyRoutingFromProfile(agentDir, jsonParsed.subagentsBlock, "project", cwd);
assert.equal(projectPath, projectSettingsPath);
const afterProject = JSON.parse(readFileSync(projectSettingsPath, "utf8"));
assert.equal(afterProject.subagents.agentOverrides.scout.model, "openai/gpt-4o");
for (const [key, value] of Object.entries(beforeProjectRouting)) {
  if (key !== "subagents") assert.deepEqual(afterProject[key], value);
}
assert.equal(detectSettingsProfile(agentDir, cwd), "routed");
assert.equal(clearRoutingFromSettings(projectSettingsPath), projectSettingsPath);
writeFileSync(
  join(cwd, ".pi", "settings.json"),
  JSON.stringify({ subagents: { agentOverrides: { scout: { model: "override/x" } } } }),
  "utf8",
);
const projectRouting = readEffectiveSubagentRouting(agentDir, cwd);
const projectOverrides = projectRouting.block?.agentOverrides as Record<string, Record<string, unknown>> | undefined;
assert.equal(projectOverrides?.scout?.model, "override/x");
assert.equal(profileMatchesRouting(jsonParsed.subagentsBlock, projectRouting), false);
assert.equal(detectSettingsProfile(agentDir, cwd), null);

// YAML profiles also drive routing: chains collapse to the first resolvable entry
const yamlRoutingProfile: Profile = {
  name: "legacy",
  default: { models: ["openai/gpt-4o", "missing/model"] },
  overrides: {
    scout: { models: ["inherit"] }, // inherit: no model opinion, thinking stays
    worker: { models: ["missing/model", "anthropic/claude-opus-4"], thinking: "high" },
    vision: { models: ["missing/model"], thinking: "max" },
  },
};
const derived = routingFromYamlProfile(yamlRoutingProfile, available);
assert.equal(derived.defaultModel, "openai/gpt-4o");
assert.deepEqual(derived.agentOverrides, {
  worker: { model: "anthropic/claude-opus-4", thinking: "high" },
  vision: { thinking: "max" },
});
assert.equal("defaultThinking" in derived, false);

// /profiles off clears routing keys but keeps unrelated settings
const offSettingsPath = join(agentDir, "settings.json");
writeFileSync(
  offSettingsPath,
  JSON.stringify({ subagents: { defaultModel: "openai/gpt-4o", defaultThinking: "low", agentOverrides: { scout: { model: "openai/gpt-4o" } }, disableBuiltins: true, machines: { box: { cwd: "/x" } } } }),
  "utf8",
);
assert.equal(clearRoutingFromSettings(offSettingsPath), offSettingsPath);
const afterOff = JSON.parse(readFileSync(offSettingsPath, "utf8"));
assert.deepEqual(afterOff.subagents, { disableBuiltins: true, machines: { box: { cwd: "/x" } } });
assert.equal(clearRoutingFromSettings(offSettingsPath), null);
writeFileSync(offSettingsPath, JSON.stringify({ subagents: { defaultModel: "openai/gpt-4o" } }), "utf8");
assert.equal(clearRoutingFromSettings(offSettingsPath), offSettingsPath);
assert.equal("subagents" in JSON.parse(readFileSync(offSettingsPath, "utf8")), false);

// created JSON profiles serialize in pi-subagents store shape and reparse
const createdJson = serializeJsonProfile({
  name: "made",
  description: "wizard",
  subagentsBlock: { defaultModel: "openai/gpt-4o", agentOverrides: { scout: { model: "inherit", thinking: "low" } } },
  mainModel: { cheap: "openai/gpt-4o", default: "anthropic/claude-opus-4" },
  mainThinking: "max",
});
const createdParsed = parseJsonProfile(createdJson, "made");
assert.equal(createdParsed.profile.name, "made");
assert.equal(createdParsed.profile.description, "wizard");
assert.deepEqual(createdParsed.profile.default, { models: ["openai/gpt-4o"] });
assert.deepEqual(createdParsed.profile.overrides.scout, { models: ["inherit"], thinking: "low" });
assert.deepEqual(createdParsed.profile.mainModel, { cheap: "openai/gpt-4o", default: "anthropic/claude-opus-4" });
assert.equal(createdParsed.profile.mainThinking, "max");
assert.deepEqual(createdParsed.subagentsBlock, {
  defaultModel: "openai/gpt-4o",
  agentOverrides: { scout: { model: "inherit", thinking: "low" } },
});
const globalState = {
  active: "global-profile",
  mainModelBackup: { provider: "openai", id: "gpt-4o" },
  mainModelApplied: { provider: "anthropic", id: "claude-opus-4", scope: "global" as const },
};
const thinkingState = {
  active: "thinking-profile",
  mainThinkingBackup: "low" as const,
  mainThinkingApplied: { level: "high" as const, scope: "project" as const },
};
saveGlobalState(agentDir, thinkingState);
assert.deepEqual(loadGlobalState(agentDir), thinkingState);
saveGlobalState(agentDir, {
  active: null,
  mainThinkingBackup: null,
  mainThinkingApplied: null,
});
assert.deepEqual(loadGlobalState(agentDir), {
  active: null,
  mainThinkingBackup: null,
  mainThinkingApplied: null,
});
saveGlobalState(agentDir, globalState);
assert.deepEqual(loadGlobalState(agentDir), globalState);
assert.equal(existsSync(join(agentDir, "subagent-profiles", `state.json.tmp-${process.pid}`)), false);
saveGlobalState(agentDir, { active: null, mainModelBackup: null, mainModelApplied: null });
assert.deepEqual(loadGlobalState(agentDir), { active: null, mainModelBackup: null, mainModelApplied: null });
writeFileSync(
  join(agentDir, "subagent-profiles", "state.json"),
  JSON.stringify({ active: "kept-mode", mainModelMode: "fast" }),
  "utf8",
);
assert.equal(loadGlobalState(agentDir).mainModelMode, "cheap");
saveGlobalState(agentDir, globalState);
assert.equal(loadProjectActive(cwd), undefined);
assert.equal(resolveActiveName(cwd, agentDir), "global-profile");
saveProjectActive(cwd, "project-profile");
assert.equal(loadProjectActive(cwd), "project-profile");
assert.equal(resolveActiveName(cwd, agentDir), "project-profile");
saveProjectActive(cwd, null);
assert.equal(loadProjectActive(cwd), undefined);
writeFileSync(join(cwd, ".pi", "subagent-profiles.json"), '{"active":null}\n', "utf8");
assert.equal(loadProjectActive(cwd), null);
assert.equal(resolveActiveName(cwd, agentDir), null);
saveProjectActive(cwd, "project-profile");
saveProjectActive(cwd, null);
assert.equal(loadProjectActive(cwd), undefined);
assert.equal(resolveActiveName(cwd, agentDir), "global-profile");
writeFileSync(
  join(agentDir, "subagent-profiles", "state.json"),
  JSON.stringify({ active: "kept", mainModelBackup: { provider: 4, id: "bad" }, mainModelApplied: globalState.mainModelApplied }),
  "utf8",
);
const corruptBackupState = loadGlobalState(agentDir);
assert.equal(corruptBackupState.active, "kept");
assert.equal("mainModelBackup" in corruptBackupState, false);
assert.deepEqual(corruptBackupState.mainModelApplied, globalState.mainModelApplied);
writeFileSync(
  join(agentDir, "subagent-profiles", "state.json"),
  JSON.stringify({ active: "kept-again", mainModelBackup: globalState.mainModelBackup, mainModelApplied: { provider: 4, id: "bad", scope: "global" } }),
  "utf8",
);
const corruptAppliedState = loadGlobalState(agentDir);
assert.equal(corruptAppliedState.active, "kept-again");
assert.deepEqual(corruptAppliedState.mainModelBackup, globalState.mainModelBackup);
assert.equal("mainModelApplied" in corruptAppliedState, false);
writeFileSync(
  join(agentDir, "subagent-profiles", "state.json"),
  JSON.stringify({ active: "kept-thinking", mainThinkingBackup: "low", mainThinkingApplied: { level: "bogus", scope: "global" } }),
  "utf8",
);
const corruptThinkingAppliedState = loadGlobalState(agentDir);
assert.equal(corruptThinkingAppliedState.active, "kept-thinking");
assert.equal(corruptThinkingAppliedState.mainThinkingBackup, "low");
assert.equal("mainThinkingApplied" in corruptThinkingAppliedState, false);

const fakeRegistry = {
  getAvailable: () => available,
  find: (provider: string, id: string) => available.find((model) => model.provider === provider && model.id === id),
};
const makeContext = (model: (typeof available)[number]): ExtensionContext =>
  ({
    cwd,
    model,
    hasUI: false,
    ui: {},
    modelRegistry: fakeRegistry,
    scopedModels: [],
    isProjectTrusted: () => true,
  }) as unknown as ExtensionContext;
const restoreCalls: string[] = [];
let thinkingLevel: ThinkingLevel = "off";
const fakePi = {
  getThinkingLevel: () => thinkingLevel,
  setThinkingLevel: (level: ThinkingLevel) => {
    thinkingLevel = level;
  },
  setModel: async (model: { provider: string; id: string }) => {
    restoreCalls.push(`${model.provider}/${model.id}`);
    return true;
  },
} as unknown as ExtensionAPI;
saveGlobalState(agentDir, { active: null, mainModelBackup: null, mainModelApplied: null });
await activateProfile(fakePi, makeContext(available[2]), "one", "project");
assert.deepEqual(loadGlobalState(agentDir), {
  active: null,
  mainModelBackup: { provider: "local", id: "tiny-unique-model" },
  mainModelApplied: { provider: "anthropic", id: "claude-opus-4", scope: "project" },
});
await activateProfile(fakePi, makeContext(available[2]), "two", "project");
assert.deepEqual(loadGlobalState(agentDir), {
  active: null,
  mainModelBackup: { provider: "local", id: "tiny-unique-model" },
  mainModelApplied: { provider: "openai", id: "gpt-4o", scope: "project" },
});
assert.equal(loadProjectActive(cwd), "two");
restoreCalls.length = 0;
await deactivateProfile(fakePi, makeContext(available[1]), "project");
assert.deepEqual(restoreCalls, ["local/tiny-unique-model"]);
assert.deepEqual(loadGlobalState(agentDir), { active: null, mainModelBackup: null, mainModelApplied: null });
const failedPi = {
  getThinkingLevel: () => thinkingLevel,
  setThinkingLevel: (level: ThinkingLevel) => {
    thinkingLevel = level;
  },
  setModel: async () => false,
} as unknown as ExtensionAPI;
await activateProfile(failedPi, makeContext(available[2]), "one", "global");
assert.deepEqual(loadGlobalState(agentDir), { active: "one", mainModelMode: "default", mainModelBackup: null, mainModelApplied: null });
saveGlobalState(agentDir, { active: null, mainModelBackup: null, mainModelApplied: null });
saveGlobalState(agentDir, {
  active: "active",
  mainModelBackup: { provider: "openai", id: "gpt-4o" },
  mainModelApplied: { provider: "anthropic", id: "claude-opus-4", scope: "global" },
});
restoreCalls.length = 0;
await deactivateProfile(fakePi, makeContext(available[3]), "global");
assert.deepEqual(restoreCalls, []);
assert.deepEqual(loadGlobalState(agentDir), { active: null, mainModelBackup: null, mainModelApplied: null });
saveGlobalState(agentDir, {
  active: "active",
  mainModelBackup: { provider: "openai", id: "gpt-4o" },
  mainModelApplied: { provider: "anthropic", id: "claude-opus-4", scope: "global" },
});
await deactivateProfile(fakePi, makeContext(available[0]), "global");
assert.deepEqual(restoreCalls, ["openai/gpt-4o"]);
assert.deepEqual(loadGlobalState(agentDir), { active: null, mainModelBackup: null, mainModelApplied: null });
saveGlobalState(agentDir, {
  active: "active",
  mainModelBackup: { provider: "openai", id: "gpt-4o" },
  mainModelApplied: { provider: "anthropic", id: "claude-opus-4", scope: "project" },
});
await deactivateProfile(fakePi, makeContext(available[0]), "global");
assert.deepEqual(loadGlobalState(agentDir), {
  active: null,
  mainModelBackup: { provider: "openai", id: "gpt-4o" },
  mainModelApplied: { provider: "anthropic", id: "claude-opus-4", scope: "project" },
});
saveProjectActive(cwd, "active");
saveGlobalState(agentDir, {
  active: "global-active",
  mainModelBackup: { provider: "openai", id: "gpt-4o" },
  mainModelApplied: { provider: "anthropic", id: "claude-opus-4", scope: "project" },
});
await deactivateProfile(fakePi, makeContext(available[0]), "project");
assert.equal(loadProjectActive(cwd), undefined);
assert.deepEqual(loadGlobalState(agentDir), {
  active: "global-active",
  mainModelBackup: null,
  mainModelApplied: null,
});
const originalBackup = { provider: "local", id: "tiny-unique-model" };
saveGlobalState(agentDir, { active: "one", mainModelBackup: originalBackup, mainModelApplied: { ...globalState.mainModelApplied } });
saveGlobalState(agentDir, { active: "two", mainModelBackup: originalBackup, mainModelApplied: { provider: "openai", id: "gpt-4o", scope: "global" } });
assert.deepEqual(loadGlobalState(agentDir).mainModelBackup, originalBackup);

// /profiles show prints the ACTIVE profile only.
writeFileSync(
  join(agentDir, "subagent-profiles", "profiles", "showcase.yaml"),
  serializeProfile({
    name: "showcase",
    default: { models: ["anthropic/claude-opus-4", "gpt-4o"], thinking: "medium", isolation: true },
    overrides: {
      Explore: { models: ["tiny-unique-model"], thinking: "low" },
      Plan: { models: ["inherit"], isolation: false },
    },
    mainModel: "anthropic/claude-opus-4",
    mainThinking: "high",
  }),
  "utf8",
);
const showNotes: { message: string; level: string }[] = [];
const showCtx = {
  cwd,
  hasUI: true,
  ui: { notify: (message: string, level: string) => showNotes.push({ message, level }) },
} as unknown as ExtensionCommandContext;
await handleCommand({} as ExtensionAPI, "show showcase", showCtx);
assert.deepEqual(showNotes, [{ message: "profiles: usage: /profiles show (shows the active profile)", level: "error" }]);

saveGlobalState(agentDir, { active: "showcase", mainModelBackup: null, mainModelApplied: null });
showNotes.length = 0;
await handleCommand({} as ExtensionAPI, "show", showCtx);
assert.deepEqual(
  showNotes.map((note) => note.message),
  [
    [
      "profiles: showcase (yaml)",
      "  'main': anthropic/claude-opus-4 (high)",
      "  'default': anthropic/claude-opus-4 -> gpt-4o (medium); isolation: on",
      "  'Explore' (overrided): tiny-unique-model (low)",
      "  'Plan' (overrided): inherit; isolation: off",
    ].join("\n"),
  ],
);

showNotes.length = 0;
saveGlobalState(agentDir, { active: null, mainModelBackup: null, mainModelApplied: null });
await handleCommand({} as ExtensionAPI, "show", showCtx);
assert.deepEqual(showNotes, [{ message: "profiles: no active profile", level: "warning" }]);

rmSync(root, { recursive: true, force: true });
console.log("ALL PASS");
