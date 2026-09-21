---
description: Fusion health check - verify the agent team is installed, loadable, and enforcing
---

Run a Fusion health check and report the result as a table. Change nothing - this command only reports.

Check each of the following and report PASS or FAIL with the evidence:

1. **Agent files present.** Confirm these exist in `~/.pi/agent/agents/`: `sidekick.md`, `explorer.md`, `research.md`, `reviewer.md`, `design.md`, `vision.md`. Report any that are missing.

2. **Agent types registered.** Call `subagent({ action: "list" })` (the pi-subagents tool) and list the returned agent names. Every file above should appear as a name. A file that exists but is not listed means its frontmatter failed to parse - say so.

3. **Model routing resolves.** Agents carry no model pins in frontmatter; pi-subagents resolves each agent's model from `subagents.agentOverrides` and `subagents.defaultModel` in `~/.pi/agent/settings.json` (plus project `.pi/settings.json`, which wins), falling back to the parent model. Read those entries, check each model against `pi --list-models`, and flag any that do not resolve - an unresolvable override makes the launch fail loudly rather than falling back.

4. **Build prompt present.** Confirm `~/.pi/agent/fusion-build-prompt.md` exists and is non-empty.

5. **Slash commands present.** Confirm `fusion-plan.md` and `fusion-status.md` exist in `~/.pi/agent/prompts/`.

6. **Enforcement mode.** Report which mode this session is in:
   - **STRICT** if `edit`, `write`, `grep`, `find`, and `ls` are absent from your own toolset (started via `pi-fusion`). Enforcement is mechanical.
   - **SOFT** if you do have those tools. The Fusion boundary is then prompt-level discipline only, held by `/fusion-agent`. Say this plainly rather than reporting a false pass.

7. **Nested delegation.** State that subagents are leaf nodes - they do not receive the `subagent` tool (pi-subagents keeps children leaf nodes unless an agent explicitly allows nesting via `tools: subagent` or `allowNestedSubagents: true`) - so all orchestration must stay with the main session.

Finish with a one-line verdict: whether Fusion is ready to use, and the single most useful thing to fix if not.
