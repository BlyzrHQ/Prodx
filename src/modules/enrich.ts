import { createBaseResult } from "./shared.js";
import { resolveProvider } from "../lib/providers.js";
import { createOpenAIJsonResponse, extractOpenAIWebSources } from "../connectors/openai.js";
import { createGeminiJsonResponse, extractGeminiGroundingSources } from "../connectors/gemini.js";
import { createAnthropicJsonResponse, extractAnthropicWebSources } from "../connectors/anthropic.js";
import { getGuideAllowedFields, getGuideDescriptionGuidance, getGuideDescriptionSections, getGuideMetafields, getGuideTitleFormula } from "../lib/catalog-guide.js";
import { buildEnrichmentPromptPayload, buildSystemPrompt, getEnrichmentPromptSpec } from "../lib/prompt-specs.js";
import { readText } from "../lib/fs.js";
import { getCatalogPaths } from "../lib/paths.js";
import { hasReviewPlaceholder, normalizeDescriptionPair } from "../lib/product.js";
import type { EnrichmentOutput, LooseRecord, PolicyDocument, ProductMetafieldValue, ProductRecord, ResolvedProvider } from "../types.js";

const HIGH_RISK_FACTUAL_TOKENS = [
  "ingredient",
  "nutrition",
  "nutritional",
  "spec",
  "specification",
  "material",
  "dimension",
  "compatib",
  "certif",
  "allergen"
];

const LOW_TRUST_VERIFICATION_DOMAINS = [
  "reddit.com",
  "wikipedia.org",
  "quora.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "pinterest.com"
];

const TRUSTED_RETAILER_HINTS = [
  "amazon",
  "instacart",
  "walmart",
  "carrefour",
  "tesco",
  "noon"
];

function buildTitle(product: ProductRecord, pattern: string) {
  const resolved = pattern
    .replace("Brand +", product.brand ?? product.vendor ?? "")
    .replace("Product +", product.title ?? "")
    .replace("[Brand]", product.brand ?? product.vendor ?? "")
    .replace("[Product]", product.title ?? "")
    .replace("[Size]", product.size ?? "")
    .replace("[Primary Variant]", product.primary_variant ?? product.color ?? "")
    .replace("[Secondary Variant]", product.secondary_variant ?? product.size ?? "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (resolved) return resolved;

  return [product.brand ?? product.vendor, product.title, product.size, product.type]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDescription(product: ProductRecord, policy: PolicyDocument) {
  const sections = getGuideDescriptionSections(policy);
  return sections.map((section: string) => {
    if (/ingredients/i.test(section) && product.ingredients_text) return `${section}\n${product.ingredients_text}`;
    if (/storage|handling/i.test(section) && product.storage_instructions) return `${section}\n${product.storage_instructions}`;
    if (/allergen/i.test(section) && typeof product.allergen_note === "string" && product.allergen_note.trim()) return `${section}\n${product.allergen_note}`;
    return "";
  }).filter(Boolean).join("\n\n");
}

function buildFallbackResult(input: ProductRecord, policy: PolicyDocument): EnrichmentOutput {
  const proposedTitle = buildTitle(input, getGuideTitleFormula(policy));
  const normalizedDescription = normalizeDescriptionPair(buildDescription(input, policy));

  return {
    title: proposedTitle || String(input.title ?? ""),
    description: normalizedDescription.description,
    description_html: normalizedDescription.description_html,
    handle: typeof input.handle === "string" && input.handle
      ? input.handle
      : "",
    vendor: typeof input.vendor === "string" && input.vendor.trim() ? input.vendor.trim() : null,
    brand: typeof input.brand === "string" && input.brand.trim() ? input.brand.trim() : null,
    product_type: typeof input.product_type === "string" && input.product_type
      ? input.product_type
      : "",
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    ingredients_text: typeof input.ingredients_text === "string" && input.ingredients_text.trim() ? input.ingredients_text.trim() : null,
    allergen_note: typeof input.allergen_note === "string" && input.allergen_note.trim() ? input.allergen_note.trim() : null,
    nutritional_facts: typeof input.nutritional_facts === "string" && input.nutritional_facts.trim() ? input.nutritional_facts.trim() : null,
    metafields: [],
    warnings: !input.brand && !input.vendor ? ["Brand or vendor is missing and was not inferred automatically."] : [],
    summary: "Used a minimal deterministic fallback because no live provider was available.",
    confidence: 0.45,
    skipped_reasons: !input.brand && !input.vendor ? ["vendor_missing_requires_review"] : []
  };
}

function nullableStringSchema() {
  return { type: ["string", "null"] };
}

function metafieldSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "namespace",
      "key",
      "type",
      "value",
      "description",
      "required",
      "source_field",
      "source",
      "validation_rules",
      "example_values",
      "usage",
      "automation_mode",
      "inferred"
    ],
    properties: {
      namespace: { type: "string" },
      key: { type: "string" },
      type: { type: "string" },
      value: { type: "string" },
      description: { type: "string" },
      required: { type: "boolean" },
      source_field: { type: "string" },
      source: { type: "string" },
      validation_rules: { type: "array", items: { type: "string" } },
      example_values: { type: "array", items: { type: "string" } },
      usage: { type: "array", items: { type: "string" } },
      automation_mode: { type: "string" },
      inferred: { type: "boolean" }
    }
  };
}

