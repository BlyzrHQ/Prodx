import { convexAction, convexQuery } from "../services/convex.js";
import { embedText } from "../services/embeddings.js";
import { callLlm } from "../services/llm.js";

export type MatchDecision = "NEW_PRODUCT" | "NEW_VARIANT" | "DUPLICATE" | "UNCERTAIN" | "REJECTED";

export interface MatchResult {
  decision: MatchDecision;
  confidence: number;
  reasoning: string;
  matchedProductId?: string;
  matchedProductTitle?: string;
  similarity?: number;
  normalizedProduct: Record<string, unknown>;
  variant: Record<string, unknown>;
  searchText: string;
  errors: string[];
  rejectionReason?: string;
}

interface VariantValidatorResult {
  valid: boolean;
  rejected: boolean;
  rejection_reason: string;
  errors: string[];
  handle: string;
  title: string;
  brand: string;
  product_type: string;
  search_text: string;
  image_url: string;
  variant: {
    sku: string;
    barcode: string;
    option1_name: string;
    option1_value: string;
    option2_name: string;
    option2_value: string;
    option3_name: string;
    option3_value: string;
    price: string;
    compare_at_price: string;
  };
}

export async function runMatcherAgent(input: {
  product: Record<string, unknown>;
  guide?: Record<string, unknown>;
}): Promise<MatchResult> {
  const candidate = input.product;
  const guide = input.guide ?? {};
  const validator = await runVariantValidator(candidate, guide);

  const normalizedProduct = buildNormalizedProduct(candidate, validator);
  const variant = buildVariantPayload(candidate, validator);
  const searchText = validator.search_text || buildSearchText(normalizedProduct, variant);

  if (validator.rejected) {
    return {
      decision: "REJECTED",
      confidence: 100,
      reasoning: validator.rejection_reason ?? "Rejected by eligibility rules",
      normalizedProduct,
      variant,
      searchText,
      errors: validator.errors,
      rejectionReason: validator.rejection_reason ?? undefined,
    };
  }

  if (variant.sku) {
    const skuMatch = await convexQuery<any | null>("variants:getBySku", { sku: variant.sku });
    if (skuMatch?.productId) {
      const product = await convexQuery<any | null>("products:getById", { id: skuMatch.productId });
      return {
        decision: "DUPLICATE",
        confidence: 99,
        reasoning: "Exact SKU already exists in the catalog.",
        matchedProductId: skuMatch.productId,
        matchedProductTitle: product?.title,
        similarity: 1,
        normalizedProduct,
        variant,
        searchText,
        errors: validator.errors,
      };
    }
  }

  const embedding = await embedText(searchText);
  const vectorResults = await convexAction<any[]>("productEmbeddings:searchSimilar", {
    embedding,
    limit: 5,
  });

  if (!vectorResults.length) {
    return {
      decision: validator.valid ? "NEW_PRODUCT" : "UNCERTAIN",
      confidence: validator.valid ? 92 : 72,
      reasoning: validator.valid
        ? "No similar product embeddings were found."
        : "No similar products were found, but the intake still has unresolved issues.",
      normalizedProduct,
      variant,
      searchText,
      errors: validator.errors,
    };
  }

  const topMatches = await Promise.all(
    vectorResults.slice(0, 3).map(async (result) => {
      const product = await convexQuery<any | null>("products:getById", { id: result.productId });
      const variants = product
        ? await convexQuery<any[]>("variants:getByProductId", { productId: product._id })
        : [];
      return {
        productId: result.productId,
        title: product?.title ?? result.title,
        vendor: product?.vendor ?? "",
        handle: product?.handle ?? "",
        similarity: result._score ?? 0,
        variants: variants.map((entry) => ({
          sku: entry.sku ?? "",
          title: entry.title ?? "",
          option1Name: entry.option1Name ?? "",
          option1: entry.option1 ?? "",
          option2Name: entry.option2Name ?? "",
          option2: entry.option2 ?? "",
          option3Name: entry.option3Name ?? "",
          option3: entry.option3 ?? "",
        })),
      };
    })
  );

  const decision = await runMatchDecision(
    {
      product: normalizedProduct,
      variant,
      errors: validator.errors,
    },
    topMatches,
    guide
  );

  const normalizedDecision = normalizeDecision(
    decision.decision,
    vectorResults[0]?._score ?? 0,
    validator
  );

  return {
    decision: normalizedDecision,
    confidence: normalizeConfidence(decision.confidence),
    reasoning: decision.reasoning,
    matchedProductId: decision.matched_product_id ?? topMatches[0]?.productId,
    matchedProductTitle: topMatches.find(
      (match) => match.productId === (decision.matched_product_id ?? topMatches[0]?.productId)
    )?.title,
    similarity: vectorResults[0]?._score,
    normalizedProduct,
    variant,
    searchText,
    errors: validator.errors,
  };
}

