import { rmSync } from "node:fs";
import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorComponent, type EditorTheme, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
	appendHistory,
	filterHistory,
	historyFileFor,
	loadHistory,
	shouldRecord,
} from "./store.ts";

type CursorPosition = { line: number; col: number };
type EditorLike = EditorComponent & {
	actionHandlers?: Map<unknown, () => void>;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
	focused?: boolean;
	getCursor?: () => CursorPosition;
	getLines?: () => string[];
	getPaddingX?: () => number;
	getAutocompleteMaxVisible?: () => number;
	isShowingAutocomplete?: () => boolean;
	isOnFirstVisualLine?: () => boolean;
	isEditorEmpty?: () => boolean;
};
type HistoryFactory = (
	tui: TUI,
	theme: EditorTheme,
	keybindings: KeybindingsManager,
) => EditorComponent;
type MarkedHistoryFactory = HistoryFactory & { __inputHistoryFactory?: true };
type StatusSetter = (text: string | undefined) => void;

const MAX_HISTORY_ENTRIES = 1000;
const HISTORY_FACTORY_MARKER = "__inputHistoryFactory";
const ORIGINAL_FACTORY_SLOT = Symbol.for("pi.input-history.originalEditorFactory");
// Bumped on session_shutdown so a deferred session-start install from a stale
// session never fires inside a newer one.
let sessionEpoch = 0;

