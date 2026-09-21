#!/usr/bin/env node

import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execFile, spawn } from "node:child_process"
import process from "node:process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const KIB_PER_MIB = 1024
const RUNS = positiveInteger(process.env.MEMORY_BENCHMARK_RUNS, 6)
const WARMUP_MS = positiveInteger(process.env.MEMORY_BENCHMARK_WARMUP_MS, 2500)
const SAMPLE_COUNT = positiveInteger(process.env.MEMORY_BENCHMARK_SAMPLES, 12)
const SAMPLE_INTERVAL_MS = positiveInteger(process.env.MEMORY_BENCHMARK_INTERVAL_MS, 100)

const basePath = requiredPath("MEMORY_BENCHMARK_BASE_PATH")
const headPath = requiredPath("MEMORY_BENCHMARK_HEAD_PATH")
const piCli = requiredPath("MEMORY_BENCHMARK_PI_CLI")
const outputPath = resolve(process.env.MEMORY_BENCHMARK_OUTPUT ?? "memory-benchmark.md")
const jsonOutputPath = resolve(process.env.MEMORY_BENCHMARK_JSON_OUTPUT ?? "memory-benchmark.json")
const baseSha = process.env.MEMORY_BENCHMARK_BASE_SHA ?? "base"
const headSha = process.env.MEMORY_BENCHMARK_HEAD_SHA ?? "head"
const piVersion = process.env.MEMORY_BENCHMARK_PI_VERSION ?? "unknown"
const runtimeName = process.versions.bun ? "Bun" : "Node"
const runtimeVersion = process.versions.bun ?? process.versions.node

const benchmarkDir = await mkdtemp(join(tmpdir(), "pi-memory-benchmark-"))
const cachePath = join(benchmarkDir, "commandcode-models.json")
await writeFile(
  cachePath,
  `${JSON.stringify(
    {
      version: 1,
      models: [
        {
          id: "memory-benchmark-model",
          name: "Memory Benchmark Model (CC)",
          reasoning: true,
          contextWindow: 128_000,
          maxTokens: 65_536,
        },
      ],
    },
    null,
    2,
  )}\n`,
)

const variants = {
  baseline: { label: "pi without extension", extensionPath: undefined },
  base: { label: `Base (${shortSha(baseSha)})`, extensionPath: basePath },
  head: { label: `PR (${shortSha(headSha)})`, extensionPath: headPath },
}

const results = Object.fromEntries(Object.keys(variants).map((key) => [key, []]))

console.log(
  `Benchmarking ${RUNS} alternating rounds with pi ${piVersion}, ${runtimeName} ${runtimeVersion}, ` +
    `${SAMPLE_COUNT} samples after ${WARMUP_MS} ms warm-up`,
)

// Discard one cold run per variant before collecting measurements.
for (const key of ["baseline", "base", "head"]) {
  console.log(`Cold warm-up: ${variants[key].label}`)
  await measureProcess(variants[key].extensionPath)
}

for (let round = 0; round < RUNS; round += 1) {
  const order = round % 2 === 0 ? ["baseline", "base", "head"] : ["baseline", "head", "base"]
  console.log(`Round ${round + 1}/${RUNS}: ${order.map((key) => variants[key].label).join(" → ")}`)

  for (const key of order) {
    const measurement = await measureProcess(variants[key].extensionPath)
    results[key].push(measurement)
    console.log(`  ${variants[key].label}: ${formatProgress(measurement)}`)
  }
}

const summary = Object.fromEntries(
  Object.entries(results).map(([key, measurements]) => [key, summarize(measurements)]),
)
const comparisons = summarizeComparisons(results)
const report = renderReport(summary, comparisons)

await writeFile(outputPath, report)
await writeFile(
  jsonOutputPath,
  `${JSON.stringify(
    {
      metadata: {
        baseSha,
        headSha,
        piVersion,
        runtimeName,
        runtimeVersion,
        runs: RUNS,
        warmupMs: WARMUP_MS,
        sampleCount: SAMPLE_COUNT,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
      },
      runs: results,
      summary,
      comparisons,
    },
    null,
    2,
  )}\n`,
)

console.log(`Wrote ${outputPath}`)
console.log(`Wrote ${jsonOutputPath}`)

