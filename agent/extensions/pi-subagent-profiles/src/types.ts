import type { MainModelConfig } from "./mainModel";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type { MainModelConfig, MainModelMode } from "./mainModel";
export { MAIN_MODEL_MODES } from "./mainModel";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
}

export interface ProfileRule {
  models: string[];
  thinking?: ThinkingLevel;
  isolation?: boolean;
}

export interface Profile {
  name: string;
  description?: string;
  /** Spawn-time model/thinking/isolation injection. Default true; false turns the
   * ext into main-model switching only (routing belongs to pi-subagents profiles). */
  inject?: boolean;
  default: ProfileRule;
  overrides: Record<string, ProfileRule>;
  mainModel?: MainModelConfig;
  mainThinking?: ThinkingLevel;
}

export interface ProfileIssue {
  level: "error" | "warning";
  message: string;
}
