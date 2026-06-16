# setup-oauth-baseline

**Tier:** baseline
**Pass rule:** STRICT on C1 + C2 (C3 supporting)
**Skill under test:** `setup-oauth`
**Grading:** assertion-based YAML parse. No LLM judge.

## Prompt

> The objectAction CET at `client-extensions/promo-discount-action/` needs
> OAuth wiring so it can call Liferay's headless APIs to update related
> Object entries. Add the OAuth companion entry to its `client-extension.yaml`.

## Pre-conditions (set up by harness)

- Fixture at `evals/fixtures/setup-oauth-baseline/client-extension.yaml`
  containing a partial objectAction CET (one entry, no OAuth wiring) is
  copied to `client-extensions/promo-discount-action/` at setup.
- Teardown removes the entire CET directory.

## What the canonical solution looks like

The agent adds a sibling `oAuthApplicationHeadlessServer` entry to the
yaml and wires the `objectAction` entry's
`oAuthApplicationHeadlessServerExternalReferenceCode` value to the OAuth
entry's top-level YAML key — NOT its `name` field.

```yaml
promo-discount-action:
  name: Promo Discount Action
  oAuthApplicationHeadlessServerExternalReferenceCode: promo-discount-action-oauth
  # ... other fields
  type: objectAction

promo-discount-action-oauth:
  name: Promo Discount Action OAuth Application
  scopes:
    - Liferay.Headless.Object.everything
  type: oAuthApplicationHeadlessServer
```

## Criteria

### C1 — OAuth entry exists

The yaml parses and contains a top-level entry with
`type: oAuthApplicationHeadlessServer`.

**Bucket on fail:** `skill-not-invoked`

**Cites:** `setup-oauth/SKILL.md` §2.

### C2 — ERC references the top-level YAML key, not the `name` field

The objectAction entry's
`oAuthApplicationHeadlessServerExternalReferenceCode` value MUST exactly
equal the top-level YAML key of the OAuth entry (case-sensitive). If the
ERC matches the OAuth entry's `name` field but not its top-level key, C2
fails — this is the documented #1 mistake.

**Bucket on fail:** `rule-misapplied`

**Cites:** `setup-oauth/SKILL.md` §2 — "The **top-level key** of this
entry … **not** its `name` field must be referenced as the
`oAuthApplicationHeadlessServerExternalReferenceCode` value." Also §6
troubleshoot row.

### C3 — Scopes include an Object-CRUD scope (supporting)

The OAuth entry's `scopes:` list contains at least one of:
`Liferay.Headless.Object.everything`, `Liferay.Object.Admin.REST.everything`,
or `Liferay.Headless.Admin.User.everything`. Not gating — recorded for
failure-bucket diagnosis only.

**Bucket on fail:** `rule-misapplied`

**Cites:** `rules/oauth-scopes.md`.

## Aggregate

STRICT on C1 + C2. C3 is supporting (does not gate the run).

## Bucket mapping for out-of-rubric failure modes

| Observation | Bucket |
|---|---|
| Agent did not modify the yaml at all | `skill-not-invoked` |
| OAuth entry exists with wrong `type` (e.g., `oAuthApplicationUserAgent`) | `rule-misapplied` |
| ERC matches OAuth entry's `name` field but not the top-level YAML key | `rule-misapplied` |
| Agent renamed/deleted the existing objectAction entry | `rule-misapplied` |
| Agent stopped mid-task awaiting input | `stalled` |
| Failure does not match any criterion above | `unknown` |