function buildEnrichmentSchema() {
  return {
    name: "catalog_enrichment",
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "description",
        "description_html",
        "handle",
        "vendor",
        "brand",
        "product_type",
        "tags",
        "ingredients_text",
        "allergen_note",
        "nutritional_facts",
        "metafields",
        "warnings",
        "summary",
        "confidence",
        "skipped_reasons"
      ],
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        description_html: { type: "string" },
        handle: { type: "string" },
        vendor: nullableStringSchema(),
        brand: nullableStringSchema(),
        product_type: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        ingredients_text: nullableStringSchema(),
        allergen_note: nullableStringSchema(),
        nutritional_facts: nullableStringSchema(),
        metafields: { type: "array", items: metafieldSchema() },
        warnings: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
        confidence: { type: "number" },
        skipped_reasons: { type: "array", items: { type: "string" } }
      }
    }
  };
}

function includesHighRiskToken(value: string): boolean {
  const normalized = value.toLowerCase();
  return HIGH_RISK_FACTUAL_TOKENS.some((token) => normalized.includes(token));
}

function getMissingHighRiskFactSignals(input: ProductRecord, policy: PolicyDocument): string[] {
  const signals = new Set<string>();
  const knownHighRiskFields = [
    "ingredients_text",
    "allergen_note",
    "nutritional_facts",
    "materials",
    "material",
    "dimensions",
    "compatibility",
    "certifications",
    "specifications"
  ];

  for (const key of knownHighRiskFields) {
    if (!(key in input)) continue;
    const value = input[key];
    const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    if (empty) signals.add(key);
  }

  for (const [key, value] of Object.entries(input)) {
    if (!includesHighRiskToken(key)) continue;
    const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    if (empty) signals.add(key);
  }

  for (const section of getGuideDescriptionSections(policy)) {
    if (includesHighRiskToken(section)) {
      if (/ingredient/i.test(section) && !input.ingredients_text) signals.add("ingredients_text");
      if (/allergen/i.test(section) && !input.allergen_note) signals.add("allergen_note");
      if (/spec|compatib|material|dimension/i.test(section)) signals.add(section);
    }
  }

  for (const metafield of getGuideMetafields(policy)) {
    const haystack = [metafield.key, metafield.description ?? "", metafield.source_field ?? ""].join(" ");
    if (!includesHighRiskToken(haystack)) continue;
    if (typeof metafield.type === "string" && metafield.type.includes("metaobject_reference")) continue;
    const existing = Array.isArray(input.metafields)
      ? input.metafields.find((item) => item.namespace === metafield.namespace && item.key === metafield.key && item.value && item.value.trim())
      : undefined;
    if (!existing) signals.add(`${metafield.namespace}.${metafield.key}`);
  }

  return [...signals];
}

export function shouldUseWebVerification(input: ProductRecord, policy: PolicyDocument): boolean {
  return getMissingHighRiskFactSignals(input, policy).length > 0;
}

