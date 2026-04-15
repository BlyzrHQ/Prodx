import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { runAnalyzerAgent } from "../agents/analyzer.js";
import { runCollectionBuilderAgent } from "../agents/collection-builder.js";
import { runCollectionEvaluatorAgent } from "../agents/collection-evaluator.js";
import { runEnrichAgent } from "../agents/enrich.js";
import { runImageAgent } from "../agents/image.js";
import { runMatcherAgent } from "../agents/matcher.js";
import { runQaAgent } from "../agents/qa.js";
import { convexAction, convexMutation, convexQuery } from "./convex.js";
import { embedText } from "./embeddings.js";
import { callLlm } from "./llm.js";
import {
  createShopifyMetaobjectEntry,
  fetchAllCollections,
  fetchAllProducts,
  fetchStoreContext,
  syncProductToShopify,
  type ShopifyCollection,
  type ShopifyProduct,
} from "./shopify.js";

type ProductRecord = Record<string, unknown> & { _id?: string };
type MatchedCandidateOutcome = {
  outcome: "added" | "skipped" | "variant" | "uncertain";
  productId?: string;
};
type PipelineStageRunners = {
  enrich: (payload: {
    product: ProductRecord;
    fieldsToImprove: string[];
    qaFeedback: string[];
  }) => Promise<any>;
  image: (payload: { product: ProductRecord }) => Promise<Awaited<ReturnType<typeof runImageAgent>>>;
  qa: (payload: { product: ProductRecord }) => Promise<Awaited<ReturnType<typeof runQaAgent>>>;
  publish: (payload: {
    productId: string;
    product: ProductRecord;
    qaScore?: number;
    reviewNotes?: Array<Record<string, unknown>>;
  }) => Promise<{ action: string; qaScore?: number }>;
};

export async function syncShopifyCatalog(): Promise<{
  productsSynced: number;
  collectionsSynced: number;
}> {
  const [shopifyProducts, shopifyCollections] = await Promise.all([
    fetchAllProducts(),
    fetchAllCollections(),
  ]);

  const productDocs = shopifyProducts.map(mapShopifyProductToProductRecord);
  const productIds = await convexMutation<string[]>("products:upsertSyncedBatch", {
    products: productDocs,
  });

  for (let index = 0; index < shopifyProducts.length; index++) {
    const shopifyProduct = shopifyProducts[index];
    const productId = productIds[index];

    await convexMutation("variants:replaceForProduct", {
      productId,
      variants: shopifyProduct.variants.map((variant) => ({
        shopifyVariantId: variant.id,
        title: variant.title || undefined,
        sku: variant.sku || undefined,
        barcode: variant.barcode || undefined,
        price: variant.price || undefined,
        compareAtPrice: variant.compareAtPrice || undefined,
        option1Name: variant.selectedOptions?.[0]?.name || undefined,
        option1: variant.selectedOptions?.[0]?.value || undefined,
        option2Name: variant.selectedOptions?.[1]?.name || undefined,
        option2: variant.selectedOptions?.[1]?.value || undefined,
        option3Name: variant.selectedOptions?.[2]?.name || undefined,
        option3: variant.selectedOptions?.[2]?.value || undefined,
        inventoryQuantity: variant.inventoryQuantity,
        requiresShipping: variant.requiresShipping,
        taxable: variant.taxable,
      })),
    });

    await ensureEmbeddingForProduct(productId, {
      title: shopifyProduct.title,
      vendor: shopifyProduct.vendor,
      productType: shopifyProduct.productType,
      source: "shopify_sync",
    });
  }

  const collectionDocs = await mapWithConcurrency(shopifyCollections, 5, async (collection) =>
    mapShopifyCollectionToCollectionRecord(collection, await embedText(collection.title))
  );
  await convexMutation("collections:upsertSyncedBatch", { collections: collectionDocs });

  await convexMutation("storeContext:upsert", {
    context: {
      productTypes: uniqueStrings(productDocs.map((product) => String(product.productType ?? ""))),
      vendors: uniqueStrings(productDocs.map((product) => String(product.vendor ?? ""))),
      tags: uniqueStrings(
        productDocs.flatMap((product) => ((product.tags as string[] | undefined) ?? []))
      ),
      lastCatalogSyncAt: Date.now(),
      lastCollectionSyncAt: Date.now(),
    },
  });

  const localGuide = loadGuideFromDisk();
  if (localGuide) {
    await convexMutation("storeContext:mergeGuide", { guide: localGuide });
  }

  return {
    productsSynced: shopifyProducts.length,
    collectionsSynced: shopifyCollections.length,
  };
}

export async function syncStoreContextFromShopify(): Promise<{
  productTypes: number;
  tags: number;
  vendors: number;
  metafieldOptions: number;
  metaobjectOptions: number;
}> {
  const storeContext = sanitizeStoreContext(await fetchStoreContext());
  await convexMutation("storeContext:upsert", {
    context: {
      ...storeContext,
      lastCatalogSyncAt: Date.now(),
    },
  });

  return {
    productTypes: storeContext.productTypes.length,
    tags: storeContext.tags.length,
    vendors: storeContext.vendors.length,
    metafieldOptions: storeContext.metafieldOptions.length,
    metaobjectOptions: storeContext.metaobjectOptions.length,
  };
}

