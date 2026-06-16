# theme-override-standard

**Tier:** standard
**Pass rule:** STRICT — all 5 criteria below must hold.
**Skills under test:** `scaffold-client-extension`, `theme-and-design`, `deploy-and-verify`
**Grading:** fully assertion-based. No LLM judge.

## Prompt

> Make all primary buttons on our site use brand color #FF6B35. It
> should apply on every page.

Goal-oriented — no "client extension," "deploy," or other Liferay
vocabulary. The agent must read the skill content and choose `globalCSS`
over `themeCSS` (per `theme-and-design/SKILL.md` §"globalCSS vs
themeCSS": globalCSS is site-agnostic always-load CSS; themeCSS requires
a manual UI assign step the harness doesn't do).

## Pre-conditions (set up by harness)

- `client-extensions/`, `modules/`, and `themes/` stashed empty so the
  agent cannot crib patterns from existing artifacts.
- Liferay running on the port from `bundles/tomcat*/conf/server.xml`.
- At least one accessible page exists on the deployed instance.

## Criteria

### C1 — CET artifact created

Some `client-extensions/<name>/client-extension.yaml` exists, parses,
and has at least one top-level entry with `type` in `{globalCSS, themeCSS}`.

**Bucket on fail:**
- No `client-extensions/` content at all → `skill-not-invoked`
- yaml exists but type is something else (objectAction, fragment, etc.)
  → `wrong-skill-invoked`

### C2 — CET shape correct for its type

- `globalCSS`: yaml has `url` field AND the referenced asset file exists
  on disk inside the CET directory (after `assemble` resolution if
  applicable).
- `themeCSS`: yaml has `clayVersion` AND `mainCssPath` (or equivalent
  `mainUrl`) AND the referenced asset file exists on disk.

**Bucket on fail:** `rule-misapplied` — wrong yaml fields for the
chosen type.

**Cites:** `theme-and-design/SKILL.md` §"Layer 1: themeCSS" and §"globalCSS
vs themeCSS".

### C3 — Deploy exits 0

`blade gw deploy` run from the CET directory exits 0 within timeout.

**Bucket on fail:** `deploy-failed` (or upstream bucket if C1/C2 also
failed, per precedence).

**Cites:** `deploy-and-verify/SKILL.md`.

### C4 — STARTED in log

`bundles/logs/liferay.<YYYY-MM-DD>.log` contains `STARTED <bundle-symbolic-name>`
for the deployed CET within the init-wait window. Bundle symbolic name
defaults to the CET directory name.

**Bucket on fail:** `deploy-failed`

**Cites:** `deploy-and-verify/SKILL.md` — STARTED is the activation gate.

### C5 — Runtime override visible

Parse the most-recent `*.client-extension-config.json` under
`bundles/tomcat/temp/clientextension*/META-INF/client-extension-config/`
(newest by mtime) whose filename matches the deployed CET. Resolve the
asset URL from `webContextPath` + the `url` value in `typeSettings` →
`http://localhost:${PORT}/o${webContextPath}<url>`. GET it. Asserts:

1. HTTP 200, AND
2. Response body contains `#FF6B35` (case-insensitive).

**Bucket on fail:**
- Asset returns non-200, or 200 but no color literal — agent picked
  themeCSS without UI-assign → `rule-misapplied` (`theme-and-design/SKILL.md`
  §"globalCSS vs themeCSS": themeCSS requires per-site theme selection)
- Asset 200 but no color literal, with wrong selector / wrong value →
  `rule-misapplied` (content-level)

## Aggregate

STRICT: all 5 criteria must hold. A single failing criterion fails the
run; the categorizer picks the bucket from the highest-precedence
failing criterion (`skill-not-invoked` → `wrong-skill-invoked` →
`artifact-malformed` → `rule-misapplied` → `deploy-failed` →
`runtime-error` → `unknown`).
