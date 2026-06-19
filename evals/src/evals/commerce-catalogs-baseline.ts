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

function productNameString(p: CommerceProductSummary): string {
  if (typeof p.name === "string") return p.name;
  if (p.name && typeof p.name === "object") {
    const obj = p.name as Record<string, unknown>;
    const candidates = [obj.en_US, obj["en-US"], ...Object.values(obj)];
    for (const v of candidates) {
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  return "";
}

type SetupState = {
  preProductPids: Set<number>;
  catalogId: number | null;
};

const state: SetupState = { preProductPids: new Set(), catalogId: null };

function productPid(p: CommerceProductSummary): number | null {
  if (typeof p.productId === "number") return p.productId;
  if (typeof p.id === "number") return p.id;
  return null;
}

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
  if (p.catalogExternalReferenceCode === "catalog-b2b-industrial" || p.catalogExternalReferenceCode === "b2b-industrial-catalog") return true;
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

async function createTargetCatalog(): Promise<number | null> {
  try {
    const res = await liferayFetch(
      `/o/headless-commerce-admin-catalog/v1.0/catalogs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          externalReferenceCode: TARGET_CATALOG_ERC,
          name: "B2B Industrial Supplies",
          defaultLanguageId: "en_US",
          currencyCode: "USD",
        }),
      }
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { id: number };
    return body.id;
  } catch {
    return null;
  }
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
    state.preProductPids = new Set();
    let cid = await resolveCatalogIdByErc(TARGET_CATALOG_ERC);
    if (cid === null) {
      cid = await createTargetCatalog();
    }
    state.catalogId = cid;
    try {
      // Pre-flight: delete any orphan drill-shaped product in the target
      // catalog so re-runs aren't blocked by Liferay's ERC-idempotent POST.
      const existing = await listCommerceProducts();
      for (const p of existing) {
        const pid = productPid(p);
        if (pid === null) continue;
        if (!DRILL_RE.test(productNameString(p))) continue;
        if (!productInTargetCatalog(p)) continue;
        try {
          await deleteCommerceProduct(pid);
        } catch {
          // best effort
        }
      }
      const products = await listCommerceProducts();
      state.preProductPids = new Set(
        products.map(productPid).filter((v): v is number => v !== null)
      );
    } catch {
      state.preProductPids = new Set();
    }
  },
  teardown: async () => {
    try {
      const products = await listCommerceProducts();
      for (const p of products) {
        const pid = productPid(p);
        if (pid !== null && !state.preProductPids.has(pid)) {
          try {
            await deleteCommerceProduct(pid);
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

    const newProducts = products.filter((p) => {
      const pid = productPid(p);
      return pid !== null && !state.preProductPids.has(pid);
    });
    const drillProducts = newProducts.filter((p) => DRILL_RE.test(productNameString(p)));
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
              ? `New product(s) created but none with a drill-shaped name (${newProducts.map(productNameString).join(", ")}).`
              : `Drill product(s) found but not in catalog ${TARGET_CATALOG_ERC} or b2b-industrial-catalog.`,
        durationMs: driver.durationMs,
        failureBucket,
        detail: { criteria, newProducts },
      };
    }

    let skus: Array<Record<string, unknown>> = [];
    let skuError = "";
    try {
      const targetPid = productPid(target);
      if (targetPid === null) {
        throw new Error("target product has no productId/id");
      }
      skus = (await listCommerceSkus(targetPid)) as unknown as Array<Record<string, unknown>>;
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
        ? `Product "${productNameString(target)}" in ${TARGET_CATALOG_ERC} has SKU at $${TARGET_PRICE}.`
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
