import { resolve } from "node:path";
import { REPO_ROOT } from "../driver.js";
import { categorize, type CriterionOutcome } from "../graders/bucket.js";
import {
  deleteCommerceProduct,
  liferayFetch,
  listCommerceProducts,
  listCommerceSkus,
  type CommerceProductSummary,
} from "../portal.js";
import { standardCleanupHooks } from "./shared.js";
import type { EvalCase, EvalResult } from "./types.js";

const ID = "commerce-catalogs-baseline";

const PROMPT = `Add a product called "Industrial Drill Bit Set" to our B2B Industrial catalog. List price is $89.99.`;

const RUBRIC_PATH = resolve(REPO_ROOT, "evals/rubrics/commerce-catalogs-baseline.md");
const TARGET_CATALOG_ERC = "catalog-b2b-industrial";
const TARGET_PRICE = 89.99;
const PRICE_TOLERANCE = 0.011;

const DRILL_RE = /drill/i;

type SetupState = {
  preProductIds: Set<number>;
  catalogId: number | null;
};

const state: SetupState = { preProductIds: new Set(), catalogId: null };

async function resolveCatalogIdByErc(erc: string): Promise<number | null> {
  try {
    const res = await liferayFetch(
      `/o/headless-commerce-admin-catalog/v1.0/catalogs?page=1&pageSize=100`
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: Array<{ id: number; externalReferenceCode?: string }> };
    const match = (body.items ?? []).find((c) => c.externalReferenceCode === erc);
    return match?.id ?? null;
  } catch {
    return null;
  }
}

function productInTargetCatalog(p: CommerceProductSummary): boolean {
  if (p.catalogExternalReferenceCode === TARGET_CATALOG_ERC) return true;
  if (state.catalogId !== null && typeof p.catalogId === "number" && p.catalogId === state.catalogId) {
    return true;
  }
  return false;
}

function readPrice(sku: Record<string, unknown>): number | null {
  for (const key of ["price", "listPrice", "purchasePrice", "promoPrice"]) {
    const v = sku[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}

const hooks = standardCleanupHooks();

export const commerceCatalogsBaseline: EvalCase = {
  id: ID,
  description:
    "STRICT baseline for the commerce-catalogs skill (drill product in the B2B Industrial catalog + a SKU at $89.99).",
  prompt: PROMPT,
  tier: "baseline",
  passRule: "strict",
  rubricPath: RUBRIC_PATH,
  setup: async () => {
    await hooks.setup();
    state.preProductIds = new Set();
    state.catalogId = await resolveCatalogIdByErc(TARGET_CATALOG_ERC);
    try {
      const products = await listCommerceProducts();
      state.preProductIds = new Set(products.map((p) => p.id));
    } catch {
      state.preProductIds = new Set();
    }
  },
  teardown: async () => {
    try {
      const products = await listCommerceProducts();
      for (const p of products) {
        if (!state.preProductIds.has(p.id)) {
          try {
            await deleteCommerceProduct(p.id);
          } catch {
            // best effort
          }
        }
      }
    } catch {
      // ignore
    }
    await hooks.teardown();
  },
  grade: async (driver): Promise<EvalResult> => {
    const criteria: CriterionOutcome[] = [];

    let products: CommerceProductSummary[];
    try {
      products = await listCommerceProducts();
    } catch (err) {
      criteria.push({ id: "C1", passed: false, bucketOnFail: "runtime-error" });
      criteria.push({ id: "C2", passed: false, bucketOnFail: "runtime-error" });
      const failureBucket = categorize({
        passed: false,
        agentTimedOut: driver.timedOut,
        criteria,
      });
      return {
        id: ID,
        passed: false,
        comment: `listCommerceProducts failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: driver.durationMs,
        failureBucket,
        detail: { criteria },
      };
    }

    const newProducts = products.filter((p) => !state.preProductIds.has(p.id));
    const drillProducts = newProducts.filter(
      (p) => typeof p.name === "string" && DRILL_RE.test(p.name)
    );
    const target = drillProducts.find(productInTargetCatalog) ?? null;
    const drillInWrongCatalog = drillProducts.length > 0 && target === null;

    const c1Pass = target !== null;
    let c1Bucket: CriterionOutcome["bucketOnFail"] = "skill-not-invoked";
    if (newProducts.length > 0 && drillProducts.length === 0) c1Bucket = "rule-misapplied";
    if (drillInWrongCatalog) c1Bucket = "wrong-skill-invoked";
    criteria.push({ id: "C1", passed: c1Pass, bucketOnFail: c1Bucket });

    if (!c1Pass) {
      criteria.push({ id: "C2", passed: false, bucketOnFail: "rule-misapplied" });
      const failureBucket = categorize({
        passed: false,
        agentTimedOut: driver.timedOut,
        criteria,
      });
      return {
        id: ID,
        passed: false,
        comment:
          newProducts.length === 0
            ? "No new products created."
            : drillProducts.length === 0
              ? `New product(s) created but none with a drill-shaped name (${newProducts.map((p) => p.name).join(", ")}).`
              : `Drill product(s) found but not in catalog ${TARGET_CATALOG_ERC}.`,
        durationMs: driver.durationMs,
        failureBucket,
        detail: { criteria, newProducts },
      };
    }

    let skus: Array<Record<string, unknown>> = [];
    let skuError = "";
    try {
      skus = (await listCommerceSkus(target.id)) as unknown as Array<Record<string, unknown>>;
    } catch (err) {
      skuError = err instanceof Error ? err.message : String(err);
    }

    const matchingSku = skus.find((s) => {
      const price = readPrice(s);
      return price !== null && Math.abs(price - TARGET_PRICE) <= PRICE_TOLERANCE;
    });

    const c2Pass = matchingSku !== undefined;
    criteria.push({ id: "C2", passed: c2Pass, bucketOnFail: "rule-misapplied" });

    const passed = criteria.every((c) => c.passed);
    const failureBucket = categorize({
      passed,
      agentTimedOut: driver.timedOut,
      criteria,
    });

    return {
      id: ID,
      passed,
      comment: passed
        ? `Product "${target.name}" in ${TARGET_CATALOG_ERC} has SKU at $${TARGET_PRICE}.`
        : skuError
          ? `SKU list query failed: ${skuError}`
          : skus.length === 0
            ? `Product exists but has zero SKUs (incomplete).`
            : `SKUs exist but none at price ${TARGET_PRICE} (saw: ${skus.map(readPrice).join(", ")}).`,
      durationMs: driver.durationMs,
      failureBucket,
      detail: { criteria, target, skus },
    };
  },
};
