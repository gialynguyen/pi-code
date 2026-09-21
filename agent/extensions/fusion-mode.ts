/**
 * Fusion Mode Extension
 *
 * Toggleable fusion-agent mode. While ON, the fusion build contract is
 * injected before every agent turn, so every prompt runs through the
 * plan → delegate → review → verify pattern without re-invoking a template.
 *
 * Usage:
 *   /fusion on       — enable
 *   /fusion off      — disable
 *   /fusion toggle   — flip
 *   /fusion          — toggle (same as /fusion toggle)
 *   Ctrl+Alt+F       — toggle
 *
 * Behavior:
 *   - Footer status always shows the state, padded: "  fusion-mode: on  " / "  fusion-mode: off  "
 *   - State is persisted in the session file: /resume restores it,
 *     /new starts OFF, /reload keeps it
 *   - When switched OFF the contract stops being appended to the system
 *     prompt, so the mode stops applying immediately. Sessions from before the
 *     move (when it was injected as a custom message) also get their stale
 *     injections filtered out of the LLM context
 *   - pi --fusion starts a session with the mode already ON
 *
 * Robustness note: on session replacement flows (/resume, --session, /new,
 * /fork) pi clears extension statuses and the rebound extension instance may
 * never receive session_start. So state restore + status assertion also run
 * from resources_discover (which does reach the rebound instance) and are
 * re-asserted on every turn_start as self-healing.
 *
 * Design: instruct-only. No tool-layer enforcement — the contract tells the
 * main agent not to edit/search directly and to delegate to specialists.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { join } from "node:path";

const CONTRACT_PATH = join(getAgentDir(), "fusion-build-prompt.md");

function buildContractMessage(): string {
	return `[FUSION MODE ACTIVE]
Fusion mode is ON (toggled via /fusion). Adopt the FUSION BUILD AGENT role for this task and every follow-up until the user runs /fusion off.

If you have not already read it this session, read ${CONTRACT_PATH} now and follow it in full. It is your operating contract: the boundaries, the five-part spec, the routing table, the review loop, and the report format.

The non-negotiables:
- **You do not edit files.** Not with \`edit\`, not with \`write\`, not with \`bash\` (no \`sed -i\`, no heredocs, no redirection). The only path to changing a file is \`Agent({ subagent_type: "sidekick" | "design", ... })\`.
- **You do not search with \`grep\`/\`find\`/\`ls\`.** Broad discovery goes to \`Agent({ subagent_type: "explorer" })\`. \`read\` is for a file whose exact path you already have.
- **\`bash\` is for verification only**: lint, test, build, typecheck, and read-only git.
- **Emit judgment, not implementation.** Decomposition, specs, routing, verdicts. If you are about to write a code block longer than a signature, that is a spec to delegate.
- **Every delegation carries the full five-part spec** - Objective, Files, Interfaces, Constraints, Verification. Subagents share none of your context, cannot ask you questions mid-run, and cannot delegate onward.
- **Decide before you delegate.** Never hand off ambiguous intent. If scope or acceptance criteria are genuinely open, ask the user first.

Available specialists: \`sidekick\` (default executor), \`explorer\` (codebase search), \`research\` (external facts), \`design\` (UI/frontend), \`reviewer\` (plan critique and diff audit), \`vision\` (images), \`commit\` (git commit & push specialist).

Run every task through the pattern - plan it, delegate execution, review the result, verify with real commands, and report.`;
}

export default function fusionModeExtension(pi: ExtensionAPI): void {
	let fusionEnabled = false;
	let stateRestored = false;

	pi.registerFlag("fusion", {
		description: "Start the session with fusion mode ON",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Padding: pi's footer sanitizer collapses ASCII-space runs and trims each
		// status, so literal spaces get stripped. U+200B bookends defeat trim();
		// U+00A0 survives the collapse. Net effect: two blank columns per side.
		// const PAD_L = "\u200b\u00a0\u00a0";
		// const PAD_R = "\u00a0\u00a0\u200b";
		// ctx.ui.setStatus("fusion-mode", `${PAD_L}fusion-mode: ${fusionEnabled ? "on" : "off"}${PAD_R}`);
		ctx.ui.setStatus("fusion-mode", `fusion-mode: ${fusionEnabled ? "on" : "off"}`);
	}

	// Restore persisted state from the session file once per extension
	// instance, then re-assert the footer status. Safe to call from any
	// event; after the first call the in-memory state is authoritative.
	function ensureStateAndStatus(ctx: ExtensionContext): void {
		if (!stateRestored) {
			stateRestored = true;
			try {
				if (pi.getFlag("fusion") === true) {
					fusionEnabled = true;
				} else {
					const entries = ctx.sessionManager.getEntries();
					const stateEntry = entries
						.filter(
							(e: { type: string; customType?: string }) =>
								e.type === "custom" && e.customType === "fusion-mode",
						)
						.pop() as { data?: { enabled?: boolean } } | undefined;
					if (stateEntry?.data?.enabled !== undefined) {
						fusionEnabled = stateEntry.data.enabled;
					}
				}
			} catch {
				// Session manager not ready or unreadable — keep default OFF.
			}
		}
		updateStatus(ctx);
	}

	function persistState(): void {
		pi.appendEntry("fusion-mode", { enabled: fusionEnabled });
	}

	function setMode(enabled: boolean, ctx: ExtensionContext): void {
		if (enabled === fusionEnabled) {
			ctx.ui.notify(`Fusion mode is already ${enabled ? "ON" : "OFF"}`, "info");
			return;
		}
		fusionEnabled = enabled;
		updateStatus(ctx);
		persistState();
		if (enabled) {
			if (!existsSync(CONTRACT_PATH)) {
				ctx.ui.notify(`Fusion mode ON — but contract file is missing: ${CONTRACT_PATH}`, "warning");
			} else {
				ctx.ui.notify("Fusion mode ON — every prompt now runs through the fusion pattern", "info");
			}
		} else {
			ctx.ui.notify("Fusion mode OFF — back to normal operation", "info");
		}
	}

	function showStatus(ctx: ExtensionContext): void {
		ctx.ui.notify(
			fusionEnabled
				? "Fusion mode is ON — the fusion contract is being injected before every turn. Use /fusion off to disable."
				: "Fusion mode is OFF. Use /fusion on to enable.",
			"info",
		);
	}

	pi.registerCommand("fusion", {
		description: "Toggle fusion mode: /fusion on|off|toggle (no args = toggle)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			switch (arg) {
				case "on":
					setMode(true, ctx);
					break;
				case "off":
					setMode(false, ctx);
					break;
				case "toggle":
				case "":
					setMode(!fusionEnabled, ctx);
					break;
				case "status":
					showStatus(ctx);
					break;
				default:
					ctx.ui.notify(`Unknown argument "${arg}". Usage: /fusion on|off|toggle`, "warning");
			}
		},
	});

	pi.registerTool({
		name: "fusion",
		label: "Fusion",
		description: "Enable fusion-mode for this session.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			setMode(true, ctx);
			return {
				content: [{ type: "text", text: `fusion-mode: ${fusionEnabled ? "on" : "off"}` }],
				details: { enabled: fusionEnabled },
			};
		},
	});

	pi.registerShortcut(Key.ctrlAlt("f"), {
		description: "Toggle fusion mode",
		handler: async (ctx) => setMode(!fusionEnabled, ctx),
	});

	// Register the fusion contract as a named system-prompt section while ON.
	//
	// System prompt rather than a custom message for two reasons: a
	// custom_message is a valid compaction cut point, so on a long session the
	// contract gets summarized away and the mode silently decays while the
	// agent keeps going unconstrained; and injected messages accumulate one
	// copy per user prompt for the life of the session. The system prompt is
	// rebuilt per request, so it stays flat and survives compaction.
	//
	// A named section (rather than a full-prompt string) lets pi diff the
	// change into one minimal patch message: toggling writes `fusion:` /
	// `fusion: null`, and models with mid-conversation system support keep
	// their cached prefix. Stable while ON, so no per-turn cost either way.
	pi.on("before_agent_start", async (event) => {
		if (fusionEnabled) event.systemPromptOptions.sections["fusion"] = buildContractMessage();
		else delete event.systemPromptOptions.sections["fusion"];
	});

	// Legacy cleanup: sessions that ran fusion mode before the contract moved
	// to the system prompt still carry the old injected custom messages in
	// their history, and nothing produces them anymore. Non-destructive, the
	// messages stay in the session file - just not in what the model sees.
	pi.on("context", async (event) => {
		if (fusionEnabled) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as { customType?: string };
				return msg.customType !== "fusion-mode-context";
			}),
		};
	});

	// Primary restore point (startup, /new in fresh processes, /reload).
	pi.on("session_start", async (_event, ctx) => {
		ensureStateAndStatus(ctx);
	});

	// Rebound-session restore point: on session replacement flows
	// (--session, /resume, /fork, /new mid-process) the rebound extension
	// instance may never see session_start, but resources_discover does
	// arrive after the rebind — restore and re-assert there.
	pi.on("resources_discover", async (_event, ctx) => {
		ensureStateAndStatus(ctx);
	});

	// Self-healing: re-assert the footer status every turn, so it survives
	// anything that clears extension statuses between the events above.
	pi.on("turn_start", async (_event, ctx) => {
		ensureStateAndStatus(ctx);
	});
}
