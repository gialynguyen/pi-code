import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"

interface PackageManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const CORE_PEERS = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"] as const

async function readPackageManifest(): Promise<PackageManifest> {
  const contents = await readFile(new URL("../package.json", import.meta.url), "utf-8")
  return JSON.parse(contents) as PackageManifest
}

describe("package manifest", () => {
  it("uses pi's bundled core packages instead of installing private runtime copies", async () => {
    const manifest = await readPackageManifest()

    for (const packageName of CORE_PEERS) {
      assert.equal(manifest.dependencies?.[packageName], undefined)
      assert.equal(manifest.devDependencies?.[packageName], undefined)
      assert.equal(manifest.peerDependencies?.[packageName], "*")
      assert.equal(manifest.peerDependenciesMeta?.[packageName]?.optional, true)
    }
  })
})
