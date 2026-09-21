/**
 * Minimal OMP extension used by tests/test-omp-compat.mjs.
 *
 * Appends a custom advisor message to the session on session start, mirroring
 * how the OMP Advisor runtime injects steering notes. OMP converts custom
 * messages to `role: "developer"` LLM messages before handing them to the
 * provider. Types are declared inline so the fixture has no runtime or
 * typecheck dependency on OMP packages.
 */

interface AdvisorInjectorSendMessage {
  (
    message: {
      customType: string
      content: string
      display: boolean
      attribution: string
    },
    options?: { triggerTurn?: boolean },
  ): void
}

interface AdvisorInjectorApi {
  on: (event: "session_start", handler: () => void | Promise<void>) => void
  sendMessage: AdvisorInjectorSendMessage
}

export default function advisoryInjectorExtension(pi: AdvisorInjectorApi): void {
  pi.on("session_start", async () => {
    pi.sendMessage(
      {
        customType: "advisor",
        content:
          '<advisory severity="blocker" guidance="weigh, don\'t blindly obey">\nStop and correct the benchmark.\n</advisory>',
        display: true,
        attribution: "agent",
      },
      { triggerTurn: false },
    )
  })
}