export async function reviewSyncedProducts(): Promise<{ marked: number }> {
  const products = await convexQuery<any[]>("products:getAll", {
    source: "shopify_sync",
    limit: 500,
  });

  const ids: string[] = [];
  const fieldsById: Record<string, string[]> = {};
  for (const product of products) {
    const fields = computeFieldsToImprove(product);
    if (fields.length > 0 && product._id) {
      ids.push(product._id);
      fieldsById[product._id] = fields;
    }
  }

  if (ids.length > 0) {
    await convexMutation("products:markNeedsReviewBatch", { ids, fieldsById });
  }

  return { marked: ids.length };
}

export async function ingestProducts(input: {
  fileUrl?: string;
  fileBase64?: string;
  fileName?: string;
  textInput?: string;
  imageUrl?: string;
  imageBase64?: string;
}): Promise<{ added: number; skipped: number; variants: number; uncertain: number }> {
  const analysis = await runAnalyzerAgent(input);
  const guide = await loadGuide();

  let added = 0;
  let skipped = 0;
  let variants = 0;
  let uncertain = 0;

  for (const candidate of analysis.products) {
    const match = await runMatcherAgent({ product: candidate as any, guide });
    const result = await handleMatchedCandidate(candidate.rawData ?? {}, match);
    if (result.outcome === "skipped") skipped++;
    if (result.outcome === "variant") variants++;
    if (result.outcome === "uncertain") uncertain++;
    if (result.outcome === "added") added++;
  }

  return { added, skipped, variants, uncertain };
}

export async function handleMatchedCandidate(
  rawData: Record<string, unknown>,
  match: Awaited<ReturnType<typeof runMatcherAgent>>,
  options?: { runPipelineInline?: boolean; publishVariantInline?: boolean }
): Promise<MatchedCandidateOutcome> {
  const runPipelineInline = options?.runPipelineInline ?? true;
  const publishVariantInline = options?.publishVariantInline ?? true;

  if (match.decision === "REJECTED" || match.decision === "DUPLICATE") {
    return { outcome: "skipped" };
  }

  if (match.decision === "NEW_VARIANT" && match.matchedProductId) {
    await convexMutation("variants:addVariant", {
      productId: match.matchedProductId,
      variant: {
        ...match.variant,
        title: String(match.normalizedProduct.title ?? "") || undefined,
      },
    });
    if (publishVariantInline) {
      await runProductPublishStage(match.matchedProductId);
    }
    return { outcome: "variant", productId: match.matchedProductId };
  }

  const product = normalizeMatchedProduct(match.normalizedProduct, rawData);
  const fieldsToImprove = computeFieldsToImprove(product);
  let id = await convexMutation<string | undefined>("products:enqueueForReview", {
    source: "manual_input",
    product,
    fieldsToImprove,
  });

  if (!id) {
    id = await recoverEnqueuedProductId(product);
  }
  if (!id) {
    throw new Error(
      "products:enqueueForReview did not return a product id for title: " +
        String(product.title ?? "")
    );
  }

  await ensureEmbeddingForProduct(id, {
    title: String(product.title ?? ""),
    vendor: String(product.vendor ?? ""),
    productType: String(product.productType ?? ""),
    source: "manual_input",
  });

  await convexMutation("variants:addVariant", {
    productId: id,
    variant: {
      ...match.variant,
      title: String(product.title ?? "") || undefined,
    },
  });

  if (match.decision === "UNCERTAIN") {
    return { outcome: "uncertain", productId: id };
  }

  if (runPipelineInline) {
    await processProductPipeline(id);
  }
  return { outcome: "added", productId: id };
}

async function recoverEnqueuedProductId(product: Record<string, unknown>): Promise<string | undefined> {
  const candidates = await convexQuery<any[]>("products:getAll", {
    limit: 25,
    source: "manual_input",
  });

  const title = String(product.title ?? "").trim().toLowerCase();
  const vendor = String(product.vendor ?? "").trim().toLowerCase();
  const productType = String(product.productType ?? "").trim().toLowerCase();

  const match = candidates.find((candidate) => {
    const candidateTitle = String(candidate.title ?? "").trim().toLowerCase();
    const candidateVendor = String(candidate.vendor ?? "").trim().toLowerCase();
    const candidateProductType = String(candidate.productType ?? "").trim().toLowerCase();

    if (title && candidateTitle !== title) return false;
    if (vendor && candidateVendor && candidateVendor !== vendor) return false;
    if (productType && candidateProductType && candidateProductType !== productType) return false;
    return true;
  });

  return typeof match?._id === "string" ? match._id : undefined;
}