function buildVerificationGuidance(input: ProductRecord, policy: PolicyDocument): string[] {
  const signals = getMissingHighRiskFactSignals(input, policy);
  if (signals.length === 0) {
    return [
      "No high-risk factual fields require web verification for this input.",
      "Do not browse or claim verification when it is unnecessary."
    ];
  }

  return [
    `High-risk fields that may need verification: ${signals.join(", ")}`,
    "Web verification is required for these unresolved high-risk factual fields before deciding whether they can be filled safely.",
    `Search official brand or manufacturer sources first. If unavailable, use trusted retailer or regulated reference sources only when they clearly match the exact product. Acceptable retailer examples include ${TRUSTED_RETAILER_HINTS.join(", ")}.`,
    "Use provider web search only for factual fields such as ingredients, nutrition, technical specs, materials, dimensions, compatibility, or certifications.",
    "Match the exact brand, pack size, flavor, fat level, and product form. Do not reuse evidence from a different pack, variant, or format.",
    "If an official source is close but not pack-specific, continue searching retailer sources for the exact pack instead of copying the near match.",
    "When Shopify metaobject reference IDs are unavailable, still fill the parallel verified text fields such as custom.ingredients_text, custom.allergen_note, or custom.nutritional_facts if exact-pack evidence is available.",
    "Treat a field as web_verified when supported by one official brand source or one exact-match trusted retailer source.",
    "If data conflicts or cannot be verified confidently, skip the field and keep it empty."
  ];
}

function isLowTrustVerificationSource(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return LOW_TRUST_VERIFICATION_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function filterUsableVerificationSources(
  sources: Array<{ title?: string; url?: string; snippet?: string }>
): Array<{ title?: string; url?: string; snippet?: string }> {
  return sources.filter((item) => typeof item.url === "string" && item.url.trim().length > 0 && !isLowTrustVerificationSource(item.url));
}

function normalizeGeneratedMetafields(input: unknown, policy: PolicyDocument): ProductMetafieldValue[] {
  const allowed = new Set(getGuideMetafields(policy).map((field) => `${field.namespace}.${field.key}`));
  if (!Array.isArray(input)) return [];

  return input.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as LooseRecord;
    const namespace = typeof record.namespace === "string" ? record.namespace : "";
    const key = typeof record.key === "string" ? record.key : "";
    const type = typeof record.type === "string" ? record.type : "single_line_text_field";
    const value = typeof record.value === "string" ? record.value.trim() : "";
    const identifier = `${namespace}.${key}`;
    if (!namespace || !key || !value || value === "requires_review" || value === "unknown_requires_review") return [];
    if (allowed.size > 0 && !allowed.has(identifier)) return [];

    return [{
      namespace,
      key,
      type,
      value,
      description: typeof record.description === "string" ? record.description : "",
      required: Boolean(record.required),
      source_field: typeof record.source_field === "string" ? record.source_field : "",
      source: typeof record.source === "string" ? record.source : "automation",
      validation_rules: Array.isArray(record.validation_rules) ? record.validation_rules.map(String) : [],
      example_values: Array.isArray(record.example_values) ? record.example_values.map(String) : [],
      usage: Array.isArray(record.usage) ? record.usage.map(String) : [],
      automation_mode: typeof record.automation_mode === "string" ? record.automation_mode : "review_required",
      inferred: Boolean(record.inferred)
    }];
  });
}

function buildGuideMetafieldLookup(policy: PolicyDocument): Map<string, ProductMetafieldValue> {
  return new Map(
    getGuideMetafields(policy).map((field) => [`${field.namespace}.${field.key}`, field])
  );
}

function upsertStructuredMetafieldChange(
  structuredChanges: LooseRecord,
  identifier: string,
  value: string,
  confidence: number,
  source: string,
  policy: PolicyDocument
): void {
  const guideField = buildGuideMetafieldLookup(policy).get(identifier);
  if (!guideField) return;

  const existing = structuredChanges.metafields && typeof structuredChanges.metafields === "object" && !Array.isArray(structuredChanges.metafields)
    ? structuredChanges.metafields as LooseRecord
    : {};

  existing[identifier] = makeFieldChange(value, confidence, source, {
    type: guideField.type,
    description: guideField.description ?? "",
    required: Boolean(guideField.required),
    source_field: guideField.source_field ?? "",
    validation_rules: guideField.validation_rules ?? [],
    example_values: guideField.example_values ?? [],
    usage: guideField.usage ?? [],
    automation_mode: guideField.automation_mode ?? "review_required",
    inferred: Boolean(guideField.inferred)
  });

  structuredChanges.metafields = existing;
}

function validateGeneratedOutput(generated: EnrichmentOutput): void {
  if (!generated.title.trim()) throw new Error("Generated title was empty.");
  if (generated.confidence < 0 || generated.confidence > 1) throw new Error("Generated confidence was outside 0..1.");
}

