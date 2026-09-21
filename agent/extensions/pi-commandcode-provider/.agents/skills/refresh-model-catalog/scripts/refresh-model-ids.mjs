#!/usr/bin/env node
// Refreshes tests/fixtures/commandcode-model-ids.json from the live Command Code
// models API. Run from the repository root:
//   node .agents/skills/refresh-model-catalog/scripts/refresh-model-ids.mjs
import { writeFile } from "node:fs/promises"

import { format, resolveConfig } from "prettier"

const MODELS_URL = "https://api.commandcode.ai/provider/v1/models"
const FIXTURE_PATH = new URL(
  "../../../../tests/fixtures/commandcode-model-ids.json",
  import.meta.url,
)

const response = await fetch(MODELS_URL)
if (!response.ok) {
  throw new Error(`Failed to fetch Command Code models: ${response.status} ${response.statusText}`)
}

const body = await response.json()
if (body?.object !== "list" || !Array.isArray(body.data)) {
  throw new Error("Expected a Command Code models list response")
}

const modelIds = body.data.map((model) => {
  if (typeof model?.id !== "string" || model.id.length === 0) {
    throw new Error("Expected each model entry to have a non-empty id")
  }
  return model.id
})
if (modelIds.length === 0) throw new Error("Command Code returned an empty model catalog")

const fixture = { fetchedAt: new Date().toISOString(), source: MODELS_URL, modelIds }
const options = await resolveConfig(new URL("../../../../.prettierrc.json", import.meta.url))
const contents = await format(JSON.stringify(fixture), {
  ...options,
  filepath: "commandcode-model-ids.json",
})
await writeFile(FIXTURE_PATH, contents, "utf-8")
console.log(`Wrote ${modelIds.length} model ids to tests/fixtures/commandcode-model-ids.json`)
