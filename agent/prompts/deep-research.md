---
description: Deep research - fan out subagents, cross-check claims with source_check, write cited report
argument-hint: "[quick|standard|deep|exhaustive] <question>"
---

Run a deep-research workflow on: $@
(If no arguments were given, research the current open question in this conversation.)

## Setup

- Depth: if the arguments begin with a depth keyword, use it and treat the rest as the question. Otherwise use `standard`.
  - `quick` — 1 research subagent, one round, spot-check the top 2-3 claims
  - `standard` — 3 angles, one round, `source_check` the load-bearing claims
  - `deep` — 4 angles + a gap-filling second round, `source_check` every key claim
  - `exhaustive` — 5+ angles + up to two gap rounds, `source_check` every material claim
- If the question is ambiguous enough that the angles could point in wrong directions, ask me ONE round of clarifying questions before spending subagent tokens. Otherwise proceed.
- Prefer a few strong subagents with sharp angles over many vague ones.

## Phase 1 — Fan out

Decompose the question into distinct research angles. Default angles, adapted as the question demands:

1. External evidence — `research` subagent: official docs, specs, release notes, benchmarks, primary sources. Prefer current-year sources for fast-moving topics.
2. Local context — `explorer` subagent, only if the question touches the current repo: existing patterns, constraints, integration points, affected files.
3. Practical tradeoffs — `research` or `explorer`: options, risks, costs, what is easiest to validate.
4. Extra angles for `deep`/`exhaustive`: recent developments, ecosystem and community sentiment, edge cases and failure modes, counterarguments to the emerging answer.

Spawn all angle subagents in parallel in a single message, fresh context (not forked). Instruct each subagent to:

- use `web_search` with 2-4 varied queries per angle (different phrasings and scopes, not near-duplicates)
- follow up with `fetch_content` on the most authoritative primary sources it finds
- return concise findings with a source link per claim, a confidence level, and explicit gaps
- not edit any files

## Phase 2 — Cross-check (mandatory, before any synthesis)

Collect the load-bearing claims from all subagent reports. From the main agent — research subagents do not have `source_check` — verify:

- the top claims (for `quick`)
- every claim the final answer depends on (for `standard` and above)

Drop or downgrade claims that come back contradicted or unclear; keep the `source_check` verdict with each claim in the report. Claims found by only one subagent that fail cross-checking are filtered out of the conclusions, not mentioned as fact.

## Phase 3 — Gap round (`deep` and `exhaustive` only)

Identify what the first round could not answer with confidence. Spawn a second round of 1-3 `research` subagents targeting exactly those gaps, same rules as Phase 1. For `exhaustive`, repeat once more if material gaps remain.

## Phase 4 — Report

Synthesize into a single Markdown file. Write it to the established research-notes convention: `~/.pi/agent/research/<kebab-case-topic>.md` — unless the current project has its own research-notes directory, in which case follow that instead.

House format (match the existing files in that directory):

- Title, date, goal
- Summary: the answer, up front
- Findings, each claim with its source link and (where run) its `source_check` verdict
- Disagreements between sources called out, not smoothed over
- Unverified observations in their own clearly-marked section
- Recommendation / next moves

Then report back in chat: the file path plus the headline answer in a few sentences.

This is research only. Do not implement anything unless I explicitly ask.
