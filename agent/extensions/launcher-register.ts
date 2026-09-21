// session-register — auto-installed by the machine adapter. Binds this Pi session to the local
// machine daemon (127.0.0.1:18473) so it can be mirrored to web/device. No-op if machine isn't running.
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let announced = false;   // posted at least once (the transcript may not exist yet)
  let registered = false;  // posted with a real, on-disk transcript — nothing left to do

  const register = async (ctx: any) => {
    const pane = process.env.TMUX_PANE;
    const herdrPane = process.env.HERDR_PANE_ID;
    let token = "";
    try { token = readFileSync("/Users/gialynguyen/.harness/cli/data/hook-credential", "utf8").trim(); } catch {}
    if ((!pane && !herdrPane) || !token) return;
    // Pi knows the session file path immediately but only WRITES it once the first assistant message
    // lands. Sending a path that isn't on disk yet is rejected by the daemon (it validates the file),
    // so announce without one first and attach the real path on a later turn.
    const file = ctx?.sessionManager?.getSessionFile?.() ?? null;
    const ready = !!file && existsSync(file);
    if (registered || (announced && !ready)) return;
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (!sessionId) return;
    try {
      const res = await fetch("http://127.0.0.1:18473/api/hook/session-start", {
        method: "POST",
        headers: { "content-type": "application/json", "x-harness-hook-token": token },
        body: JSON.stringify({
          engine: "pi",
          pluginVersion: "0.2.39",
          sessionId,
          transcriptPath: ready ? file : undefined,
          cwd: ctx?.cwd ?? undefined,
          tmuxPane: pane,
          callerPid: process.pid,
          runtimeHints: [
            ...(pane ? [{ backend: "tmux", paneId: pane }] : []),
            ...(herdrPane ? [{ backend: "herdr", paneId: herdrPane, sessionName: process.env.HERDR_SESSION, socketPath: process.env.HERDR_SOCKET_PATH }] : []),
          ],
        }),
      });
      if (!res.ok) return; // daemon refused (e.g. transcript not readable yet) — retry on the next turn
      announced = true;
      if (ready) registered = true;
    } catch {}
  };

  // session_start fires before the transcript exists; the turn hooks catch it once it does.
  pi.on("session_start", async (_event, ctx) => { await register(ctx); });
  pi.on("turn_start", async (_event, ctx) => { await register(ctx); });
  pi.on("turn_end", async (_event, ctx) => { await register(ctx); });
}
