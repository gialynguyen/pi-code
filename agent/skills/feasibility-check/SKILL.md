---
name: feasibility-check
description: Verify whether an idea, plan, or claim is actually feasible — honestly, with a reachable NO-GO. Extracts the load-bearing claims as falsifiable questions, dispatches trace-blind critics in parallel to hunt disconfirming evidence and documented failure precedents, checks the local repo for dependencies the proposal assumes exist, then returns GO / GO-WITH-CONDITIONS / NO-GO from a conjunctive gate that breaks ties toward NO-GO. Use before committing to a plan, when a decision feels too comfortable, or when you need someone to tell you the thing will not work.
license: MIT
disable-model-invocation: true
---

# Feasibility check

Your job is to find out whether this holds up. Not to help it along.

**The one rule:** a `NO-GO` is a successful outcome of this skill. So is a `GO`. An unreachable `NO-GO` makes the whole exercise theatre — if you cannot describe what result would have produced one, you have not run this skill.

---

## Step 0 — Reframe before judging

Do this first, always, and show it. Do not evaluate the proposal in the form it arrived in.

1. Write the proposal as **3–6 load-bearing claims** — the things that must be true for it to work. Not risks, not tasks. Claims.
2. Convert each into a **question with a discoverable answer**: "Does X actually support Y?" not "X should support Y."
3. Mark each claim `[verified: <url | file:line>]`, `[testable: <the specific check>]`, or `[assumed]`.

If you cannot state a claim in falsifiable form, that is itself a finding — record it as `[unfalsifiable]` and carry it forward.

Why this step exists and comes first: evaluating a proposal *as asserted* is the single largest driver of agreement bias; restating it as an open question measurably reverses it. Everything below is weaker than this step.

---

## Step 1 — Assemble the brief

Build one self-contained artifact for the critics. It contains **only**:

- the proposal text (in full, verbatim);
- your Step 0 claim list;
- the minimum context needed to judge it.

It must **not** contain: this conversation, your own opinion, who proposed it, how confident anyone sounded, or any prior round's conclusions. Critics inherit no context by default in pi — do not hand-carry it back in. Selecting what "context" to paste is where your framing leaks, so keep it to the artifact.

---

## Step 2 — Dispatch two critics, in one message

Send **one** message containing **both** `Agent` calls. One message is what makes them run in parallel.

Fixed at two. Not dynamic. More critics drawn from the same model do not buy more truth — they agree with each other roughly 60% of the time *when both are wrong*, and multi-critic debate measures no better than a single pass at 2–3× the tokens. The gain comes from context isolation, not headcount.

**Critic A — claim verifier** · `subagent_type: research`

> Verify or refute each claim below against primary sources. Your job is to find what makes them **false**, not to confirm them.
> 1. For each claim: search for evidence that **contradicts** it before evidence that supports it. Report both.
> 2. Search for **documented cases where a lookalike actually failed** — postmortems, shutdowns, deprecations, migration retrospectives, closed issues. One documented failure of a real lookalike outweighs any amount of reasoning about what *might* go wrong.
> 3. Quote the proposal's own wishful-thinking phrases back at it and say what each is standing in for: `should work`, `we expect`, `typically`, `straightforward`, `just`, `simply`, `it's only`.
> Mark every factual statement `[verified: <url>]` or `[estimate]`. Never both, never neither.
> Return: findings, each with severity `lethal | serious | minor`, and for each — **what would have to be true for the proposal to survive it**.

**Critic B — pre-mortem** · `subagent_type: reviewer`

> Assume this has already failed. Work backwards.
> 1. Name the top 3 causes, most probable first. Mechanism, not vibes.
> 2. Quote every hand-wave in the proposal and say what a concrete substitute looks like: `figure out`, `coordinate with`, `as needed`, `TBD`, `handle`, `somehow`, `we'll see`.
> 3. Name what is **missing** that someone experienced would expect to be there.
> 4. If you would bet against this, say what you would bet against and at what odds.
> Return: findings, each with severity `lethal | serious | minor`, and for each — **what would have to be true for the proposal to survive it**.

Both critic prompts must end with the shared guards in the **Guards** section below. Paste them in.

**Do not** tell a critic to dispatch its own agents. pi subagents are leaf nodes — they do not receive the `Agent` tool, so a nested dispatch silently degrades to one serial pass and you lose the isolation that is doing all the work here. All dispatch stays in this session.

---

## Step 3 — Local reality check (only when it applies)

If the proposal names files, modules, APIs, scripts, commands, env vars, or dependencies **in this repo**, add a third call to the same message:

**Critic C — local reality** · `subagent_type: explorer`

> For every file path, module, function, API, script, command, and dependency the proposal below assumes exists, report exactly one of:
> `EXISTS <path:line>` · `MISSING` · `DIFFERENT <path:line> — <how it actually differs>`
> Report only what you verified by reading. No recommendations, no opinions, no design feedback. If you could not check something, say `UNCHECKED` and why.

This is a fact-checker, not a third opinion — which is why it does not count against the two-critic limit. It exists because a proposal built on an API that isn't there is infeasible for reasons no amount of critique will surface.

Skip it entirely for proposals with no local footprint. Say that you skipped it.

---

## Step 4 — Synthesize in a fresh context

Dispatch **one** `Agent` call, `subagent_type: general-purpose`. Do not synthesize yourself — you have read the proposal and every critique, which is exactly the position from which self-grading happens.

