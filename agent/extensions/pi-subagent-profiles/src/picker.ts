import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";

export interface PickerModel {
  provider: string;
  id: string;
  name: string;
}

export interface PseudoEntry {
  value: string;
  label: string;
  description: string;
}

export interface Section {
  header: string | null;
  items: PickerModel[];
}

export interface PickModelsOptions {
  title: string;
  mode: "single" | "multi";
  models: readonly PickerModel[];
  pseudoEntries?: readonly PseudoEntry[];
}

function pseudoModel(entry: PseudoEntry): PickerModel {
  return { provider: "", id: entry.value, name: entry.label };
}

export function buildSections(models: readonly PickerModel[], pseudo?: readonly PseudoEntry[]): Section[] {
  const sections: Section[] = [];
  if (pseudo && pseudo.length > 0) {
    sections.push({ header: null, items: pseudo.map((entry) => pseudoModel(entry)) });
  }

  const grouped = new Map<string, PickerModel[]>();
  for (const model of models) {
    const items = grouped.get(model.provider);
    if (items) items.push(model);
    else grouped.set(model.provider, [model]);
  }
  for (const provider of [...grouped.keys()].sort((a, b) => a.localeCompare(b))) {
    const items = grouped.get(provider);
    if (!items) continue;
    items.sort((a, b) => a.id.localeCompare(b.id));
    sections.push({ header: provider, items });
  }
  return sections;
}

export function filterSections(sections: readonly Section[], query: string): Section[] {
  if (query === "") return sections as Section[];
  const filtered: Section[] = [];
  for (const section of sections) {
    if (section.header === null) {
      filtered.push(section);
      continue;
    }
    const items = fuzzyFilter(
      [...section.items],
      query,
      (model) => {
        const name = model.name ? ` ${model.name}` : "";
        return `${model.provider} ${model.provider}/${model.id} ${model.provider} ${model.id}${name}`;
      },
    );
    if (items.length > 0) filtered.push({ header: section.header, items });
  }
  return filtered;
}

export function flattenSelectable(sections: readonly Section[]): string[] {
  const values: string[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      values.push(section.header === null ? item.id : `${item.provider}/${item.id}`);
    }
  }
  return values;
}

export function defaultSelectionIndex(sections: readonly Section[], query: string): number {
  if (query === "") return 0;
  let index = 0;
  for (const section of sections) {
    if (section.header !== null && section.items.length > 0) return index;
    index += section.items.length;
  }
  return 0;
}

export function reanchorIndex(previousValue: string | null, selectables: readonly string[]): number {
  if (selectables.length === 0) return 0;
  if (previousValue !== null) {
    const index = selectables.indexOf(previousValue);
    if (index >= 0) return index;
  }
  return selectables.length - 1;
}

export function computeWindow(
  lineCount: number,
  selectedLine: number,
  maxVisible: number,
): { start: number; end: number } {
  const safeLineCount = Math.max(0, lineCount);
  const safeMaxVisible = Math.max(0, maxVisible);
  const maxStart = Math.max(0, safeLineCount - safeMaxVisible);
  const start = Math.max(0, Math.min(selectedLine - Math.floor(safeMaxVisible / 2), maxStart));
  return { start, end: Math.min(start + safeMaxVisible, safeLineCount) };
}

type PickResult = string[] | string | null;

type Selectable = {
  value: string;
  model: PickerModel;
  pseudo: boolean;
};

