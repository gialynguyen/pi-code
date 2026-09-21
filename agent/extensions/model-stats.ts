import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Live TPS + TTFT in zen-tui's Working line (protocol v1):
// https://github.com/lmilojevicc/pi-zentui/blob/main/docs/configuration.md#working-line-extension-integration
// Falls back to Pi's setWorkingMessage() when zen-tui's Working line is inactive.

const CAPABILITY_EVENT = "zentui:working-line-segment-capability";
const SEGMENT_EVENT = "zentui:working-line-segment";
const SEGMENT_KEY = "model-stats:throughput";
const PUBLISH_THROTTLE_MS = 250;

function fmtTTFT(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export default function (pi: ExtensionAPI) {
	let turnStartMs: number | null = null;
	let firstTokenMs: number | null = null;
	let liveChars = 0;
	let lastPublishMs = 0;
	let zentuiActive: boolean | null = null;
	let fallbackUsed = false;

	// Async signature, but the emit + read below stay in one synchronous block:
	// pi.events.emit() is sync and the handler mutates the object we passed, so
	// an await between the two lines would race the mutation.
	async function probeZentui(): Promise<boolean> {
		try {
			const capability = { supported: false, active: false };
			pi.events.emit(CAPABILITY_EVENT, capability);
			return capability.active === true;
		} catch {
			return false;
		}
	}

	async function show(ctx: { ui: { setWorkingMessage: (message?: string) => void } }, text: string): Promise<void> {
		if (zentuiActive) {
			try {
				pi.events.emit(SEGMENT_EVENT, { key: SEGMENT_KEY, text });
			} catch {
				// Fail open: a dropped segment must never break the turn.
			}
			return;
		}
		try {
			ctx.ui.setWorkingMessage(text);
			fallbackUsed = true;
		} catch {
			// Fail open.
		}
	}

	async function hide(ctx?: { ui: { setWorkingMessage: (message?: string) => void } }): Promise<void> {
		if (zentuiActive) {
			try {
				pi.events.emit(SEGMENT_EVENT, { key: SEGMENT_KEY, text: undefined });
			} catch {
				// Fail open.
			}
			return;
		}
		if (ctx && fallbackUsed) {
			try {
				ctx.ui.setWorkingMessage(undefined);
			} catch {
				// Fail open.
			}
			fallbackUsed = false;
		}
	}

	// Shared finalizer for message_end / turn_end (whichever fires first wins;
	// the second is a no-op because tracking is already reset).
	async function finishTurn(
		ctx: { ui: { setWorkingMessage: (message?: string) => void } },
		message: { role: string; usage?: { output?: number } },
	): Promise<void> {
		if (message.role === "assistant" && (message.usage?.output ?? 0) > 0 && firstTokenMs !== null && turnStartMs !== null) {
			const decodeSecs = (Date.now() - firstTokenMs) / 1000;
			// Same-millisecond finish: no meaningful TPS yet, keep the TTFT text.
			await show(ctx, decodeSecs > 0
				? `${(message.usage!.output! / decodeSecs).toFixed(1)} tok/s · TTFT ${fmtTTFT(firstTokenMs - turnStartMs)}`
				: `TTFT ${fmtTTFT(firstTokenMs - turnStartMs)}`);
		} else if (firstTokenMs === null) {
			await hide(ctx);
		}
		turnStartMs = null;
		firstTokenMs = null;
		liveChars = 0;
	}

	pi.on("turn_start", async (event, ctx) => {
		turnStartMs = typeof event.timestamp === "number" ? event.timestamp : Date.now();
		firstTokenMs = null;
		liveChars = 0;
		lastPublishMs = 0;
		zentuiActive = ctx.hasUI ? await probeZentui() : false;
	});

	pi.on("message_update", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (turnStartMs === null) {
			// Extension (re)loaded mid-turn: start measuring from here.
			turnStartMs = Date.now();
			firstTokenMs = null;
			liveChars = 0;
			lastPublishMs = 0;
			zentuiActive = await probeZentui();
		}
		const streamEvent = event.assistantMessageEvent;
		if (streamEvent.type !== "text_delta" && streamEvent.type !== "thinking_delta" && streamEvent.type !== "toolcall_delta") {
			return;
		}
		// TTFT counts any first output activity (incl. tool-call JSON), but the
		// live TPS estimate only counts text-ish chars.
		if (streamEvent.type !== "toolcall_delta") liveChars += streamEvent.delta.length;
		const now = Date.now();
		if (firstTokenMs === null) {
			firstTokenMs = now;
			lastPublishMs = now;
			await show(ctx, `TTFT ${fmtTTFT(now - turnStartMs)}`);
			return;
		}
		if (now - lastPublishMs < PUBLISH_THROTTLE_MS) return;
		const decodeSecs = (now - firstTokenMs) / 1000;
		if (decodeSecs <= 0) return;
		lastPublishMs = now;
		await show(ctx, `${(Math.ceil(liveChars / 4) / decodeSecs).toFixed(1)} tok/s · TTFT ${fmtTTFT(firstTokenMs - turnStartMs)}`);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!ctx.hasUI || turnStartMs === null) return;
		await finishTurn(ctx, event.message);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!ctx.hasUI || turnStartMs === null) return;
		await finishTurn(ctx, event.message);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await hide(ctx);
		turnStartMs = null;
		firstTokenMs = null;
		liveChars = 0;
		zentuiActive = null;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await hide(ctx);
		turnStartMs = null;
		firstTokenMs = null;
		liveChars = 0;
		zentuiActive = null;
	});
}