export async function processPendingProducts(options?: { limit?: number }): Promise<{ processed: number }> {
  const pending = await convexQuery<any[]>("products:getPendingPipeline", {
    limit: options?.limit ?? 25,
  });
  for (const product of pending) {
    await processProductPipeline(product._id);
  }
  return { processed: pending.length };
}

export async function publishApprovedProducts(): Promise<{ published: number }> {
  const approved = await convexQuery<any[]>("products:getApprovedForPublish", {});
  let published = 0;
  for (const product of approved) {
    const result = await runProductPublishStage(product._id);
    if (result.action === "published") {
      published++;
    }
  }
  return { published };
}

export async function approveAndPublishProduct(productId: string): Promise<{ dispatched: boolean }> {
  const product = await convexQuery<any>("products:getById", { id: productId });
  if (!product) {
    throw new Error("Product not found: " + productId);
  }

  await convexMutation("products:approveProduct", {
    id: productId,
    productPatch: toProductPatch(product),
    qaScore: typeof product.qaScore === "number" ? product.qaScore : undefined,
    reviewNotes: Array.isArray(product.reviewNotes) ? product.reviewNotes : undefined,
  });

  if (isTriggerConfigured()) {
    await triggerTask("product-publisher", { productId });
    return { dispatched: true };
  }

  await runProductPublishStage(productId);
  return { dispatched: false };
}

export async function processProductPipeline(
  productId: string
): Promise<{ action: string; qaScore?: number }> {
  return processProductPipelineWithRunners(productId, createInlinePipelineStageRunners());
}

export async function processProductPipelineWithRunners(
  productId: string,
  stageRunners: PipelineStageRunners
): Promise<{ action: string; qaScore?: number }> {
  const original = await convexQuery<any>("products:getById", { id: productId });
  if (!original) {
    throw new Error("Product not found: " + productId);
  }

  await convexMutation("products:updatePipelineState", {
    id: productId,
    workflowStatus: "in_review",
  });

  let storeContext = await convexQuery<any>("storeContext:get", {});
  let currentProduct: ProductRecord = { ...original };
  let fieldsToImprove = normalizeFieldsToImprove(
    (original.fieldsToImprove as string[] | undefined) ?? computeFieldsToImprove(original)
  );
  let qaFeedback: string[] = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    const stagePlan = determineStagePlan(currentProduct, fieldsToImprove, attempt);

    if (stagePlan.needsEnrichment) {
      const enrichResult = await stageRunners.enrich({
        product: currentProduct,
        fieldsToImprove,
        qaFeedback,
      });
      currentProduct = mergeEnrichmentResult(currentProduct, enrichResult);
      storeContext = await materializeStoreContextUpdates(storeContext, currentProduct, enrichResult);
      if (enrichResult.fallbackReason) {
        qaFeedback = [enrichResult.fallbackReason];
      }
    }

    if (stagePlan.needsImageOptimization) {
      const imageResult = await stageRunners.image({ product: currentProduct });
      currentProduct = mergeImageResult(currentProduct, imageResult);
    }

    currentProduct = ensureFeaturedImageMirrorsImages(currentProduct);
    await ensureEmbeddingForProduct(productId, {
      title: String(currentProduct.title ?? ""),
      vendor: String(currentProduct.vendor ?? ""),
      productType: String(currentProduct.productType ?? ""),
      source: String(currentProduct.source ?? "manual_input"),
    });

    const qaResult = await stageRunners.qa({ product: currentProduct });

    const reviewNotes = buildReviewNotes(qaResult);
    fieldsToImprove = normalizeFieldsToImprove(qaResult.suggested_fixes.specific_fields);
    qaFeedback = [
      ...reviewNotes.map((note) => String(note.message ?? "")),
      String(qaResult.suggested_fixes?.feedback_for_enricher ?? "").trim(),
    ].filter(Boolean);

    await convexMutation("products:updatePipelineState", {
      id: productId,
      qaScore: qaResult.score,
      reviewNotes,
      fieldsToImprove,
      productPatch: toProductPatch(currentProduct),
      incrementAttempt: true,
    });

    if (qaResult.status === "PASS") {
      return stageRunners.publish({
        productId,
        product: currentProduct,
        qaScore: qaResult.score,
        reviewNotes,
      });
    }

    if (attempt === 2) {
      const workflowStatus = shouldEscalateToHumanReview(fieldsToImprove)
        ? "needs_human_review"
        : "needs_review";
      await convexMutation("products:rejectProduct", {
        id: productId,
        workflowStatus,
        qaScore: qaResult.score,
        reviewNotes,
      });
      return { action: workflowStatus, qaScore: qaResult.score };
    }
  }

  return { action: "needs_review" };
}

