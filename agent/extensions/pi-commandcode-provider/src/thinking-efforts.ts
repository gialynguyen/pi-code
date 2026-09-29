import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { CommandCodeReasoningEffort } from "./commandcode-catalog.ts"

/**
 * Live thinking-effort specs from models.dev, an online LLM database.
 *
 * The database reports `reasoning_options` per model *per serving provider*.
 * The model's vendor (first-party) entry is the model's own spec and wins;
 * without one the most commonly reported effort list wins. Only effort values
 * Command Code can express are kept.
 */
export const DEFAULT_THINKING_DB_URL = "https://models.dev/api.json"
export const DEFAULT_THINKING_DB_TIMEOUT_MS = 15_000

const THINKING_DB_CACHE_VERSION = 1
const VALID_EFFORTS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

export type ModelThinkingEfforts = Readonly<Record<string, readonly CommandCodeReasoningEffort[]>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Stable lookup key: the id segment after the last `/`, lowercased and without
 * Command Code pricing suffixes, so `tencent/hy3-paid` finds `tencent/Hy3`.
 */
export function modelSlug(modelId: string): string {
  const base = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId
  return base.toLowerCase().replace(/(?::free|-paid)$/, "")
}

function normalizedProvider(providerId: string): string {
  return providerId.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * Vendor providers for models hosted under a bare id. Command Code ids with a
 * `vendor/` prefix map to the provider of the same name; a vendor's own catalog
 * uses bare ids (`xai` publishes `grok-4.7`), so family names map explicitly.
 */
const BARE_ID_VENDORS: readonly (readonly [string, string])[] = [
  ["claude", "anthropic"],
  ["gpt", "openai"],
  ["grok", "xai"],
  ["gemini", "google"],
  ["deepseek", "deepseek"],
  ["glm", "zai"],
  ["kimi", "moonshot"],
  ["muse", "meta"],
  ["mimo", "xiaomi"],
  ["minimax", "minimax"],
  ["qwen", "qwen"],
  ["hy", "tencent"],
  ["longcat", "meituan"],
  ["step", "stepfun"],
  ["nemotron", "nvidia"],
  ["fugu", "sakana"],
  ["inkling", "thinkingmachines"],
  ["ling", "inclusionai"],
  ["laguna", "poolside"],
  ["space-bunny", "stealth"],
]

function vendorProviders(modelId: string): readonly string[] {
  const slash = modelId.indexOf("/")
  if (slash > 0) return [normalizedProvider(modelId.slice(0, slash))]
  const lower = modelId.toLowerCase()
  return BARE_ID_VENDORS.filter(([family]) => lower.startsWith(family)).map(([, vendor]) => vendor)
}

function isVendorProvider(providerId: string, modelId: string): boolean {
  return vendorProviders(modelId).some((vendor) => {
    const provider = normalizedProvider(providerId)
    return provider === vendor || provider.startsWith(vendor) || vendor.startsWith(provider)
  })
}

function effortList(options: unknown): CommandCodeReasoningEffort[] {
  if (!Array.isArray(options)) return []
  const efforts: CommandCodeReasoningEffort[] = []
  for (const option of options) {
    if (!isRecord(option) || option.type !== "effort" || !Array.isArray(option.values)) continue
    for (const value of option.values) {
      if (typeof value === "string" && VALID_EFFORTS.has(value)) {
        efforts.push(value as CommandCodeReasoningEffort)
      }
    }
  }
  return [...new Set(efforts)]
}

/** Most commonly reported list; ties go to the more capable list. */
function pickEfforts(
  lists: readonly (readonly CommandCodeReasoningEffort[])[],
): CommandCodeReasoningEffort[] {
  const counts = new Map<string, { list: readonly CommandCodeReasoningEffort[]; count: number }>()
  for (const list of lists) {
    const key = list.join(",")
    const entry = counts.get(key)
    if (entry) entry.count += 1
    else counts.set(key, { list, count: 1 })
  }
  const ranked = [...counts.values()].sort(
    (left, right) => right.count - left.count || right.list.length - left.list.length,
  )
  return [...(ranked[0]?.list ?? [])]
}

/**
 * Extracts `slug -> thinking efforts` from a models.dev `api.json` document.
 */
export function thinkingEffortsFromDatabase(database: unknown): ModelThinkingEfforts {
  if (!isRecord(database)) throw new Error("Expected the thinking database to be an object")

  interface Candidates {
    vendor: CommandCodeReasoningEffort[][]
    all: CommandCodeReasoningEffort[][]
  }
  const bySlug = new Map<string, Candidates>()

  for (const [providerId, provider] of Object.entries(database)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!isRecord(model)) continue
      const list = effortList(model.reasoning_options)
      if (list.length === 0) continue
      const candidates = bySlug.get(modelSlug(modelId)) ?? { vendor: [], all: [] }
      const target = isVendorProvider(providerId, modelId) ? candidates.vendor : candidates.all
      target.push(list)
      bySlug.set(modelSlug(modelId), candidates)
    }
  }

  const efforts: Record<string, readonly CommandCodeReasoningEffort[]> = {}
  for (const [slug, candidates] of [...bySlug.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const picked = pickEfforts(candidates.vendor.length > 0 ? candidates.vendor : candidates.all)
    if (picked.length > 0) efforts[slug] = picked
  }
  return efforts
}

