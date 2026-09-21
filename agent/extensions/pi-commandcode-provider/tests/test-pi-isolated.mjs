import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const launcher = join(repoRoot, "scripts", "pi-isolated.mjs")

function runLauncher({ exitStatus = 0 } = {}) {
  const fakeBin = mkdtempSync(join(tmpdir(), "pi-commandcode-fake-bin-"))
  const logPath = join(fakeBin, "calls.jsonl")
  const fakePi = join(fakeBin, "pi")

  writeFileSync(
    fakePi,
    `#!/bin/sh
node - "$@" <<'NODE'
const { appendFileSync } = require("node:fs")
appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({
  args: process.argv.slice(2),
  agentDir: process.env.PI_CODING_AGENT_DIR,
  sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
  skipVersionCheck: process.env.PI_SKIP_VERSION_CHECK,
  home: process.env.HOME,
  userProfile: process.env.USERPROFILE,
  inheritedApiKey:
    process.env.COMMAND_CODE_API_KEY ?? process.env.COMMANDCODE_API_KEY ?? null,
}) + "\\n")
NODE
if [ "$1" = "install" ]; then exit 0; fi
exit ${exitStatus}
`,
    { mode: 0o700 },
  )

  try {
    const result = spawnSync(process.execPath, [launcher, "--model", "claude-sonnet-5"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        FAKE_PI_LOG: logPath,
        COMMAND_CODE_API_KEY: "must-not-leak-official",
        COMMANDCODE_API_KEY: "must-not-leak-legacy",
      },
      encoding: "utf8",
    })
    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    return { result, calls }
  } finally {
    rmSync(fakeBin, { recursive: true, force: true })
  }
}

describe("isolated pi launcher", () => {
  it("installs the current checkout, forwards arguments, and removes its environment", () => {
    const { result, calls } = runLauncher()

    assert.equal(result.status, 0)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0].args, ["install", repoRoot, "--no-approve"])
    assert.deepEqual(calls[1].args, [
      "--no-approve",
      "--provider",
      "commandcode",
      "--model",
      "gpt-5.6-luna",
      "--model",
      "claude-sonnet-5",
    ])

    const [install, launch] = calls
    assert.equal(install.agentDir, launch.agentDir)
    assert.equal(install.sessionDir, launch.sessionDir)
    assert.equal(launch.skipVersionCheck, "1")
    assert.equal(launch.inheritedApiKey, null)
    assert.ok(launch.agentDir.includes("pi-commandcode-isolated-"))
    assert.equal(launch.home, dirname(launch.agentDir))
    assert.equal(launch.userProfile, dirname(launch.agentDir))
    assert.equal(dirname(launch.agentDir), dirname(launch.sessionDir))
    assert.equal(existsSync(dirname(launch.agentDir)), false)
    assert.match(result.stderr, /Removed the isolated pi environment/)
  })

  it("returns the pi exit status and still removes its environment", () => {
    const { result, calls } = runLauncher({ exitStatus: 7 })

    assert.equal(result.status, 7)
    assert.equal(calls.length, 2)
    assert.equal(existsSync(dirname(calls[1].agentDir)), false)
  })
})
