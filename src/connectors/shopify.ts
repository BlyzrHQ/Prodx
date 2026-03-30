import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
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

type ShopifyMetafieldDefinitionMap = Map<string, { type: string }>;

interface ShopifyGraphqlRequest {
  store: string;
  apiVersion?: string;
  accessToken: string;
  query: string;
  variables?: Record<string, unknown>;
}

interface ShopifyOAuthResponse {
  access_token: string;
  scope?: string;
  scopes?: string[];
  expires_in?: number;
  associated_user_scope?: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  token_type?: string;
}

interface ShopifyGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

function buildGraphqlUrl(store: string, apiVersion = "2025-04"): string {
  return `https://${store}/admin/api/${apiVersion}/graphql.json`;
}

function isShopifyProductGid(value: unknown): value is string {
  return typeof value === "string" && /^gid:\/\/shopify\/Product\/.+$/i.test(value.trim());
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

  const firstVariant = Array.isArray(product.variants) && product.variants.length > 0
    ? product.variants[0] as ProductVariant
    : null;

  return {
    id: product.id ?? null,
    title: product.title,
    handle: product.handle,
    descriptionHtml: product.description_html ?? product.description ?? "",
    vendor: product.vendor ?? product.brand ?? "",
    productType: product.product_type ?? "",
    tags: product.tags ?? [],
    variants: product.variants ?? [],
    price: typeof firstVariant?.price === "string" ? firstVariant.price : product.price,
    compareAtPrice: typeof firstVariant?.compare_at_price === "string" ? firstVariant.compare_at_price : product.compare_at_price,
    featuredImage: imageCandidates[0] ?? "",
    images: imageCandidates,
    imageAltText: typeof product.image_alt_text === "string" ? product.image_alt_text : product.title ?? "",
    metafields: Array.isArray(product.metafields) ? product.metafields : []
  };
}

function normalizeShopDomain(store: string): string {
  const trimmed = store.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return trimmed.endsWith(".myshopify.com") ? trimmed : `${trimmed}.myshopify.com`;
}

function buildOauthHmac(params: URLSearchParams, clientSecret: string): string {
  const message = [...params.entries()]
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return crypto.createHmac("sha256", clientSecret).update(message).digest("hex");
}

