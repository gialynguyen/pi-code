/**
 * Slash Autocomplete - floating overlay popup for slash command-name completion.
 *
 * Replaces pi's inline slash-command autocomplete with a floating overlay (above
 * the input box, left-aligned to the `/` column) installed as a pure extension
 * via `ctx.ui.setEditorComponent`. The core autocomplete provider is reused for
 * suggestions + commit logic, so ALL command sources (built-in + extension +
 * prompt + skill) remain available. `@`/`#` attachment and file/path Tab
 * completion stay inline via the base editor; only slash COMMAND-NAME completion
 * moves to the floating popup.
 *
 * Usage: pi --extension ./agent/extensions/slash-autocomplete/index.ts
 *
 * v1 scope: slash COMMAND-NAME completion only. The popup closes once a space
 * follows the command (argument completion stays inline via base, out of scope).
 */

import {
	CustomEditor,
	getAgentDir,
	getSettingsListTheme,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	SelectList,
	SettingsList,
	Container,
	Text,
	matchesKey,
	Key,
	truncateToWidth,
	type Component,
	type EditorTheme,
	type TUI,
	type AutocompleteProvider,
	type AutocompleteItem,
	type AutocompleteSuggestions,
	type OverlayHandle,
	type SettingItem,
} from "@earendil-works/pi-tui";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ---- Persisted settings (cross-session; pi has no extension settings API) ----
interface SlashSettings {
	enabled: boolean;
	popupMode: "followCursor" | "fixedLeft";
	yMargin: number; // rows to lift the popup above the input box (clears footer/status)
}
const DEFAULT_SETTINGS: SlashSettings = { enabled: true, popupMode: "followCursor", yMargin: 3 };
const SETTINGS_FILE = join(getAgentDir(), "extensions", "slash-autocomplete", "settings.json");

function loadSettings(): SlashSettings {
	try {
		const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as Partial<SlashSettings>;
		const ym =
			typeof parsed.yMargin === "number"
				? Math.max(0, Math.min(30, Math.round(parsed.yMargin)))
				: DEFAULT_SETTINGS.yMargin;
		return {
			enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_SETTINGS.enabled,
			popupMode: parsed.popupMode === "fixedLeft" ? "fixedLeft" : "followCursor",
			yMargin: ym,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}
const settings: SlashSettings = loadSettings();

function saveSettings(): void {
	try {
		mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
		writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
	} catch {
		// ignore write errors
	}
}

// Track the live editor instance so we can close its popup on session shutdown
// (prevents a stale overlay persisting across reload/new/resume/fork switches).
let liveEditor: SlashAutocompleteEditor | null = null;

// Editor factory shared by session_start and the settings "enable" toggle.
// Captures the live instance so the settings command can close its popup before
// restoring the default editor.
const makeEditor = (
	tui: TUI,
	theme: EditorTheme,
	keybindings: KeybindingsManager,
): SlashAutocompleteEditor => {
	liveEditor = new SlashAutocompleteEditor(tui, theme, keybindings);
	return liveEditor;
};

export default function (pi: ExtensionAPI): void {
	// Install the custom editor only when enabled. The /slash-settings command
	// is always registered so the user can re-enable from a disabled state.
	// session_start re-fires on /reload / /new / /resume / /fork, so the flag
	// always takes effect on the next session.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return; // TUI-only; no-op in print/json/rpc
		if (settings.enabled) ctx.ui.setEditorComponent(makeEditor);
	});
	pi.on("session_shutdown", () => {
		try {
			(liveEditor as any)?.closePopup();
		} catch {
			// ignore
		}
		liveEditor = null;
	});

	// Settings menu: `/slash-settings` opens a SettingsList dialog. Toggles
	// persist to settings.json (cross-session). The "enabled" toggle is applied
	// AFTER the dialog closes — calling setEditorComponent from inside the
	// dialog's onChange would wipe the dialog and hang the command.
	pi.registerCommand("slash-settings", {
		description: "Slash autocomplete settings",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			const initialEnabled = settings.enabled;
			await ctx.ui.custom((_tui, theme, _kb, done) => {
				const items: SettingItem[] = [
					{
						id: "enabled",
						label: "Slash autocomplete",
						description: "Floating popup for / commands",
						currentValue: settings.enabled ? "on" : "off",
						values: ["on", "off"],
					},
					{
						id: "popupMode",
						label: "Popup display",
						description:
							"followCursor = align to / column; fixedLeft = fixed left, full width",
						currentValue: settings.popupMode,
						values: ["followCursor", "fixedLeft"],
					},
					{
						id: "yMargin",
						label: "Popup y-margin",
						description: "Rows to lift the popup above the input (increase if it overlaps)",
						currentValue: String(settings.yMargin),
						values: ["0", "1", "2", "3", "4", "5", "6", "8", "10", "12", "16", "20"],
					},
				];
				const container = new Container();
				container.addChild(
					new Text(theme.fg("accent", theme.bold("Slash Autocomplete Settings")), 1, 1),
				);
				const list = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						if (id === "enabled") {
							settings.enabled = newValue === "on";
							saveSettings();
						} else if (id === "popupMode") {
							settings.popupMode = newValue === "fixedLeft" ? "fixedLeft" : "followCursor";
							saveSettings();
						} else if (id === "yMargin") {
							const n = Number.parseInt(newValue, 10);
							settings.yMargin = Number.isFinite(n)
								? Math.max(0, Math.min(30, n))
								: DEFAULT_SETTINGS.yMargin;
							saveSettings();
						}
						ctx.ui.notify(`${id}: ${newValue}`, "info");
					},
					() => done(undefined),
				);
				container.addChild(list);
				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => list.handleInput?.(data),
				};
			});
			// Dialog closed (editor restored). Apply the enable toggle ONLY if it
			// actually changed, to avoid resetting undo/cursor when nothing changed.
			if (settings.enabled !== initialEnabled) {
				if (settings.enabled) {
					ctx.ui.setEditorComponent(makeEditor);
				} else {
					try {
						(liveEditor as any)?.closePopup?.();
					} catch {
						// ignore
					}
					ctx.ui.setEditorComponent(undefined);
				}
			}
		},
	});
}

