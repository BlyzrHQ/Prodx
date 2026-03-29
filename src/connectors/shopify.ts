import type { ProductRecord, ProductVariant, ShopifyPayload } from "../types.js";

interface CreateMediaInput {
  originalSource: string;
  alt: string;
  mediaContentType: "IMAGE";
}

interface MetafieldInput {
  namespace: string;
  key: string;
  type: string;
  value: string;
}

interface ShopifyGraphqlRequest {
  store: string;
  apiVersion?: string;
  accessToken: string;
  query: string;
  variables?: Record<string, unknown>;
}

interface ShopifyGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

function buildGraphqlUrl(store: string, apiVersion = "2025-04"): string {
  return `https://${store}/admin/api/${apiVersion}/graphql.json`;
}

async function shopifyGraphql<T>({
  store,
  apiVersion = "2025-04",
  accessToken,
  query,
  variables = {}
}: ShopifyGraphqlRequest): Promise<T> {
  const response = await fetch(buildGraphqlUrl(store, apiVersion), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`Shopify request failed with ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json() as ShopifyGraphqlResponse<T>;
  if (payload.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${payload.errors.map((item) => item.message).join("; ")}`);
  }

  if (!payload.data) {
    throw new Error("Shopify response did not contain data.");
  }

  return payload.data;
}

function normalizeVariant(node: any): ProductVariant {
  const selectedOptions = Array.isArray(node.selectedOptions) ? node.selectedOptions : [];
  return {
    id: node.id,
    sku: node.sku ?? "",
    barcode: node.barcode ?? "",
    title: node.title ?? "",
    option1: selectedOptions[0]?.value ?? "",
    option2: selectedOptions[1]?.value ?? "",
    option3: selectedOptions[2]?.value ?? ""
  };
}

export function buildShopifyPayload(product: ProductRecord): ShopifyPayload {
  const imageCandidates = [
    typeof product.featured_image === "string" ? product.featured_image : "",
    ...(Array.isArray(product.images) ? product.images.filter((item) => typeof item === "string") : [])
  ].filter((value, index, items): value is string => Boolean(value) && items.indexOf(value) === index);

  return {
    id: product.id ?? null,
    title: product.title,
    handle: product.handle,
    descriptionHtml: product.description_html ?? product.description ?? "",
    vendor: product.brand ?? product.vendor ?? "",
    productType: product.product_type ?? "",
    tags: product.tags ?? [],
    variants: product.variants ?? [],
    featuredImage: imageCandidates[0] ?? "",
    images: imageCandidates,
    imageAltText: typeof product.image_alt_text === "string" ? product.image_alt_text : product.title ?? "",
    metafields: Array.isArray(product.metafields) ? product.metafields : []
  };
}