async function measureProcess(extensionPath) {
  const args = [
    piCli,
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
  ]
  if (extensionPath) args.push("-e", extensionPath)

  const child = spawn(process.execPath, args, {
    detached: true,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: join(benchmarkDir, "pi-agent"),
      PI_OFFLINE: "1",
      COMMANDCODE_MODELS_CACHE: cachePath,
      COMMANDCODE_MODELS_URL: "http://127.0.0.1:9/provider/v1/models",
    },
    stdio: ["pipe", "pipe", "pipe"],
  })

  let stderr = ""
  child.stdout.resume()
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8")
    if (stderr.length > 16_384) stderr = stderr.slice(-16_384)
  })

  try {
    await wait(WARMUP_MS)
    ensureRunning(child, stderr)

    const samples = []
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      samples.push(await readSampledMemory(child.pid))
      await wait(SAMPLE_INTERVAL_MS)
      ensureRunning(child, stderr)
    }

    const sampled = Object.fromEntries(
      Object.keys(samples[0]).map((metric) => [
        metric,
        metric === "peakRss"
          ? Math.max(...samples.map((sample) => sample[metric]))
          : median(samples.map((sample) => sample[metric])),
      ]),
    )
    const snapshot = process.platform === "darwin" ? await readDarwinFootprint(child.pid) : {}
    return { ...sampled, ...snapshot }
  } finally {
    stopProcessGroup(child)
    await Promise.race([onceExit(child), wait(3000)])
    stopProcessGroup(child, "SIGKILL")
  }
}

async function readSampledMemory(pid) {
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "rss=", "-p", String(pid)])
    const rssKiB = Number.parseInt(stdout.trim(), 10)
    if (!Number.isFinite(rssKiB)) throw new Error(`Could not parse RSS from ps output: ${stdout}`)
    return { rss: rssKiB / KIB_PER_MIB }
  }

  if (process.platform === "linux") return readLinuxMemory(pid)
  throw new Error(`Unsupported memory benchmark platform: ${process.platform}`)
}

async function readDarwinFootprint(pid) {
  const { stdout } = await execFileAsync("/usr/bin/footprint", [
    "-p",
    String(pid),
    "-f",
    "bytes",
    "--noCategories",
  ])
  const footprint = /Footprint:\s*(\d+) B/.exec(stdout)
  const peak = /phys_footprint_peak:\s*(\d+) B/.exec(stdout)
  if (!footprint || !peak) throw new Error(`Could not parse macOS footprint output:\n${stdout}`)

  return {
    physicalFootprint: Number(footprint[1]) / 1024 / 1024,
    physicalPeak: Number(peak[1]) / 1024 / 1024,
  }
}

async function readLinuxMemory(pid) {
  const [status, smaps] = await Promise.all([
    readFile(`/proc/${pid}/status`, "utf8"),
    readFile(`/proc/${pid}/smaps_rollup`, "utf8"),
  ])
  const statusValues = parseKiBFields(status)
  const smapsValues = parseKiBFields(smaps)
  const privateMemory =
    (smapsValues.Private_Clean ?? 0) +
    (smapsValues.Private_Dirty ?? 0) +
    (smapsValues.Private_Hugetlb ?? 0)

  return {
    rss: requireMetric(statusValues, "VmRSS"),
    anonymousRss: requireMetric(statusValues, "RssAnon"),
    pss: requireMetric(smapsValues, "Pss"),
    uss: privateMemory,
    peakRss: requireMetric(statusValues, "VmHWM"),
  }
}

function parseKiBFields(contents) {
  const result = {}
  for (const line of contents.split("\n")) {
    const match = /^([A-Za-z_]+):\s+(\d+) kB$/.exec(line.trim())
    if (match) result[match[1]] = Number(match[2]) / KIB_PER_MIB
  }
  return result
}

function summarize(measurements) {
  return Object.fromEntries(
    Object.keys(measurements[0]).map((metric) => {
      const values = measurements.map((measurement) => measurement[metric])
      const center = median(values)
      return [
        metric,
        { median: center, mad: median(values.map((value) => Math.abs(value - center))) },
      ]
    }),
  )
}

function summarizeComparisons(measurements) {
  const metrics = Object.keys(measurements.baseline[0])
  const paired = (left, right, metric) =>
    left.map((measurement, index) => measurement[metric] - right[index][metric])
  const estimate = (values) => {
    const center = median(values)
    return { median: center, mad: median(values.map((value) => Math.abs(value - center))) }
  }

  return Object.fromEntries(
    metrics.map((metric) => [
      metric,
      {
        headMinusBase: estimate(paired(measurements.head, measurements.base, metric)),
        baseOverhead: estimate(paired(measurements.base, measurements.baseline, metric)),
        headOverhead: estimate(paired(measurements.head, measurements.baseline, metric)),
      },
    ]),
  )
}

