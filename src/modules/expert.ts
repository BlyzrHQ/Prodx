import { createBaseResult } from "./shared.js";
import { applyCatalogGuideCompatibility } from "../lib/catalog-guide.js";
import { buildCatalogGuidePromptPayload, buildSystemPrompt, getCatalogGuidePromptSpec } from "../lib/prompt-specs.js";
import { buildStarterPolicy, initialLearningMarkdown, renderPolicyMarkdown } from "../lib/policy-template.js";
import { getCatalogPaths } from "../lib/paths.js";
import { exists, readText, writeJson, writeText } from "../lib/fs.js";
import { resolveProvider } from "../lib/providers.js";
import { createOpenAIJsonResponse } from "../connectors/openai.js";
import { createGeminiJsonResponse } from "../connectors/gemini.js";
import { createAnthropicJsonResponse } from "../connectors/anthropic.js";
import { searchSerperWeb } from "../connectors/serper.js";
import { fetchShopifyPolicyContext } from "../connectors/shopify.js";
import type { LooseRecord, PolicyDocument, ProductMetafieldValue, ResolvedProvider } from "../types.js";

function providerReady(resolved: ResolvedProvider | null): resolved is ResolvedProvider {
  return Boolean(resolved?.provider && resolved?.credential?.value);
}

function strictObject(properties: Record<string, unknown>, required: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required
  };
}

function stringArraySchema() {
  return { type: "array", items: { type: "string" } };
}

function taxonomyTreeSchema() {
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        label: { type: "string" },
        department: { type: "string" },
        category: { type: "string" },
        subcategory: { type: "string" },
        device_type: { type: "string" },
        categories: stringArraySchema(),
        children: stringArraySchema(),
        notes: { type: "string" }
      },
      required: ["label", "department", "category", "subcategory", "device_type", "categories", "children", "notes"]
    }
  };
}

function metafieldDefinitionSchema() {
  return strictObject(
    {
      namespace: { type: "string" },
      key: { type: "string" },
      type: { type: "string" },
      value: { type: "string" },
      description: { type: "string" },
      required: { type: "boolean" },
      source_field: { type: "string" },
      source: { type: "string" },
      validation_rules: stringArraySchema(),
      example_values: stringArraySchema(),
      usage: stringArraySchema(),
      automation_mode: { type: "string" },
      inferred: { type: "boolean" }
    },
    [
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
    ]
  );
}

function recommendedMetafieldSchema() {
  return strictObject(
    {
      namespace: { type: "string" },
      key: { type: "string" },
      type: { type: "string" },
      purpose: { type: "string" },
      example_values: stringArraySchema()
    },
    ["namespace", "key", "type", "purpose", "example_values"]
  );
}