export async function runProductPublishStage(
  productId: string,
  providedProduct?: Record<string, unknown>,
  qaScore?: number,
  reviewNotes?: Array<Record<string, unknown>>
): Promise<{ action: string; qaScore?: number }> {
  const product = providedProduct ?? (await convexQuery<any>("products:getById", { id: productId }));
  if (!product) {
    throw new Error("Product not found: " + productId);
  }

  const variants = await convexQuery<any[]>("variants:getByProductId", { productId });
  const storeContext = await convexQuery<any>("storeContext:get", {});

  if (!String(product.price ?? "").trim()) {
    await convexMutation("products:rejectProduct", {
      id: productId,
      workflowStatus: "needs_review",
      qaScore,
      reviewNotes: [
        ...(reviewNotes ?? []),
        {
          message: "Price is missing, so the product cannot be published yet.",
          severity: "major",
          source: "publish",
        },
      ],
    });
    return { action: "needs_review", qaScore };
  }

  try {
    const publishResult = await syncProductToShopify({
      product,
      variants,
      storeContext,
    });

    await convexMutation("products:updatePipelineState", {
      id: productId,
      productPatch: {
        shopifyId: publishResult.shopifyProductId,
      },
      qaScore,
      reviewNotes: [
        ...(reviewNotes ?? []),
        ...publishResult.skippedMetafields.map((metafield) => ({
          message: "Skipped Shopify metafield without a valid definition: " + metafield,
          severity: "minor",
          source: "publish",
        })),
      ],
    });
    await convexMutation("products:markPublished", { id: productId });
    return { action: "published", qaScore };
  } catch (error) {
    await convexMutation("products:approveProduct", {
      id: productId,
      productPatch: toProductPatch(product),
      qaScore,
      reviewNotes: [
        ...(reviewNotes ?? []),
        {
          message:
            "Shopify publish failed: " +
            (error instanceof Error ? error.message : String(error)),
          severity: "major",
          source: "publish",
        },
      ],
    });
    return { action: "approved", qaScore };
  }
}

export async function buildCollectionsOnce(): Promise<{ created: number }> {
  const guide = await loadGuide();
  const summary = await convexQuery<any>("catalogueSummary:getCatalogueSummary", {});
  const existingCollections = await convexQuery<any[]>("collections:getAll", { limit: 500 });
  let created = 0;

  for (const candidate of summary.collectionCandidates ?? []) {
    const proposal = await runCollectionBuilderAgent({ candidate, guide });
    const embedding = await embedText(proposal.title);
    const similar = await convexAction<any[]>("collections:searchSimilarTitles", {
      embedding,
      limit: 5,
    });
    const evaluation = await runCollectionEvaluatorAgent({
      proposal,
      existingCollections: [
        ...existingCollections.map((collection) => ({
          title: collection.title,
          handle: collection.handle,
        })),
        ...similar.map((collection) => ({
          title: collection.title,
          handle: collection.handle,
        })),
      ],
    });

    if (evaluation.decision !== "APPROVE") {
      continue;
    }

    await convexMutation("collections:upsertGenerated", {
      collection: {
        source: "generated",
        workflowStatus: "needs_review",
        title: proposal.title,
        handle: proposal.handle,
        descriptionHtml: proposal.descriptionHtml,
        seoTitle: proposal.seoTitle,
        seoDescription: proposal.seoDescription,
        ruleType: proposal.ruleType,
        ruleValue: proposal.ruleValue,
        ruleDefinition: {
          type: proposal.ruleType,
          value: proposal.ruleValue,
          description: proposal.rationale,
        },
        productCount: proposal.productCount,
        titleEmbedding: embedding,
        reviewNotes: [{ message: proposal.rationale, source: "collection_builder" }],
      },
    });
    created++;
  }

  return { created };
}

export async function getStatusSnapshot(): Promise<{
  products: Record<string, unknown>;
  collections: Record<string, unknown>;
}> {
  const [products, collections] = await Promise.all([
    convexQuery<Record<string, unknown>>("products:getStatusSummary", {}),
    convexQuery<Record<string, unknown>>("collections:getStatusSummary", {}),
  ]);
  return { products, collections };
}

export async function regenerateGuide(): Promise<void> {
  const storeContext = await convexQuery<any>("storeContext:get", {});
  const currentGuide = await loadGuide();
  const businessName =
    (currentGuide as any)?.at_a_glance?.name ??
    (currentGuide as any)?.industry_business_context?.summary ??
    "My Store";
  const industry =
    (currentGuide as any)?.at_a_glance?.industry ??
    (currentGuide as any)?.industry_business_context?.industry ??
    "general";
  const description = (currentGuide as any)?.at_a_glance?.store_summary ?? "";

  const guide = await callLlm<Record<string, unknown>>({
    systemPrompt:
      "You are a Senior Catalog Strategist and Shopify Product Data Architect. Generate a comprehensive catalog guide as JSON.",
    userPrompt:
      "Business: " +
      businessName +
      "\nDescription: " +
      description +
      "\nIndustry: " +
      industry +
      "\nStore context: " +
      JSON.stringify(storeContext ?? {}, null, 2),
    schema: {
      name: "catalog_guide",
      schema: {
        type: "object",
        properties: {
          at_a_glance: { type: "object", properties: {} },
          industry_business_context: { type: "object", properties: {} },
          eligibility_rules: { type: "object", properties: {} },
          taxonomy: { type: "object", properties: {} },
          product_title_system: { type: "object", properties: {} },
          product_description_system: { type: "object", properties: {} },
          variant_architecture: { type: "object", properties: {} },
          attributes_metafields_schema: { type: "object", properties: {} },
          image_media_standards: { type: "object", properties: {} },
          merchandising_rules: { type: "object", properties: {} },
          seo_discovery_rules: { type: "object", properties: {} },
          qa_validation_system: { type: "object", properties: {} },
          automation_playbook: { type: "object", properties: {} },
        },
        required: [
          "at_a_glance",
          "industry_business_context",
          "eligibility_rules",
          "taxonomy",
          "product_title_system",
          "product_description_system",
          "variant_architecture",
          "attributes_metafields_schema",
          "image_media_standards",
          "merchandising_rules",
          "seo_discovery_rules",
          "qa_validation_system",
          "automation_playbook",
        ],
      },
    },
  });

  saveGuideLocally(guide);
  await convexMutation("storeContext:mergeGuide", { guide });
}