function sanitizeCustomerFacingDescription(generated: EnrichmentOutput): {
  description: string;
  description_html: string;
  placeholderDetected: boolean;
} {
  const normalized = normalizeDescriptionPair(generated.description_html || generated.description);
  const placeholderDetected = hasReviewPlaceholder(normalized.description) || hasReviewPlaceholder(normalized.description_html);
  if (placeholderDetected) {
    return {
      description: "",
      description_html: "",
      placeholderDetected: true
    };
  }

  return {
    description: normalized.description,
    description_html: normalized.description_html,
    placeholderDetected: false
  };
}

function makeFieldChange(value: unknown, confidence: number, source: string, extra: LooseRecord = {}): LooseRecord {
  return {
    value,
    confidence,
    source,
    ...extra
  };
}

async function generateWithProvider(
  provider: ResolvedProvider,
  input: ProductRecord,
  policy: PolicyDocument,
  learningText: string
): Promise<{ output: EnrichmentOutput; verificationUsed: boolean; verificationSources: Array<{ title?: string; url?: string; snippet?: string }> }> {
  const schema = buildEnrichmentSchema();
  const systemPrompt = buildSystemPrompt(getEnrichmentPromptSpec());
  const useWebVerification = shouldUseWebVerification(input, policy);
  const prompt = buildEnrichmentPromptPayload({
    product: input,
    guide: policy,
    allowedFields: getGuideAllowedFields(policy),
    storeContext: {
      business_name: policy.meta?.business_name ?? "Store",
      industry: policy.meta?.industry ?? "general",
      title_formula: getGuideTitleFormula(policy),
      description_guidance: getGuideDescriptionGuidance(policy),
      verification_guidance: buildVerificationGuidance(input, policy),
      web_search_enabled: useWebVerification
    },
    learningText
  });

  if (provider.provider.type === "openai") {
    const response = await createOpenAIJsonResponse<EnrichmentOutput>({
      apiKey: provider.credential.value,
      model: provider.provider.model ?? "gpt-5-mini",
      instructions: systemPrompt,
      input: prompt,
      schema,
      maxOutputTokens: 2600,
      reasoningEffort: "low",
      webSearch: useWebVerification ? {
        enabled: true,
        includeSources: true,
        externalWebAccess: true
      } : undefined
    });
    const verificationSources = useWebVerification ? filterUsableVerificationSources(extractOpenAIWebSources(response.raw)) : [];
    return {
      output: response.json,
      verificationUsed: useWebVerification,
      verificationSources
    };
  }

  if (provider.provider.type === "gemini") {
    const response = await createGeminiJsonResponse<EnrichmentOutput>({
      apiKey: provider.credential.source === "oauth" ? undefined : provider.credential.value,
      accessToken: provider.credential.source === "oauth" ? provider.credential.value : undefined,
      googleProjectId: provider.credential.source === "oauth" ? String(provider.credential.metadata?.project_id ?? "") : undefined,
      model: provider.provider.model ?? "gemini-2.5-flash",
      systemInstruction: systemPrompt,
      textPrompt: prompt,
      schema,
      googleSearch: useWebVerification
    });
    const verificationSources = useWebVerification ? filterUsableVerificationSources(extractGeminiGroundingSources(response.raw)) : [];
    return {
      output: response.json,
      verificationUsed: useWebVerification,
      verificationSources
    };
  }

  if (provider.provider.type === "anthropic") {
    const response = await createAnthropicJsonResponse<EnrichmentOutput>({
      apiKey: provider.credential.value,
      model: provider.provider.model ?? "claude-sonnet-4-20250514",
      systemInstruction: systemPrompt,
      textPrompt: `${prompt}\nReturn valid JSON matching this schema exactly: ${JSON.stringify((schema as { schema: unknown }).schema)}`,
      maxTokens: 2600,
      webSearch: useWebVerification ? {
        enabled: true,
        maxUses: 3
      } : undefined
    });
    const verificationSources = useWebVerification ? filterUsableVerificationSources(extractAnthropicWebSources(response.raw)) : [];
    return {
      output: response.json,
      verificationUsed: useWebVerification,
      verificationSources
    };
  }

  throw new Error(`Unsupported enricher provider type: ${provider.provider.type}`);
}

function providerReady(resolved: ResolvedProvider | null): resolved is ResolvedProvider {
  return Boolean(resolved?.provider && resolved?.credential?.value);
}

