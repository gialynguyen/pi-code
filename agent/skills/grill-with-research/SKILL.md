---
name: grill-with-research
description: A relentless interview to sharpen a plan or design, which also researches and cross-checks external fact-gaps.
disable-model-invocation: true
---

Call the Skill tool with "grilling".

## Research delta

- External fact-gaps (library behavior, API and version specifics, benchmarks, release notes, prior art) are never settled from memory: dispatch `research` subagents. Filesystem and repo facts still go to `explore`.
- Size depth per gap: one subagent to spot-check a minor fact; 2-4 parallel angles when the fact is load-bearing for a whole branch of the design tree.
- Instruct each dispatched subagent to run `web_search` with 2-4 varied queries, `fetch_content` the primary sources, and attach a confidence level to each claim.
- Cross-check from the main agent with `source_check` (research subagents do not have that tool) on load-bearing claims.
- Drop or downgrade claims that come back contradicted or unclear.
- Recommended answers carry their source links inline, in the `➡️` recommendation line of grilling's question format.

Research is done when every external fact-gap has been dispatched, every load-bearing claim cross-checked, and every recommendation carries its source links.
