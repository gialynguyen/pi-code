# Calibration

Do **not** copy the content of these examples. Copy the *form* — the tone, the specificity, and where the line sits between a finding that changes a decision and one that does not. Layout follows Step 6 of SKILL.md; the appendix is stubbed here because the raws are evidence, not calibration.

Two worked runs follow. The `GO` one is the important one.

---

## Example 1 — a real `NO-GO`

**Proposal:** "Let's replace our Postgres full-text search with the vector search built into SQLite so we can drop the Postgres dependency and run the whole app from a single file. Should be a couple of days' work."

```
TL;DR
  VERDICT: NO-GO
  Why: the proposal's core premise — that SQLite has built-in vector search — is false, and the
  extension that provides it does not support the concurrent-write pattern this app already relies on.

LOAD-BEARING CLAIMS
  SQLite has built-in vector search — [verified: sqlite.org/docs.html — no vector type or index exists in core SQLite]
  sqlite-vec can replace pg full-text search — [testable: benchmark recall@10 on our corpus]
  Dropping Postgres removes operational burden — [assumed]
  The work is ~2 days — [assumed]

WHAT KILLS IT
  SQLite has no built-in vector search. The capability comes from `sqlite-vec`, a loadable
  extension — which means the "single file, no dependencies" benefit that motivates the whole
  change does not exist. You would trade a Postgres dependency for a compiled-extension
  dependency that must be built per platform. To survive: the proposal would need to be
  re-scoped as "adopt sqlite-vec," and the single-file benefit dropped from the justification entirely.

FINDINGS
  | lethal  | No built-in vector search; requires a loadable native extension, so the stated motivation is unattainable | would need the motivation restated |
  | serious | Full-text and vector search are not substitutes. The current queries are keyword/prefix; swapping to embeddings changes result semantics, not just the backend | would need product sign-off that changed results are acceptable |
  | serious | Writer concurrency: this app has 4 background workers writing during indexing. SQLite permits one writer; WAL does not change that | would need the workers serialised behind a single writer, which is not in the plan |
  | minor   | "Should be a couple of days" — hand-wave. The estimate covers neither the re-embedding backfill nor the per-platform extension build | — |

WHERE THE CRITICS DISAGREED
  Critic A rated the concurrency issue lethal; Critic B rated it serious on the grounds that a
  single-writer queue is a known, bounded fix. I side with B — it is real and unplanned, but it
  has a standard remedy. It does not need to be lethal, because finding #1 already is.

WHAT BOTH CRITICS MISSED
  Neither asked what actually drove the request. If the real goal is cheaper hosting rather than
  architectural simplicity, managed Postgres tiers are worth pricing before any migration is designed.

SKIPPED
  Local reality check ran; results folded into findings above.

---
## Appendix — raw critiques (verbatim, unedited)
<critic outputs, unedited>
```

Note what makes this a `NO-GO` rather than a long list of concerns: **one claim was checked and found false**, and it was the claim the justification rested on. That is the gate firing, not an accumulation of grumbles.

---

## Example 2 — a real `GO`

This is the harder example. A `GO` must not collapse into applause.

**Proposal:** "Add a `--json` flag to our CLI's `status` command so CI can parse it, instead of the current human-readable table. Reuse the existing serializer."

```
TL;DR
  VERDICT: GO
  Why: every load-bearing claim checked out against the code, the serializer exists and already
  covers the required fields, and no critic found a lethal issue.

LOAD-BEARING CLAIMS
  A reusable serializer already exists — [verified: src/output/serialize.ts:14-62]
  It covers every field the table renders — [verified: src/commands/status.ts:88-114
    renders 7 fields; serializer emits all 7]
  No consumer parses the current table output — [verified: grep across ci/ and
    scripts/ finds no callers of `status` without `--porcelain`]
  Adding a flag is non-breaking — [testable: existing snapshot tests must pass unchanged]

WHAT KILLS IT
  Nothing lethal found.

FINDINGS
  | serious | The serializer emits `lastSync` as a localised string, not ISO 8601. Machine consumers will need to re-parse it | would need the JSON path to emit ISO 8601 while the table keeps the localised form |
  | minor   | No schema versioning on the output. The first consumer to depend on the shape will make it an implicit contract | would need a `"schemaVersion": 1` field now, which is cheap before there are consumers and expensive after |
  | minor   | `status` exits non-zero when degraded. In JSON mode a parser sees an exit code and no output unless the flag is handled before the early return | would need the JSON branch to emit a document on the degraded path too |

WHERE THE CRITICS DISAGREED
  Critic A wanted the localised-timestamp issue treated as a blocker; Critic B considered it a
  detail. A is closer to right: it is the one finding that would silently produce wrong values
  downstream rather than an obvious error. It stays serious, and it is the first condition to
  handle even under a GO.

WHAT BOTH CRITICS MISSED
  Neither checked whether `--json` collides with a global flag. It does not
  (verified: no global `--json` in src/cli.ts:20-58) — but that check belonged in
  the review, not in the synthesis.

SKIPPED
  Web search returned nothing relevant; this is a local API-shape question with no meaningful
  external precedent to check. Said so rather than padding with generic CLI-design advice.

---
## Appendix — raw critiques (verbatim, unedited)
<critic outputs, unedited>
```

### What to take from the `GO`

- **No applause.** A `GO` means the risk moved from "this idea is wrong" to "these three details are unresolved." That is a smaller claim than approval, and it is stated as such.
- **A `GO` still carries findings.** Three of them. Zero findings on a non-trivial proposal is a sign the critics did not engage, not a sign the proposal is perfect.
- **The evidence is specific.** `src/output/serialize.ts:14-62`, not "the serializer looks reusable." Every claim is checked at a location.
- **Absence of evidence is reported, not padded.** The web search found nothing, and the run says so. It does not substitute generic best-practice filler for a real answer.
- **Findings that would not change the decision are not present.** No naming nits, no "consider adding tests," no restating the proposal back.

---

## The failure mode this file exists to prevent

A critic that returns `NO-GO` on everything is exactly as worthless as one that returns `GO` on everything — it carries no information either way, and it trains the reader to ignore it.

The tie-break in Step 5 leans toward `NO-GO` **on genuine ambiguity only**. It is not a licence to reach for `NO-GO` when the claims actually check out. If you cannot point to a specific claim that failed, a specific documented precedent, or a specific missing dependency, you do not have a `NO-GO` — you have `GO-WITH-CONDITIONS` and some discomfort.
