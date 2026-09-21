export const MAIN_MODEL_MODES = ["cheap", "default", "slow"] as const;

/** Ctrl+M is ASCII CR, the same byte Enter sends. Use Ctrl+Shift+M. */
export const MAIN_MODEL_MODE_SHORTCUT = "ctrl+shift+m" as const;

export type MainModelMode = (typeof MAIN_MODEL_MODES)[number];

const MAIN_MODEL_MODE_ALIASES: Record<string, MainModelMode> = { fast: "cheap" };

/** Single model string or up to three named main-session tiers. */
export type MainModelConfig = string | Partial<Record<MainModelMode, string>>;

export function isMainModelMode(value: string): value is MainModelMode {
  return (MAIN_MODEL_MODES as readonly string[]).includes(value);
}

export function canonicalizeMainModelMode(value: string): MainModelMode | undefined {
  if (isMainModelMode(value)) return value;
  return MAIN_MODEL_MODE_ALIASES[value];
}

export function hasMainModelModes(config: MainModelConfig | undefined): config is Partial<Record<MainModelMode, string>> {
  return typeof config === "object" && config !== null;
}

export function parseMainModelConfig(value: unknown): MainModelConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (value.trim().length === 0) throw new Error("mainModel must be a non-empty string when provided");
    return value;
  }
  if (!isRecord(value)) throw new Error("mainModel must be a string or mapping");
  const modes: Partial<Record<MainModelMode, string>> = {};
  for (const [key, entry] of Object.entries(value)) {
    const mode = canonicalizeMainModelMode(key);
    if (mode === undefined) {
      throw new Error(`mainModel mapping keys must be one of: ${MAIN_MODEL_MODES.join(", ")}`);
    }
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`mainModel.${mode} must be a non-empty string`);
    }
    if (modes[mode] !== undefined) {
      throw new Error(`mainModel.${mode} is set more than once`);
    }
    modes[mode] = entry;
  }
  if (Object.keys(modes).length === 0) {
    throw new Error(`mainModel mapping must include at least one of: ${MAIN_MODEL_MODES.join(", ")}`);
  }
  return modes;
}

export function resolveMainModelString(config: MainModelConfig | undefined, mode: MainModelMode): string | undefined {
  if (config === undefined) return undefined;
  if (typeof config === "string") return config;
  return config[mode] ?? config.default ?? config.cheap ?? config.slow;
}

export function nextMainModelMode(current: MainModelMode): MainModelMode {
  const index = MAIN_MODEL_MODES.indexOf(current);
  return MAIN_MODEL_MODES[(index + 1) % MAIN_MODEL_MODES.length];
}

export function formatMainModelConfig(config: MainModelConfig | undefined): string {
  if (config === undefined) return "none";
  if (typeof config === "string") return config;
  return MAIN_MODEL_MODES.filter((mode) => config[mode] !== undefined)
    .map((mode) => `${mode}: ${config[mode]}`)
    .join(", ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