async function runVariantValidator(
  product: Record<string, unknown>,
  guide: Record<string, unknown>
): Promise<VariantValidatorResult> {
  const skuExamples = await convexQuery<any[]>("variants:listSkuExamples", { limit: 15 });
  const guideSlices = buildGuideSlices(guide, [
    "eligibility_rules",
    "product_title_system",
    "variant_architecture",
    "taxonomy",
  ]);

  const result = await callLlm<VariantValidatorResult>({
    systemPrompt: `You are a product variant validator for a catalog management system.

## PURPOSE
Normalize one incoming product candidate into a clean product-level record plus a variant-level record that downstream matching can trust.

## CORE JOB
1. Check product eligibility using the guide's eligibility rules
2. Normalize product-level identity
3. Normalize variant options
4. Generate SKU if missing using the existing store SKU style
5. Build search_text optimized for semantic duplicate matching
6. Extract image URL if present
7. Separate soft publish issues from true identity blockers

## RULES
- Use the guide's eligibility rules, not hardcoded industry assumptions, to decide whether the product belongs in this catalog.
- Price can be missing. Treat that as a soft issue, not a reason to reject identity or force uncertainty.
- Product title should be product-level, not variant-level.
- Size, pack, flavor, roast, form, and count usually belong on the variant.
- Remove obvious size or pack tokens from the product title unless the guide clearly allows them at the product level.
- If no existing SKU is provided, imitate the existing store SKU style shown below.
- If a brand is clearly visible or obvious from the title, use it. Otherwise leave it empty.
- Use empty strings for unavailable string fields, never null-like placeholders.

Guide slices:
${guideSlices}

Recent SKU examples:
${JSON.stringify(skuExamples, null, 2)}
`,
    userPrompt:
      "Normalize this candidate for matching.\n\nCandidate:\n" +
      JSON.stringify(product, null, 2),
    schema: {
      name: "variant_validator",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          valid: { type: "boolean" },
          rejected: { type: "boolean" },
          rejection_reason: { type: "string" },
          errors: { type: "array", items: { type: "string" } },
          handle: { type: "string" },
          title: { type: "string" },
          brand: { type: "string" },
          product_type: { type: "string" },
          search_text: { type: "string" },
          image_url: { type: "string" },
          variant: {
            type: "object",
            additionalProperties: false,
            properties: {
              sku: { type: "string" },
              barcode: { type: "string" },
              option1_name: { type: "string" },
              option1_value: { type: "string" },
              option2_name: { type: "string" },
              option2_value: { type: "string" },
              option3_name: { type: "string" },
              option3_value: { type: "string" },
              price: { type: "string" },
              compare_at_price: { type: "string" },
            },
            required: [
              "sku",
              "barcode",
              "option1_name",
              "option1_value",
              "option2_name",
              "option2_value",
              "option3_name",
              "option3_value",
              "price",
              "compare_at_price",
            ],
          },
        },
        required: [
          "valid",
          "rejected",
          "rejection_reason",
          "errors",
          "handle",
          "title",
          "brand",
          "product_type",
          "search_text",
          "image_url",
          "variant",
        ],
      },
    },
  });

  const errors = [...new Set(result.errors ?? [])];
  const valid = result.rejected ? false : Boolean(result.title || product.title);
  if (!result.variant.price && String(product.price ?? "").trim().length === 0) {
    errors.push("Price is missing");
  }

  return {
    ...result,
    valid,
    errors,
    title: stripVariantTokens(result.title || String(product.title ?? ""), [
      result.variant.option1_value,
      result.variant.option2_value,
      result.variant.option3_value,
    ]),
    brand: result.brand || String(product.brand ?? product.vendor ?? ""),
    product_type: result.product_type || String(product.productType ?? ""),
    search_text:
      result.search_text || buildSearchText(buildNormalizedProduct(product, result), buildVariantPayload(product, result)),
  };
}

async function runMatchDecision(
  candidate: {
    product: Record<string, unknown>;
    variant: Record<string, unknown>;
    errors: string[];
  },
  matches: Array<{
    productId: string;
    title: string;
    vendor: string;
    handle: string;
    similarity: number;
    variants: Array<Record<string, unknown>>;
  }>,
  guide: Record<string, unknown>
): Promise<{
  decision: MatchDecision;
  confidence: number;
  reasoning: string;
  matched_product_id?: string;
}> {
  const guideSlices = buildGuideSlices(guide, ["variant_architecture", "taxonomy"]);

  return callLlm({
    systemPrompt: `You are a product matching decision engine.

Use semantic match results plus existing variant rows to decide whether the candidate is:
- NEW_PRODUCT
- NEW_VARIANT
- DUPLICATE
- UNCERTAIN

Rules:
- If there is no meaningful match, choose NEW_PRODUCT.
- If the base product matches but variant options differ, choose NEW_VARIANT.
- If the same base product and same variant already exist, choose DUPLICATE.
- Missing price alone should not force UNCERTAIN.
- Generic values like Original, Default, Standard are weak variant signals.
- Use the guide to judge which variant dimensions are meaningful for this catalog.
- If the candidate identity is strong and there is no strong catalog match, prefer NEW_PRODUCT over UNCERTAIN.
- Use UNCERTAIN only for real ambiguity, conflicting identity signals, or risky grouping cases.

Guide slices:
${guideSlices}`,
    userPrompt:
      "Candidate:\n" +
      JSON.stringify(candidate, null, 2) +
      "\n\nTop matches:\n" +
      JSON.stringify(matches, null, 2),
    schema: {
      name: "match_decision",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          decision: {
            type: "string",
            enum: ["NEW_PRODUCT", "NEW_VARIANT", "DUPLICATE", "UNCERTAIN"],
          },
          confidence: { type: "number" },
          reasoning: { type: "string" },
          matched_product_id: { type: "string" },
        },
        required: ["decision", "confidence", "reasoning", "matched_product_id"],
      },
    },
  });
}