function rawCursorKey(data: string, direction: "up" | "down"): boolean {
	if (direction === "up") {
		return data === "\x1b[A" || data === "\x1bOA" || /^\x1b\[[0-9;]*A$/.test(data);
	}
	return data === "\x1b[B" || data === "\x1bOB" || /^\x1b\[[0-9;]*B$/.test(data);
}

function matchesCursorKey(
	data: string,
	direction: "up" | "down",
	keybindings: KeybindingsManager,
): boolean {
	const matcher = (keybindings as unknown as {
		matches?: (value: string, keybinding: string) => boolean;
	}).matches;
	if (typeof matcher === "function") {
		try {
			return matcher.call(keybindings, data, direction === "up" ? "tui.editor.cursorUp" : "tui.editor.cursorDown");
		} catch {
			return rawCursorKey(data, direction);
		}
	}
	return rawCursorKey(data, direction);
}

function getOriginalFactory(): HistoryFactory | undefined {
	return (globalThis as unknown as { [key: symbol]: unknown })[ORIGINAL_FACTORY_SLOT] as HistoryFactory | undefined;
}

function hasOriginalFactory(): boolean {
	return Object.prototype.hasOwnProperty.call(globalThis, ORIGINAL_FACTORY_SLOT);
}

function setOriginalFactory(factory: HistoryFactory | undefined): void {
	(globalThis as unknown as { [key: symbol]: unknown })[ORIGINAL_FACTORY_SLOT] = factory;
}

function clearOriginalFactory(): void {
	delete (globalThis as unknown as { [key: symbol]: unknown })[ORIGINAL_FACTORY_SLOT];
}

function isMarkedHistoryFactory(value: unknown): value is MarkedHistoryFactory {
	return typeof value === "function" && (value as unknown as Record<string, unknown>)[HISTORY_FACTORY_MARKER] === true;
}

export class HistoryEditor implements EditorComponent {
	static readonly isInputHistoryEditor = true;
	readonly isInputHistoryEditor = true;

	private cycling = false;
	private draft = "";
	private matches: string[] = [];
	private index = -1;
	private statusVisible = false;

	private readonly inner: EditorLike;
	private readonly entries: () => string[];
	private readonly keybindings: KeybindingsManager;
	private readonly setStatus: StatusSetter;

	constructor(inner: EditorLike, entries: () => string[], keybindings: KeybindingsManager, setStatus: StatusSetter) {
		this.inner = inner;
		this.entries = entries;
		this.keybindings = keybindings;
		this.setStatus = setStatus;
	}

	render(width: number): string[] {
		return this.inner.render(width);
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	// Delegate clicks to the wrapped editor. Without this, clicks dispatch to
	// Editor.prototype.handleMouse with the wrapper as receiver, where
	// `this.state` is undefined → crash on `this.state.lines`.
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.inner.handleMouse?.(event);
	}

	handleInput(data: string): void {
		if (this.inner.isShowingAutocomplete?.()) {
			this.stopCycling();
			this.inner.handleInput(data);
			return;
		}

		const up = matchesCursorKey(data, "up", this.keybindings);
		const down = matchesCursorKey(data, "down", this.keybindings);

		if (up && (this.cycling || this.shouldInterceptUp())) {
			if (!this.cycling) {
				this.draft = this.inner.getText();
				this.matches = filterHistory(this.entries(), this.draft);
				if (this.matches.length === 0) {
					this.showStatus("no matches");
					return;
				}
				this.cycling = true;
				this.index = 0;
			} else {
				this.index = Math.min(this.index + 1, this.matches.length - 1);
			}
			this.recallCurrent();
			return;
		}

		if (down && this.cycling) {
			this.index -= 1;
			if (this.index < 0) {
				this.inner.setText(this.draft);
				this.stopCycling();
			} else {
				this.recallCurrent();
			}
			return;
		}

		if (this.cycling || this.statusVisible) this.stopCycling();
		this.inner.handleInput(data);
	}

	getText(): string {
		return this.inner.getText();
	}

	setText(text: string): void {
		this.stopCycling();
		this.inner.setText(text);
	}

	get onSubmit(): ((text: string) => void) | undefined {
		return this.inner.onSubmit;
	}

	set onSubmit(value: ((text: string) => void) | undefined) {
		this.inner.onSubmit = value;
	}

	get onChange(): ((text: string) => void) | undefined {
		return this.inner.onChange;
	}

	set onChange(value: ((text: string) => void) | undefined) {
		this.inner.onChange = value;
	}

	addToHistory(text: string): void {
		this.inner.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.stopCycling();
		this.inner.insertTextAtCursor?.(text);
	}

	getExpandedText(): string {
		return this.inner.getExpandedText?.() ?? this.inner.getText();
	}

	setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]): void {
		this.inner.setAutocompleteProvider?.(provider);
	}

	get borderColor(): ((str: string) => string) | undefined {
		return this.inner.borderColor;
	}

	set borderColor(value: ((str: string) => string) | undefined) {
		this.inner.borderColor = value;
	}

	get focused(): boolean {
		return this.inner.focused ?? false;
	}

	set focused(value: boolean) {
		this.inner.focused = value;
	}

	get wantsKeyRelease(): boolean | undefined {
		return this.inner.wantsKeyRelease;
	}

	set wantsKeyRelease(value: boolean | undefined) {
		this.inner.wantsKeyRelease = value;
	}

	setPaddingX(padding: number): void {
		this.inner.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.inner.setAutocompleteMaxVisible?.(maxVisible);
	}

	getPaddingX(): number | undefined {
		return this.inner.getPaddingX?.();
	}

	getAutocompleteMaxVisible(): number | undefined {
		return this.inner.getAutocompleteMaxVisible?.();
	}

	getLines(): string[] | undefined {
		return this.inner.getLines?.();
	}

	getCursor(): CursorPosition | undefined {
		return this.inner.getCursor?.();
	}

	isShowingAutocomplete(): boolean {
		return this.inner.isShowingAutocomplete?.() ?? false;
	}

	get actionHandlers(): Map<unknown, () => void> | undefined {
		return this.inner.actionHandlers;
	}

	get onEscape(): (() => void) | undefined {
		return this.inner.onEscape;
	}

	set onEscape(value: (() => void) | undefined) {
		this.inner.onEscape = value;
	}

	get onCtrlD(): (() => void) | undefined {
		return this.inner.onCtrlD;
	}

	set onCtrlD(value: (() => void) | undefined) {
		this.inner.onCtrlD = value;
	}

	get onPasteImage(): (() => void) | undefined {
		return this.inner.onPasteImage;
	}

	set onPasteImage(value: (() => void) | undefined) {
		this.inner.onPasteImage = value;
	}

	get onExtensionShortcut(): ((data: string) => boolean) | undefined {
		return this.inner.onExtensionShortcut;
	}

	set onExtensionShortcut(value: ((data: string) => boolean) | undefined) {
		this.inner.onExtensionShortcut = value;
	}

	resetHistory(): void {
		this.stopCycling();
	}

	private shouldInterceptUp(): boolean {
		if (this.isInnerHistoryActive()) return false;
		if (
			typeof this.inner.isOnFirstVisualLine !== "function" ||
			typeof this.inner.isEditorEmpty !== "function"
		) {
			return false;
		}
		const cursor = this.inner.getCursor?.();
		return this.inner.isOnFirstVisualLine() &&
			(this.inner.isEditorEmpty() || cursor?.col === 0);
	}

	private isInnerHistoryActive(): boolean {
		const historyIndex = (this.inner as unknown as { historyIndex?: unknown }).historyIndex;
		return typeof historyIndex === "number" && historyIndex > -1;
	}

	private recallCurrent(): void {
		const text = this.matches[this.index];
		if (text === undefined) return;
		this.inner.setText(text);
		this.showStatus(`history ${this.index + 1}/${this.matches.length}`);
	}

	private showStatus(text: string): void {
		this.statusVisible = true;
		this.setStatus(text);
	}

	private stopCycling(): void {
		this.cycling = false;
		this.draft = "";
		this.matches = [];
		this.index = -1;
		if (this.statusVisible) {
			this.statusVisible = false;
			this.setStatus(undefined);
		}
	}
}