function buildMediaInputs(payload: ShopifyPayload): CreateMediaInput[] {
  const imageCandidates = [
    typeof payload.featuredImage === "string" ? payload.featuredImage : "",
    ...(Array.isArray(payload.images) ? payload.images.filter((item): item is string => typeof item === "string") : [])
  ]
    .map((item) => item.trim())
    .filter((item, index, items) => item.length > 0 && /^https?:\/\//i.test(item) && items.indexOf(item) === index);

  const alt = typeof payload.imageAltText === "string" && payload.imageAltText.trim().length > 0
    ? payload.imageAltText.trim()
    : typeof payload.title === "string"
      ? payload.title
      : "Product image";

  return imageCandidates.map((imageUrl) => ({
    originalSource: imageUrl,
    alt,
    mediaContentType: "IMAGE" as const
  }));
}

export async function testShopifyConnection({
  store,
  apiVersion = "2025-04",
  accessToken
}: {
  store: string;
  apiVersion?: string;
  accessToken: string;
}): Promise<{ name: string; myshopifyDomain: string }> {
  const data = await shopifyGraphql<{ shop: { name: string; myshopifyDomain: string } }>({
    store,
    apiVersion,
    accessToken,
    query: "query CatalogToolkitShop { shop { name myshopifyDomain } }"
  });
  return data.shop;
}

export async function fetchShopifyCatalogSnapshot({
  store,
  apiVersion = "2025-04",
  accessToken,
  first = 50
}: {
  store: string;
  apiVersion?: string;
  accessToken: string;
  first?: number;
}): Promise<ProductRecord[]> {
  const data = await shopifyGraphql<{
    products?: {
      edges?: Array<{
        node: {
          id: string;
          title?: string;
          handle?: string;
          vendor?: string;
          productType?: string;
          tags?: string[];
          variants?: { edges?: Array<{ node: any }> };
        };
      }>;
    };
  }>({
    store,
    apiVersion,
    accessToken,
    query: `
      query CatalogToolkitProducts($first: Int!) {
        products(first: $first) {
          edges {
            node {
              id
              title
              handle
              vendor
              productType
              tags
              variants(first: 50) {
                edges {
                  node {
                    id
                    title
                    sku
                    barcode
                    selectedOptions {
                      name
                      value
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    variables: { first }
  });

  return (data.products?.edges ?? []).map(({ node }) => {
    const variants = (node.variants?.edges ?? []).map(({ node: variantNode }) => normalizeVariant(variantNode));
    const firstVariant = variants[0] ?? {};
    return {
      id: node.id,
      title: node.title ?? "",
      handle: node.handle ?? "",
      brand: node.vendor ?? "",
      vendor: node.vendor ?? "",
      product_type: node.productType ?? "",
      tags: node.tags ?? [],
      sku: firstVariant.sku ?? "",
      barcode: firstVariant.barcode ?? "",
      option1: firstVariant.option1 ?? "",
      option2: firstVariant.option2 ?? "",
      option3: firstVariant.option3 ?? "",
      variants
    };
  });
}

export async function fetchShopifyPolicyContext({
  store,
  apiVersion = "2025-04",
  accessToken,
  first = 3
}: {
  store: string;
  apiVersion?: string;
  accessToken: string;
  first?: number;
}): Promise<{
  store: { name: string; myshopifyDomain: string };
  sample_products: Array<{
    id: string;
    title: string;
    handle: string;
    vendor: string;
    product_type: string;
    tags: string[];
    options: string[];
    sample_metafields: Array<{ namespace: string; key: string; type: string }>;
  }>;
  product_metafield_definitions: Array<{
    namespace: string;
    key: string;
    type: string;
    description: string;
    required: boolean;
    source_field: string;
    value: string;
  }>;
}> {
  const data = await shopifyGraphql<{
    shop: { name: string; myshopifyDomain: string };
    products?: {
      edges?: Array<{
        node: {
          id: string;
          title?: string;
          handle?: string;
          vendor?: string;
          productType?: string;
          tags?: string[];
          options?: Array<{ name?: string }>;
          metafields?: { edges?: Array<{ node: { namespace?: string; key?: string; type?: string } }> };
        };
      }>;
    };
    metafieldDefinitions?: {
      edges?: Array<{
        node: {
          namespace?: string;
          key?: string;
          name?: string;
          description?: string;
          type?: { name?: string };
          validations?: Array<{ name?: string; value?: string }>;
        };
      }>;
    };
  }>({
    store,
    apiVersion,
    accessToken,
    query: `
      query CatalogToolkitPolicyContext($first: Int!) {
        shop {
          name
          myshopifyDomain
        }
        products(first: $first) {
          edges {
            node {
              id
              title
              handle
              vendor
              productType
              tags
              options {
                name
              }
              metafields(first: 10) {
                edges {
                  node {
                    namespace
                    key
                    type
                  }
                }
              }
            }
          }
        }
        metafieldDefinitions(first: 25, ownerType: PRODUCT) {
          edges {
            node {
              namespace
              key
              name
              description
              type {
                name
              }
              validations {
                name
                value
              }
            }
          }
        }
      }
    `,
    variables: { first }
  });

  return {
    store: data.shop,
    sample_products: (data.products?.edges ?? []).map(({ node }) => ({
      id: node.id,
      title: node.title ?? "",
      handle: node.handle ?? "",
      vendor: node.vendor ?? "",
      product_type: node.productType ?? "",
      tags: node.tags ?? [],
      options: (node.options ?? []).map((option) => option.name ?? "").filter(Boolean),
      sample_metafields: (node.metafields?.edges ?? []).map(({ node: metafield }) => ({
        namespace: metafield.namespace ?? "",
        key: metafield.key ?? "",
        type: metafield.type ?? ""
      }))
    })),
    product_metafield_definitions: (data.metafieldDefinitions?.edges ?? []).map(({ node }) => ({
      namespace: node.namespace ?? "",
      key: node.key ?? "",
      type: node.type?.name ?? "single_line_text_field",
      description: node.description ?? node.name ?? "",
      required: (node.validations ?? []).some((validation) => validation.name === "required" && String(validation.value).toLowerCase() === "true"),
      source_field: "",
      value: ""
    })).filter((definition) => definition.namespace && definition.key)
  };
}

function buildProductInput(payload: ShopifyPayload): Record<string, unknown> {
  const metafields: MetafieldInput[] = Array.isArray(payload.metafields)
    ? payload.metafields.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const namespace = typeof item.namespace === "string" ? item.namespace : "";
        const key = typeof item.key === "string" ? item.key : "";
        const type = typeof item.type === "string" ? item.type : "single_line_text_field";
        const value = typeof item.value === "string" ? item.value : "";
        if (!namespace || !key || !value) return [];
        return [{ namespace, key, type, value }];
      })
    : [];

  return {
    ...(payload.id ? { id: payload.id } : {}),
    title: payload.title ?? "",
    handle: payload.handle ?? undefined,
    descriptionHtml: payload.descriptionHtml ?? "",
    vendor: payload.vendor ?? "",
    productType: payload.productType ?? "",
    tags: payload.tags ?? [],
    metafields
  };
}

export async function applyShopifyPayload({
  store,
  apiVersion = "2025-04",
  accessToken,
  payload
}: {
  store: string;
  apiVersion?: string;
  accessToken: string;
  payload: ShopifyPayload;
}): Promise<{ mode: "create" | "update"; productId: string; handle?: string; variantSupport: string }> {
  const variantCount = Array.isArray(payload.variants) ? payload.variants.length : 0;
  const media = buildMediaInputs(payload);
  if (variantCount > 1) {
    throw new Error("Live Shopify apply currently supports products with zero or one variant only. Review multi-variant payloads manually before live apply.");
  }

  if (payload.id) {
    const data = await shopifyGraphql<{
      productUpdate: {
        product?: { id: string; handle?: string };
        userErrors?: Array<{ field?: string[]; message: string }>;
      };
    }>({
      store,
      apiVersion,
      accessToken,
      query: `
        mutation CatalogToolkitProductUpdate($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
          productUpdate(product: $product, media: $media) {
            product {
              id
              handle
              media(first: 10) {
                nodes {
                  mediaContentType
                }
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      variables: {
        product: buildProductInput(payload),
        media
      }
    });

    const errors = data.productUpdate.userErrors ?? [];
    if (errors.length > 0) {
      throw new Error(`Shopify productUpdate failed: ${errors.map((item) => item.message).join("; ")}`);
    }

    return {
      mode: "update",
      productId: data.productUpdate.product?.id ?? String(payload.id),
      handle: data.productUpdate.product?.handle,
      variantSupport: variantCount <= 1 ? "single_variant_or_default" : "unsupported"
    };
  }

  const data = await shopifyGraphql<{
    productCreate: {
      product?: { id: string; handle?: string };
      userErrors?: Array<{ field?: string[]; message: string }>;
    };
  }>({
    store,
    apiVersion,
    accessToken,
    query: `
      mutation CatalogToolkitProductCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
        productCreate(product: $product, media: $media) {
          product {
            id
            handle
            media(first: 10) {
              nodes {
                mediaContentType
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    variables: {
      product: buildProductInput(payload),
      media
    }
  });

  const errors = data.productCreate.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(`Shopify productCreate failed: ${errors.map((item) => item.message).join("; ")}`);
  }

  return {
    mode: "create",
    productId: data.productCreate.product?.id ?? "",
    handle: data.productCreate.product?.handle,
    variantSupport: variantCount <= 1 ? "single_variant_or_default" : "unsupported"
  };
}
