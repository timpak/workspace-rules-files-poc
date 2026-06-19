# build-site-standard

**Tier:** standard
**Pass rule:** STRICT — all 7 criteria below must hold.
**Skills under test:** `scaffold-client-extension`, `scaffold-fragment`, `manage-pages` (composed via `build-site` orchestrator).
**Grading:** fully assertion-based. No LLM judge.

## Prompt

> Hey, we're doing a spring promo launch site and need a quick page on
> it to point ads at. Just needs to say something punchy at the top —
> I want our team to be able to update that text ourselves once it's
> up. Let me know when the site is up.

## Pre-conditions (set up by harness)

- `client-extensions/`, `modules/`, and `themes/` are stashed empty so
  the agent cannot crib patterns from existing artifacts.
- Bundle is running at `LIFERAY_URL` (default `http://localhost:8080`)
  with default credentials.

## What the canonical solution looks like

The agent produces a `siteInitializer`-type CET under `client-extensions/`
containing:

1. `client-extension.yaml` declaring `type: siteInitializer` with a
   `siteExternalReferenceCode`, a `siteName`, and (optionally) an
   `oAuthApplicationHeadlessServer` — OAuth is **not required** for a
   pure fragment+layout initializer.
2. A fragment under `site-initializer/fragments/group/<collection-key>/fragments/<fragment-key>/`
   with the four canonical files (`fragment.json`, `index.html`,
   `index.css`, `index.js`) and an editable text region.
3. A layout under `site-initializer/layouts/<page-folder>/` with
   `page.json` (declaring the friendly URL) and `page-definition.json`
   that references the fragment by `key` in a Fragment-type
   `pageElement`.

After deploy, the initializer fires, the site is provisioned, the
fragment is imported, the layout is created referencing it, and a
guest GET of the page returns 200 with both the layout-structure-item
marker and the fragment's wrapper class in the rendered HTML.

## Criteria

### C1 — A siteInitializer CET directory exists under `client-extensions/`

There must be at least one subdirectory of `client-extensions/`
containing a `client-extension.yaml` whose top-level CET declaration
sets `type: siteInitializer`.

**Bucket on fail:**
- No `client-extensions/*/client-extension.yaml` at all → `skill-not-invoked`
- yaml exists but no `type: siteInitializer` block → `wrong-skill-invoked`
  (the agent picked a different CET type)

**Cites:** `scaffold-client-extension` SKILL.md; `rules/client-extension-types.md`.

### C2 — yaml declares the required site fields

The `siteInitializer` block must declare both `siteExternalReferenceCode`
(non-empty) and `siteName` (non-empty).

**Bucket on fail:** `artifact-malformed`.

**Cites:** `rules/client-extension-types.md` (siteInitializer field reference).

### C3 — Fragment exists at the canonical nesting depth

There must be at least one directory matching the regex
`site-initializer/fragments/group/[^/]+/fragments/[^/]+/` containing all
four canonical files: `fragment.json`, `index.html`, `index.css`,
`index.js`.

**Bucket on fail:**
- No fragment dir anywhere in the CET → `rule-misapplied` (fragments
  skill content not followed)
- Dir present but nested wrong → `rule-misapplied`
- Dir present but missing canonical files → `artifact-malformed`

**Cites:** `scaffold-fragment` SKILL.md — "fragments/ nesting REQUIRED";
canonical file set.

### C4 — Layout exists with both required JSON files

There must be at least one directory at `site-initializer/layouts/<page-folder>/`
containing both `page.json` and `page-definition.json`.

**Bucket on fail:**
- No layouts dir at all → `rule-misapplied`
- Layout folder but missing one of the two files → `artifact-malformed`

**Cites:** `manage-pages` SKILL.md; `rules/site-initializer-format.md`
(layouts directory shape).

### C5 — Layout's page-definition references the fragment by key

In the layout's `page-definition.json`, the `pageElement.pageElements`
array must contain at least one entry with `type: "Fragment"` whose
`definition.fragment.key` matches the `key` of the fragment from C3.
(Fragment key is `fragment.json#key` if declared, or the fragment
directory name as the fallback per the importer convention.)

**Bucket on fail:** `rule-misapplied` (page-definition format spec
not followed, or fragment not wired in).

**Cites:** `rules/site-initializer-format.md`; `manage-pages` SKILL.md
(referencing fragments by key).

### C6 — Deploy succeeds and the site initializer completes

`blade gw deploy` from the CET directory exits 0 within timeout. The
liferay log (`bundles/logs/liferay.<YYYY-MM-DD>.log`), tailed from the
byte offset captured at deploy-start, must contain in order:

1. `Initializing <siteName> for group <gid>`
2. `Invoking addFragmentEntries took N ms` (no adjacent `ERROR` from
   the initializer thread between the previous and next `Invoking` lines)
3. `Invoking addOrUpdateLayouts took N ms` (same no-adjacent-ERROR rule)
4. `Initialized <siteName> for group <gid> in N ms`

All four within the deploy + init timeout (default 90 seconds).

**Bucket on fail:**
- `blade gw deploy` non-zero exit or timeout → `deploy-failed`
- Bundle deployed but no `Initializing` line → `deploy-failed`
- `Initializing` appears but no `Initialized` (or an `ERROR` from the
  initializer thread between phase lines) → `runtime-error`

**Cites:** `deploy-and-verify` SKILL.md; `site-initializer-format.md`
(initializer phase model).

### C7 — Page renders with the fragment present

After init completes, `GET /o/headless-admin-site/v1.0/sites/<ERC>`
returns 200 and the response body's `id` is captured as `<gid>`. Then
`GET /web/group-<gid>/<friendlyURL>` (taking `<friendlyURL>` from the
layout's `page.json#friendlyURL`) returns 200 with a body containing:

- the literal string `lfr-layout-structure-item-<fragmentKey>`, AND
- at least one selector from the fragment's `index.css` (a sufficient
  proxy: the fragment's outermost wrapper class string from its
  `index.html`).

**Bucket on fail:**
- Site lookup 404 → `runtime-error` (init claimed success but no site
  registered)
- Page render non-200 → `runtime-error`
- Page renders but neither marker present → `runtime-error` (fragment
  imported but didn't land on the layout, or imported as DRAFT)

**Cites:** observed behavior of `BundleSiteInitializer` + Liferay's
layout renderer.

## Aggregate

STRICT: all 7 criteria must hold for the eval to pass. A single failing
criterion fails the run; the categorizer picks the bucket from the
highest-precedence failing criterion's `bucketOnFail` tag (precedence
`skill-not-invoked` → `wrong-skill-invoked` → `artifact-malformed` →
`rule-misapplied` → `deploy-failed` → `runtime-error` → `unknown`).