export async function triggerTask(taskId: string, payload: Record<string, unknown>): Promise<void> {
  const { triggerSecretKey } = getConfig();
  if (!triggerSecretKey) {
    throw new Error("TRIGGER_SECRET_KEY not configured");
  }

  const response = await fetch("https://api.trigger.dev/api/v1/tasks/" + taskId + "/trigger", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + triggerSecretKey,
    },
    body: JSON.stringify({ payload }),
  });

  if (!response.ok) {
    throw new Error("Trigger API error: " + response.status + " " + (await response.text()));
  }
}

export function isTriggerConfigured(): boolean {
  const { triggerProjectId, triggerSecretKey } = getConfig();
  return Boolean(triggerProjectId && triggerSecretKey);
}

export async function loadGuide(): Promise<Record<string, unknown>> {
  const local = loadGuideFromDisk();
  if (local) return local;
  const storeContext = await convexQuery<any>("storeContext:get", {});
  return (storeContext?.guide as Record<string, unknown>) ?? {};
}

function loadGuideFromDisk(): Record<string, unknown> | null {
  const guidePath = path.resolve(".catalog/guide/catalog-guide.json");
  if (!fs.existsSync(guidePath)) return null;
  return JSON.parse(fs.readFileSync(guidePath, "utf-8"));
}

function saveGuideLocally(guide: Record<string, unknown>): void {
  const guideDir = path.resolve(".catalog/guide");
  fs.mkdirSync(guideDir, { recursive: true });
  fs.writeFileSync(path.join(guideDir, "catalog-guide.json"), JSON.stringify(guide, null, 2));
}

async function ensureEmbeddingForProduct(
  productId: string,
  input: { title: string; vendor: string; productType: string; source: string }
) {
  const title = String(input.title ?? "").trim();
  if (!title) return;

  const existing = await convexQuery<any | null>("productEmbeddings:getByProductId", { productId });
  if (existing?.title === title) {
    return;
  }

  const embedding = await embedText(buildEmbeddingText(title, input.vendor, input.productType));
  await convexMutation("productEmbeddings:upsertEmbedding", {
    productId,
    title,
    source: input.source,
    embedding,
  });
}

function createInlinePipelineStageRunners(): PipelineStageRunners {
  const guidePromise = loadGuide();

  return {
    enrich: async ({ product, fieldsToImprove, qaFeedback }) => {
      const [guide, storeContext] = await Promise.all([
        guidePromise,
        convexQuery<Record<string, unknown> | null>("storeContext:get", {}),
      ]);
      return runEnrichAgent({
        product,
        guide,
        storeContext,
        fieldsToImprove,
        qaFeedback,
      });
    },
    image: async ({ product }) => {
      const guide = await guidePromise;
      return runImageAgent({ product, guide });
    },
    qa: async ({ product }) => {
      const guide = await guidePromise;
      return runQaAgent({
        product,
        guide,
        passingScore: Number((guide as any)?.qa_validation_system?.passing_score ?? 70),
      });
    },
    publish: async ({ productId, product, qaScore, reviewNotes }) =>
      runProductPublishStage(productId, product, qaScore, reviewNotes),
  };
}

function mapShopifyProductToProductRecord(product: ShopifyProduct): Record<string, unknown> {
  return {
    shopifyId: product.id,
    title: product.title,
    handle: product.handle || undefined,
    description: product.description || undefined,
    descriptionHtml: product.descriptionHtml || undefined,
    vendor: product.vendor || undefined,
    productType: product.productType || undefined,
    status: product.status || undefined,
    tags: product.tags.length > 0 ? product.tags : undefined,
    images: product.images.length > 0 ? product.images : undefined,
    featuredImage: product.featuredImage ?? undefined,
    price: product.priceRange.min || undefined,
    compareAtPrice:
      product.priceRange.max && product.priceRange.max !== product.priceRange.min
        ? product.priceRange.max
        : undefined,
    seoTitle: product.seoTitle ?? undefined,
    seoDescription: product.seoDescription ?? undefined,
    metafields: product.metafields.length > 0 ? product.metafields : undefined,
  };
}

