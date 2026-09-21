import { strict as assert } from "node:assert";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { Editor } from "@earendil-works/pi-tui";
import { HistoryEditor } from "./index.ts";

function pass(name: string): void {
	console.log(`PASS ${name}`);
}

// Minimal stubs: the HistoryEditor constructor only assigns fields and never
// invokes methods, so empty objects (cast to the expected shapes) suffice.
// EditorLike/KeybindingsManager/StatusSetter are internal to index.ts, so the
// stubs are cast through `unknown` via ConstructorParameters.
const inner = {} as unknown as ConstructorParameters<typeof HistoryEditor>[0];
const keybindings = {} as unknown as ConstructorParameters<typeof HistoryEditor>[2];
const editor = new HistoryEditor(inner, () => [], keybindings, () => {});

assert.equal(editor instanceof Editor, true);
pass("HistoryEditor passes instanceof Editor");

assert.equal(({}) instanceof Editor, false);
pass("plain object does not pass instanceof Editor (would fail before the fix)");

assert.equal(
	Object.getPrototypeOf(Object.getPrototypeOf(editor)) === Editor.prototype,
	true,
);
pass("Editor.prototype is spliced directly into HistoryEditor's prototype chain");

// Regression test for the click-to-focus crash: HistoryEditor inherits
// Editor.prototype.handleMouse via the prototype splice, so without its own
// handleMouse the dispatch runs with the wrapper as receiver (`state` lives
// on `inner`) and throws on `this.state.lines`. It must delegate instead.
const seen: TuiMouseEvent[] = [];
const clickable = {
	render: (_width: number) => ["x"],
	handleMouse: (event: TuiMouseEvent) => {
		seen.push(event);
		return { handled: true, focus: true } as const;
	},
	handleInput: (_data: string) => {},
	getText: () => "",
	setText: (_text: string) => {},
} as unknown as ConstructorParameters<typeof HistoryEditor>[0];
const clickEditor = new HistoryEditor(clickable, () => [], keybindings, () => {});
const clickEvent = {
	type: "click",
	button: "left",
	x: 1,
	y: 1,
	screenX: 1,
	screenY: 1,
	width: 80,
	height: 5,
	shift: false,
	alt: false,
	ctrl: false,
} as TuiMouseEvent;
const clickResult = (clickEditor as unknown as Component).handleMouse?.(clickEvent);
assert.deepEqual(clickResult, { handled: true, focus: true });
assert.equal(seen.length, 1);
assert.equal(seen[0], clickEvent);
pass("handleMouse delegates click to inner editor (no inherited-state crash)");