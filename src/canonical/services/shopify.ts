import { getConfig } from "../config.js";

export interface ShopifyImage {
  url: string;
  altText: string | null;
  position?: number;
  sourceUrl?: string;
  storageId?: string;
}

export interface ShopifyProduct {
  id: string;
  title: string;
  description: string;
  descriptionHtml: string;
  handle: string;
  productType: string;
  vendor: string;
  status: string;
  tags: string[];
  images: ShopifyImage[];
  featuredImage: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  metafields: Array<{ namespace: string; key: string; value: string; type: string }>;
  variants: Array<{
    id: string;
    title: string;
    sku: string;
    barcode: string;
    price: string;
    compareAtPrice: string | null;
    selectedOptions: Array<{ name: string; value: string }>;
    inventoryQuantity: number;
    requiresShipping: boolean;
    taxable: boolean;
  }>;
  priceRange: { min: string; max: string };
}

export interface ShopifyCollection {
  id: string;
  title: string;
  handle: string;
  descriptionHtml: string;
  ruleType: string | null;
  ruleValue: string | null;
  productCount: number;
}

export interface ShopifyMetaobjectOptionGroup {
  type: string;
  name: string;
  entries: Array<{ id: string; displayName: string; fields: Record<string, string> }>;
}

export interface ShopifyStoreContext {
  productTypes: string[];
  tags: string[];
  vendors: string[];
  metaobjectOptions: ShopifyMetaobjectOptionGroup[];
  metafieldOptions: Array<{
    namespace: string;
    key: string;
    type?: string;
    validations: Array<{ name: string; value: string }>;
  }>;
}

export interface ShopifySyncResult {
  shopifyProductId: string;
  skippedMetafields: string[];
}

function getShopifyConfig() {
  const { shopifyStore, shopifyAccessToken } = getConfig();
  if (!shopifyStore || !shopifyAccessToken) {
    throw new Error("Shopify not configured");
  }
  return { shopifyStore, shopifyAccessToken };
}

async function shopifyGraphql<T = any>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const { shopifyStore, shopifyAccessToken } = getShopifyConfig();
  const response = await fetch("https://" + shopifyStore + "/admin/api/2025-04/graphql.json", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": shopifyAccessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error("Shopify API error: " + response.status + " " + (await response.text()));
  }

  const data = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string; path?: string[]; extensions?: { code?: string } }>;
  };
  if (data.errors?.length) {
    throw new Error(
      data.errors
        .map((error) => {
          const code = error.extensions?.code ? "[" + error.extensions.code + "] " : "";
          const path = error.path?.length ? " (" + error.path.join(".") + ")" : "";
          return code + (error.message ?? "Unknown Shopify GraphQL error") + path;
        })
        .join("; ")
    );
  }

  if (!data.data) {
    throw new Error("Shopify returned no data.");
  }

  return data.data;
}