function buildPolicySchema() {
  return {
    name: "catalog_guide",
    schema: strictObject(
      {
        industry_business_context: strictObject(
          {
            summary: { type: "string" },
            audience: { type: "string" },
            notes: { type: "string" },
            operating_mode: { type: "string" }
          },
          ["summary", "audience", "notes", "operating_mode"]
        ),
        eligibility_rules: strictObject(
          {
            accept: stringArraySchema(),
            reject: stringArraySchema()
          },
          ["accept", "reject"]
        ),
        taxonomy_design: strictObject(
          {
            hierarchy: stringArraySchema(),
            category_tree: taxonomyTreeSchema(),
            collection_logic: stringArraySchema(),
            tagging_system: stringArraySchema(),
            product_type_rules: stringArraySchema(),
            handle_structure_rules: stringArraySchema()
          },
          ["hierarchy", "category_tree", "collection_logic", "tagging_system", "product_type_rules", "handle_structure_rules"]
        ),
        product_title_system: strictObject(
          {
            formula: { type: "string" },
            examples: stringArraySchema(),
            disallowed_patterns: stringArraySchema(),
            seo_rules: stringArraySchema(),
            edge_case_rules: stringArraySchema()
          },
          ["formula", "examples", "disallowed_patterns", "seo_rules", "edge_case_rules"]
        ),
        product_description_system: strictObject(
          {
            structure_template: stringArraySchema(),
            tone_rules: stringArraySchema(),
            length_rules: stringArraySchema(),
            formatting_rules: stringArraySchema(),
            auto_generatable: stringArraySchema(),
            manual_required: stringArraySchema(),
            guidance: stringArraySchema()
          },
          ["structure_template", "tone_rules", "length_rules", "formatting_rules", "auto_generatable", "manual_required", "guidance"]
        ),
        variant_architecture: strictObject(
          {
            allowed_dimensions: stringArraySchema(),
            split_vs_variant_rules: stringArraySchema(),
            max_variant_logic: stringArraySchema(),
            naming_conventions: stringArraySchema(),
            duplicate_rules: stringArraySchema()
          },
          ["allowed_dimensions", "split_vs_variant_rules", "max_variant_logic", "naming_conventions", "duplicate_rules"]
        ),
        attributes_metafields_schema: strictObject(
          {
            required_fields: stringArraySchema(),
            optional_fields: stringArraySchema(),
            standard_shopify_fields: stringArraySchema(),
            metafields: { type: "array", items: metafieldDefinitionSchema() },
            fill_rules: stringArraySchema(),
            guidance: { type: "string" }
          },
          ["required_fields", "optional_fields", "standard_shopify_fields", "metafields", "fill_rules", "guidance"]
        ),
        image_media_standards: strictObject(
          {
            image_types: stringArraySchema(),
            background_rules: stringArraySchema(),
            aspect_ratios: stringArraySchema(),
            naming_conventions: stringArraySchema(),
            alt_text_rules: stringArraySchema(),
            automation_tagging_rules: stringArraySchema(),
            avoid: stringArraySchema()
          },
          ["image_types", "background_rules", "aspect_ratios", "naming_conventions", "alt_text_rules", "automation_tagging_rules", "avoid"]
        ),
        merchandising_rules: strictObject(
          {
            collection_sorting_logic: stringArraySchema(),
            cross_sell_rules: stringArraySchema(),
            upsell_rules: stringArraySchema(),
            product_grouping_logic: stringArraySchema(),
            seasonal_overrides: stringArraySchema(),
            featured_product_logic: stringArraySchema()
          },
          ["collection_sorting_logic", "cross_sell_rules", "upsell_rules", "product_grouping_logic", "seasonal_overrides", "featured_product_logic"]
        ),
        seo_discovery_rules: strictObject(
          {
            meta_title_format: stringArraySchema(),
            meta_description_rules: stringArraySchema(),
            url_handle_rules: stringArraySchema(),
            internal_linking_logic: stringArraySchema(),
            keyword_usage_patterns: stringArraySchema()
          },
          ["meta_title_format", "meta_description_rules", "url_handle_rules", "internal_linking_logic", "keyword_usage_patterns"]
        ),
        automation_playbook: strictObject(
          {
            fully_automated: stringArraySchema(),
            validation_checkpoints: stringArraySchema(),
            human_approval_required: stringArraySchema(),
            transformation_logic: stringArraySchema(),
            fallback_rules: stringArraySchema(),
            error_handling_rules: stringArraySchema()
          },
          ["fully_automated", "validation_checkpoints", "human_approval_required", "transformation_logic", "fallback_rules", "error_handling_rules"]
        ),
        qa_validation_system: strictObject(
          {
            title_validation: stringArraySchema(),
            variant_validation: stringArraySchema(),
            metafield_completeness: stringArraySchema(),
            image_checks: stringArraySchema(),
            seo_checks: stringArraySchema(),
            pass_fail_conditions: stringArraySchema(),
            auto_fix_rules: stringArraySchema(),
            passing_score: { type: "number" }
          },
          ["title_validation", "variant_validation", "metafield_completeness", "image_checks", "seo_checks", "pass_fail_conditions", "auto_fix_rules", "passing_score"]
        ),
        agentic_commerce_readiness: strictObject(
          {
            principles: stringArraySchema(),
            required_signals: stringArraySchema(),
            description_requirements: stringArraySchema(),
            faq_requirements: stringArraySchema(),
            catalog_mapping_recommendations: stringArraySchema(),
            recommended_metafields: { type: "array", items: recommendedMetafieldSchema() },
            scoring_model: stringArraySchema()
          },
          ["principles", "required_signals", "description_requirements", "faq_requirements", "catalog_mapping_recommendations", "recommended_metafields", "scoring_model"]
        )
      },
      [
        "industry_business_context",
        "eligibility_rules",
        "taxonomy_design",
        "product_title_system",
        "product_description_system",
        "variant_architecture",
        "attributes_metafields_schema",
        "image_media_standards",
        "merchandising_rules",
        "seo_discovery_rules",
        "automation_playbook",
        "qa_validation_system",
        "agentic_commerce_readiness"
      ]
    )
  };
}

