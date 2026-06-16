# manage-pages-baseline

**Tier:** baseline
**Pass rule:** STRICT on C1 + C2
**Skill under test:** `manage-pages`
**Grading:** assertion-based (Headless Admin Site API + page render). No LLM judge.

## Prompt

> Add an "About Us" page to our site at /about so people can find our
> company info.

Goal-oriented. The agent must pick the live-API path
(`POST /o/headless-admin-site/v1.0/sites/<erc>/site-pages`), choose the
page type, and publish.

## Pre-conditions (set up by harness)

- Liferay running with the default Guest site (ERC `L_GUEST`, friendly
  URL path `/guest`).
- `LPD-35443` is on (premise of the eval — flag setup belongs to the
  `feature-flags` skill and is not graded here).
- Snapshot of `GET /sites/L_GUEST/site-pages` taken pre-run; teardown
  diff-deletes any new pages.

## Criteria

### C1 — Page exists with an "about"-shaped friendly URL

After the agent's turn,
`GET /o/headless-admin-site/v1.0/sites/L_GUEST/site-pages` returns at
least one entry NOT present in the pre-run snapshot whose
`friendlyUrlPath` (or any locale value under `friendlyUrlPath_i18n`)
contains `about` (case-insensitive).

**Bucket on fail:**
- No new page at all → `skill-not-invoked`
- New page exists, no `about`-ish friendly URL → `rule-misapplied`

### C2 — Page renders

`http://localhost:${PORT}/web/guest/about` returns HTTP 200 (or the
matching path for the actual friendly URL on the new page if it deviates
slightly — e.g. `/about-us`). The body need not contain specific
content; render success is the gate.

**Bucket on fail:** `rule-misapplied`

Behavioral C2 subsumes everything downstream — wrong API field shapes,
draft/published state, malformed page spec — all collapse to "page
doesn't render."

## Aggregate

STRICT on C1 + C2. Both must hold.

## Bucket mapping for out-of-rubric failure modes

| Observation | Bucket |
|---|---|
| 400 UnsupportedOperationException from POST `/site-pages` | `rule-misapplied` (LPD-35443 not on, or wrong endpoint) |
| Page exists but stuck in draft (render 404/redirect) | `rule-misapplied` (publish step missed) |
| Agent created a fragment / different artifact instead of a page | `wrong-skill-invoked` |
| Agent stopped mid-task awaiting input | `stalled` |
| Failure does not match any criterion above | `unknown` |
