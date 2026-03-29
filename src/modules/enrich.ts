import { createBaseResult } from "./shared.js";
import { resolveProvider } from "../lib/providers.js";
import { createOpenAIJsonResponse } from "../connectors/openai.js";
import { createGeminiJsonResponse } from "../connectors/gemini.js";
import type { EnrichmentOutput, LooseRecord, PolicyDocument, ProductMetafieldValue, ProductRecord, ResolvedProvider } from "../types.js";

function buildTitle(product: ProductRecord, pattern: string) {
  const resolved = pattern
    .replace("[Brand]", product.brand ?? "")
    .replace("[Product]", product.title ?? "")
    .replace("[Size]", product.size ?? "")
    .replace("[Primary Variant]", product.primary_variant ?? product.color ?? "")
    .replace("[Secondary Variant]", product.secondary_variant ?? product.size ?? "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (resolved) return resolved;

  return [product.brand, product.title, product.size, product.type]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDescription(product: ProductRecord, policy: PolicyDocument) {
  const sections = policy.description_structure?.required_sections ?? [];
  return sections.map((section: string) => {
    if (/ingredients/i.test(section) && product.ingredients_text) return `${section}: ${product.ingredients_text}`;
    if (/storage|handling/i.test(section) && product.storage_instructions) return `${section}: ${product.storage_instructions}`;
    if (/allergen/i.test(section) && typeof product.allergen_note === "string" && product.allergen_note.trim()) return `${section}: ${product.allergen_note}`;
    return `${section}: ${product.title} by ${product.brand ?? "the store brand"}.`;
  }).join("\n\n");
}

function buildFallbackResult(input: ProductRecord, policy: PolicyDocument) {
  const proposedTitle = buildTitle(input, policy.product_title_structure.pattern);
  const proposedDescription = buildDescription(input, policy);
  const proposedChanges: LooseRecord = {};
  const warnings: string[] = [];

  if (proposedTitle && proposedTitle !== input.title) proposedChanges.title = proposedTitle;
  if (!input.description || input.description.length < 60) {
    proposedChanges.description = proposedDescription;
    proposedChanges.description_html = proposedDescription;
  }
  if (!input.handle) proposedChanges.handle = proposedTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!input.product_type) proposedChanges.product_type = policy.meta.industry === "grocery" ? "Grocery" : "General";
  if (!input.brand) warnings.push("Brand is missing; review before final approval.");

  return {
    proposedChanges,
    warnings,
    reasoning: [
      "Applied local title and description structure from the catalog policy.",
      "Fell back to deterministic enrichment because no live LLM provider was available."
    ]
  };
}

function metafieldSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["namespace", "key", "type", "value", "description", "required", "source_field"],
    properties: {
      namespace: { type: "string" },
      key: { type: "string" },
      type: { type: "string" },
      value: { type: "string" },
      description: { type: "string" },
      required: { type: "boolean" },
      source_field: { type: "string" }
    }
  };
}

function buildEnrichmentSchema() {
  return {
    name: "catalog_enrichment",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "description", "handle", "product_type", "tags", "warnings", "summary", "metafields"],
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        handle: { type: "string" },
        product_type: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        metafields: { type: "array", items: metafieldSchema() },
        warnings: { type: "array", items: { type: "string" } },
        summary: { type: "string" }
      }
    }
  };
}

function getPolicyMetafields(policy: PolicyDocument): ProductMetafieldValue[] {
  return Array.isArray(policy.attributes_metafields_schema?.metafields)
    ? policy.attributes_metafields_schema.metafields
    : [];
}

function getAllowedShopifyFields(policy: PolicyDocument): string[] {
  return Array.isArray(policy.attributes_metafields_schema?.standard_shopify_fields)
    ? policy.attributes_metafields_schema.standard_shopify_fields
    : [];
}

function normalizeGeneratedMetafields(input: unknown, policy: PolicyDocument): ProductMetafieldValue[] {
  const allowed = new Set(getPolicyMetafields(policy).map((field) => `${field.namespace}.${field.key}`));
  if (!Array.isArray(input)) return [];

  return input.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as LooseRecord;
    const namespace = typeof record.namespace === "string" ? record.namespace : "";
    const key = typeof record.key === "string" ? record.key : "";
    const type = typeof record.type === "string" ? record.type : "single_line_text_field";
    const value = typeof record.value === "string" ? record.value : "";
    const identifier = `${namespace}.${key}`;
    if (!namespace || !key || !value || (allowed.size > 0 && !allowed.has(identifier))) return [];

    return [{
      namespace,
      key,
      type,
      value,
      description: typeof record.description === "string" ? record.description : "",
      required: Boolean(record.required),
      source_field: typeof record.source_field === "string" ? record.source_field : ""
    }];
  });
}

function hasPlaceholderText(value: string): boolean {
  return /\[[^\]]+\]/.test(value) || /product name or primary keyword/i.test(value);
}

function looksGenericSectionedDescription(value: string, input: ProductRecord): boolean {
  const normalized = value.toLowerCase();
  const repeatedSnippet = `${String(input.title ?? "").toLowerCase()} by ${String(input.brand ?? "").toLowerCase()}`.trim();
  const repeatedCount = repeatedSnippet ? normalized.split(repeatedSnippet).length - 1 : 0;
  return repeatedCount >= 3;
}