export async function fetchAllProducts(): Promise<ShopifyProduct[]> {
  const products: ShopifyProduct[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data: {
      products: {
        edges: Array<{
          cursor: string;
          node: any;
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await shopifyGraphql<{
      products: {
        edges: Array<{
          cursor: string;
          node: any;
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(
      `query FetchProducts($after: String) {
        products(first: 50, after: $after) {
          edges {
            cursor
            node {
              id
              title
              handle
              vendor
              productType
              status
              description
              descriptionHtml
              tags
              seo { title description }
              featuredImage { url altText }
              images(first: 20) {
                edges {
                  node {
                    url
                    altText
                  }
                }
              }
              metafields(first: 100) {
                edges {
                  node {
                    namespace
                    key
                    value
                    type
                  }
                }
              }
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    sku
                    barcode
                    price
                    compareAtPrice
                    selectedOptions { name value }
                    inventoryQuantity
                    taxable
                    inventoryItem { requiresShipping }
                  }
                }
              }
              priceRangeV2 {
                minVariantPrice { amount }
                maxVariantPrice { amount }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      { after: cursor }
    );

    for (const edge of data.products.edges) {
      const node = edge.node;
      products.push({
        id: node.id,
        title: node.title ?? "",
        description: node.description ?? "",
        descriptionHtml: node.descriptionHtml ?? "",
        handle: node.handle ?? "",
        productType: node.productType ?? "",
        vendor: node.vendor ?? "",
        status: node.status ?? "ACTIVE",
        tags: node.tags ?? [],
        images: (node.images?.edges ?? []).map((imageEdge: any, index: number) => ({
          url: imageEdge.node.url,
          altText: imageEdge.node.altText ?? null,
          position: index + 1,
        })),
        featuredImage: node.featuredImage?.url ?? null,
        seoTitle: node.seo?.title ?? null,
        seoDescription: node.seo?.description ?? null,
        metafields: (node.metafields?.edges ?? []).map((entry: any) => ({
          namespace: entry.node.namespace,
          key: entry.node.key,
          value: entry.node.value,
          type: entry.node.type,
        })),
        variants: (node.variants?.edges ?? []).map((entry: any) => ({
          id: entry.node.id,
          title: entry.node.title ?? "",
          sku: entry.node.sku ?? "",
          barcode: entry.node.barcode ?? "",
          price: entry.node.price ?? "",
          compareAtPrice: entry.node.compareAtPrice ?? null,
          selectedOptions: entry.node.selectedOptions ?? [],
          inventoryQuantity: entry.node.inventoryQuantity ?? 0,
          requiresShipping: entry.node.inventoryItem?.requiresShipping ?? true,
          taxable: entry.node.taxable ?? true,
        })),
        priceRange: {
          min: node.priceRangeV2?.minVariantPrice?.amount ?? "",
          max: node.priceRangeV2?.maxVariantPrice?.amount ?? "",
        },
      });
    }

    hasNextPage = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
  }

  return products;
}

export async function fetchAllCollections(): Promise<ShopifyCollection[]> {
  const collections: ShopifyCollection[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data: {
      collections: {
        edges: Array<{ cursor: string; node: any }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await shopifyGraphql<{
      collections: {
        edges: Array<{ cursor: string; node: any }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(
      `query FetchCollections($after: String) {
        collections(first: 50, after: $after) {
          edges {
            cursor
            node {
              id
              title
              handle
              descriptionHtml
              productsCount { count }
              ruleSet {
                rules {
                  column
                  condition
                  relation
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      { after: cursor }
    );

    for (const edge of data.collections.edges) {
      const firstRule = edge.node.ruleSet?.rules?.[0];
      collections.push({
        id: edge.node.id,
        title: edge.node.title ?? "",
        handle: edge.node.handle ?? "",
        descriptionHtml: edge.node.descriptionHtml ?? "",
        ruleType: firstRule?.column ?? null,
        ruleValue: firstRule?.condition ?? null,
        productCount: edge.node.productsCount?.count ?? 0,
      });
    }

    hasNextPage = data.collections.pageInfo.hasNextPage;
    cursor = data.collections.pageInfo.endCursor;
  }

  return collections;
}

export async function fetchStoreContext(): Promise<ShopifyStoreContext> {
  const data = await shopifyGraphql<{
    products: { edges: Array<{ node: any }> };
    metafieldDefinitions: { edges: Array<{ node: any }> };
  }>(
    `query FetchStoreContext {
      products(first: 50) {
        edges {
          node {
            productType
            vendor
            tags
            metafields(first: 50) {
              edges {
                node {
                  namespace
                  key
                  type
                  value
                  reference {
                    ... on Metaobject {
                      id
                      type
                      displayName
                      fields { key value }
                    }
                  }
                  references(first: 20) {
                    edges {
                      node {
                        ... on Metaobject {
                          id
                          type
                          displayName
                          fields { key value }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      metafieldDefinitions(first: 100, ownerType: PRODUCT) {
        edges {
          node {
            namespace
            key
            type { name }
            validations { name value }
          }
        }
      }
    }`
  );

  const products = data.products.edges.map((edge) => edge.node);
  const productTypes = uniqueStrings(products.map((product) => product.productType));
  const vendors = uniqueStrings(products.map((product) => product.vendor));
  const tags = uniqueStrings(products.flatMap((product) => product.tags ?? []));

  const metaobjectGroups = new Map<string, ShopifyMetaobjectOptionGroup>();
  for (const product of products) {
    for (const metafieldEdge of product.metafields?.edges ?? []) {
      const metafield = metafieldEdge.node;
      const type = String(metafield.type ?? "");
      if (type !== "metaobject_reference" && type !== "list.metaobject_reference") {
        continue;
      }

      const references = [
        ...(metafield.reference ? [metafield.reference] : []),
        ...(metafield.references?.edges ?? []).map((entry: any) => entry.node),
      ].filter(Boolean);

      for (const reference of references) {
        const groupType = String(reference.type ?? "").trim();
        if (!groupType) continue;
        const existingGroup =
          metaobjectGroups.get(groupType) ?? {
            type: groupType,
            name: groupType,
            entries: [],
          };

        if (!existingGroup.entries.some((entry) => entry.id === reference.id)) {
          existingGroup.entries.push({
            id: String(reference.id ?? ""),
            displayName: String(reference.displayName ?? ""),
            fields: Object.fromEntries(
              (reference.fields ?? [])
                .map((field: any) => [String(field.key ?? ""), String(field.value ?? "")] as const)
              .filter((entry: readonly [string, string]) => entry[0] && entry[1])
          ),
        });
        }

        metaobjectGroups.set(groupType, existingGroup);
      }
    }
  }

  const metafieldOptions = (data.metafieldDefinitions?.edges ?? [])
    .map((edge) => ({
      namespace: String(edge.node.namespace ?? ""),
      key: String(edge.node.key ?? ""),
      type: edge.node.type?.name ? String(edge.node.type.name) : undefined,
      validations: (edge.node.validations ?? [])
        .map((validation: any) => ({
          name: String(validation.name ?? ""),
          value: String(validation.value ?? ""),
        }))
        .filter((validation: { name: string; value: string }) => validation.name && validation.value),
    }))
    .filter((definition) => definition.namespace && definition.key);

  return {
    productTypes,
    tags,
    vendors,
    metaobjectOptions: [...metaobjectGroups.values()],
    metafieldOptions,
  };
}

export async function createShopifyMetaobjectEntry(input: {
  type: string;
  displayName: string;
  fields: Record<string, string>;
}): Promise<{ id: string; displayName: string; type: string; fields: Record<string, string> }> {
  const fields = Object.entries(input.fields)
    .map(([key, value]) => ({ key, value }))
    .filter((field) => field.key && field.value);

  const data = await shopifyGraphql<{
    metaobjectCreate: {
      metaobject?: {
        id: string;
        type: string;
        displayName: string;
        fields: Array<{ key: string; value: string }>;
      };
      userErrors?: Array<{ message?: string }>;
    };
  }>(
    `mutation CreateMetaobject($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject {
          id
          type
          displayName
          fields { key value }
        }
        userErrors { message }
      }
    }`,
    {
      metaobject: {
        type: input.type,
        fields,
      },
    }
  );

  const userErrors = data.metaobjectCreate.userErrors ?? [];
  if (userErrors.length > 0 || !data.metaobjectCreate.metaobject) {
    throw new Error(
      "Metaobject creation failed: " + userErrors.map((error) => error.message ?? "Unknown").join("; ")
    );
  }

  return {
    id: data.metaobjectCreate.metaobject.id,
    displayName: data.metaobjectCreate.metaobject.displayName || input.displayName,
    type: data.metaobjectCreate.metaobject.type,
    fields: Object.fromEntries(
      (data.metaobjectCreate.metaobject.fields ?? [])
        .map((field) => [field.key, field.value] as const)
        .filter(([key, value]) => key && value)
    ),
  };
}

export async function syncProductToShopify(input: {
  product: Record<string, unknown>;
  variants: Array<Record<string, unknown>>;
  storeContext?: Record<string, unknown> | null;
}): Promise<ShopifySyncResult> {
  const { product, variants, storeContext } = input;
  const metafieldDefinitions = new Map(
    ((storeContext?.metafieldOptions as Array<any>) ?? []).map((definition) => [
      definition.namespace + "." + definition.key,
      definition,
    ])
  );

  const skippedMetafields: string[] = [];
  const metafields = ((product.metafields as Array<any>) ?? [])
    .map((metafield) => {
      const key = metafield.namespace + "." + metafield.key;
      const definition = metafieldDefinitions.get(key);
      if (!definition) {
        skippedMetafields.push(key);
        return null;
      }
      if (definition.type && metafield.type && definition.type !== metafield.type) {
        skippedMetafields.push(key);
        return null;
      }
      return {
        namespace: metafield.namespace,
        key: metafield.key,
        type: definition.type ?? metafield.type,
        value: String(metafield.value ?? ""),
      };
    })
    .filter((metafield): metafield is NonNullable<typeof metafield> => Boolean(metafield?.value));

  const productOptions = buildProductOptions(variants);
  const files = buildProductFiles(product);

  const data = await shopifyGraphql<{
    productSet: {
      product?: { id: string };
      userErrors?: Array<{ message?: string; field?: string[] }>;
    };
  }>(
    `mutation UpsertProduct($input: ProductSetInput!, $synchronous: Boolean!) {
      productSet(input: $input, synchronous: $synchronous) {
        product { id }
        userErrors { field message }
      }
    }`,
    {
      synchronous: true,
      input: {
        ...(product.shopifyId ? { id: product.shopifyId } : {}),
        title: product.title,
        descriptionHtml: product.descriptionHtml || product.description || "",
        handle: product.handle || undefined,
        vendor: product.vendor || undefined,
        productType: product.productType || undefined,
        status: "ACTIVE",
        tags: Array.isArray(product.tags) ? product.tags : [],
        seo:
          product.seoTitle || product.seoDescription
            ? {
                title: product.seoTitle || undefined,
                description: product.seoDescription || undefined,
              }
            : undefined,
        metafields,
        files,
        productOptions,
        variants: variants.map((variant) => ({
          ...(variant.shopifyVariantId ? { id: variant.shopifyVariantId } : {}),
          sku: variant.sku || undefined,
          barcode: variant.barcode || undefined,
          price: variant.price || undefined,
          compareAtPrice: variant.compareAtPrice || undefined,
          taxable: variant.taxable ?? true,
          inventoryPolicy: "CONTINUE",
          optionValues: buildVariantOptionValues(variant),
        })),
      },
    }
  );

  const userErrors = data.productSet.userErrors ?? [];
  if (userErrors.length > 0 || !data.productSet.product?.id) {
    throw new Error(
      userErrors.map((error) => error.message ?? "Unknown Shopify publish error").join("; ") ||
        "Product sync failed."
    );
  }

  return {
    shopifyProductId: data.productSet.product.id,
    skippedMetafields,
  };
}

function buildProductOptions(variants: Array<Record<string, unknown>>) {
  const optionMap = new Map<string, Set<string>>();
  for (const variant of variants) {
    for (const [nameKey, valueKey] of [
      ["option1Name", "option1"],
      ["option2Name", "option2"],
      ["option3Name", "option3"],
    ] as const) {
      const optionName = String(variant[nameKey] ?? "").trim();
      const optionValue = String(variant[valueKey] ?? "").trim();
      if (!optionName || !optionValue) continue;
      const set = optionMap.get(optionName) ?? new Set<string>();
      set.add(optionValue);
      optionMap.set(optionName, set);
    }
  }

  return [...optionMap.entries()].map(([name, values]) => ({
    name,
    values: [...values].map((value) => ({ name: value })),
  }));
}

function buildVariantOptionValues(variant: Record<string, unknown>) {
  return [
    { nameKey: "option1Name", valueKey: "option1" },
    { nameKey: "option2Name", valueKey: "option2" },
    { nameKey: "option3Name", valueKey: "option3" },
  ]
    .map(({ nameKey, valueKey }) => ({
      optionName: String(variant[nameKey] ?? "").trim(),
      name: String(variant[valueKey] ?? "").trim(),
    }))
    .filter((entry) => entry.optionName && entry.name);
}

function buildProductFiles(product: Record<string, unknown>) {
  const images = Array.isArray(product.images) ? product.images : [];
  const normalized = images
    .map((image) => {
      if (typeof image === "string") {
        return { url: image, altText: String(product.title ?? "") || undefined };
      }
      if (image && typeof image === "object") {
        return {
          url: String((image as any).sourceUrl ?? (image as any).url ?? ""),
          altText: (image as any).altText ? String((image as any).altText) : undefined,
        };
      }
      return null;
    })
    .filter((image): image is NonNullable<typeof image> => Boolean(image?.url))
    .filter((image) => image.url.startsWith("http://") || image.url.startsWith("https://"));

  return normalized.map((image) => ({
    contentType: "IMAGE",
    originalSource: image.url,
    alt: image.altText,
  }));
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}