function normalizeGeneratedPolicy(base: PolicyDocument, generated: LooseRecord, input: LooseRecord, generationMethod: string): PolicyDocument {
  const combined: PolicyDocument = {
    ...base,
    ...generated,
    attributes_metafields_schema: {
      ...base.attributes_metafields_schema,
      ...((generated.attributes_metafields_schema as LooseRecord | undefined) ?? {}),
      metafields: Array.isArray((generated.attributes_metafields_schema as LooseRecord | undefined)?.metafields)
        ? ((generated.attributes_metafields_schema as LooseRecord).metafields as ProductMetafieldValue[])
        : base.attributes_metafields_schema?.metafields ?? []
    },
    meta: {
      ...(base.meta ?? {}),
      business_name: String(input.businessName ?? base.meta?.business_name ?? "Demo Store"),
      business_description: String(input.businessDescription ?? base.meta?.business_description ?? ""),
      industry: String(input.industry ?? base.meta?.industry ?? "generic"),
      target_market: String(input.targetMarket ?? base.meta?.target_market ?? ""),
      operating_mode: String(input.operatingMode ?? base.meta?.operating_mode ?? "local_files"),
      store_url: String(input.storeUrl ?? base.meta?.store_url ?? ""),
      generated_at: new Date().toISOString(),
      generation_method: generationMethod
    }
  };

  return applyCatalogGuideCompatibility(combined);
}

function normalizeShopifyMetafields(input: unknown): ProductMetafieldValue[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as LooseRecord;
    const namespace = typeof record.namespace === "string" ? record.namespace : "";
    const key = typeof record.key === "string" ? record.key : "";
    if (!namespace || !key) return [];
    return [{
      namespace,
      key,
      type: typeof record.type === "string" ? record.type : "single_line_text_field",
      value: typeof record.value === "string" ? record.value : "requires_review",
      description: typeof record.description === "string" ? record.description : "",
      required: Boolean(record.required),
      source_field: typeof record.source_field === "string" ? record.source_field : "shopify_context",
      source: typeof record.source === "string" ? record.source : "shopify",
      validation_rules: Array.isArray(record.validation_rules) ? record.validation_rules.map(String) : [],
      example_values: Array.isArray(record.example_values) ? record.example_values.map(String) : [],
      usage: Array.isArray(record.usage) ? record.usage.map(String) : ["internal logic"],
      automation_mode: typeof record.automation_mode === "string" ? record.automation_mode : "review_required",
      inferred: Boolean(record.inferred)
    }];
  });
}

function applyShopifyContextToStarterPolicy(starterPolicy: PolicyDocument, shopifyContext: LooseRecord | null): PolicyDocument {
  if (!shopifyContext) return starterPolicy;

  const sampleProducts = Array.isArray(shopifyContext.sample_products) ? shopifyContext.sample_products as LooseRecord[] : [];
  const sampleDefinitions = normalizeShopifyMetafields(shopifyContext.product_metafield_definitions);
  const productTypeValues = [...new Set(sampleProducts.map((item) => typeof item.product_type === "string" ? item.product_type : "").filter(Boolean))];
  const optionValues = [...new Set(sampleProducts.flatMap((item) => Array.isArray(item.options) ? item.options.map(String) : []))];
  const tagsSeen = [...new Set(sampleProducts.flatMap((item) => Array.isArray(item.tags) ? item.tags.map(String) : []))];

  const mergedMetafields = [...starterPolicy.attributes_metafields_schema?.metafields ?? []];
  const seenMetafields = new Set(mergedMetafields.map((field) => `${field.namespace}.${field.key}`));
  for (const definition of sampleDefinitions) {
    const identifier = `${definition.namespace}.${definition.key}`;
    if (seenMetafields.has(identifier)) continue;
    seenMetafields.add(identifier);
    mergedMetafields.push(definition);
  }

  const updated: PolicyDocument = {
    ...starterPolicy,
    taxonomy_design: {
      ...starterPolicy.taxonomy_design,
      product_type_rules: [
        ...(starterPolicy.taxonomy_design?.product_type_rules ?? []),
        ...(productTypeValues.length > 0 ? [`Observed Shopify product types: ${productTypeValues.join(", ")}`] : [])
      ]
    },
    attributes_metafields_schema: {
      ...starterPolicy.attributes_metafields_schema,
      standard_shopify_fields: [
        ...new Set([
          ...(starterPolicy.attributes_metafields_schema?.standard_shopify_fields ?? []),
          ...(optionValues.length > 0 ? optionValues.map((option) => `option:${option}`) : [])
        ])
      ],
      metafields: mergedMetafields,
      fill_rules: [
        ...(starterPolicy.attributes_metafields_schema?.fill_rules ?? []),
        ...(sampleDefinitions.length > 0 ? ["Shopify metafield definitions were pulled from the connected store and should be treated as the source of truth for type and requiredness."] : []),
        ...(tagsSeen.length > 0 ? [`Observed Shopify tags for reference: ${tagsSeen.slice(0, 20).join(", ")}`] : [])
      ]
    }
  };

  return applyCatalogGuideCompatibility(updated);
}

