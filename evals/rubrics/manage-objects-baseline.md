# manage-objects-baseline

**Tier:** baseline
**Pass rule:** HARD GATE on C1 (C2, C3 supporting)
**Skill under test:** `manage-objects`
**Grading:** assertion-based (Object Admin API queries against a pre-run snapshot). No LLM judge.

## Prompt

> Our support team needs to track tickets. Each ticket has a Subject, a
> Description, and a Status that can be Open, In Progress, or Closed.
> Set it up so they can start using it.

Goal-oriented — no "object," "picklist," or "field" vocabulary. The agent
must recognize this needs a Liferay Object, create + publish it via the
Object Admin API, and model "Open / In Progress / Closed" as a picklist
(not a free-text Status field).

## Pre-conditions (set up by harness)

- Liferay running with BasicAuth verifier active (`LIFERAY_URL` default
  `http://localhost:8080`, credentials `test@liferay.com` / `test`).
- Pre-run snapshot of `GET /o/object-admin/v1.0/object-definitions` and
  picklists (`/o/headless-admin-list-type/v1.0/list-type-definitions`)
  captured by `standardCleanupHooks`. Teardown deletes anything not in
  the snapshot.

## Criteria

### C1 — New published object exists (the gate)

After the agent's turn, `GET /o/object-admin/v1.0/object-definitions`
returns at least one entry that:

1. Did NOT exist in the pre-run snapshot (new id), AND
2. Has `status.label == "approved"` (or `status.code` equivalent), AND
3. Has its `name`, `label.en_US`, or `externalReferenceCode` containing
   the substring `ticket` (case-insensitive).

**Bucket on fail:**
- No new object at all → `skill-not-invoked`
- New object exists but `status` is `draft` → `rule-misapplied`
  (publish step missed)
- New object exists but no `ticket`-ish identifier → `wrong-skill-invoked`
  (agent built something else)

**Cites:** `manage-objects/SKILL.md` — publish step required for live
use; Object Admin API as the creation surface.

### C2 — Object has ≥3 fields (supporting)

`GET /o/object-admin/v1.0/object-definitions/<id>/object-fields` returns
≥3 entries. Bucket diagnosis only.

**Bucket on fail:** `rule-misapplied`

### C3 — One field is a Picklist linked to a 3-entry list (supporting)

At least one field has either `businessType == "Picklist"` or non-null
`listTypeDefinitionId`. Disambiguates "agent modeled Status as
free-text" from "agent recognized the enumeration."

**Bucket on fail:** `rule-misapplied`

**Cites:** `manage-objects/SKILL.md` — picklists are the canonical way
to model a fixed enumeration.

## Aggregate

HARD GATE on C1. C2 and C3 are supporting — their failures inform the
failure bucket but do not gate the run.

## Bucket mapping for out-of-rubric failure modes

| Observation | Bucket |
|---|---|
| API returns 400 ObjectDefinitionStorageTypeException at create time | `rule-misapplied` (storageType: default returns 400) |
| API returns 500 NPE on field POST | `rule-misapplied` (required: explicit on fields) |
| Agent created via Headless Delivery instead of Object Admin | `wrong-skill-invoked` |
| Agent stopped mid-task awaiting input | `stalled` |
| Failure does not match any criterion above | `unknown` |