// Splice Editor.prototype into the chain so `instanceof Editor` is true for this
// composition wrapper. Other extensions (e.g. @tintinweb/pi-subagents FleetList)
// gate key handling on `focusedComponent instanceof Editor`; without this, a
// wrapper that merely `implements EditorComponent` fails that check. We keep
// composition (no `extends`). HistoryEditor must keep shadowing every Component
// method pi dispatches (render/handleInput/handleMouse) so no inherited Editor
// method ever runs with the wrapper as receiver (`state` lives on `inner`).
Object.setPrototypeOf(HistoryEditor.prototype, Editor.prototype);

function makeHistoryFactory(
	previous: HistoryFactory | undefined,
	defaultEditor: typeof CustomEditor | undefined,
	entries: () => string[],
	setStatus: StatusSetter,
	onCreate: (editor: HistoryEditor) => void,
): MarkedHistoryFactory {
	const factory = ((tui: TUI, theme: EditorTheme, keybindingsManager: KeybindingsManager) => {
		let inner: EditorLike;
		if (!previous) {
			if (!defaultEditor) throw new Error("Default editor constructor is unavailable");
			// CustomEditor has private members, so it is not structurally EditorLike; the cast is type-only.
			inner = new defaultEditor(tui, theme, keybindingsManager) as unknown as EditorLike;
		} else {
			inner = previous(tui, theme, keybindingsManager);
		}
		const editor = new HistoryEditor(inner, entries, keybindingsManager, setStatus);
		onCreate(editor);
		return editor;
	}) as MarkedHistoryFactory;
	Object.defineProperty(factory, HISTORY_FACTORY_MARKER, { value: true });
	return factory;
}

export default function (pi: ExtensionAPI): void {
	let projectFile: string | undefined;
	let entries: string[] = [];
	let activeEditor: HistoryEditor | undefined;

	const resetState = (): void => {
		activeEditor?.resetHistory();
		activeEditor = undefined;
	};

	// Re-establish the history wrapper whenever another extension replaces the
	// editor component (session_start ordering, reloads, or late swaps). A cheap
	// no-op once our marked factory is already installed.
	const ensureHistoryEditor = (ctx: ExtensionContext): void => {
		try {
			if (ctx.mode !== "tui" || !ctx.hasUI) return;
			if (isMarkedHistoryFactory(ctx.ui.getEditorComponent())) return;
			const detectedPrevious = ctx.ui.getEditorComponent();
			if (!hasOriginalFactory()) {
				setOriginalFactory(isMarkedHistoryFactory(detectedPrevious) ? undefined : detectedPrevious);
			}
			const stashedOriginal = getOriginalFactory();
			const previous = isMarkedHistoryFactory(detectedPrevious) ? stashedOriginal : detectedPrevious;

			const factory = makeHistoryFactory(
				previous,
				CustomEditor,
				() => entries,
				(text) => ctx.ui.setStatus("input-history", text),
				(editor) => {
					activeEditor = editor;
				},
			);
			ctx.ui.setEditorComponent(factory);
		} catch (err) {
			try {
				ctx.ui.notify(
					`input-history: editor install failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			} catch {
				// Swallow: history recording must keep working even if the UI is gone.
			}
		}
	};

	pi.registerCommand("input-history-clear", {
		description: "Clear input history for the current project",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) return;
			const file = projectFile ?? historyFileFor(ctx.cwd);
			rmSync(file, { force: true });
			projectFile = file;
			entries = [];
			activeEditor?.resetHistory();
			ctx.ui.notify("Input history cleared for this project", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		projectFile = historyFileFor(ctx.cwd);
		entries = loadHistory(projectFile);
		resetState();

		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		ensureHistoryEditor(ctx);
		const epoch = sessionEpoch;
		setTimeout(() => {
			if (epoch === sessionEpoch) ensureHistoryEditor(ctx);
		}, 0);
	});

	pi.on("session_shutdown", (event, ctx) => {
		sessionEpoch += 1;
		if (ctx.mode === "tui" && ctx.hasUI) {
			if (event.reason === "reload") {
				ctx.ui.setEditorComponent(getOriginalFactory());
			}
			ctx.ui.setStatus("input-history", undefined);
		}
		resetState();
		clearOriginalFactory();
		projectFile = undefined;
		entries = [];
	});

	pi.on("input", (event, ctx) => {
		if (ctx.mode !== "tui" || event.source !== "interactive") return { action: "continue" as const };
		ensureHistoryEditor(ctx);
		const file = projectFile ?? historyFileFor(ctx.cwd);
		if (projectFile === undefined) {
			projectFile = file;
			entries = loadHistory(file);
		}
		if (shouldRecord(entries.at(-1), event.text)) {
			appendHistory(file, event.text);
			entries.push(event.text);
			if (entries.length > MAX_HISTORY_ENTRIES) entries.shift();
		}
		return { action: "continue" as const };
	});
}