function openBrowser(url: string): void {
  const platform = process.platform;
  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

export async function authenticateShopifyViaOAuth({
  store,
  clientId,
  clientSecret,
  scopes = ["write_products", "read_products", "read_metafields", "write_metafields"],
  openBrowserWindow = true
}: {
  store: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  openBrowserWindow?: boolean;
}): Promise<ShopifyOAuthResponse & { store: string; method: "oauth"; obtained_at: string }> {
  const normalizedStore = normalizeShopDomain(store);
  const state = crypto.randomBytes(16).toString("hex");
  const callbackServer = await new Promise<{ redirectUri: string; codePromise: Promise<string> }>((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname !== "/oauth/callback") {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      try {
        const code = requestUrl.searchParams.get("code") ?? "";
        const callbackState = requestUrl.searchParams.get("state") ?? "";
        const callbackShop = normalizeShopDomain(requestUrl.searchParams.get("shop") ?? "");
        const hmac = requestUrl.searchParams.get("hmac") ?? "";
        if (!code) throw new Error("Missing Shopify authorization code.");
        if (callbackState !== state) throw new Error("State verification failed for Shopify OAuth.");
        if (callbackShop !== normalizedStore) throw new Error("Shopify OAuth callback returned a different shop domain.");
        const computedHmac = buildOauthHmac(requestUrl.searchParams, clientSecret);
        if (!hmac || computedHmac !== hmac) throw new Error("Shopify OAuth HMAC verification failed.");

        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end("<html><body><h1>Shopify authentication complete</h1><p>You can close this window and return to the CLI.</p></body></html>");
        server.close();
        codeResolver(code);
      } catch (error) {
        response.statusCode = 400;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<html><body><h1>Shopify authentication failed</h1><p>${error instanceof Error ? error.message : String(error)}</p></body></html>`);
        server.close();
        codeRejecter(error);
      }
    });

    let codeResolver!: (code: string) => void;
    let codeRejecter!: (error: unknown) => void;
    const codePromise = new Promise<string>((resolveCode, rejectCode) => {
      codeResolver = resolveCode;
      codeRejecter = rejectCode;
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to start local Shopify OAuth callback server."));
        return;
      }
      resolve({ redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`, codePromise });
    });

    const timer = setTimeout(() => {
      server.close();
      codeRejecter(new Error("Timed out waiting for Shopify OAuth callback."));
    }, 300000);
    codePromise.finally(() => clearTimeout(timer)).catch(() => {});
  });

  const authorizeUrl = new URL(`https://${normalizedStore}/admin/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("scope", scopes.join(","));
  authorizeUrl.searchParams.set("redirect_uri", callbackServer.redirectUri);
  authorizeUrl.searchParams.set("state", state);

  if (openBrowserWindow) {
    openBrowser(authorizeUrl.toString());
  }

  const code = await callbackServer.codePromise;
  const tokenResponse = await fetch(`https://${normalizedStore}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code
    })
  });
  const payload = await tokenResponse.json() as ShopifyOAuthResponse;
  if (!tokenResponse.ok || !payload.access_token) {
    throw new Error(`Shopify OAuth token exchange failed: ${tokenResponse.status} ${JSON.stringify(payload)}`);
  }

  return {
    ...payload,
    store: normalizedStore,
    method: "oauth",
    obtained_at: new Date().toISOString()
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

async function fetchProductMetafieldDefinitionsMap({
  store,
  apiVersion = "2025-04",
  accessToken
}: {
  store: string;
  apiVersion?: string;
  accessToken: string;
}): Promise<ShopifyMetafieldDefinitionMap> {
  const data = await shopifyGraphql<{
    metafieldDefinitions?: {
      edges?: Array<{
        node: {
          namespace?: string;
          key?: string;
          type?: { name?: string };
        };
      }>;
    };
  }>({
    store,
    apiVersion,
    accessToken,
    query: `
      query CatalogToolkitMetafieldDefinitions {
        metafieldDefinitions(first: 100, ownerType: PRODUCT) {
          edges {
            node {
              namespace
              key
              type {
                name
              }
            }
          }
        }
      }
    `
  });

  const definitions: ShopifyMetafieldDefinitionMap = new Map();
  for (const edge of data.metafieldDefinitions?.edges ?? []) {
    const namespace = edge.node.namespace ?? "";
    const key = edge.node.key ?? "";
    const type = edge.node.type?.name ?? "";
    if (!namespace || !key || !type) continue;
    definitions.set(`${namespace}.${key}`, { type });
  }
  return definitions;
}

function isMetaobjectGid(value: string): boolean {
  return /^gid:\/\/shopify\/Metaobject\/.+$/i.test(value.trim());
}

function isCompatibleMetafieldValue(type: string, value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (type === "metaobject_reference") return isMetaobjectGid(trimmed);
  if (type === "list.metaobject_reference") {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && isMetaobjectGid(item));
    } catch {
      return false;
    }
  }
  return true;
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
    validation_rules: string[];
    example_values: string[];
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
        metafieldDefinitions(first: 100, ownerType: PRODUCT) {
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
      value: "",
      validation_rules: (node.validations ?? [])
        .filter((validation) => typeof validation.name === "string" && validation.name.trim().length > 0)
        .map((validation) => {
          const name = String(validation.name);
          const value = validation.value === undefined || validation.value === null ? "" : String(validation.value);
          return value ? `${name}: ${value}` : name;
        }),
      example_values: []
    })).filter((definition) => definition.namespace && definition.key)
  };
}

function buildProductInput(
  payload: ShopifyPayload,
  options?: { includeId?: boolean; definitions?: ShopifyMetafieldDefinitionMap }
): Record<string, unknown> {
  const metafields: MetafieldInput[] = Array.isArray(payload.metafields)
    ? payload.metafields.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const namespace = typeof item.namespace === "string" ? item.namespace : "";
        const key = typeof item.key === "string" ? item.key : "";
        const type = typeof item.type === "string" ? item.type : "single_line_text_field";
        const value = typeof item.value === "string" ? item.value : "";
        if (!namespace || !key || !value) return [];
        const definition = options?.definitions?.get(`${namespace}.${key}`);
        if (definition) {
          if (definition.type !== type) return [];
          if (!isCompatibleMetafieldValue(definition.type, value)) return [];
        }
        return [{ namespace, key, type, value }];
      })
    : [];

  return {
    ...(options?.includeId && isShopifyProductGid(payload.id) ? { id: payload.id } : {}),
    title: payload.title ?? "",
    handle: payload.handle ?? undefined,
    descriptionHtml: payload.descriptionHtml ?? "",
    vendor: payload.vendor ?? "",
    productType: payload.productType ?? "",
    tags: payload.tags ?? [],
    metafields
  };
}

