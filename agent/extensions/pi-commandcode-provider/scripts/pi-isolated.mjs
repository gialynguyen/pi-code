#!/usr/bin/env node

import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const testRoot = await mkdtemp(join(tmpdir(), "pi-commandcode-isolated-"))
const agentDir = join(testRoot, "agent")
const sessionDir = join(testRoot, "sessions")

await mkdir(agentDir, { mode: 0o700 })
await mkdir(sessionDir, { mode: 0o700 })

const env = {
  ...process.env,
  HOME: testRoot,
  USERPROFILE: testRoot,
  PI_CODING_AGENT_DIR: agentDir,
  PI_CODING_AGENT_SESSION_DIR: sessionDir,
  PI_SKIP_VERSION_CHECK: "1",
}
delete env.COMMAND_CODE_API_KEY
delete env.COMMANDCODE_API_KEY

let activeChild
let receivedSignal

function forwardSignal(signal) {
  receivedSignal = signal
  activeChild?.kill(signal)
}

const forwardSigint = () => forwardSignal("SIGINT")
const forwardSigterm = () => forwardSignal("SIGTERM")
process.on("SIGINT", forwardSigint)
process.on("SIGTERM", forwardSigterm)

function runPi(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("pi", args, { cwd: repoRoot, env, stdio: "inherit" })
    activeChild = child
    child.once("error", rejectRun)
    child.once("exit", (status, signal) => {
      activeChild = undefined
      resolveRun({ status, signal })
    })
  })
}

let result
try {
  console.error("Installing the current checkout into an isolated pi environment...")
  const install = await runPi(["install", repoRoot, "--no-approve"])
  if (install.status !== 0 || install.signal) {
    result = install
  } else {
    console.error("Starting pi. Temporary auth and sessions will be removed on exit.")
    result = await runPi([
      "--no-approve",
      "--provider",
      "commandcode",
      "--model",
      "gpt-5.6-luna",
      ...process.argv.slice(2),
    ])
  }
} finally {
  process.removeListener("SIGINT", forwardSigint)
  process.removeListener("SIGTERM", forwardSigterm)
  await rm(testRoot, { recursive: true, force: true })
  console.error("Removed the isolated pi environment.")
}

const signal = receivedSignal ?? result?.signal
if (signal) process.kill(process.pid, signal)
process.exitCode = result?.status ?? 1