function validateGeneratedOutput(generated: EnrichmentOutput, input: ProductRecord): void {
  if (!generated.title || hasPlaceholderText(generated.title)) {
    throw new Error("Generated title still contains placeholders or is empty.");
  }

  if (!generated.description || generated.description.trim().length < 80) {
    throw new Error("Generated description was too short to trust.");
  }

  if (hasPlaceholderText(generated.description) || looksGenericSectionedDescription(generated.description, input)) {
    throw new Error("Generated description looked generic or placeholder-like.");
  }
}

async function generateWithProvider(provider: ResolvedProvider, input: ProductRecord, policy: PolicyDocument): Promise<EnrichmentOutput> {
  const schema = buildEnrichmentSchema();
  const policyMetafields = getPolicyMetafields(policy).map((field) => ({
    namespace: field.namespace,
    key: field.key,
    type: field.type,
    description: field.description ?? "",
    required: Boolean(field.required),
    source_field: field.source_field ?? ""
  }));
  const prompt = [
    "You are enriching a Shopify product listing.",
    "Follow the store policy strictly and return only safe proposed changes.",
    "Only populate metafields listed in the policy schema.",
    "Do not invent custom fields that are not present in the policy.",
    `Industry: ${policy.meta?.industry ?? "general"}`,
    `Business: ${policy.meta?.business_name ?? "Store"}`,
    `Title pattern: ${policy.product_title_structure?.pattern ?? ""}`,
    `Description guidance: ${policy.description_structure?.guidance ?? ""}`,
    `Required sections: ${(policy.description_structure?.required_sections ?? []).join(", ")}`,
    `Allowed Shopify fields: ${getAllowedShopifyFields(policy).join(", ")}`,
    `Policy metafields: ${JSON.stringify(policyMetafields)}`,
    `Product input: ${JSON.stringify(input)}`
  ].join("\n");

  if (provider.provider.type === "openai") {
    const response = await createOpenAIJsonResponse<EnrichmentOutput>({
      apiKey: provider.credential.value,
      model: provider.provider.model ?? "gpt-5-mini",
      instructions: "Return enriched product fields as JSON only.",
      input: prompt,
      schema,
      maxOutputTokens: 2200,
      reasoningEffort: "low"
    });
    return response.json;
  }

  if (provider.provider.type === "gemini") {
    const response = await createGeminiJsonResponse<EnrichmentOutput>({
      apiKey: provider.credential.value,
      model: provider.provider.model ?? "gemini-2.5-flash",
      systemInstruction: "Return enriched product fields as JSON only.",
      textPrompt: prompt,
      schema
    });
    return response.json;
  }

  throw new Error(`Unsupported enricher provider type: ${provider.provider.type}`);
}

function providerReady(resolved: ResolvedProvider | null): resolved is ResolvedProvider {
  return Boolean(resolved?.provider && resolved?.credential?.value);
}

export async function runEnrich({ root, jobId, input, policy }: { root: string; jobId: string; input: ProductRecord; policy: PolicyDocument }) {
  const primary = await resolveProvider(root, "product-enricher", "llm_provider");
  const fallback = await resolveProvider(root, "product-enricher", "fallback_llm_provider");
  const proposedChanges: LooseRecord = {};
  const warnings: string[] = [];
  const reasoning: string[] = [];
  let providerUsed: string | null = null;

  const fallbackResult = buildFallbackResult(input, policy);
  Object.assign(proposedChanges, fallbackResult.proposedChanges);
  warnings.push(...fallbackResult.warnings);

  const candidates = [primary, fallback].filter(providerReady);
  for (const candidate of candidates) {
    try {
      const generated = await generateWithProvider(candidate, input, policy);
      validateGeneratedOutput(generated, input);
      if (generated.title && generated.title !== input.title) proposedChanges.title = generated.title;
      if (generated.description) {
        proposedChanges.description = generated.description;
        proposedChanges.description_html = generated.description;
      }
      if (generated.handle && !input.handle) proposedChanges.handle = generated.handle;
      if (generated.product_type && !input.product_type) proposedChanges.product_type = generated.product_type;
      if (Array.isArray(generated.tags) && generated.tags.length > 0) proposedChanges.tags = generated.tags;
      const generatedMetafields = normalizeGeneratedMetafields((generated as unknown as LooseRecord).metafields, policy);
      if (generatedMetafields.length > 0) proposedChanges.metafields = generatedMetafields;
      warnings.push(...(generated.warnings ?? []));
      reasoning.push(generated.summary ?? `Generated enrichment through ${candidate.providerAlias}.`);
      providerUsed = candidate.providerAlias;
      break;
    } catch (error) {
      warnings.push(`Provider ${candidate.providerAlias} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!providerUsed) {
    reasoning.push(...fallbackResult.reasoning);
  } else {
    reasoning.unshift(`Used provider ${providerUsed} for enrichment suggestions.`);
  }

  if (!input.brand) warnings.push("Brand is missing; review before final approval.");

  return createBaseResult({
    jobId,
    module: "product-enricher",
    status: "success",
    needsReview: true,
    proposedChanges,
    warnings: [...new Set(warnings)],
    reasoning,
    artifacts: providerUsed ? { provider_used: providerUsed } : {},
    nextActions: ["Review title, description, tags, and warnings before apply."]
  });
}
