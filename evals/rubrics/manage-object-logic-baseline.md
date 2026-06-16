# manage-object-logic-baseline

**Tier:** baseline
**Pass rule:** STRICT on C1 + C2
**Skill under test:** `manage-object-logic`
**Grading:** assertion-based (Object Admin API + behavioral notification check). No LLM judge.

## Prompt

> Whenever a new support ticket gets created, send me a notification so I
> can triage it.

"Send me" frames the recipient as the calling user (test admin), so the
verification target is well-defined: a new entry in test admin's
`my-user-account/user-notifications` inbox.

## Pre-conditions (set up by harness)

- Liferay running with BasicAuth verifier active.
- Setup hook creates a `Ticket` object with at least Subject (text) and
  Description (text) fields, then publishes it via Object Admin API. The
  agent is expected to find this object and add an action + notification
  template to it.
- Pre-run snapshot of `/o/object-admin/v1.0/object-definitions/<id>/object-actions`
  and `/o/headless-admin-user/v1.0/my-user-account/user-notifications`
  captured so the eval can compute deltas.
- Teardown deletes the Ticket object, which cascades the actions and any
  test entries the harness posted; the standard portal-cleanup hook
  catches any extra objects/picklists.

## Criteria

### C1 — Active onAfterAdd action exists (gate)

After the agent's turn,
`GET /o/object-admin/v1.0/object-definitions/<ticket-id>/object-actions`
returns at least one entry with:

- `objectActionTriggerKey == "onAfterAdd"`, AND
- `active == true`

…that did NOT exist in the pre-run snapshot.

**Bucket on fail:**
- No new action at all → `skill-not-invoked`
- Action exists but trigger is wrong (e.g., `onAfterUpdate`) → `rule-misapplied`
- Action exists but `active == false` → `rule-misapplied`

**Cites:** `manage-object-logic/SKILL.md` §3 — action trigger keys.

### C2 — Notification delivered when ticket created (gate)

After C1 passes, the harness:

1. Snapshots `GET .../my-user-account/user-notifications` (pre-N).
2. POSTs a test entry to `/o/c/<pluralLabel>/` with a valid payload
   (subject + description scalars matching the seeded schema).
3. Waits up to 10 seconds for the action to fire.
4. Re-queries notifications; asserts at least one notification id NOT
   present in pre-N now appears.

Any failure here (POST 4xx, no new notification within timeout) fails C2.

**Bucket on fail:** `rule-misapplied` — the chain is malformed somewhere
(wrong template, wrong recipient, wrong action type, missing reference,
etc). Behavioral verification subsumes per-field introspection.

**Cites:** `manage-object-logic/SKILL.md` §3a — template-first, then
action referencing it.

## Aggregate

STRICT on C1 + C2. Both must hold.

## Bucket mapping for out-of-rubric failure modes

| Observation | Bucket |
|---|---|
| API 400/500 during action POST attempt by agent | `rule-misapplied` |
| Agent created an objectAction on the WRONG object (not the Ticket) | `wrong-skill-invoked` |
| Agent did not create any action; no template either | `skill-not-invoked` |
| Test POST to `/o/c/<pluralLabel>/` returns 4xx (schema mismatch with what the agent built) | `rule-misapplied` |
| Agent stopped mid-task awaiting input | `stalled` |
| Failure does not match any criterion above | `unknown` |
