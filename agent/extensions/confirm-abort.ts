/**
 * confirm-abort — require confirmation before the interrupt key aborts the active agent run.
 *
 * pi's interrupt keybinding ("app.interrupt", Escape by default) cancels/aborts
 * the running agent turn. While the agent is working (LLM streaming, a tool
 * executing, retrying, or compacting), a stray keypress throws that work away.
 * This extension gates the abort behind a confirmation dialog:
 *
 *   interrupt while working  ->  "Abort current run?"   [Enter = stop, Esc = keep running]
 *   interrupt while idle     ->  untouched (autocomplete cancel, double-ESC, bash-mode
 *                                clear, etc. all behave exactly as without the extension)
 *
 * If the run finishes on its own while the dialog is open, the dialog
 * auto-dismisses and the work is kept.
 *
 * How it works:
 * - The extension patches CustomEditor.prototype.handleInput once per process.
 *   Every editor that ultimately delegates to CustomEditor's handleInput — the
 *   built-in editor, and extension editors that call super.handleInput or
 *   delegate to an inner editor (slash-autocomplete, input-history, vim, ...) —
 *   passes through the gate. Because the gate lives at the keybinding layer
 *   instead of raw terminal input, it:
 *     - follows the user's keybinding config (rebinding app.interrupt moves it)
 *     - runs after the TUI's key-release filter (no manual release handling)
 *     - only fires while the editor is focused (other extensions' overlays and
 *       dialogs keep their own interrupt-key handling)
 *     - coexists with extensions that replace or wrap the editor: no factory
 *       chain conflicts, no callback forwarding, no editor lifecycle management
 * - On confirmation, the editor's current interrupt handler (onEscape) is
 *   invoked — the exact built-in interrupt path at that moment, covering
 *   streaming aborts, retry aborts, and compaction aborts alike.
 * - Run state is tracked via agent_start / agent_settled. "Settled" is the
 *   point where pi will not auto-retry, auto-compact, or continue with queued
 *   follow-ups, so the gate stays active across those transitions.
 * - The dialog gets an AbortController; agent_settled aborts it so the dialog
 *   closes itself when there is nothing left to abort.
 * - Gate state and the gate handler live on globalThis so /reload (which
 *   re-evaluates the module and re-registers handlers) updates the
 *   already-installed patch with fresh state and fresh logic instead of
 *   leaving a stale closure.
 * - All event handlers filter on ctx.mode === "tui": headless sessions
 *   (sidekick subagents run in print mode) emit the same events through the
 *   same extension system, and their no-op UI context (confirm -> false)
 *   must never overwrite the TUI session's state.
 *
 * Known limitations:
 * - Editors that neither extend CustomEditor nor delegate to it are not gated
 *   (inherent to the prototype patch).
 * - While the built-in inline autocomplete popup is open, the interrupt key
 *   closes the popup instead of gating (built-in behavior, preserved).
 * - Background sidekicks are not gated: once the main agent run settles, the
 *   interrupt key falls through to the built-in behavior, which has nothing
 *   to abort while a background subagent runs.
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Marks CustomEditor.prototype once the gate is installed (survives /reload). */
const PATCH_MARKER = Symbol.for("confirm-abort.prototypePatched");
/** Shared gate state, so a re-evaluated module updates the installed patch. */
const STATE_KEY = Symbol.for("confirm-abort.state");

interface GateState {
  ctx?: ExtensionContext;
  runActive: boolean;
  dialogAbort?: AbortController;
  /** Installed gate handler; replaced on /reload so the patch picks up new logic. */
  handle?: (editor: CustomEditor, data: string) => boolean;
}

export default function (pi: ExtensionAPI) {
  const globalState = globalThis as unknown as Record<symbol, GateState>;
  const state: GateState = globalState[STATE_KEY] ?? { runActive: false };
  globalState[STATE_KEY] = state;

  // Install the gate handler. This is the only module-load side effect:
  // /reload re-evaluates the module and must be able to replace the handler
  // with fresh logic. Per-session state is reset by session_start below —
  // NOT here, because headless sessions (sidekick subagents) also load this
  // module and would clobber the TUI session's state mid-run.
  state.handle = makeGateHandler();

  installGate();

  // All event handlers filter on ctx.mode === "tui": headless sessions
  // (sidekick subagents run in print mode) emit the same events through the
  // same extension system, and their no-op UI context (confirm -> false)
  // must never overwrite the TUI session's state.
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    state.runActive = true;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    state.runActive = false;
    // If the confirm dialog is still open, close it: nothing is left to abort.
    state.dialogAbort?.abort();
    state.dialogAbort = undefined;
  });

  pi.on("session_start", (_event, sessionCtx) => {
    if (sessionCtx.mode !== "tui") return;
    state.ctx = sessionCtx;
    state.runActive = false;
    state.dialogAbort?.abort();
    state.dialogAbort = undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    state.dialogAbort?.abort();
    state.dialogAbort = undefined;
    state.runActive = false;
    state.ctx = undefined;
  });

  /** Install the gate on CustomEditor.prototype once per process. */
  function installGate(): void {
    const proto = CustomEditor.prototype as CustomEditor & { [PATCH_MARKER]?: boolean };
    if (proto[PATCH_MARKER]) return;
    proto[PATCH_MARKER] = true;

    const original = proto.handleInput;
    proto.handleInput = function (this: CustomEditor, data: string): void {
      if (state.handle?.(this, data)) return; // consumed by the gate
      original.call(this, data);
    };
  }

  /** Decide per keypress whether to consume the key. Mirrors the original
   *  handleInput order for the interrupt key: extension shortcuts first,
   *  then the autocomplete popup, then the gate. */
  function makeGateHandler(): (editor: CustomEditor, data: string) => boolean {
    return (editor, data) => {
      // keybindings is TS-private on CustomEditor; reach it like other
      // extensions do (slash-autocomplete uses the same cast).
      const kb = (editor as unknown as {
        keybindings?: { matches(d: string, a: string): boolean };
      }).keybindings;
      if (!kb?.matches(data, "app.interrupt")) return false;
      if (editor.onExtensionShortcut?.(data)) return true; // shortcut wins
      if (editor.isShowingAutocomplete()) return false; // popup closes first
      return gateInterrupt(editor);
    };
  }

  /** Show the confirm dialog if a run is active. Returns true if the key was consumed. */
  function gateInterrupt(editor: CustomEditor): boolean {
    if (!state.runActive) return false;
    // Dialog already pending: swallow. Never fall through to the built-in
    // abort while a confirmation is outstanding.
    if (state.dialogAbort) return true;

    const controller = new AbortController();
    state.dialogAbort = controller;

    void (async () => {
      try {
        const confirmed = await state.ctx?.ui.confirm(
          "Abort current run?",
          "The agent is still working.\n\nEnter — stop it now\nEsc — keep it running",
          { signal: controller.signal },
        );
        if (confirmed) {
          // Identical to the built-in interrupt at this moment: the dynamic
          // onEscape handler covers streaming, retry, and compaction aborts.
          const handler = editor.onEscape ?? editor.actionHandlers.get("app.interrupt");
          handler?.();
        }
      } finally {
        if (state.dialogAbort === controller) state.dialogAbort = undefined;
      }
    })();

    return true;
  }
}