function mapShopifyCollectionToCollectionRecord(
  collection: ShopifyCollection,
  titleEmbedding: number[]
): Record<string, unknown> {
  return {
    shopifyId: collection.id,
    title: collection.title,
    handle: collection.handle || slugify(collection.title),
    descriptionHtml: collection.descriptionHtml || undefined,
    ruleType: collection.ruleType ?? undefined,
    ruleValue: collection.ruleValue ?? undefined,
    ruleDefinition:
      collection.ruleType && collection.ruleValue
        ? {
            type: collection.ruleType,
            value: collection.ruleValue,
            description: "Imported from Shopify collection rules",
          }
        : undefined,
    productCount: collection.productCount,
    titleEmbedding,
  };
}

function sanitizeStoreContext(storeContext: Awaited<ReturnType<typeof fetchStoreContext>>) {
  return {
    productTypes: uniqueStrings(storeContext.productTypes),
    tags: uniqueStrings(storeContext.tags),
    vendors: uniqueStrings(storeContext.vendors),
    metafieldOptions: (storeContext.metafieldOptions ?? []).map((definition) => ({
      namespace: String(definition.namespace ?? "").trim(),
      key: String(definition.key ?? "").trim(),
      ...(definition.type ? { type: String(definition.type).trim() } : {}),
      validations: (definition.validations ?? [])
        .map((validation) => ({
          name: String(validation.name ?? "").trim(),
          value: String(validation.value ?? "").trim(),
        }))
        .filter((validation) => validation.name && validation.value),
    })),
    metaobjectOptions: (storeContext.metaobjectOptions ?? []).map((group) => ({
      type: String(group.type ?? "").trim(),
      name: String(group.name ?? group.type ?? "").trim(),
      entries: (group.entries ?? [])
        .map((entry) => ({
          id: String(entry.id ?? "").trim(),
          displayName: String(entry.displayName ?? "").trim(),
          fields: Object.fromEntries(
            Object.entries(entry.fields ?? {})
              .map(([key, value]) => [String(key ?? "").trim(), String(value ?? "").trim()] as const)
              .filter(([key, value]) => key && value)
          ),
        }))
        .filter((entry) => entry.id && entry.displayName),
    })),
  };
}

function normalizeMatchedProduct(
  product: Record<string, unknown>,
  rawData: Record<string, unknown>
): Record<string, unknown> {
  const images = Array.isArray(product.images)
    ? product.images.map((image, index) =>
        typeof image === "string"
          ? { url: image, altText: String(product.title ?? "") || null, position: index + 1 }
          : image
      )
    : [];

  const mergedRawData =
    product.rawData && typeof product.rawData === "object"
      ? { ...(product.rawData as Record<string, unknown>), ...rawData }
      : rawData;

  return {
    shopifyId: typeof product.shopifyId === "string" ? product.shopifyId : undefined,
    title: String(product.title ?? "").trim(),
    handle: typeof product.handle === "string" ? product.handle : undefined,
    description: typeof product.description === "string" ? product.description : undefined,
    descriptionHtml: typeof product.descriptionHtml === "string" ? product.descriptionHtml : undefined,
    vendor: typeof product.vendor === "string" ? product.vendor : undefined,
    productType: typeof product.productType === "string" ? product.productType : undefined,
    status: typeof product.status === "string" ? product.status : undefined,
    tags: Array.isArray(product.tags) ? product.tags.map(String).filter(Boolean) : undefined,
    images,
    featuredImage:
      typeof product.featuredImage === "string"
        ? product.featuredImage
        : images[0]?.url ?? undefined,
    price: typeof product.price === "string" ? product.price : undefined,
    compareAtPrice:
      typeof product.compareAtPrice === "string" ? product.compareAtPrice : undefined,
    seoTitle: typeof product.seoTitle === "string" ? product.seoTitle : undefined,
    seoDescription:
      typeof product.seoDescription === "string" ? product.seoDescription : undefined,
    metafields: Array.isArray(product.metafields) ? product.metafields : undefined,
    rawData: mergedRawData,
  };
}

function determineStagePlan(
  product: Record<string, unknown>,
  fieldsToImprove: string[],
  attempt: number
): { needsEnrichment: boolean; needsImageOptimization: boolean } {
  const imageFields = new Set(["images", "featuredImage"]);
  const cameFromImageInput =
    Boolean((product.rawData as Record<string, unknown> | undefined)?.sourceImage) ||
    String((product.rawData as Record<string, unknown> | undefined)?.sourceType ?? "") === "image";
  const needsImageOptimization =
    fieldsToImprove.some((field) => imageFields.has(field)) ||
    (attempt === 0 && cameFromImageInput) ||
    !String(product.featuredImage ?? "").trim() ||
    !Array.isArray(product.images) ||
    product.images.length === 0;

  const needsEnrichment =
    fieldsToImprove.some((field) => !imageFields.has(field)) ||
    !String(product.description ?? "").trim() ||
    !String(product.productType ?? "").trim() ||
    !String(product.vendor ?? "").trim();

  return { needsEnrichment, needsImageOptimization };
}

