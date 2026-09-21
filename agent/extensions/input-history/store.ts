import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_HISTORY_ENTRIES = 1000;

export function historyFileFor(cwd: string): string {
	// The default agent directory uses the .pi configuration directory name.
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const digest = createHash("sha1").update(cwd).digest("hex");
	return join(agentDir, "input-history", `${digest}.jsonl`);
}

export function loadHistory(file: string): string[] {
	let contents: string;
	try {
		contents = readFileSync(file, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return [];
		throw error;
	}

	const records: Array<{ text: string; ts: number }> = [];
	for (const line of contents.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (!isHistoryRecord(value)) continue;
			records.push(value);
		} catch {
			continue;
		}
	}

	const keptRecords = records.slice(-MAX_HISTORY_ENTRIES);
	if (records.length > MAX_HISTORY_ENTRIES) {
		try {
			const tempFile = `${file}.tmp`;
			writeFileSync(
				tempFile,
				`${keptRecords.map((record) => JSON.stringify({ text: record.text, ts: record.ts })).join("\n")}\n`,
				"utf8",
			);
			renameSync(tempFile, file);
		} catch {
			// Best-effort compaction only.
		}
	}
	return keptRecords.map((record) => record.text);
}

export function appendHistory(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify({ text, ts: Date.now() })}\n`, "utf8");
}

export function shouldRecord(last: string | undefined, text: string): boolean {
	return text.trim().length > 0 && !text.startsWith("!") && text !== last;
}

export function filterHistory(entries: string[], query: string): string[] {
	const needle = query.toLowerCase();
	return entries
		.filter((entry) => needle.length === 0 || entry.toLowerCase().includes(needle))
		.reverse();
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isHistoryRecord(value: unknown): value is { text: string; ts: number } {
	if (typeof value !== "object" || value === null) return false;
	if (!("text" in value) || !("ts" in value)) return false;
	const record = value as { text?: unknown; ts?: unknown };
	return typeof record.text === "string" && typeof record.ts === "number";
}
