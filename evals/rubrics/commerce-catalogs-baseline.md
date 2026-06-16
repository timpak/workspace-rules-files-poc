# commerce-catalogs-baseline

**Tier:** baseline
**Pass rule:** STRICT on C1 + C2
**Skill under test:** `commerce-catalogs`
**Grading:** assertion-based (Commerce Admin API). No LLM judge.

## Prompt

> Add a product called "Industrial Drill Bit Set" to our B2B Industrial
> catalog. List price is $89.99.

## Pre-conditions (set up by harness)

- Liferay running with Commerce. The `catalog-b2b-industrial` catalog
  (display name: "B2B Industrial Supplies") is already present.
- Pre-run snapshot of `GET /o/headless-commerce-admin-catalog/v1.0/products`.
- Teardown: diff-deletes any new products via DELETE by numeric ID.

## Criteria

### C1 — Product exists in the right catalog (gate)

Post-run `GET .../v1.0/products` returns at least one product NOT in the
pre-run snapshot where:

- `name` contains `drill` (case-insensitive), AND
- `catalogExternalReferenceCode == "catalog-b2b-industrial"` OR
  `catalogId` matches the B2B Industrial catalog's id (resolved by ERC
  at eval start).

**Bucket on fail:**
- No new product at all → `skill-not-invoked`
- Product exists but in the wrong catalog → `wrong-skill-invoked`
- Product exists but no drill-ish name → `rule-misapplied`

**Cites:** `commerce-catalogs/SKILL.md` — endpoint path includes the
`headless-` prefix; products are created via this API.

### C2 — Product has a SKU at the right price (gate)

`GET .../products/<id>/skus` returns at least one entry with a price
field equal to `89.99` (±0.01). Products without SKUs are not
purchasable.

**Bucket on fail:**
- Empty SKU list → `rule-misapplied` (product incomplete)
- SKU exists but price is wrong → `rule-misapplied`

**Cites:** `commerce-catalogs/SKILL.md` — products require at least one
SKU to be purchasable.

## Aggregate

STRICT on C1 + C2. Both must hold.

## Bucket mapping for out-of-rubric failure modes

| Observation | Bucket |
|---|---|
| Agent used `/o/commerce-admin-catalog/` (missing `headless-`) and got 404 | `rule-misapplied` |
| Agent created the product in the `Master` catalog | `wrong-skill-invoked` |
| Agent created a SKU but referenced wrong product | `rule-misapplied` |
| Agent stopped mid-task awaiting input | `stalled` |
| Failure does not match any criterion above | `unknown` |
