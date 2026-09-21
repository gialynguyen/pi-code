---
name: fusion-mode
description: Fusion-mode. Use when the user asks to work using fusion-mode or fusion mode, e.g. "Help me build this feature using fusion-mode".
---

# Fusion-mode

The user asked to work in fusion-mode. Start it, then do their task.

1. **Enable.** Call the `fusion` tool (no arguments). If that tool is not available, skip this step. Done when the result is `fusion-mode: on`, or the tool is missing.
2. **Contract.** Read `/Users/gialynguyen/.pi/agent/fusion-build-prompt.md` unless `[FUSION MODE ACTIVE]` is already in context. Done when you have the contract.
3. **Do the task** under that contract. `/fusion off` ends it.
