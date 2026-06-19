const BASE_URL = process.env.LIFERAY_URL ?? "http://localhost:8080";
const USERNAME = process.env.LIFERAY_USER ?? "test@liferay.com";
const PASSWORD = process.env.LIFERAY_PASS ?? "test";

const authHeader = "Basic " + Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64");

export type ObjectDefinition = {
  id: number;
  name: string;
  status?: { code: number; label?: string };
  objectFields?: Array<{ name: string; businessType?: string; required?: boolean }>;
  [key: string]: unknown;
};

export async function liferayFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", authHeader);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const maxRetries = 3;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(`${BASE_URL}${path}`, { ...init, headers });
    } catch (err: any) {
      lastError = err;
      const isSocketError =
        err?.code === "UND_ERR_SOCKET" ||
        err?.cause?.code === "ECONNREFUSED" ||
        err?.cause?.code === "ECONNRESET";

      if (isSocketError && attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.warn(`[liferayFetch] Socket error on ${path}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export async function healthCheck(): Promise<void> {
  const res = await liferayFetch("/o/object-admin/v1.0/object-definitions?page=1&pageSize=1");
  if (!res.ok) {
    throw new Error(
      `Liferay health check failed at ${BASE_URL}: HTTP ${res.status}. ` +
        `Ensure the bundle is running and credentials (${USERNAME}) are valid.`
    );
  }
}

export async function getObjectDefinitionByName(name: string): Promise<ObjectDefinition | null> {
  const res = await liferayFetch(
    `/o/object-admin/v1.0/object-definitions?filter=${encodeURIComponent(`name eq '${name}'`)}&pageSize=1`
  );
  if (!res.ok) throw new Error(`getObjectDefinitionByName(${name}) HTTP ${res.status}`);
  const body = (await res.json()) as { items?: ObjectDefinition[] };
  return body.items?.[0] ?? null;
}

export async function deleteObjectByName(name: string): Promise<boolean> {
  const def = await getObjectDefinitionByName(name);
  if (!def) return false;
  const res = await liferayFetch(`/o/object-admin/v1.0/object-definitions/${def.id}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`deleteObjectByName(${name}) HTTP ${res.status}: ${await res.text()}`);
  }
  return true;
}