/** Thinking efforts previously fetched from the database, if any. */
export function thinkingEffortsForModel(
  efforts: ModelThinkingEfforts,
  modelId: string,
): readonly CommandCodeReasoningEffort[] | undefined {
  const list = efforts[modelSlug(modelId)]
  return list && list.length > 0 ? list : undefined
}

function emptyResult(): { efforts: ModelThinkingEfforts; source: "none" } {
  return { efforts: {}, source: "none" }
}

async function readCache(cachePath: string): Promise<ModelThinkingEfforts | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(cachePath, "utf-8"))
    if (
      !isRecord(parsed) ||
      parsed.version !== THINKING_DB_CACHE_VERSION ||
      !isRecord(parsed.efforts)
    ) {
      return undefined
    }
    return thinkingEffortsFromCachedRecord(parsed.efforts)
  } catch {
    return undefined
  }
}

function thinkingEffortsFromCachedRecord(record: Record<string, unknown>): ModelThinkingEfforts {
  const efforts: Record<string, readonly CommandCodeReasoningEffort[]> = {}
  for (const [slug, value] of Object.entries(record)) {
    if (!Array.isArray(value)) continue
    const list = value.filter(
      (entry): entry is CommandCodeReasoningEffort =>
        typeof entry === "string" && VALID_EFFORTS.has(entry),
    )
    if (list.length > 0) efforts[slug] = list
  }
  return efforts
}

/** Reads the cached database without touching the network. */
export async function loadCachedThinkingEfforts(cachePath: string): Promise<ModelThinkingEfforts> {
  return (await readCache(cachePath)) ?? {}
}

export interface LoadThinkingEffortsOptions {
  cachePath: string
  url?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}

export interface LoadThinkingEffortsResult {
  efforts: ModelThinkingEfforts
  source: "live" | "cache" | "none"
  warning?: string
}

/**
 * Fetches the thinking-effort database, falling back to the last cached copy.
 * `COMMANDCODE_THINKING_DB_URL=off` disables the fetch entirely.
 *
 * ponytail: fetches the full models.dev document (~5MB) per refresh; switch to
 * per-model lookups if that ever matters.
 */
export async function loadThinkingEfforts(
  options: LoadThinkingEffortsOptions,
): Promise<LoadThinkingEffortsResult> {
  const url = options.url ?? DEFAULT_THINKING_DB_URL
  if (url === "off" || url === "none" || url === "disabled") return emptyResult()

  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_THINKING_DB_TIMEOUT_MS
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)

  try {
    const response = await fetchImpl(url, { signal })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const database: unknown = await response.json()
    const efforts = thinkingEffortsFromDatabase(database)
    await writeCache(options.cachePath, efforts)
    return { efforts, source: "live" }
  } catch (error) {
    if (options.signal?.aborted) throw error
    const cached = await readCache(options.cachePath)
    if (cached) return { efforts: cached, source: "cache" }
    return {
      ...emptyResult(),
      warning: `Could not fetch thinking-effort specs (${error instanceof Error ? error.message : String(error)}); using the catalog snapshot.`,
    }
  }
}

async function writeCache(cachePath: string, efforts: ModelThinkingEfforts): Promise<void> {
  try {
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(
      cachePath,
      `${JSON.stringify({ version: THINKING_DB_CACHE_VERSION, efforts }, null, 2)}\n`,
      { encoding: "utf-8", mode: 0o600 },
    )
  } catch {
    // A missing cache only costs a future fetch; never fail the refresh over it.
  }
}
