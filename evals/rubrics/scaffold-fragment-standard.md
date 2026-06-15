# scaffold-fragment-standard

**Tier:** standard
**Pass rule:** STRICT — all criteria below must pass.
**Skill under test:** `scaffold-fragment`
**Grading:** assertion-based (no LLM judge). This document is the
human-readable specification of the assertions implemented in
`evals/src/evals/scaffold-fragment-standard.ts`.

## Prompt

> Build a fragment called `product-card` for the marketing collection.
> It should have an editable product title (text) and an editable
> product image. Give it some basic padding and a subtle border via
> CSS so it works in a card layout. Drop it under a collection called
> `marketing` so the team can find it in the page editor.

## Criteria

### C1 — Fragment is nested under a `fragments/` directory

Fragment directory exists at
`**/site-initializer/fragments/group/<collection-key>/fragments/product-card/`.

**Bucket on fail:** `artifact-malformed`

**Cites:** `scaffold-fragment/SKILL.md` — "The `collection.json` sits at
the collection-key root, and the fragment folders live under a
`fragments/` subdirectory beside it. This nesting is required —
placing fragment folders directly under `<collection-key>/` (with no
`fragments/` level) prevents the collection's fragments from
importing."

**Pass:** path matches `…/group/marketing/fragments/product-card/`.
**Fail:** path is `…/group/marketing/product-card/` (no `fragments/`
level) or fragment lives outside a `group/` collection.

### C2 — Canonical fragment files present

The four files exist inside the fragment directory:
`fragment.json`, `index.html`, `index.css`, `index.js`.

**Bucket on fail:** `artifact-malformed`

**Cites:** `scaffold-fragment/SKILL.md` — fragment directory layout.

### C3 — `fragment.json` uses key `htmlPath`

`fragment.json` parses as JSON and includes the key `htmlPath`
(NOT bare `html`).

**Bucket on fail:** `rule-misapplied`

**Cites:** `scaffold-fragment/SKILL.md` — "Do not use `html` or `css`
keys in `fragment.json`. The valid keys are `htmlPath`, `cssPath`,
`jsPath`, `configurationPath`, `thumbnailPath`."

### C4 — `fragment.json` uses key `cssPath`

`fragment.json` includes the key `cssPath` (NOT bare `css`).

**Bucket on fail:** `rule-misapplied`

**Cites:** same line as C3.

### C5 — Editable text region present

`index.html` contains at least one element with attribute
`data-lfr-editable-type="text"` (or `"rich-text"`, which the skill
treats as equivalent for text content).

**Bucket on fail:** `rule-misapplied`

**Cites:** `scaffold-fragment/SKILL.md` — editable regions are declared
via `data-lfr-editable-type` on `index.html` elements.

### C6 — Editable image region present

`index.html` contains at least one element with attribute
`data-lfr-editable-type="image"`.

**Bucket on fail:** `rule-misapplied`

**Cites:** same line as C5.

### C7 — CSS is scoped under a wrapper

`index.css` rules are prefixed with `#wrapper .<class>` (or
equivalent fragment-scoped selector) rather than bare element
selectors that would leak into the page.

**Bucket on fail:** `rule-misapplied`

**Cites:** `scaffold-fragment/SKILL.md` — "Every fragment must wrap
its content in a named container div. Prefix **all** CSS rules with
`#wrapper .<wrapper-class>` to prevent cascade conflicts."

**Pass:** every rule begins with `#wrapper`, `.<wrapper-class>` (where
the class matches a wrapper div in `index.html`), or the fragment's
own id class.
**Fail:** rules begin with bare element selectors (`div`, `h1`, `img`,
`*`) or unrelated class names.

## Bucket mapping for out-of-rubric failure modes

| Observation | Bucket |
|---|---|
| No fragment files produced anywhere | `skill-not-invoked` |
| Agent scaffolded a `customElement` (or other CET type) instead of a fragment | `wrong-skill-invoked` |
| Deploy threw or did not complete | `deploy-failed` |
| Agent stopped mid-task awaiting input | `stalled` |
| Failure does not match any criterion above and no documented rule covers the correct value | `unknown` (signal: rule needs to be authored) |