export async function runEnrich({ root, jobId, input, policy }: { root: string; jobId: string; input: ProductRecord; policy: PolicyDocument }) {
  const learningText = await readText(getCatalogPaths(root).learningMarkdown, "");
  const primary = await resolveProvider(root, "product-enricher", "llm_provider");
  const fallback = await resolveProvider(root, "product-enricher", "fallback_llm_provider");
  const structuredChanges: LooseRecord = {};
  const skippedFields: Array<{ field: string; reason: string }> = [];
  const warnings: string[] = [];
  const reasoning: string[] = [];
  let providerUsed: string | null = null;
  let verificationUsed = false;
  let verificationSources: Array<{ title?: string; url?: string; snippet?: string }> = [];

  const fallbackResult = buildFallbackResult(input, policy);
  const candidates = [primary, fallback].filter(providerReady);

  for (const candidate of candidates) {
    try {
      const generatedResult = await generateWithProvider(candidate, input, policy, learningText);
      const generated = generatedResult.output;
      validateGeneratedOutput(generated);
      if (generated.title && generated.title !== input.title) {
        structuredChanges.title = makeFieldChange(generated.title, generated.confidence, generatedResult.verificationUsed ? "web_verified" : "derived");
      }
      if (generated.description_html || generated.description) {
        const sanitized = sanitizeCustomerFacingDescription(generated);
        if (sanitized.placeholderDetected) {
          warnings.push("Generated description contained review-placeholder text and was not applied.");
          skippedFields.push({ field: "description_html", reason: "generated_description_contains_review_placeholder" });
        } else {
          structuredChanges.description = makeFieldChange(sanitized.description, generated.confidence, "derived");
          structuredChanges.description_html = makeFieldChange(sanitized.description_html, generated.confidence, "derived");
        }
      }
      if (generated.handle && !input.handle) {
        structuredChanges.handle = makeFieldChange(generated.handle, generated.confidence, "derived");
      }
      if (typeof generated.vendor === "string" && generated.vendor.trim() && !input.vendor) {
        structuredChanges.vendor = makeFieldChange(generated.vendor.trim(), generated.confidence, generatedResult.verificationUsed ? "web_verified" : "derived");
      }
      if (typeof generated.brand === "string" && generated.brand.trim() && !input.brand) {
        structuredChanges.brand = makeFieldChange(generated.brand.trim(), generated.confidence, generatedResult.verificationUsed ? "web_verified" : "derived");
      }
      if (generated.product_type && !input.product_type) {
        structuredChanges.product_type = makeFieldChange(generated.product_type, generated.confidence, generatedResult.verificationUsed ? "web_verified" : "derived");
      }
      if (Array.isArray(generated.tags) && generated.tags.length > 0) {
        structuredChanges.tags = makeFieldChange(generated.tags, generated.confidence, "derived");
      }
      if (typeof generated.ingredients_text === "string" && generated.ingredients_text.trim()) {
        structuredChanges.ingredients_text = makeFieldChange(generated.ingredients_text.trim(), generated.confidence, generatedResult.verificationUsed ? "web_verified" : "derived");
        upsertStructuredMetafieldChange(
          structuredChanges,
          "custom.ingredients_text",
          generated.ingredients_text.trim(),
          generated.confidence,
          generatedResult.verificationUsed ? "web_verified" : "derived",
          policy
        );
      }
      if (typeof generated.allergen_note === "string" && generated.allergen_note.trim()) {
        structuredChanges.allergen_note = makeFieldChange(generated.allergen_note.trim(), generated.confidence, generatedResult.verificationUsed ? "web_verified" : "derived");
        upsertStructuredMetafieldChange(
          structuredChanges,
          "custom.allergen_note",
          generated.allergen_note.trim(),
          generated.confidence,
          generatedResult.verificationUsed ? "web_verified" : "derived",
          policy
        );
      }
      if (typeof generated.nutritional_facts === "string" && generated.nutritional_facts.trim()) {
        structuredChanges.nutritional_facts = makeFieldChange(generated.nutritional_facts.trim(), generated.confidence, generatedResult.verificationUsed ? "web_verified" : "derived");
        upsertStructuredMetafieldChange(
          structuredChanges,
          "custom.nutritional_facts",
          generated.nutritional_facts.trim(),
          generated.confidence,
          generatedResult.verificationUsed ? "web_verified" : "derived",
          policy
        );
      }
      const generatedMetafields = normalizeGeneratedMetafields(generated.metafields, policy);
      if (generatedMetafields.length > 0) {
        const existing = structuredChanges.metafields && typeof structuredChanges.metafields === "object" && !Array.isArray(structuredChanges.metafields)
          ? structuredChanges.metafields as LooseRecord
          : {};
        structuredChanges.metafields = {
          ...existing,
          ...Object.fromEntries(
          generatedMetafields.map((field) => [
            `${field.namespace}.${field.key}`,
            makeFieldChange(field.value, generated.confidence, field.source ?? (generatedResult.verificationUsed ? "web_verified" : "derived"), {
              type: field.type,
              description: field.description ?? "",
              required: Boolean(field.required),
              source_field: field.source_field ?? "",
              validation_rules: field.validation_rules ?? [],
              example_values: field.example_values ?? [],
              usage: field.usage ?? [],
              automation_mode: field.automation_mode ?? "review_required",
              inferred: Boolean(field.inferred)
            })
          ])
          )
        };
      }
      warnings.push(...generated.warnings);
      if (generated.skipped_reasons.length > 0) {
        warnings.push(`Skipped: ${generated.skipped_reasons.join(", ")}`);
        skippedFields.push(...generated.skipped_reasons.map((reason) => ({ field: "requires_review", reason })));
      }
      reasoning.push(generated.summary || `Generated enrichment through ${candidate.providerAlias}.`);
      reasoning.push(`Provider confidence: ${generated.confidence.toFixed(2)}`);
      verificationUsed = generatedResult.verificationUsed;
      verificationSources = generatedResult.verificationSources;
      providerUsed = candidate.providerAlias;
      break;
    } catch (error) {
      warnings.push(`Provider ${candidate.providerAlias} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!providerUsed) {
    if (fallbackResult.title && fallbackResult.title !== input.title) {
      structuredChanges.title = makeFieldChange(fallbackResult.title, fallbackResult.confidence, "derived");
    }
    const normalized = normalizeDescriptionPair(fallbackResult.description_html || fallbackResult.description);
    if (normalized.description_html) {
      structuredChanges.description = makeFieldChange(normalized.description, fallbackResult.confidence, "derived");
      structuredChanges.description_html = makeFieldChange(normalized.description_html, fallbackResult.confidence, "derived");
    }
    if (fallbackResult.handle && !input.handle) {
      structuredChanges.handle = makeFieldChange(fallbackResult.handle, fallbackResult.confidence, "derived");
    }
    if (fallbackResult.product_type && !input.product_type) {
      structuredChanges.product_type = makeFieldChange(fallbackResult.product_type, fallbackResult.confidence, "derived");
    }
    if (!input.vendor && typeof fallbackResult.vendor === "string" && fallbackResult.vendor.trim()) {
      structuredChanges.vendor = makeFieldChange(fallbackResult.vendor.trim(), fallbackResult.confidence, "derived");
    }
    if (!input.brand && typeof fallbackResult.brand === "string" && fallbackResult.brand.trim()) {
      structuredChanges.brand = makeFieldChange(fallbackResult.brand.trim(), fallbackResult.confidence, "derived");
    }
    warnings.push(...fallbackResult.warnings);
    reasoning.push(fallbackResult.summary);
    if (fallbackResult.skipped_reasons.length > 0) {
      warnings.push(`Skipped: ${fallbackResult.skipped_reasons.join(", ")}`);
      skippedFields.push(...fallbackResult.skipped_reasons.map((reason) => ({ field: "requires_review", reason })));
    }
  } else {
    reasoning.unshift(`Used provider ${providerUsed} for enrichment suggestions.`);
    if (verificationUsed) {
      reasoning.push("Enabled provider web search for unresolved high-risk factual verification.");
      if (verificationSources.length > 0) {
        reasoning.push(`Collected ${verificationSources.length} verification source(s) for factual checks.`);
      }
    }
  }

  if (!input.brand && !input.vendor && !structuredChanges.brand && !structuredChanges.vendor) {
    warnings.push("Brand or vendor is still missing after enrichment.");
  }

  return createBaseResult({
    jobId,
    module: "product-enricher",
    status: "success",
    needsReview: false,
    proposedChanges: {
      changes: structuredChanges,
      skipped_fields: skippedFields
    },
    warnings: [...new Set(warnings)],
    reasoning,
    artifacts: providerUsed ? {
      provider_used: providerUsed,
      web_verification_enabled: verificationUsed,
      verification_targets: getMissingHighRiskFactSignals(input, policy),
      verification_sources: verificationSources
    } : {},
    nextActions: ["Proceed to image selection and QA validation."]
  });
}