async function getShopifyContext(root: string): Promise<LooseRecord | null> {
  const shopifyProvider = await resolveProvider(root, "catalogue-match", "catalog_provider");
  if (!providerReady(shopifyProvider) || shopifyProvider.provider.type !== "shopify" || !shopifyProvider.provider.store) {
    return null;
  }

  try {
    return await fetchShopifyPolicyContext({
      store: shopifyProvider.provider.store,
      apiVersion: shopifyProvider.provider.api_version ?? "2025-04",
      accessToken: shopifyProvider.credential.value,
      first: 3
    }) as LooseRecord;
  } catch {
    return null;
  }
}

async function getResearchNotes(root: string, input: LooseRecord): Promise<Array<{ title: string; link: string; snippet?: string }>> {
  const researchProvider = await resolveProvider(root, "catalogue-expert", "research_provider");
  if (!providerReady(researchProvider) || researchProvider.provider.type !== "serper") {
    return [];
  }

  const query = `${String(input.industry ?? "ecommerce")} Shopify catalog guide best practices`;
  return searchSerperWeb({
    apiKey: researchProvider.credential.value,
    query,
    num: 3
  });
}

async function generateWithProvider(
  provider: ResolvedProvider,
  input: LooseRecord,
  starterPolicy: PolicyDocument,
  shopifyContext: LooseRecord | null,
  researchNotes: Array<{ title: string; link: string; snippet?: string }>,
  learningText: string
): Promise<PolicyDocument> {
  const spec = getCatalogGuidePromptSpec();
  const systemPrompt = buildSystemPrompt(spec);
  const requestBody = buildCatalogGuidePromptPayload(
    starterPolicy,
    {
      business_name: input.businessName ?? "Demo Store",
      business_description: input.businessDescription ?? "",
      industry: input.industry ?? "generic",
      target_market: input.targetMarket ?? "",
      operating_mode: input.operatingMode ?? "both",
      store_url: input.storeUrl ?? "",
      notes: input.notes ?? ""
    },
    shopifyContext,
    researchNotes,
    learningText
  );
  const schema = buildPolicySchema();
  let generated: LooseRecord;

  if (provider.provider.type === "openai") {
    const response = await createOpenAIJsonResponse<LooseRecord>({
      apiKey: provider.credential.value,
      model: provider.provider.model ?? "gpt-5",
      instructions: systemPrompt,
      input: requestBody,
      schema,
      maxOutputTokens: 5200,
      reasoningEffort: "low"
    });
    generated = response.json;
  } else if (provider.provider.type === "gemini") {
    const response = await createGeminiJsonResponse<LooseRecord>({
      apiKey: provider.credential.source === "oauth" ? undefined : provider.credential.value,
      accessToken: provider.credential.source === "oauth" ? provider.credential.value : undefined,
      googleProjectId: provider.credential.source === "oauth" ? String(provider.credential.metadata?.project_id ?? "") : undefined,
      model: provider.provider.model ?? "gemini-2.5-flash",
      systemInstruction: systemPrompt,
      textPrompt: requestBody,
      schema
    });
    generated = response.json;
  } else if (provider.provider.type === "anthropic") {
    const response = await createAnthropicJsonResponse<LooseRecord>({
      apiKey: provider.credential.value,
      model: provider.provider.model ?? "claude-sonnet-4-20250514",
      systemInstruction: systemPrompt,
      textPrompt: `${requestBody}\n\nReturn valid JSON matching this schema exactly: ${JSON.stringify((schema as { schema: unknown }).schema)}`,
      maxTokens: 5200
    });
    generated = response.json;
  } else {
    throw new Error(`Unsupported guide provider type: ${provider.provider.type}`);
  }

  return normalizeGeneratedPolicy(
    starterPolicy,
    generated,
    input,
    shopifyContext ? `${provider.provider.type}-with-shopify-context` : provider.provider.type
  );
}