class ModelPicker implements Component, Focusable {
  private readonly topBorder: DynamicBorder;
  private readonly bottomBorder: DynamicBorder;
  private readonly input: Input;
  private readonly baseSections: Section[];
  private readonly pseudoEntries: Map<string, PseudoEntry>;
  private readonly mode: "single" | "multi";
  private readonly title: string;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: (result: PickResult) => void;
  private filteredSections: Section[] = [];
  private chain: string[] = [];
  private selectedIndex = 0;
  private _focused = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    options: PickModelsOptions,
    done: (result: PickResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.title = options.title;
    this.mode = options.mode;
    this.done = done;
    this.topBorder = new DynamicBorder((text: string) => theme.fg("accent", text));
    this.bottomBorder = new DynamicBorder((text: string) => theme.fg("accent", text));
    this.input = new Input();
    this.baseSections = buildSections(options.models, options.pseudoEntries);
    this.pseudoEntries = new Map((options.pseudoEntries ?? []).map((entry) => [entry.value, entry]));
    this.refreshSections(true);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  invalidate(): void {
    this.topBorder.invalidate();
    this.bottomBorder.invalidate();
    this.input.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    const lines: string[] = [];
    const append = (line: string): void => {
      lines.push(truncateToWidth(line, safeWidth));
    };

    for (const line of this.topBorder.render(safeWidth)) append(line);
    append(this.theme.bold(this.theme.fg("accent", this.title)));
    for (const line of this.input.render(safeWidth)) append(line);

    append(this.theme.fg("dim", this.mode === "multi"
      ? "type to filter | up/down navigate | enter add | esc finish"
      : "type to filter | up/down navigate | enter select | esc skip"));
    if (this.mode === "multi" && this.chain.length > 0) {
      append(this.theme.fg("dim", `chain: ${this.chain.join(" > ")}`));
    }

    const list = this.renderList(safeWidth);
    for (const line of list) append(line);
    for (const line of this.bottomBorder.render(safeWidth)) append(line);
    return lines;
  }

  handleInput(data: string): void {
    const kb = this.keybindings;
    if (kb.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      this.selectCurrent();
      return;
    }
    if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) {
      this.done(this.mode === "multi" ? [...this.chain] : null);
      return;
    }
    if (
      matchesKey(data, Key.backspace) &&
      this.input.getValue() === "" &&
      this.mode === "multi" &&
      this.chain.length > 0
    ) {
      this.chain.pop();
      this.refreshSections(false);
      this.tui.requestRender();
      return;
    }

    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) {
      this.refreshSections(true);
      this.tui.requestRender();
    }
  }

  private moveSelection(delta: -1 | 1): void {
    const count = flattenSelectable(this.filteredSections).length;
    if (count === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + count) % count;
    this.tui.requestRender();
  }

  private selectCurrent(): void {
    const selectable = this.getSelectable();
    const selected = selectable[this.selectedIndex];
    if (!selected) return;
    if (selected.pseudo) {
      if (this.mode === "single") this.done(selected.value);
      else this.done([selected.value]);
      return;
    }
    if (this.mode === "single") {
      this.done(selected.value);
      return;
    }
    if (!this.chain.includes(selected.value)) this.chain.push(selected.value);
    this.input.setValue("");
    this.refreshSections(true);
    this.tui.requestRender();
  }

  private refreshSections(resetSelection: boolean): void {
    const previousValue = resetSelection ? null : this.getSelectable()[this.selectedIndex]?.value ?? null;
    let sections = this.baseSections;
    if (this.mode === "multi" && this.chain.length > 0) {
      sections = sections.filter((section) => section.header !== null);
    }
    this.filteredSections = filterSections(sections, this.input.getValue());
    const selectables = flattenSelectable(this.filteredSections);
    this.selectedIndex = resetSelection
      ? defaultSelectionIndex(this.filteredSections, this.input.getValue())
      : reanchorIndex(previousValue, selectables);
  }

  private getSelectable(): Selectable[] {
    const selectable: Selectable[] = [];
    for (const section of this.filteredSections) {
      for (const model of section.items) {
        const pseudo = section.header === null;
        selectable.push({
          value: pseudo ? model.id : `${model.provider}/${model.id}`,
          model,
          pseudo,
        });
      }
    }
    return selectable;
  }

  private renderList(width: number): string[] {
    const selectable = this.getSelectable();
    if (selectable.length === 0) return [this.theme.fg("warning", "  No matching models")];

    const displayLines: string[] = [];
    const selectableLines: number[] = [];
    const modelLabelWidth = selectable.reduce(
      (max, entry) => (entry.pseudo ? max : Math.max(max, visibleWidth(`${entry.model.provider}/${entry.model.id}`))),
      0,
    );
    let selectableIndex = 0;
    for (const section of this.filteredSections) {
      if (section.header !== null) {
        displayLines.push(this.theme.fg("muted", `${section.header} (${section.items.length})`));
      }
      for (const model of section.items) {
        selectableLines.push(displayLines.length);
        displayLines.push(this.renderItem(model, section.header === null, selectableIndex === this.selectedIndex, modelLabelWidth));
        selectableIndex += 1;
      }
    }

    const selectedLine = selectableLines[this.selectedIndex] ?? 0;
    const window = computeWindow(displayLines.length, selectedLine, 8);
    const clipped = window.start > 0 || window.end < displayLines.length;
    const lines = displayLines.slice(window.start, window.end);
    if (clipped) lines.push(this.theme.fg("dim", `(${this.selectedIndex + 1}/${selectable.length})`));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderItem(model: PickerModel, pseudo: boolean, selected: boolean, labelWidth: number): string {
    const prefix = selected ? "> " : "  ";
    const value = pseudo ? model.id : `${model.provider}/${model.id}`;
    const label = pseudo ? this.pseudoEntries.get(value)?.label ?? model.name : value;
    const valueText = selected ? this.theme.fg("accent", `${prefix}${label}`) : `${prefix}${label}`;
    if (pseudo) {
      const entry = this.pseudoEntries.get(value);
      const description = entry?.description ?? "";
      return `${valueText}${description === "" ? "" : this.theme.fg("dim", `  ${description}`)}`;
    }
    const padding = " ".repeat(Math.max(0, labelWidth - visibleWidth(value) + 2));
    return `${valueText}${this.theme.fg("dim", `${padding}${model.name}`)}`;
  }
}

export function pickModels(ctx: ExtensionContext, options: PickModelsOptions & { mode: "multi" }): Promise<string[]>;
export function pickModels(ctx: ExtensionContext, options: PickModelsOptions & { mode: "single" }): Promise<string | null>;
export function pickModels(ctx: ExtensionContext, options: PickModelsOptions): Promise<string[] | string | null> {
  return ctx.ui.custom<PickResult>(
    (tui, theme, keybindings, done) => new ModelPicker(tui, theme, keybindings, options, done),
    { overlay: true, overlayOptions: { width: "70%", maxHeight: "60%", anchor: "center" } },
  );
}
