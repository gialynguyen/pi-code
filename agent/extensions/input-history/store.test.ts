import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendHistory,
	filterHistory,
	historyFileFor,
	loadHistory,
	shouldRecord,
} from "./store.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempRoot = join(tmpdir(), `pi-input-history-${process.pid}-${Date.now()}`);

function pass(name: string): void {
	console.log(`PASS ${name}`);
}

try {
	mkdirSync(tempRoot, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = tempRoot;

	const cwd = "/tmp/example-project";
	const expectedDigest = createHash("sha1").update(cwd).digest("hex");
	const historyFile = historyFileFor(cwd);
	assert.equal(historyFile, join(tempRoot, "input-history", `${expectedDigest}.jsonl`));
	assert.equal(historyFileFor(cwd), historyFile);
	pass("sha1 filename format and stability");

	const missingFile = join(tempRoot, "missing", "history.jsonl");
	assert.deepEqual(loadHistory(missingFile), []);
	pass("missing history file loads as empty");

	const mixedFile = join(tempRoot, "mixed.jsonl");
	writeFileSync(
		mixedFile,
		[
			JSON.stringify({ text: "first", ts: 1 }),
			"not json",
			JSON.stringify({ text: 42, ts: 2 }),
			JSON.stringify({ text: "second", ts: 3 }),
			"",
		].join("\n"),
	);
	assert.deepEqual(loadHistory(mixedFile), ["first", "second"]);
	pass("corrupt lines are skipped");

	const largeFile = join(tempRoot, "large.jsonl");
	writeFileSync(
		largeFile,
		Array.from({ length: 1005 }, (_, index) => JSON.stringify({ text: `entry-${index}`, ts: index })).join("\n") + "\n",
	);
	const largeHistory = loadHistory(largeFile);
	assert.equal(largeHistory.length, 1000);
	assert.equal(largeHistory[0], "entry-5");
	assert.equal(largeHistory.at(-1), "entry-1004");
	const rewrittenLines = readFileSync(largeFile, "utf8").trimEnd().split("\n");
	assert.equal(rewrittenLines.length, 1000);
	pass("load keeps the last 1000 entries and compacts the file");

	const appendedFile = join(tempRoot, "nested", "history.jsonl");
	appendHistory(appendedFile, "one");
	appendHistory(appendedFile, "two\nline");
	assert.equal(existsSync(appendedFile), true);
	assert.deepEqual(loadHistory(appendedFile), ["one", "two\nline"]);
	const appendedLines = readFileSync(appendedFile, "utf8").trim().split("\n");
	assert.equal(JSON.parse(appendedLines[0]!).text, "one");
	assert.equal(typeof JSON.parse(appendedLines[0]!).ts, "number");
	pass("append creates directories and round-trips through load");

	assert.equal(shouldRecord(undefined, ""), false);
	assert.equal(shouldRecord(undefined, "   \t"), false);
	assert.equal(shouldRecord(undefined, "!ls"), false);
	assert.equal(shouldRecord("same", "same"), false);
	assert.equal(shouldRecord("different", "normal prompt"), true);
	pass("shouldRecord rules");

	const entries = ["alpha", "Beta project", "xALPHAx", "none"];
	assert.deepEqual(filterHistory(entries, "AlPh"), ["xALPHAx", "alpha"]);
	assert.deepEqual(filterHistory(entries, "proj"), ["Beta project"]);
	assert.deepEqual(filterHistory(entries, ""), ["none", "xALPHAx", "Beta project", "alpha"]);
	pass("case-insensitive substring filtering and newest-first order");
} finally {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}
