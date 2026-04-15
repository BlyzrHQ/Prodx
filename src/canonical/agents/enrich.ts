import { callLlm } from "../services/llm.js";

interface MetaobjectFieldPair {
  key: string;
  value: string;
}

interface SuggestedMetaobjectEntry {
  type: string;
  displayName: string;
  fields: MetaobjectFieldPair[];
}

export interface EnrichResult {
  title: string;
  handle: string;
  description: string;
  descriptionHtml: string;
  seoTitle: string;
  seoDescription: string;
  productType: string;
  vendor: string;
  price: string;
  compareAtPrice: string;
  tags: string[];
  metafields: Array<{ namespace: string; key: string; value: string; type: string }>;
  fieldsEnriched: string[];
  newStoreValues: {
    productTypes: string[];
    tags: string[];
    metaobjectEntries: SuggestedMetaobjectEntry[];
  };
  researchConfidence: "high" | "medium" | "not_found";
  fallbackReason?: string;
}

export async function runEnrichAgent(input: {
  product: Record<string, unknown>;
  guide: Record<string, unknown>;
  storeContext?: Record<string, unknown> | null;
  fieldsToImprove: string[];
  qaFeedback?: string[];
}): Promise<EnrichResult> {
  const { product, guide, storeContext, fieldsToImprove, qaFeedback = [] } = input;
  const focusFields = fieldsToImprove.length > 0 ? fieldsToImprove : defaultFieldSet();

  try {
    const result = await callLlm<EnrichResult>({
      systemPrompt: buildSystemPrompt(guide, storeContext, focusFields, qaFeedback),
      userPrompt:
        "Product to enrich:\n" +
        JSON.stringify(product, null, 2) +
        "\n\nReturn a full enriched product object. Keep verified existing values unless you can improve them safely.",
      schema: {
        name: "enrich_product",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            handle: { type: "string" },
            description: { type: "string" },
            descriptionHtml: { type: "string" },
            seoTitle: { type: "string" },
            seoDescription: { type: "string" },
            productType: { type: "string" },
            vendor: { type: "string" },
            price: { type: "string" },
            compareAtPrice: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            metafields: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  namespace: { type: "string" },
                  key: { type: "string" },
                  value: { type: "string" },
                  type: { type: "string" },
                },
                required: ["namespace", "key", "value", "type"],
              },
            },
            fieldsEnriched: { type: "array", items: { type: "string" } },
            newStoreValues: {
              type: "object",
              additionalProperties: false,
              properties: {
                productTypes: { type: "array", items: { type: "string" } },
                tags: { type: "array", items: { type: "string" } },
                metaobjectEntries: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      type: { type: "string" },
                      displayName: { type: "string" },
                      fields: {
                        type: "array",
                        items: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            key: { type: "string" },
                            value: { type: "string" },
                          },
                          required: ["key", "value"],
                        },
                      },
                    },
                    required: ["type", "displayName", "fields"],
                  },
                },
              },
              required: ["productTypes", "tags", "metaobjectEntries"],
            },
            researchConfidence: {
              type: "string",
              enum: ["high", "medium", "not_found"],
            },
          },
          required: [
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
            "tags",
            "metafields",
            "fieldsEnriched",
            "newStoreValues",
            "researchConfidence",
          ],
        },
      },
      webSearch: true,
    });

    return sanitizeEnrichmentResult(result, product);
  } catch (error) {
    return {
      ...buildDeterministicFallback(product),
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildSystemPrompt(
  guide: Record<string, unknown>,
  storeContext: Record<string, unknown> | null | undefined,
  focusFields: string[],
  qaFeedback: string[]
): string {
  return `You are an expert Shopify catalog merchandiser with 10+ years of experience building high-converting product listings.

## YOUR MINDSET
Think like a senior merchandiser:
- Would a shopper understand exactly what this product is from the title alone?
- Does the description answer what it is, who it is for, and how it is used?
- Would a shopper find this product where I am classifying it?
- Am I 100% certain about every fact I am including, or am I guessing?

GOLDEN RULE: When uncertain about any fact, leave the field empty. Never guess. Empty is always better than wrong.

## YOUR TASK
Return a full enriched product object, not a tiny patch.
- Fill the full supported product field set whenever it can be safely verified.
- The fields currently needing the most attention are: ${focusFields.join(", ")}.
- QA feedback to address now: ${qaFeedback.join("; ") || "none"}.
- Preserve strong existing values unless you can improve them with higher-confidence information.
- Most products should leave this stage with all or most fields filled. Only leave a field empty if the information truly cannot be validated.

## HOW TO WORK
### Mode 1: IMPROVE
- The product already has some content.
- Improve weak or missing fields while preserving good existing values.

### Mode 2: BUILD
- The product has minimal content.
- Use available product facts and web research to build publication-ready fields from scratch.

## FIELD-SPECIFIC RULES
- title: follow the guide title system and keep the product title product-level, not variant-level.
- handle: lowercase, hyphenated, readable, stable, and derived from the finalized product title.
- description: must include a clean product overview as part of the body, not as an internal note.
- descriptionHtml: clean HTML rendering of the enriched description, not a different content strategy.
- vendor: use the real product brand/manufacturer when confidently known; prefer an existing store vendor if one matches.
- productType: choose the best matching existing store product type whenever possible.
- price / compareAtPrice: never invent. Preserve or normalize trusted product input values only.
- seoTitle / seoDescription: publication-ready, guide-compliant, and never placeholders.
- tags: use existing store tags when a good match exists.
- metafields: fill required and optional metafields whenever they can be validated safely.

## METAFIELD RULES
The guide defines metafields with automation modes:
- safe_if_taxonomy_match: auto-fill when the mapping is clear from product data
- review_required: only fill with high-confidence product data or verified research
- manual_only: do not fill automatically

For metaobject_reference fields:
- pick from existing store context entries whenever possible
- prefer existing Shopify GIDs when available
- if nothing fits, suggest a new entry in newStoreValues.metaobjectEntries

## WEB RESEARCH (ENABLED — USE IT)
Use web research when needed for product identity, brand validation, ingredients, allergens, nutrition, certifications, specs, or other higher-risk facts.

Preferred sources, in order:
1. Official brand/manufacturer sources
2. Major retailer product pages
3. Strong secondary retailer/catalog sources

Do not trust blogs, recipes, user reviews, AI-generated content, or random low-quality stores for factual product data.

## SAFETY RULES
- Never leak sources, citations, URLs, or internal notes into customer-facing copy.
- Never use placeholder text like unknown, requires_review, check pack, or to be confirmed.
- Never invent ingredients, allergens, nutrition, certifications, or origin claims.
- If a fact cannot be validated, leave the field empty rather than guessing.

## RELEVANT GUIDE SLICES
${buildGuideSlices(guide)}

## STORE CONTEXT
${JSON.stringify(
    {
      productTypes: storeContext?.productTypes ?? [],
      tags: storeContext?.tags ?? [],
      vendors: storeContext?.vendors ?? [],
      metafieldOptions: storeContext?.metafieldOptions ?? [],
      metaobjectOptions: storeContext?.metaobjectOptions ?? [],
    },
    null,
    2
  )}`;
}

function sanitizeEnrichmentResult(
  result: EnrichResult,
  product: Record<string, unknown>
): EnrichResult {
  const description = sanitizeCustomerCopy(result.description);
  const descriptionHtml = sanitizeCustomerCopy(result.descriptionHtml);
  const tags = [...new Set((result.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
  const fieldsEnriched = [...new Set((result.fieldsEnriched ?? []).filter(Boolean))];

  return {
    ...result,
    title: cleanValue(result.title || String(product.title ?? "")),
    handle: cleanValue(result.handle || slugify(result.title || String(product.title ?? ""))),
    description,
    descriptionHtml,
    seoTitle: cleanValue(result.seoTitle),
    seoDescription: sanitizeCustomerCopy(result.seoDescription),
    productType: cleanValue(result.productType || String(product.productType ?? "")),
    vendor: cleanValue(result.vendor || String(product.vendor ?? "")),
    price: cleanValue(result.price || String(product.price ?? "")),
    compareAtPrice: cleanValue(result.compareAtPrice || String(product.compareAtPrice ?? "")),
    tags,
    metafields: sanitizeMetafields(result.metafields),
    fieldsEnriched,
    newStoreValues: {
      productTypes: uniqueStrings(result.newStoreValues?.productTypes),
      tags: uniqueStrings(result.newStoreValues?.tags),
      metaobjectEntries: sanitizeMetaobjectEntries(result.newStoreValues?.metaobjectEntries),
    },
  };
}

function buildDeterministicFallback(product: Record<string, unknown>): EnrichResult {
  const title = cleanValue(String(product.title ?? ""));
  const vendor = cleanValue(String(product.vendor ?? product.brand ?? ""));
  const productType = cleanValue(String(product.productType ?? ""));
  const description = sanitizeCustomerCopy(String(product.description ?? ""));
  const descriptionHtml = sanitizeCustomerCopy(String(product.descriptionHtml ?? description));

  return {
    title,
    handle: cleanValue(String(product.handle ?? slugify(title))),
    description,
    descriptionHtml,
    seoTitle: cleanValue(String(product.seoTitle ?? title).slice(0, 70)),
    seoDescription: sanitizeCustomerCopy(
      String(product.seoDescription ?? description).slice(0, 160)
    ),
    productType,
    vendor,
    price: cleanValue(String(product.price ?? "")),
    compareAtPrice: cleanValue(String(product.compareAtPrice ?? "")),
    tags: Array.isArray(product.tags) ? uniqueStrings(product.tags) : [],
    metafields: Array.isArray(product.metafields) ? sanitizeMetafields(product.metafields as any[]) : [],
    fieldsEnriched: [],
    newStoreValues: {
      productTypes: [],
      tags: [],
      metaobjectEntries: [],
    },
    researchConfidence: "not_found",
  };
}

function sanitizeCustomerCopy(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\b(source|sources|citation|citations)\s*:\s*.*$/gim, "")
    .replace(/\[[^\]]+\]\([^)]+\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeMetafields(
  metafields: Array<{ namespace: string; key: string; value: string; type: string }>
): Array<{ namespace: string; key: string; value: string; type: string }> {
  return metafields
    .map((metafield) => ({
      namespace: cleanValue(String(metafield.namespace ?? "")),
      key: cleanValue(String(metafield.key ?? "")),
      value: cleanValue(String(metafield.value ?? "")),
      type: cleanValue(String(metafield.type ?? "")),
    }))
    .filter((metafield) => metafield.namespace && metafield.key && metafield.type && metafield.value);
}

function sanitizeMetaobjectEntries(
  entries: SuggestedMetaobjectEntry[] | undefined
): SuggestedMetaobjectEntry[] {
  return (entries ?? [])
    .map((entry) => ({
      type: cleanValue(String(entry.type ?? "")),
      displayName: cleanValue(String(entry.displayName ?? "")),
      fields: (entry.fields ?? [])
        .map((field) => ({
          key: cleanValue(String(field.key ?? "")),
          value: cleanValue(String(field.value ?? "")),
        }))
        .filter((field) => field.key && field.value),
    }))
    .filter((entry) => entry.type && entry.displayName);
}

function buildGuideSlices(guide: Record<string, unknown>): string {
  const sections = [
    "product_title_system",
    "product_description_system",
    "seo_discovery_rules",
    "taxonomy",
    "variant_architecture",
    "attributes_metafields_schema",
    "image_media_standards",
    "qa_validation_system",
  ];

  return sections
    .map((section) => [section, guide[section as keyof typeof guide]])
    .filter(([, value]) => value !== undefined)
    .map(([section, value]) => `## ${section}\n${JSON.stringify(value, null, 2)}`)
    .join("\n\n");
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => cleanValue(String(value))).filter(Boolean))];
}

function defaultFieldSet(): string[] {
  return [
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
    "tags",
    "metafields",
  ];
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