function getSingleVariantPayload(payload: ShopifyPayload): ProductVariant | null {
  if (Array.isArray(payload.variants) && payload.variants.length > 0) {
    return payload.variants[0] as ProductVariant;
  }

  const hasStandaloneFields = [
    payload.price,
    payload.compareAtPrice
  ].some((value) => typeof value === "string" && value.trim().length > 0);

  if (!hasStandaloneFields) return null;

  return {
    title: "Default Title",
    option1: "Default Title",
    price: payload.price,
    compare_at_price: payload.compareAtPrice
  };
}

async function updateStandaloneVariant({
  store,
  apiVersion,
  accessToken,
  productId,
  variantId,
  payload
}: {
  store: string;
  apiVersion: string;
  accessToken: string;
  productId: string;
  variantId: string;
  payload: ShopifyPayload;
}): Promise<void> {
  const sourceVariant = getSingleVariantPayload(payload);
  if (!sourceVariant) return;

  const variantsInput: Array<Record<string, unknown>> = [{
    id: variantId,
    ...(typeof sourceVariant.price === "string" && sourceVariant.price.trim().length > 0 ? { price: sourceVariant.price } : {}),
    ...(typeof sourceVariant.compare_at_price === "string" && sourceVariant.compare_at_price.trim().length > 0 ? { compareAtPrice: sourceVariant.compare_at_price } : {}),
    ...(typeof sourceVariant.sku === "string" && sourceVariant.sku.trim().length > 0 ? { sku: sourceVariant.sku } : {}),
    ...(typeof sourceVariant.barcode === "string" && sourceVariant.barcode.trim().length > 0 ? { barcode: sourceVariant.barcode } : {})
  }];

  if (Object.keys(variantsInput[0]).length <= 1) return;

  const data = await shopifyGraphql<{
    productVariantsBulkUpdate: {
      userErrors?: Array<{ field?: string[]; message: string }>;
    };
  }>({
    store,
    apiVersion,
    accessToken,
    query: `
      mutation CatalogToolkitProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    variables: {
      productId,
      variants: variantsInput
    }
  });

  const errors = data.productVariantsBulkUpdate.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(`Shopify productVariantsBulkUpdate failed: ${errors.map((item) => item.message).join("; ")}`);
  }
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
  const definitions = await fetchProductMetafieldDefinitionsMap({ store, apiVersion, accessToken });
  if (variantCount > 1) {
    throw new Error("Live Shopify apply currently supports products with zero or one variant only. Review multi-variant payloads manually before live apply.");
  }

  if (isShopifyProductGid(payload.id)) {
    const data = await shopifyGraphql<{
      productUpdate: {
        product?: { id: string; handle?: string; variants?: { nodes?: Array<{ id: string }> } };
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
              variants(first: 1) {
                nodes {
                  id
                }
              }
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
        product: buildProductInput(payload, { includeId: true, definitions }),
        media
      }
    });

    const errors = data.productUpdate.userErrors ?? [];
    if (errors.length > 0) {
      throw new Error(`Shopify productUpdate failed: ${errors.map((item) => item.message).join("; ")}`);
    }

    const updatedProductId = data.productUpdate.product?.id ?? String(payload.id);
    const updatedVariantId = data.productUpdate.product?.variants?.nodes?.[0]?.id ?? "";
    if (updatedProductId && updatedVariantId) {
      await updateStandaloneVariant({
        store,
        apiVersion,
        accessToken,
        productId: updatedProductId,
        variantId: updatedVariantId,
        payload
      });
    }

    return {
      mode: "update",
      productId: updatedProductId,
      handle: data.productUpdate.product?.handle,
      variantSupport: variantCount <= 1 ? "single_variant_or_default" : "unsupported"
    };
  }

  const data = await shopifyGraphql<{
    productCreate: {
      product?: { id: string; handle?: string; variants?: { nodes?: Array<{ id: string }> } };
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
            variants(first: 1) {
              nodes {
                id
              }
            }
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
      product: buildProductInput(payload, { definitions }),
      media
    }
  });

  const errors = data.productCreate.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(`Shopify productCreate failed: ${errors.map((item) => item.message).join("; ")}`);
  }

  const createdProductId = data.productCreate.product?.id ?? "";
  const createdVariantId = data.productCreate.product?.variants?.nodes?.[0]?.id ?? "";
  if (createdProductId && createdVariantId) {
    await updateStandaloneVariant({
      store,
      apiVersion,
      accessToken,
      productId: createdProductId,
      variantId: createdVariantId,
      payload
    });
  }

  return {
    mode: "create",
    productId: createdProductId,
    handle: data.productCreate.product?.handle,
    variantSupport: variantCount <= 1 ? "single_variant_or_default" : "unsupported"
  };
}
