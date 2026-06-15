# feature-flags-diagnostic

**Tier:** standard (no baseline for pure-diagnostic skills)
**Pass rule:** HARD GATE — the single criterion below must hold.
**Skill under test:** `feature-flags`
**Grading:** LLM judge against this rubric (per-criterion boolean).

## Prompt

> I'm trying to create a content page via `POST
> http://localhost:8080/o/headless-admin-site/v1.0/sites/MY_SITE_ERC/site-pages`
> and the response is `400 UnsupportedOperationException`. The site
> exists — `GET /sites/MY_SITE_ERC` returns 200. My OAuth token has
> `Liferay.Headless.Admin.Site.everything`. BasicAuth works on other
> endpoints (`GET /o/c/users/` returns 200). Why is this POST
> failing?

## Rubric note (for the judge)

Pass requires both (a) the literal string `LPD-35443` and (b) a
recommendation to enable it (any phrasing that conveys "turn it on" /
"add it to your config" / "set it to true"). Mentions of
sync-to-bundles, Tomcat restart, scope verification, or any other
follow-up steps are **nice-to-have additions** but are NOT required
for pass. Do not penalize for terseness or for omitting follow-up
steps if the two required elements are present. Do not penalize for
including extra correct context (e.g., explaining what the flag
gates) — only check the two required elements.

## Criteria

### C1 — Identifies LPD-35443 and recommends enabling it

The agent's response must:

1. Name the literal string `LPD-35443`, AND
2. Recommend enabling it.

**Bucket on fail:** `rule-misapplied`

**Cites:**
- `feature-flags/SKILL.md` — "Many flag-gated Headless endpoints fail
  silently — `400 UnsupportedOperationException` with no log output —
  when the required flag is off. Always check proactively."
- `feature-flags/SKILL.md` flag table — `LPD-35443 | off | Headless
  Admin Site public layout API`.

## Anchored examples

### Pass (terse)

> Enable `LPD-35443`.

### Pass (standard)

> The endpoint is gated behind LPD-35443 (Headless Admin Site public
> layout API). Enable it in `portal-ext.properties` and restart.

### Pass (with extras as side-notes)

> You're missing the LPD-35443 flag — add it to `portal-ext` and
> bounce Tomcat. While you're at it, double-check the ERC formatting
> in your URL, though that looks fine from your description.

### Borderline → FAIL

> Sounds like the endpoint might be feature-flagged. Check
> `bundles/portal-ext.properties` for any `LPD-*` flags that need
> enabling.

(Names the concept but not the specific flag. Bad UX — the user has
to look it up. Fails C1 because requirement (1) is unmet.)

### Fail — diagnoses the exception, not the gate

> `UnsupportedOperationException` means POST isn't supported on this
> path. Check the API docs for which methods are allowed.

### Fail — chases scope

> Your OAuth scope might be wrong — try
> `Liferay.Headless.Admin.Site.everything.write` instead.

## Bucket mapping for out-of-rubric failure modes

| Response pattern | Bucket |
|---|---|
| Diagnoses auth/scope/path without mentioning any feature flag | `rule-misapplied` |
| Names a different flag (e.g., `LPD-74328`) | `rule-misapplied` |
| Mentions feature flags abstractly with no specific ID | `rule-misapplied` (the borderline-fail case above) |
| Empty or truncated response | `stalled` |
| Agent rebuilds the site / scaffolds something / doesn't engage feature-flags reasoning | `wrong-skill-invoked` |
