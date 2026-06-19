import { liferayFetch, healthCheck } from "./portal.js";

const TARGET_CATALOG_ERC = "catalog-b2b-industrial";
const PRODUCT_ERC = "industrial-drill-bit-set";
const PRODUCT_NAME = "Industrial Drill Bit Set";
const PRODUCT_PRICE = 89.99;

async function resolveCatalogIdByErc(erc: string): Promise<number | null> {
  try {
    const res = await liferayFetch(
      `/o/headless-commerce-admin-catalog/v1.0/catalogs?page=1&pageSize=100`
    );
    if (!res.ok) {
      console.error(`Failed to fetch catalogs: HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { items?: Array<{ id: number; externalReferenceCode?: string }> };
    const match = (body.items ?? []).find((c) => c.externalReferenceCode === erc);
    return match?.id ?? null;
  } catch (err) {
    console.error("Error resolving catalog ID:", err);
    return null;
  }
}

async function run() {
  console.log("Checking Liferay health...");
  await healthCheck();
  console.log("Liferay is healthy. Resolving catalog ID...");

  const catalogId = await resolveCatalogIdByErc(TARGET_CATALOG_ERC);
  if (catalogId === null) {
    throw new Error(`Catalog with ERC '${TARGET_CATALOG_ERC}' not found.`);
  }
  console.log(`Resolved catalog ID: ${catalogId}`);

  console.log(`Checking for existing product with ERC '${PRODUCT_ERC}' to clean up...`);
  const deleteRes = await liferayFetch(
    `/o/headless-commerce-admin-catalog/v1.0/products/by-externalReferenceCode/${PRODUCT_ERC}`,
    {
      method: "DELETE",
    }
  );
  if (deleteRes.ok) {
    console.log(`Successfully cleaned up existing product '${PRODUCT_ERC}'`);
  } else if (deleteRes.status === 404) {
    console.log(`No existing product with ERC '${PRODUCT_ERC}' found.`);
  } else {
    console.warn(`Attempt to delete existing product with ERC '${PRODUCT_ERC}' returned HTTP ${deleteRes.status}`);
  }

  console.log(`Creating product '${PRODUCT_NAME}' with ERC '${PRODUCT_ERC}'...`);
  const productRes = await liferayFetch(
    "/o/headless-commerce-admin-catalog/v1.0/products",
    {
      method: "POST",
      body: JSON.stringify({
        active: true,
        catalogId: catalogId,
        externalReferenceCode: PRODUCT_ERC,
        name: {
          en_US: PRODUCT_NAME,
        },
        productType: "simple",
      }),
    }
  );

  if (!productRes.ok) {
    throw new Error(`Failed to create product: HTTP ${productRes.status} - ${await productRes.text()}`);
  }

  const product = (await productRes.json()) as { id: number };
  const productId = product.id;
  console.log(`Successfully created product with ID: ${productId}`);

  console.log(`Adding SKU with price $${PRODUCT_PRICE} to product via ERC '${PRODUCT_ERC}'...`);
  const skuRes = await liferayFetch(
    `/o/headless-commerce-admin-catalog/v1.0/products/by-externalReferenceCode/${PRODUCT_ERC}/skus`,
    {
      method: "POST",
      body: JSON.stringify({
        sku: "drill-bit-set-sku",
        price: PRODUCT_PRICE,
        published: true,
        purchasable: true,
      }),
    }
  );

  if (!skuRes.ok) {
    throw new Error(`Failed to create SKU: HTTP ${skuRes.status} - ${await skuRes.text()}`);
  }

  const sku = await skuRes.json();
  console.log("Successfully created SKU:", sku);
  console.log("Done!");
}

run().catch((err) => {
  console.error("Execution failed:", err);
  process.exit(1);
});