export async function runExpertGenerate({ root, jobId, input }: { root: string; jobId: string; input: LooseRecord }) {
  const paths = getCatalogPaths(root);
  const llmProvider = await resolveProvider(root, "catalogue-expert", "llm_provider");
  const reasoning: string[] = [];
  const warnings: string[] = [];
  const shopifyContext = await getShopifyContext(root);
  const starterPolicy = applyShopifyContextToStarterPolicy(buildStarterPolicy(input), shopifyContext);
  const shouldResearch = Boolean(input.research);
  let researchNotes: Array<{ title: string; link: string; snippet?: string }> = [];
  const existingLearningText = await readText(paths.learningMarkdown, "");

  if (shopifyContext) {
    reasoning.push("Fetched Shopify sample structure and metafield definitions to adapt the Catalog Guide.");
  }

  if (shouldResearch) {
    try {
      researchNotes = await getResearchNotes(root, input);
      if (researchNotes.length > 0) {
        reasoning.push(`Collected ${researchNotes.length} optional research note(s) for guide generation.`);
      }
    } catch (error) {
      warnings.push(`Optional research failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!providerReady(llmProvider) || !["openai", "gemini", "anthropic"].includes(llmProvider.provider.type)) {
    return createBaseResult({
      jobId,
      module: "catalogue-expert",
      status: "failed",
      needsReview: true,
      warnings,
      errors: ["No ready LLM provider was configured for catalogue-expert."],
      reasoning: [
        ...reasoning,
        "Guide generation was stopped because fallback guide creation is disabled."
      ],
      nextActions: [
        "Configure a supported LLM provider for catalogue-expert.",
        "Retry `guide generate` after provider configuration is fixed."
      ]
    });
  }

  let policy: PolicyDocument;
  try {
    policy = await generateWithProvider(llmProvider, input, starterPolicy, shopifyContext, researchNotes, existingLearningText);
    reasoning.push(`Generated the Catalog Guide with ${llmProvider.providerAlias}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createBaseResult({
      jobId,
      module: "catalogue-expert",
      status: "failed",
      needsReview: true,
      warnings,
      errors: [`Catalog Guide generation failed: ${message}`],
      reasoning: [
        ...reasoning,
        "Guide generation was stopped because fallback guide creation is disabled."
      ],
      artifacts: {
        provider_used: llmProvider.providerAlias,
        shopify_context_used: Boolean(shopifyContext),
        research_used: shouldResearch && researchNotes.length > 0
      },
      nextActions: [
        "Fix the provider/schema error and rerun `guide generate`.",
        "Do not continue with workflow runs that depend on a new guide until this succeeds."
      ]
    });
  }

  await writeJson(paths.policyJson, policy);
  await writeText(paths.policyMarkdown, renderPolicyMarkdown(policy));
  if (!(await exists(paths.learningMarkdown))) {
    await writeText(paths.learningMarkdown, initialLearningMarkdown(policy));
  } else {
    const currentLearning = await readText(paths.learningMarkdown, "");
    if (!currentLearning.trim() || /No lessons recorded yet\./i.test(currentLearning)) {
      await writeText(paths.learningMarkdown, initialLearningMarkdown(policy));
    }
  }

  return createBaseResult({
    jobId,
    module: "catalogue-expert",
    status: "success",
    needsReview: false,
    proposedChanges: {
      policy_files: [
        ".catalog/policy/catalog-policy.md",
        ".catalog/policy/catalog-policy.json",
        ".catalog/learning/catalog-learning.md"
      ]
    },
    warnings,
    reasoning: [
      ...reasoning,
      "Rendered the Markdown Catalog Guide directly from the JSON source of truth.",
      "Initialized the learning file for future review outcomes."
    ],
    artifacts: {
      provider_used: providerReady(llmProvider) ? llmProvider.providerAlias : null,
      shopify_context_used: Boolean(shopifyContext),
      research_used: shouldResearch && researchNotes.length > 0
    },
    nextActions: [
      "Review the generated Catalog Guide files before running enrichment and QA workflows.",
      "Use `catalog guide show` to inspect the current guide summary."
    ]
  });
}