export function computeFieldsToImprove(product: Record<string, unknown>): string[] {
  const fields: string[] = [];
  if (!String(product.title ?? "").trim()) fields.push("title");
  if (!String(product.handle ?? "").trim()) fields.push("handle");
  if (!String(product.description ?? "").trim()) fields.push("description");
  if (!String(product.descriptionHtml ?? "").trim()) fields.push("descriptionHtml");
  if (!String(product.seoTitle ?? "").trim()) fields.push("seoTitle");
  if (!String(product.seoDescription ?? "").trim()) fields.push("seoDescription");
  if (!String(product.productType ?? "").trim()) fields.push("productType");
  if (!String(product.vendor ?? "").trim()) fields.push("vendor");
  if (!String(product.price ?? "").trim()) fields.push("price");
  if (!Array.isArray(product.tags) || product.tags.length === 0) fields.push("tags");
  if (!Array.isArray(product.metafields) || product.metafields.length === 0) fields.push("metafields");
  const hasImages =
    String(product.featuredImage ?? "").trim() ||
    (Array.isArray(product.images) && product.images.length > 0);
  if (!hasImages) fields.push("images");
  return normalizeFieldsToImprove(fields);
}

function normalizeFieldsToImprove(fields: string[]): string[] {
  return [...new Set(fields.map((field) => String(field).trim()).filter(Boolean))];
}

function mergeEnrichmentResult(currentProduct: ProductRecord, enrichResult: any): ProductRecord {
  const next: ProductRecord = { ...currentProduct };
  for (const field of [
    "title",
    "handle",
    "description",
    "descriptionHtml",
    "seoTitle",
    "seoDescription",
    "productType",
    "vendor",
    "price",
    "compareAtPrice",
  ]) {
    const value = enrichResult[field];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      next[field] = value;
    }
  }

  if (Array.isArray(enrichResult.tags) && enrichResult.tags.length > 0) {
    next.tags = [...new Set(enrichResult.tags.map(String).filter(Boolean))];
  }

  const existingMetafields = Array.isArray(currentProduct.metafields)
    ? [...(currentProduct.metafields as any[])]
    : [];
  for (const metafield of Array.isArray(enrichResult.metafields) ? enrichResult.metafields : []) {
    const index = existingMetafields.findIndex(
      (candidate) => candidate.namespace === metafield.namespace && candidate.key === metafield.key
    );
    if (index >= 0) {
      existingMetafields[index] = { ...existingMetafields[index], ...metafield };
    } else {
      existingMetafields.push(metafield);
    }
  }
  next.metafields = existingMetafields;

  return next;
}

function mergeImageResult(
  currentProduct: ProductRecord,
  imageResult: Awaited<ReturnType<typeof runImageAgent>>
): ProductRecord {
  const next: ProductRecord = { ...currentProduct };
  if (imageResult.featuredImage) {
    next.featuredImage = imageResult.featuredImage;
  }
  if (imageResult.images.length > 0) {
    next.images = imageResult.images;
  }
  return ensureFeaturedImageMirrorsImages(next);
}

function ensureFeaturedImageMirrorsImages(product: ProductRecord): ProductRecord {
  const next: ProductRecord = { ...product };
  const images = Array.isArray(product.images) ? [...(product.images as any[])] : [];
  if (next.featuredImage && !images.some((image) => image && image.url === next.featuredImage)) {
    images.unshift({
      url: next.featuredImage,
      altText: String(next.title ?? "") || null,
      position: 1,
    });
  }

  const normalizedImages = images.map((image, index) => ({
    ...image,
    position: index + 1,
  }));
  next.images = normalizedImages;

  if (!next.featuredImage && normalizedImages.length > 0) {
    next.featuredImage = normalizedImages[0].url;
  }

  return next;
}

