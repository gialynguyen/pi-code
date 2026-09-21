/**
 * Test fixture: a sibling extension that streams through the pi-ai compat
 * entrypoint with the active session model, the way background-agent
 * extensions do. Registers `/compat-call` so the test can drive it over RPC.
 *
 * Types are declared inline so the fixture has no typecheck dependency on the
 * optional pi peer packages; the host's extension loader resolves the import.
 */

// @ts-expect-error pi resolves this peer package at load time.
import * as compatModule from "@earendil-works/pi-ai/compat"

interface CompatTextPart {
  type: string
  text?: string
}

interface CompatStreamResult {
  result(): Promise<{ content: readonly CompatTextPart[] }>
}

interface CompatModule {
  streamSimple(model: unknown, context: unknown): CompatStreamResult
}

interface CompatCallerContext {
  model?: unknown
  ui: { notify(message: string, level: "info" | "error"): void }
}

interface CompatCallerExtensionApi {
  registerCommand(
    name: string,
    command: {
      description: string
      handler: (args: string, ctx: CompatCallerContext) => Promise<void>
    },
  ): void
}

const compat = compatModule as CompatModule

export default function (pi: CompatCallerExtensionApi) {
  pi.registerCommand("compat-call", {
    description: "Stream through @earendil-works/pi-ai/compat with the session model",
    handler: async (_args, ctx) => {
      const model = ctx.model
      if (!model) {
        ctx.ui.notify("compat-call: no active model", "error")
        return
      }
      try {
        const message = await compat
          .streamSimple(model, {
            messages: [{ role: "user", content: "say mock token", timestamp: Date.now() }],
          })
          .result()
        const text = message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("")
        ctx.ui.notify(`compat-call ok: ${text}`, "info")
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`compat-call failed: ${detail}`, "error")
      }
    },
  })
}