class SlashAutocompleteEditor extends CustomEditor {
	// Editor.theme is private; capture the theme here for the overlay/popup.
	private readonly editorTheme: EditorTheme;
	// The REAL provider (all command sources); used to drive our overlay.
	private slashProvider?: AutocompleteProvider;
	private popupOpen = false;
	private overlayHandle: OverlayHandle | null = null;
	private popup: SlashPopup | null = null;
	private currentList: SelectList | null = null;
	private currentPrefix = "";
	private queryController: AbortController | null = null;
	private lastEditorHeight = 1; // updated in render()

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
		this.editorTheme = theme;
	}

	// Keep the REAL provider for our overlay; hand the base a wrapper that
	// suppresses the inline slash list (so only the popup shows it) while still
	// delegating @/#/file completion to base inline. This preserves @/#/file
	// completion (base inline) while suppressing base's inline slash list.
	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.slashProvider = provider;
		const wrapper: AutocompleteProvider = {
			triggerCharacters: provider.triggerCharacters,
			shouldTriggerFileCompletion: provider.shouldTriggerFileCompletion?.bind(provider),
			async getSuggestions(lines, cl, cc, opts) {
				const before = (lines[cl] ?? "").slice(0, cc);
				const isSlashName = cl === 0 && before.trimStart().startsWith("/") && !before.trimStart().includes(" ");
				if (isSlashName) return null; // base shows NO inline slash list
				return provider.getSuggestions(lines, cl, cc, opts); // delegate @/#/file to base inline
			},
			applyCompletion(lines, cl, cc, item, prefix) {
				return provider.applyCompletion(lines, cl, cc, item, prefix); // base uses for @/file; never for slash
			},
		};
		super.setAutocompleteProvider(wrapper); // base keeps @/#/file completion
	}

	handleInput(data: string): void {
		if (this.popupOpen) {
			if (this.isUp(data) || this.isDown(data)) {
				this.currentList?.handleInput(data);
				this.tui.requestRender();
				return;
			}
			if (this.isTab(data)) {
				const it = this.currentList?.getSelectedItem();
				if (it) this.commit(it);
				else this.closePopup();
				return;
			}
			if (this.isEnter(data)) {
				const it = this.currentList?.getSelectedItem();
				if (it) this.commit(it);
				else this.closePopup(); // no selection / in-flight: close; press Enter again to submit
				return;
			}
			if (this.isEsc(data)) {
				this.closePopup();
				return; // swallow (don't interrupt agent)
			}
			if (this.isClear(data)) {
				this.closePopup();
				return; // Ctrl+C: swallow (don't clear buffer)
			}
			// else fall through (printable/backspace/arrows/home/end/pgup/down): super then re-eval
		}

		// popup closed OR popup open with a text key:
		super.handleInput(data);

		// after super mutates buffer, re-evaluate slash command-name context:
		if (this.inSlashContext()) {
			if (!this.popupOpen) this.openPopup();
			else this.query(); // query also when open (refilter)
		} else if (this.popupOpen) {
			this.closePopup();
		}
	}

	render(width: number): string[] {
		const lines = super.render(width);
		this.lastEditorHeight = lines.length; // capture for overlay positioning
		return lines; // do NOT modify base render output (base inline list is suppressed via the wrapper)
	}

	private inSlashContext(): boolean {
		const c = this.getCursor();
		if (c.line !== 0) return false;
		const before = (this.getLines()[0] ?? "").slice(0, c.col);
		return before.trimStart().startsWith("/") && !before.trimStart().includes(" ");
	}

	private openPopup(): void {
		const c = this.getCursor();
		const before = (this.getLines()[0] ?? "").slice(0, c.col);
		const slashIdx = before.indexOf("/"); // col of the '/'
		const termW = this.termWidth();
		const termH = this.termHeight();
		const padX = this.getPaddingX(); // public on Editor
		// POSITIONING HEURISTIC: editor is bottom-docked; exact footer/status
		// height is unknown via public API. Horizontal alignment is approximated
		// from the logical cursor column (paddingX + slashIdx) and may misalign
		// for wrapped/long lines and CJK -- do not attempt to fix in v1.
		let popupCol: number;
		let popupWidth: number;
		if (settings.popupMode === "fixedLeft") {
			// "Fixed left, full width": align to the input's left padding and span
			// the input content width (termW - padX*2).
			popupCol = padX;
			popupWidth = Math.max(10, termW - padX * 2);
		} else {
			// "followCursor": align to the / column; narrow, capped at 60.
			popupCol = padX + Math.max(0, slashIdx);
			popupCol = Math.max(0, Math.min(popupCol, termW - 10));
			// popupCol is clamped to <= termW-10, so termW - popupCol >= 10.
			// Cap width at available space so the popup never overflows the right edge.
			popupWidth = Math.min(60, termW - popupCol);
		}
		// Lift the popup above the editor by lastEditorHeight + yMargin rows.
		// yMargin (configurable in /slash-settings) clears the footer/status bar
		// below the editor; increase it if the popup still overlaps the input.
		const offsetY = -(this.lastEditorHeight + settings.yMargin);
		const maxH = Math.min(20, Math.max(4, termH - this.lastEditorHeight - settings.yMargin));
		this.popup = new SlashPopup(this.editorTheme);
		this.overlayHandle = this.tui.showOverlay(this.popup, {
			nonCapturing: true,
			anchor: "bottom-left",
			offsetX: popupCol,
			offsetY,
			width: popupWidth,
			maxHeight: maxH,
		});
		this.popupOpen = true;
		this.query();
	}

	private closePopup(): void {
		this.queryController?.abort();
		this.queryController = null;
		try {
			this.overlayHandle?.hide();
		} catch {
			// overlay already hidden
		}
		this.overlayHandle = null;
		this.popup = null;
		this.currentList = null;
		this.popupOpen = false;
		this.tui.requestRender();
	}

	private commit(item: AutocompleteItem): void {
		if (!this.slashProvider) {
			this.closePopup();
			return;
		}
		const c = this.getCursor();
		const lines = this.getLines();
		// Make completion undoable (best-effort; these are private on Editor).
		try {
			(this as any).pushUndoSnapshot?.();
			(this as any).lastAction = null;
		} catch {
			// ignore
		}
		const r = this.slashProvider.applyCompletion(lines, c.line, c.col, item, this.currentPrefix);
		// Mirror base editor.js commit: Editor has no public cursor setter, and
		// `state`/`setCursorCol` are TS-private (not #private), so a cast works.
		// May need updating if pi renames these private fields.
		(this as any).state.lines = r.lines;
		(this as any).state.cursorLine = r.cursorLine;
		(this as any).setCursorCol(r.cursorCol);
		this.closePopup();
		try {
			this.onChange?.(this.getText()); // notify subscribers (base does this after applyCompletion)
		} catch {
			// ignore
		}
		this.tui.requestRender();
	}

	private async query(): Promise<void> {
		this.queryController?.abort();
		const ctrl = new AbortController();
		this.queryController = ctrl;
		if (!this.slashProvider) {
			this.closePopup();
			return;
		}
		const c = this.getCursor();
		const lines = this.getLines();
		let res: AutocompleteSuggestions | null = null;
		try {
			res = await this.slashProvider.getSuggestions(lines, c.line, c.col, {
				signal: ctrl.signal,
				force: false,
			});
		} catch {
			this.closePopup();
			return;
		}
		if (ctrl.signal.aborted || !this.popupOpen) return;
		if (!res || !res.items || res.items.length === 0) {
			this.closePopup();
			return;
		}
		this.currentPrefix = res.prefix;
		const maxVis = Math.min(res.items.length, 8);
		const list = new SelectList(res.items, maxVis, this.editorTheme.selectList, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 32,
		});
		// re-select best match (base does getBestAutocompleteMatchIndex): prefer exact, else prefix, else 0
		const want = this.currentPrefix.replace(/^\//, "").toLowerCase();
		let best = res.items.findIndex((it) => it.value.toLowerCase() === want);
		if (best < 0) best = res.items.findIndex((it) => it.value.toLowerCase().startsWith(want));
		if (best < 0) best = 0;
		try {
			list.setSelectedIndex(best);
		} catch {
			// index out of range -- keep default
		}
		this.currentList = list;
		if (this.popup) this.popup.currentList = list;
		this.tui.requestRender();
	}

	// termWidth()/termHeight(): prefer the TUI terminal getters; fall back to
	// process.stdout when the terminal is not accessible.
	private termWidth(): number {
		const cols = this.tui.terminal.columns;
		if (cols) return cols;
		const fallback = (globalThis as { process?: { stdout?: { columns?: number } } }).process?.stdout
			?.columns;
		return fallback ?? 80;
	}

	private termHeight(): number {
		const rows = this.tui.terminal.rows;
		if (rows) return rows;
		const fallback = (globalThis as { process?: { stdout?: { rows?: number } } }).process?.stdout?.rows;
		return fallback ?? 24;
	}

	// KEY DETECTION:
	// Prefer the KeybindingsManager (this.keybindings) so user-rebound keys for
	// popup navigation/confirmation are honored. `keybindings` is private on
	// CustomEditor, so we access it via a cast. If the manager is somehow missing
	// we fall back to matchesKey against the default key ids.
	// NOTE: the matchesKey fallback does NOT honor user-rebound keys for popup
	// nav (a v1 limitation).
	private getKb(): { matches: (data: string, keybinding: string) => boolean } | undefined {
		return (this as unknown as { keybindings?: { matches: (d: string, a: string) => boolean } })
			.keybindings;
	}

	private isUp(data: string): boolean {
		const kb = this.getKb();
		return kb ? kb.matches(data, "tui.select.up") : matchesKey(data, Key.up);
	}

	private isDown(data: string): boolean {
		const kb = this.getKb();
		return kb ? kb.matches(data, "tui.select.down") : matchesKey(data, Key.down);
	}

	private isTab(data: string): boolean {
		const kb = this.getKb();
		return kb ? kb.matches(data, "tui.input.tab") : matchesKey(data, Key.tab);
	}

	private isEnter(data: string): boolean {
		const kb = this.getKb();
		return kb ? kb.matches(data, "tui.select.confirm") : matchesKey(data, Key.enter);
	}

	private isEsc(data: string): boolean {
		const kb = this.getKb();
		return kb ? kb.matches(data, "tui.select.cancel") : matchesKey(data, Key.escape);
	}

	private isClear(data: string): boolean {
		const kb = this.getKb();
		return kb ? kb.matches(data, "app.clear") : matchesKey(data, Key.ctrl("c"));
	}
}

class SlashPopup implements Component {
	currentList: SelectList | null = null;
	constructor(private theme: any) {} // EditorTheme

	render(width: number): string[] {
		const lines: string[] = [];
		const border = (s: string) => (this.theme.borderColor ? this.theme.borderColor(s) : s);
		lines.push(border("\u2500".repeat(Math.max(2, width))));
		lines.push(" Slash commands ");
		if (this.currentList) lines.push(...this.currentList.render(width));
		lines.push(" \u2191\u2193 navigate \u00b7 Tab/Enter select \u00b7 Esc close ");
		lines.push(border("\u2500".repeat(Math.max(2, width))));
		return lines.map((l) => truncateToWidth(l, width));
	}

	invalidate(): void {
		this.currentList?.invalidate?.();
	}

	handleInput(_data: string): void {
		/* not called: overlay is nonCapturing */
	}
}