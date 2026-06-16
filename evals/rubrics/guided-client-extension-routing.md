# guided-client-extension-routing

**Tier:** standard (routing)
**Pass rule:** HARD GATE on C1 (C2 supporting, LLM-judged)
**Skill under test:** `guided-client-extension`
**Grading:** C1 deterministic (workspace diff); C2 LLM-judged on the
agent's final response.

## Prompt

> I just set up Liferay for the first time. How do I start building stuff
> for my site?

The beginner cue is "for the first time" — factual, not a self-label,
plain language. No Liferay vocabulary (no "client extension", "widget",
"fragment", "theme"). The agent shouldn't know what shape to scaffold
even if it tried, which is exactly the situation where the
`guided-client-extension` skill's pre-flight ask is supposed to fire.

## Pre-conditions (set up by harness)

- Standard cleanup hook captures the workspace pre-run; teardown
  restores it.

## What the canonical solution looks like

The agent recognizes the beginner cue, pauses, and offers to walk the
user through a guided experience. It does NOT scaffold any artifacts in
this turn.

## Criteria

### C1 — No scaffolding artifacts created (the gate)

Workspace snapshot diff after the agent's turn shows zero new files
under `client-extensions/`, `modules/`, or `themes/`. Deterministic
assertion.

**Bucket on fail:** `wrong-skill-invoked` — the agent scaffolded
something instead of offering guidance.

**Cites:** `guided-client-extension/SKILL.md` §0 "Pre-Flight Check":
ask if they would like a guided experience before scaffolding.

### C2 — Agent offered a guided walkthrough (LLM-judged, supporting)

The agent's final response must explicitly offer to walk the user
through it — phrasings like "walk you through", "guide you through",
"step by step", "let me get you started with a guided experience" all
count. Generic engagement ("what kind of site is it?", "tell me more")
does not count. Used for failure-bucket disambiguation; does not gate.

**Bucket on fail:** `rule-misapplied`

**Cites:** same SKILL.md §0.

## Anchored examples for the C2 judge

### Pass (terse)

> I can walk you through this step by step. Want to start?

### Pass (standard)

> Since this is your first time — I can guide you through building and
> deploying a small first extension, then you'll have a template for
> everything else. Sound good?

### Pass (with extras)

> Welcome to Liferay. There's a lot here, so I'd recommend a guided
> walkthrough — we'll start with one small thing on a page, deploy it,
> and you'll see how the cycle works. Should we begin?

### Borderline → FAIL

> Liferay supports several extension types: customElement for embedded
> JS apps, globalCSS for site-wide styles, themes for full visual
> overhauls, etc. Which one are you looking for?

(No guidance offer — jumped to scaffold-client-extension's "pick a
type" branch.)

### Fail — scaffolded

> *(C1 also fails: files appear under `client-extensions/`)*
>
> I've created a starter custom element at
> `client-extensions/my-first-widget/`.

### Fail — stalled-style clarifying questions

> What kind of site is it? What do you want to build? What technologies
> are you most comfortable with?

(Clarifying questions, no guidance offer.)

## Aggregate

HARD GATE on C1 (workspace must show no scaffolding artifacts). C2 is
LLM-judged and used to disambiguate the failure bucket but does not
gate the run.

## Bucket mapping for out-of-rubric failure modes

| Observation | Bucket |
|---|---|
| Agent scaffolded a CET (C1 fails) | `wrong-skill-invoked` |
| C1 passes, C2 fails, response asks unrelated clarifying questions | `rule-misapplied` |
| C1 passes, C2 fails, generic docs / no engagement | `rule-misapplied` |
| Empty/truncated response | `stalled` |
| Failure does not match any criterion above | `unknown` |