Pass it: the Step 0 claim list, the critic outputs **verbatim**, and the gate from Step 5. Not this conversation.

> You are reading critiques as data. You did not write the proposal and were not present for its discussion.
> 1. Merge findings that describe **the same problem at the same place**. Where merged findings carry different severities, **take the highest — never the average.** Do not merge two findings that share a location but describe different problems.
> 2. Where critics disagree, **say so and take a side with reasoning.** Do not average them. Do not produce a vote count.
> 3. **Cross-critique:** what did *both* critics miss? Answer in 1–2 sentences. Critics drawn from one model share priors, and this is the only step that attacks that.
> 4. Apply the verdict gate exactly as written. Compute it; do not negotiate with it.
> You may not invent new findings in §1–2. You must independently determine the verdict in §4, and §3 is where new observations belong.
> Produce merged findings as one-line table rows: `| severity | finding | what would have to be true |`. No prose paragraphs per finding. Verbatim critiques still ship in the appendix, unedited.

---

## Step 5 — The verdict gate

Output `NO-GO` if **any** of these is true:

- a load-bearing claim is contradicted by evidence;
- a documented lookalike failed for a reason that applies here unchanged;
- a required file / API / dependency is `MISSING` with no substitute named;
- success requires an `[assumed]` or `[unfalsifiable]` claim that cannot be cheaply tested first;
- any finding is `lethal` on its own.

Output `GO` only if **all** of these are true:

- every load-bearing claim is `[verified]` or `[testable]` with the test named;
- no finding is `lethal`;
- the local reality check found nothing `MISSING` (or was correctly skipped).

Otherwise `GO-WITH-CONDITIONS` — and **every condition must name a specific check, not an intention.** "Validate the rate limits" is not a condition. "Confirm the endpoint allows 100 req/s on the free tier before building the queue" is.

**Tie-breaks, and why they are asymmetric:** if you are torn between `GO-WITH-CONDITIONS` and `NO-GO`, choose **`NO-GO`**. If torn between `GO` and `GO-WITH-CONDITIONS`, choose **`GO-WITH-CONDITIONS`**. The default failure mode is to validate what you were handed, so the correction runs the other way. This rule exists because of your bias, not because of the proposal's merit — which is why you may not argue your way out of it mid-task.

Declaring `GO` without having actually run both critics is a failure, not efficiency.

---

## Step 6 — Output shape

The report has two parts: a **summary** (everything above the appendix) and an **appendix** (the raw critiques). The summary is the digest; the appendix is the unedited evidence. Where they disagree, the disagreement must remain visible — the reader gets to notice.

**Length discipline:** one line per claim, one row per finding, one sentence per disagreement. The whole summary should fit on roughly one screen. The appendix is unbounded by design — that is where the detail lives, and it goes last so it never buries the verdict.

```
TL;DR
  VERDICT: GO | GO-WITH-CONDITIONS | NO-GO
  Why: <one sentence, no hedging>

LOAD-BEARING CLAIMS
  <claim> — [verified: src] / [testable: check] / [assumed] / [unfalsifiable]

WHAT KILLS IT  (or: "nothing lethal found")
  <the single most dangerous finding, and what would have to be true to survive it>

FINDINGS  (severity order, lethal first — one row each)
  | severity | finding | what would have to be true |

WHERE THE CRITICS DISAGREED
  <the disagreement, stated as a disagreement, and which side you took and why>

WHAT BOTH CRITICS MISSED
  <1–2 sentences>

CONDITIONS  (GO-WITH-CONDITIONS only — each one a named check)

SKIPPED
  <anything not run, and why>

---
## Appendix — raw critiques (verbatim, unedited)
<every critic's output, verbatim, unedited>
```

The raw critiques ship every time. Nothing is hidden: this skill ranks and judges, it does not quietly drop. If the summary and the raws disagree, the reader gets to notice.

---

## Guards — paste into every critic prompt

**No flattery.** Do not validate, congratulate, or open with something positive. No "good idea, but", "solid foundation", "you're on the right track", "great question". No emojis, no exclamation marks of encouragement. This applies to the **whole** response — opening, transitions, and closing — not just the first line. The only place a strength may be named is the verdict, and there it is stated dry.

**But do not manufacture problems.** A criticism that does not hold up weakens the entire case. Aim at the assumptions carrying the weight, not cosmetic details. If an angle genuinely does not apply, say so in one line and move on — do not pad to fill a quota. Before reporting a finding, ask: *would this change the decision?* If no, drop it.

**Never invent details not in the artifact.** If the proposal is too thin to judge on some dimension, say `insufficient detail` and name what you would need. Do not fill the gap with a plausible assumption and then critique the assumption.

**Citations are for the reader's audit, not for authority.** A source that merely sounds authoritative changes nothing — an authoritative-looking citation is a known trigger for flipping toward a wrong answer, so quote the passage that carries the weight and say what it does and does not establish. Never cite something you did not read.

**No confidence percentages.** Say `[verified]`, `[estimate]`, or `[assumed]`. Numeric confidence in this setting is unmeasured decoration.

---

## Calibration

Read `references/calibration.md` before your first verdict. It contains a worked `NO-GO` and a worked `GO` — the `GO` matters more, because the failure mode of a skill like this is a critic that says no to everything, which is exactly as useless as one that says yes to everything.