function renderReport(summary, comparisons) {
  const metrics =
    process.platform === "darwin"
      ? [
          ["rss", "Stable RSS"],
          ["physicalFootprint", "Physical footprint"],
          ["physicalPeak", "Physical peak"],
        ]
      : [
          ["rss", "Stable RSS"],
          ["anonymousRss", "Anonymous RSS"],
          ["pss", "PSS"],
          ["uss", "USS (private memory)"],
          ["peakRss", "Peak RSS"],
        ]

  const comparisonRows = metrics
    .map(([key, label]) => {
      const base = summary.base[key]
      const head = summary.head[key]
      const difference = comparisons[key].headMinusBase
      const percentage = base.median === 0 ? 0 : (difference.median / base.median) * 100
      return `| ${label} | ${formatEstimate(base)} | ${formatEstimate(head)} | ${formatSignedEstimate(difference)} | ${formatSigned(percentage, "%")} |`
    })
    .join("\n")

  const clearChanges = metrics
    .map(([key, label]) => [label, comparisons[key].headMinusBase])
    .filter(([, estimate]) => Math.abs(estimate.median) > estimate.mad)
  const interpretation =
    clearChanges.length === 0
      ? "No metric shows a clear Base-to-PR difference beyond its measured run-to-run variation."
      : `Differences larger than their measured MAD: ${clearChanges
          .map(([label, estimate]) => `${label} ${formatSignedEstimate(estimate)}`)
          .join(", ")}.`

  const overheadRows = metrics
    .map(([key, label]) => {
      const comparison = comparisons[key]
      return `| ${label} | ${formatSignedEstimate(comparison.baseOverhead)} | ${formatSignedEstimate(comparison.headOverhead)} | ${formatSignedEstimate(comparison.headMinusBase)} |`
    })
    .join("\n")

  return (
    `## Memory benchmark\n\n` +
    `Compared base \`${shortSha(baseSha)}\` with PR head \`${shortSha(headSha)}\` on the same GitHub-hosted ${process.platform} runner. Lower values are better.\n\n` +
    `| Metric | Base | PR | PR − Base | Change |\n` +
    `|---|---:|---:|---:|---:|\n` +
    `${comparisonRows}\n\n` +
    `**Interpretation:** ${interpretation}\n\n` +
    `### Extension overhead above pi baseline\n\n` +
    `| Metric | Base overhead | PR overhead | Difference |\n` +
    `|---|---:|---:|---:|\n` +
    `${overheadRows}\n\n` +
    `Values are medians of ${RUNS} alternating, paired runs. The value after \`±\` is the median absolute deviation (MAD). ` +
    `Each process was sampled ${SAMPLE_COUNT} times after a ${WARMUP_MS} ms warm-up.\n\n` +
    `Environment: pi \`${piVersion}\`, ${runtimeName} \`${runtimeVersion}\`, ${process.platform} \`${process.arch}\`. ` +
    measurementSource() +
    `\n\n> This is a comparative signal, not a pass/fail threshold. GitHub-hosted runner noise can affect absolute values.\n`
  )
}

function measurementSource() {
  if (process.platform === "darwin") {
    return "RSS comes from `ps`; physical footprint and peak come from macOS `footprint`."
  }
  return "PSS and USS come from `/proc/<pid>/smaps_rollup`; RSS metrics come from `/proc/<pid>/status`."
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function formatProgress(measurement) {
  if (process.platform === "darwin") {
    return `${formatMiB(measurement.rss)} RSS, ${formatMiB(measurement.physicalFootprint)} physical`
  }
  return `${formatMiB(measurement.rss)} RSS, ${formatMiB(measurement.pss)} PSS`
}

function formatEstimate(value) {
  return `${formatMiB(value.median)} ± ${value.mad.toFixed(1)} MiB`
}

function formatMiB(value) {
  return `${value.toFixed(1)} MiB`
}

function formatSignedEstimate(value) {
  return `${formatSigned(value.median)} ± ${value.mad.toFixed(1)} MiB`
}

function formatSigned(value, suffix = " MiB") {
  const sign = value > 0 ? "+" : ""
  return `${sign}${value.toFixed(1)}${suffix}`
}

function requiredPath(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return resolve(value)
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`Expected a positive integer, got ${value}`)
  return parsed
}

function requireMetric(values, name) {
  const value = values[name]
  if (value === undefined) throw new Error(`Missing ${name} in Linux process memory data`)
  return value
}

function shortSha(sha) {
  return sha.slice(0, 7)
}

function ensureRunning(child, stderr) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `pi exited before memory sampling completed (code ${child.exitCode}, signal ${child.signalCode})\n${stderr}`,
    )
  }
}

function stopProcessGroup(child, signal = "SIGTERM") {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== "ESRCH") throw error
  }
}

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolveExit) => child.once("exit", resolveExit))
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
}