export async function createObjectDefinition(payload: Record<string, unknown>): Promise<ObjectDefinition> {
  const res = await liferayFetch("/o/object-admin/v1.0/object-definitions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`createObjectDefinition HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as ObjectDefinition;
}

export async function publishObjectDefinition(id: number): Promise<void> {
  const res = await liferayFetch(`/o/object-admin/v1.0/object-definitions/${id}/publish`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`publishObjectDefinition(${id}) HTTP ${res.status}: ${await res.text()}`);
}

export async function getEndpointStatus(path: string): Promise<number> {
  const res = await liferayFetch(path);
  return res.status;
}

async function fetchAllIds(
  basePath: string,
  filter?: string
): Promise<Array<{ id: number; name?: string }>> {
  const out: Array<{ id: number; name?: string }> = [];
  const pageSize = 100;
  let page = 1;
  while (true) {
    const filterParam = filter ? `&filter=${encodeURIComponent(filter)}` : "";
    const res = await liferayFetch(`${basePath}?page=${page}&pageSize=${pageSize}${filterParam}`);
    if (!res.ok) throw new Error(`fetchAllIds(${basePath}) HTTP ${res.status}`);
    const body = (await res.json()) as {
      items?: Array<{ id: number; name?: string }>;
      lastPage?: number;
      page?: number;
    };
    const items = body.items ?? [];
    out.push(...items);
    if (items.length < pageSize) break;
    if (body.lastPage && page >= body.lastPage) break;
    page += 1;
  }
  return out;
}

export type PortalSnapshot = {
  objectDefinitionIds: Set<number>;
  picklistIds: Set<number>;
};

export async function snapshotPortal(): Promise<PortalSnapshot> {
  const [objects, picklists] = await Promise.all([
    fetchAllIds("/o/object-admin/v1.0/object-definitions"),
    fetchAllIds("/o/headless-admin-list-type/v1.0/list-type-definitions"),
  ]);
  return {
    objectDefinitionIds: new Set(objects.map((o) => o.id)),
    picklistIds: new Set(picklists.map((p) => p.id)),
  };
}

export type CleanupReport = {
  deletedObjectDefinitions: Array<{ id: number; name?: string; ok: boolean; status?: number }>;
  deletedPicklists: Array<{ id: number; name?: string; ok: boolean; status?: number }>;
};

export async function cleanupNewArtifacts(baseline: PortalSnapshot): Promise<CleanupReport> {
  const [objects, picklists] = await Promise.all([
    fetchAllIds("/o/object-admin/v1.0/object-definitions"),
    fetchAllIds("/o/headless-admin-list-type/v1.0/list-type-definitions"),
  ]);

  const report: CleanupReport = { deletedObjectDefinitions: [], deletedPicklists: [] };

  const newObjects = objects.filter((o) => !baseline.objectDefinitionIds.has(o.id));
  for (const obj of newObjects) {
    const res = await liferayFetch(`/o/object-admin/v1.0/object-definitions/${obj.id}`, {
      method: "DELETE",
    });
    report.deletedObjectDefinitions.push({
      id: obj.id,
      name: obj.name,
      ok: res.ok || res.status === 404,
      status: res.status,
    });
  }

  const newPicklists = picklists.filter((p) => !baseline.picklistIds.has(p.id));
  for (const pl of newPicklists) {
    const res = await liferayFetch(`/o/headless-admin-list-type/v1.0/list-type-definitions/${pl.id}`, {
      method: "DELETE",
    });
    report.deletedPicklists.push({
      id: pl.id,
      name: pl.name,
      ok: res.ok || res.status === 404,
      status: res.status,
    });
  }

  return report;
}

export type SiteSummary = { id: number; externalReferenceCode?: string; descriptiveName?: string; friendlyUrlPath?: string };

export async function getSiteByErc(erc: string): Promise<SiteSummary | null> {
  const res = await liferayFetch(
    `/o/headless-admin-site/v1.0/sites/${encodeURIComponent(erc)}`
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getSiteByErc(${erc}) HTTP ${res.status}`);
  return (await res.json()) as SiteSummary;
}

export async function deleteSiteByErc(erc: string): Promise<boolean> {
  const res = await liferayFetch(
    `/o/headless-admin-site/v1.0/sites/${encodeURIComponent(erc)}`,
    { method: "DELETE" }
  );
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`deleteSiteByErc(${erc}) HTTP ${res.status}: ${await res.text()}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Site-pages helpers (manage-pages-baseline)
// ---------------------------------------------------------------------------

export type SitePageSummary = {
  id: number;
  friendlyUrlPath?: string;
  friendlyUrlPath_i18n?: Record<string, string>;
  name?: string;
  externalReferenceCode?: string;
};

export async function listSitePages(siteErc: string): Promise<SitePageSummary[]> {
  const items = await fetchAllIds(
    `/o/headless-admin-site/v1.0/sites/${encodeURIComponent(siteErc)}/site-pages`
  );
  return items as unknown as SitePageSummary[];
}

export async function deleteSitePage(siteErc: string, pageErc: string): Promise<boolean> {
  const res = await liferayFetch(
    `/o/headless-admin-site/v1.0/sites/${encodeURIComponent(siteErc)}/site-pages/${encodeURIComponent(pageErc)}`,
    { method: "DELETE" }
  );
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`deleteSitePage(${siteErc}, ${pageErc}) HTTP ${res.status}: ${await res.text()}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Object-actions helpers (manage-object-logic-baseline)
// ---------------------------------------------------------------------------

export type ObjectActionSummary = {
  id: number;
  active?: boolean;
  name?: string;
  objectActionExecutorKey?: string;
  objectActionTriggerKey?: string;
};

export async function listObjectActions(objectDefId: number): Promise<ObjectActionSummary[]> {
  const items = await fetchAllIds(
    `/o/object-admin/v1.0/object-definitions/${objectDefId}/object-actions`
  );
  return items as unknown as ObjectActionSummary[];
}

// ---------------------------------------------------------------------------
// User notifications helpers (manage-object-logic-baseline)
// ---------------------------------------------------------------------------

export type UserNotificationSummary = { id: number; [key: string]: unknown };

export async function listMyUserNotifications(): Promise<UserNotificationSummary[]> {
  const items = await fetchAllIds(
    "/o/notification/v1.0/notification-queue-entries"
  );
  return items as unknown as UserNotificationSummary[];
}

// ---------------------------------------------------------------------------
// Commerce catalog helpers (commerce-catalogs-baseline)
// ---------------------------------------------------------------------------

export type CommerceProductSummary = {
  id: number;
  productId?: number;
  name?: string | Record<string, string>;
  catalogId?: number;
  catalogExternalReferenceCode?: string;
  externalReferenceCode?: string;
  [key: string]: unknown;
};

export type CommerceSkuSummary = {
  id: number;
  price?: number;
  sku?: string;
  [key: string]: unknown;
};

export async function listCommerceProducts(): Promise<CommerceProductSummary[]> {
  const items = await fetchAllIds(
    "/o/headless-commerce-admin-catalog/v1.0/products"
  );
  return items as unknown as CommerceProductSummary[];
}

export async function listCommerceSkus(productId: number): Promise<CommerceSkuSummary[]> {
  const items = await fetchAllIds(
    `/o/headless-commerce-admin-catalog/v1.0/products/${productId}/skus`
  );
  return items as unknown as CommerceSkuSummary[];
}

export async function deleteCommerceProduct(productId: number): Promise<boolean> {
  const res = await liferayFetch(
    `/o/headless-commerce-admin-catalog/v1.0/products/${productId}`,
    { method: "DELETE" }
  );
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`deleteCommerceProduct(${productId}) HTTP ${res.status}: ${await res.text()}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Object definition helpers (manage-objects-baseline + manage-object-logic-baseline)
// ---------------------------------------------------------------------------

export type ObjectFieldSummary = {
  name?: string;
  businessType?: string;
  type?: string;
  listTypeDefinitionId?: number;
  required?: boolean;
  [key: string]: unknown;
};

export async function listObjectDefinitions(): Promise<ObjectDefinition[]> {
  const items = await fetchAllIds("/o/object-admin/v1.0/object-definitions");
  return items as unknown as ObjectDefinition[];
}

export async function listObjectFields(objectDefId: number): Promise<ObjectFieldSummary[]> {
  const items = await fetchAllIds(
    `/o/object-admin/v1.0/object-definitions/${objectDefId}/object-fields`
  );
  return items as unknown as ObjectFieldSummary[];
}

export { BASE_URL };