function buildNormalizedProduct(
  product: Record<string, unknown>,
  validator: VariantValidatorResult
): Record<string, unknown> {
  const title = stripVariantTokens(validator.title || String(product.title ?? ""));
  const vendor = cleanValue(validator.brand || String(product.vendor ?? product.brand ?? ""));
  const productType = cleanValue(validator.product_type || String(product.productType ?? ""));
  const handle = validator.handle || slugify(title || [vendor, productType].filter(Boolean).join(" "));
  const price = cleanValue(validator.variant.price || String(product.price ?? ""));
  const compareAtPrice = cleanValue(
    validator.variant.compare_at_price || String(product.compareAtPrice ?? "")
  );
  const images = Array.isArray(product.images)
    ? (product.images as unknown[]).map(String).filter(Boolean)
    : [];

  return {
    ...product,
    title,
    handle,
    vendor,
    brand: vendor,
    productType,
    price,
    compareAtPrice,
    featuredImage:
      typeof product.featuredImage === "string"
        ? product.featuredImage
        : validator.image_url || images[0] || undefined,
    images:
      validator.image_url && !images.includes(validator.image_url)
        ? [validator.image_url, ...images]
        : images,
  };
}

function buildVariantPayload(
  product: Record<string, unknown>,
  validator: VariantValidatorResult
): Record<string, unknown> {
  return {
    title: cleanValue(String(product.title ?? validator.title ?? "")),
    sku: cleanValue(validator.variant.sku || String(product.sku ?? "")),
    barcode: cleanValue(validator.variant.barcode || String(product.barcode ?? "")),
    price: cleanValue(validator.variant.price || String(product.price ?? "")),
    compareAtPrice: cleanValue(
      validator.variant.compare_at_price || String(product.compareAtPrice ?? "")
    ),
    option1Name: cleanValue(validator.variant.option1_name),
    option1: cleanValue(validator.variant.option1_value),
    option2Name: cleanValue(validator.variant.option2_name),
    option2: cleanValue(validator.variant.option2_value),
    option3Name: cleanValue(validator.variant.option3_name),
    option3: cleanValue(validator.variant.option3_value),
  };
}

function buildSearchText(product: Record<string, unknown>, variant: Record<string, unknown>): string {
  return [
    product.vendor,
    product.vendor,
    product.title,
    variant.option1,
    variant.option2,
    variant.option3,
    product.productType,
  ]
    .map((value) => cleanValue(String(value ?? "")).toLowerCase())
    .filter(Boolean)
    .join(" ");
}

function normalizeDecision(
  decision: MatchDecision,
  topSimilarity: number,
  validator: VariantValidatorResult
): MatchDecision {
  if (decision === "NEW_PRODUCT" || decision === "NEW_VARIANT" || decision === "DUPLICATE") {
    return decision;
  }

  const onlySoftPriceIssue =
    validator.errors.length > 0 &&
    validator.errors.every((error) => error.toLowerCase().includes("price"));

  if (
    decision === "UNCERTAIN" &&
    topSimilarity < 0.82 &&
    !validator.rejected &&
    (validator.valid || onlySoftPriceIssue)
  ) {
    return "NEW_PRODUCT";
  }

  return decision;
}

function normalizeConfidence(value: number): number {
  if (value <= 1) {
    return Math.round(value * 100);
  }
  return Math.round(value);
}

function stripVariantTokens(value: string, optionValues: Array<unknown> = []): string {
  let next = value;
  for (const token of optionValues.map((entry) => cleanValue(String(entry ?? ""))).filter(Boolean)) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next.replace(new RegExp(`\\b${escaped}\\b`, "gi"), " ");
  }

  return cleanValue(
    next
      .replace(/\b\d+(\.\d+)?\s?(g|kg|oz|lb|ml|l|pack|pcs|pc|dozen)\b/gi, "")
      .replace(/\b\d+-pack\b/gi, "")
      .replace(/\s+/g, " ")
  );
}

function buildGuideSlices(guide: Record<string, unknown>, keys: string[]): string {
  return keys
    .map((key) => [key, guide[key as keyof typeof guide]])
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `## ${key}\n${JSON.stringify(value, null, 2)}`)
    .join("\n\n");
}

function cleanValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
