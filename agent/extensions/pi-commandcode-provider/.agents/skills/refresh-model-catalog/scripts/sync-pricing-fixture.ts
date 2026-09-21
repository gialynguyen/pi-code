// Regenerates tests/fixtures/commandcode-pricing.json from src/pricing.ts so the
// snapshot always matches MODEL_COSTS. Run from the repository root:
//   npx tsx .agents/skills/refresh-model-catalog/scripts/sync-pricing-fixture.ts
import { writeFile } from "node:fs/promises"

import { format, resolveConfig } from "prettier"

import { MODEL_COSTS, PRICING_LAST_VERIFIED, PRICING_SOURCE_URL } from "../../../../src/pricing.ts"

const FIXTURE_PATH = new URL("../../../../tests/fixtures/commandcode-pricing.json", import.meta.url)

const costs: Record<string, [number, number, number, number]> = {}
const tiers: Record<string, [number, number, number, number, number][]> = {}
for (const [modelId, cost] of Object.entries(MODEL_COSTS)) {
  costs[modelId] = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite]
  if (cost.tiers) {
    tiers[modelId] = cost.tiers.map((tier) => [
      tier.inputTokensAbove,
      tier.input,
      tier.output,
      tier.cacheRead,
      tier.cacheWrite,
    ])
  }
}

const fixture = {
  verifiedAt: PRICING_LAST_VERIFIED,
  source: PRICING_SOURCE_URL,
  tierPolicy:
    "Use request-wide input tiers; the highest threshold exceeded by input plus cache tokens applies to the full request.",
  tiers,
  costs,
}
const options = await resolveConfig(new URL("../../../../.prettierrc.json", import.meta.url))
const contents = await format(JSON.stringify(fixture), {
  ...options,
  filepath: "commandcode-pricing.json",
})
await writeFile(FIXTURE_PATH, contents, "utf-8")
console.log(
  `Wrote ${Object.keys(costs).length} model prices to tests/fixtures/commandcode-pricing.json`,
)