async function materializeStoreContextUpdates(
  currentStoreContext: Record<string, unknown> | null,
  currentProduct: ProductRecord,
  enrichResult: {
    newStoreValues?: {
      productTypes?: string[];
      tags?: string[];
      metaobjectEntries?: Array<{
        type: string;
        displayName: string;
        fields: Array<{ key: string; value: string }>;
      }>;
    };
  }
) {
  const nextContext = {
    ...(currentStoreContext ?? {}),
    productTypes: uniqueStrings([
      ...(((currentStoreContext?.productTypes as string[]) ?? []) as string[]),
      ...((enrichResult.newStoreValues?.productTypes ?? []) as string[]),
      String(currentProduct.productType ?? ""),
    ]),
    tags: uniqueStrings([
      ...(((currentStoreContext?.tags as string[]) ?? []) as string[]),
      ...((enrichResult.newStoreValues?.tags ?? []) as string[]),
      ...(((currentProduct.tags as string[]) ?? []) as string[]),
    ]),
    vendors: uniqueStrings([
      ...(((currentStoreContext?.vendors as string[]) ?? []) as string[]),
      String(currentProduct.vendor ?? ""),
    ]),
    metafieldOptions: (currentStoreContext?.metafieldOptions as any[]) ?? [],
    metaobjectOptions: [...(((currentStoreContext?.metaobjectOptions as any[]) ?? []) as any[])],
  };

  const createdEntries: Array<{ type: string; displayName: string; id: string; fields: Record<string, string> }> =
    [];
  for (const entry of enrichResult.newStoreValues?.metaobjectEntries ?? []) {
    const fields = Object.fromEntries(
      (entry.fields ?? [])
        .map((field) => [String(field.key ?? "").trim(), String(field.value ?? "").trim()] as const)
        .filter(([key, value]) => key && value)
    );
    if (!entry.type || !entry.displayName || Object.keys(fields).length === 0) {
      continue;
    }

    try {
      const created = await createShopifyMetaobjectEntry({
        type: entry.type,
        displayName: entry.displayName,
        fields,
      });
      createdEntries.push(created);
    } catch {
      createdEntries.push({
        id: "suggested:" + entry.type + ":" + slugify(entry.displayName),
        type: entry.type,
        displayName: entry.displayName,
        fields,
      });
    }
  }

  nextContext.metaobjectOptions = mergeMetaobjectOptions(
    nextContext.metaobjectOptions as any[],
    createdEntries
  );
  await convexMutation("storeContext:upsert", { context: nextContext });
  applyResolvedMetaobjectReferences(currentProduct, nextContext.metaobjectOptions as any[]);
  return nextContext;
}

function applyResolvedMetaobjectReferences(
  product: ProductRecord,
  metaobjectOptions: Array<{
    type: string;
    entries: Array<{ id: string; displayName: string }>;
  }>
) {
  const metafields = Array.isArray(product.metafields) ? [...(product.metafields as any[])] : [];
  product.metafields = metafields.map((metafield) => {
    if (
      metafield.type !== "metaobject_reference" &&
      metafield.type !== "list.metaobject_reference"
    ) {
      return metafield;
    }

    if (String(metafield.value ?? "").startsWith("gid://")) {
      return metafield;
    }

    const match = metaobjectOptions
      .flatMap((group) => group.entries)
      .find((entry) => entry.displayName.toLowerCase() === String(metafield.value ?? "").toLowerCase());

    return match ? { ...metafield, value: match.id } : metafield;
  });
}

function mergeMetaobjectOptions(
  current: Array<{
    type: string;
    name?: string;
    entries?: Array<{ id: string; displayName: string; fields?: Record<string, string> }>;
  }>,
  incoming: Array<{ type: string; displayName: string; id: string; fields: Record<string, string> }>
) {
  const groups = new Map<
    string,
    {
      type: string;
      name?: string;
      entries: Array<{ id: string; displayName: string; fields: Record<string, string> }>;
    }
  >();

  for (const group of current) {
    groups.set(group.type, {
      type: group.type,
      name: group.name ?? group.type,
      entries: (group.entries ?? []).map((entry) => ({
        id: entry.id,
        displayName: entry.displayName,
        fields: entry.fields ?? {},
      })),
    });
  }

  for (const entry of incoming) {
    const group = groups.get(entry.type) ?? { type: entry.type, name: entry.type, entries: [] };
    if (!group.entries.some((candidate) => candidate.id === entry.id)) {
      group.entries.push({
        id: entry.id,
        displayName: entry.displayName,
        fields: entry.fields,
      });
    }
    groups.set(entry.type, group);
  }

  return [...groups.values()];
}

function buildReviewNotes(qaResult: {
  findings: Array<{ message: string; severity: string; field: string; source: string }>;
}) {
  return (qaResult.findings ?? []).map((finding) => ({
    message: finding.message,
    severity: finding.severity,
    field: finding.field,
    source: finding.source,
  }));
}

function toProductPatch(product: Record<string, unknown>) {
  const {
    _id,
    _creationTime,
    createdAt,
    updatedAt,
    source,
    workflowStatus,
    qaScore,
    reviewNotes,
    attemptCount,
    lastProcessedAt,
    syncedAt,
    publishedAt,
    rawData,
    ...rest
  } = product as Record<string, unknown>;

  return rest;
}

function shouldEscalateToHumanReview(fieldsToImprove: string[]) {
  return fieldsToImprove.some((field) =>
    ["price", "images", "title", "vendor", "productType"].includes(field)
  );
}

function buildEmbeddingText(title: string, vendor: string, productType: string): string {
  return [vendor, title, productType].filter(Boolean).join(" ").trim();
}

function uniqueStrings(values: Array<string | null | undefined | string[]>): string[] {
  return [
    ...new Set(
      values
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    ),
  ];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
