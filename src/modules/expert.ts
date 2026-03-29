import { createBaseResult } from "./shared.js";
import { buildStarterPolicy, initialLearningMarkdown, renderPolicyMarkdown } from "../lib/policy-template.js";
import { getCatalogPaths } from "../lib/paths.js";
import { writeJson, writeText } from "../lib/fs.js";
import { resolveProvider } from "../lib/providers.js";
import { createOpenAIJsonResponse } from "../connectors/openai.js";
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

function metafieldDefinitionSchema() {
  return strictObject(
    {
      namespace: { type: "string" },
      key: { type: "string" },
      type: { type: "string" },
      value: { type: "string" },
      description: { type: "string" },
      required: { type: "boolean" },
      source_field: { type: "string" }
    },
    ["namespace", "key", "type", "value", "description", "required", "source_field"]
  );
}

function buildPolicySchema() {
  return {
    name: "catalog_policy",
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
        product_title_structure: strictObject(
          {
            pattern: { type: "string" },
            examples: stringArraySchema()
          },
          ["pattern", "examples"]
        ),
        description_structure: strictObject(
          {
            tone: { type: "string" },
            word_count: { type: "string" },
            guidance: { type: "string" },
            required_sections: stringArraySchema()
          },
          ["tone", "word_count", "guidance", "required_sections"]
        ),
        categorization_taxonomy: strictObject(
          {
            type: { type: "string" },
            tree: stringArraySchema(),
            guidance: { type: "string" }
          },
          ["type", "tree", "guidance"]
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
        product_listing_checklist: strictObject(
          {
            required: stringArraySchema(),
            optional: stringArraySchema()
          },
          ["required", "optional"]
        ),
        qa_scoring_criteria: strictObject(
          {
            passing_score: { type: "number" },
            success_definition: { type: "string" },
            weights: strictObject(
              {
                title: { type: "number" },
                description: { type: "number" },
                classification: { type: "number" },
                images: { type: "number" },
                required_fields: { type: "number" },
                attributes: { type: "number" },
                additional_information: { type: "number" }
              },
              ["title", "description", "classification", "images", "required_fields", "attributes", "additional_information"]
            )
          },
          ["passing_score", "success_definition", "weights"]
        ),
        image_requirements: strictObject(
          {
            primary_image: { type: "string" },
            background: { type: "string" },
            preferred_styles: stringArraySchema(),
            avoid: stringArraySchema()
          },
          ["primary_image", "background", "preferred_styles", "avoid"]
        ),
        seo_handle_rules: strictObject(
          {
            handle_format: { type: "string" },
            seo_description_pattern: { type: "string" },
            title_guidance: { type: "string" }
          },
          ["handle_format", "seo_description_pattern", "title_guidance"]
        ),
        variant_structure: strictObject(
          {
            primary_dimensions: stringArraySchema(),
            guidance: { type: "string" },
            duplicate_rules: stringArraySchema()
          },
          ["primary_dimensions", "guidance", "duplicate_rules"]
        ),
        pricing_discount_display_rules: strictObject(
          {
            compare_at_price: { type: "string" },
            pricing_copy: { type: "string" },
            bundles: { type: "string" },
            unit_pricing: { type: "string" }
          },
          ["compare_at_price", "pricing_copy", "bundles", "unit_pricing"]
        ),
        collections_merchandising_rules: strictObject(
          {
            status: { type: "string" },
            guidance: { type: "string" },
            default_collection_types: stringArraySchema()
          },
          ["status", "guidance", "default_collection_types"]
        )
      },
      [
        "industry_business_context",
        "eligibility_rules",
        "product_title_structure",
        "description_structure",
        "categorization_taxonomy",
        "attributes_metafields_schema",
        "product_listing_checklist",
        "qa_scoring_criteria",
        "image_requirements",
        "seo_handle_rules",
        "variant_structure",
        "pricing_discount_display_rules",
        "collections_merchandising_rules"
      ]
    )
  };
}

function normalizeGeneratedPolicy(base: PolicyDocument, generated: LooseRecord, input: LooseRecord, generationMethod: string): PolicyDocument {
  const taxonomy = generated.categorization_taxonomy as LooseRecord | undefined;
  const baseTaxonomy = (base.categorization_taxonomy as LooseRecord | undefined) ?? {};
  const baseQa = (base.qa_scoring_criteria as LooseRecord | undefined) ?? {};
  const generatedQa = (generated.qa_scoring_criteria as LooseRecord | undefined) ?? {};
  const computedWeights: LooseRecord = (generatedQa.weights as LooseRecord | undefined) ?? ((baseQa.weights as LooseRecord | undefined) ?? {});
  const baseAttributeSchema = (base.attributes_metafields_schema as LooseRecord | undefined) ?? {};
  const generatedAttributeSchema = (generated.attributes_metafields_schema as LooseRecord | undefined) ?? {};
  return {
    ...base,
    ...generated,
    categorization_taxonomy: {
      ...baseTaxonomy,
      ...(taxonomy ?? {}),
      tree: Array.isArray(taxonomy?.tree) ? taxonomy.tree : baseTaxonomy.tree
    },
    qa_scoring_criteria: {
      ...baseQa,
      ...generatedQa,
      weights: computedWeights
    },
    attributes_metafields_schema: {
      ...baseAttributeSchema,
      ...generatedAttributeSchema,
      metafields: Array.isArray(generatedAttributeSchema.metafields)
        ? generatedAttributeSchema.metafields
        : Array.isArray(baseAttributeSchema.metafields)
          ? baseAttributeSchema.metafields
          : []
    },
    meta: {
      ...(base.meta ?? {}),
      business_name: String(input.businessName ?? base.meta?.business_name ?? "Demo Store"),
      business_description: String(input.businessDescription ?? base.meta?.business_description ?? ""),
      industry: String(input.industry ?? base.meta?.industry ?? "generic"),
      target_market: String(input.targetMarket ?? base.meta?.target_market ?? "General ecommerce shoppers"),
      operating_mode: String(input.operatingMode ?? base.meta?.operating_mode ?? "local_files"),
      store_url: String(input.storeUrl ?? base.meta?.store_url ?? ""),
      generated_at: new Date().toISOString(),
      generation_method: generationMethod
    }
  };
}

function normalizeShopifyMetafields(input: unknown): ProductMetafieldValue[] {
  if (!Array.isArray(input)) return [];

  return input.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as LooseRecord;
    const namespace = typeof record.namespace === "string" ? record.namespace : "";
    const key = typeof record.key === "string" ? record.key : "";
    const type = typeof record.type === "string" ? record.type : "single_line_text_field";
    if (!namespace || !key) return [];

    return [{
      namespace,
      key,
      type,
      value: typeof record.value === "string" ? record.value : "",
      description: typeof record.description === "string" ? record.description : "",
      required: Boolean(record.required),
      source_field: typeof record.source_field === "string" ? record.source_field : ""
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

  return {
    ...starterPolicy,
    attributes_metafields_schema: {
      ...(starterPolicy.attributes_metafields_schema ?? {}),
      standard_shopify_fields: [
        ...new Set([
          ...((starterPolicy.attributes_metafields_schema?.standard_shopify_fields ?? []) as string[]),
          "title",
          "handle",
          "body_html",
          "vendor",
          "product_type",
          "tags",
          ...(optionValues.length > 0 ? optionValues.map((option) => `option:${option}`) : [])
        ])
      ],
      metafields: sampleDefinitions.length > 0
        ? sampleDefinitions
        : starterPolicy.attributes_metafields_schema?.metafields ?? [],
      fill_rules: [
        ...new Set([
          ...((starterPolicy.attributes_metafields_schema?.fill_rules ?? []) as string[]),
          ...(productTypeValues.length > 0 ? [`Observed Shopify product types: ${productTypeValues.join(", ")}`] : []),
          ...(tagsSeen.length > 0 ? [`Observed Shopify tags for reference: ${tagsSeen.slice(0, 20).join(", ")}`] : [])
        ])
      ]
    }
  };
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

  const query = `${String(input.industry ?? "ecommerce")} Shopify catalog policy best practices`;
  const results = await searchSerperWeb({
    apiKey: researchProvider.credential.value,
    query,
    num: 3
  });
  return results;
}

async function generateWithOpenAI(provider: ResolvedProvider, input: LooseRecord, starterPolicy: PolicyDocument, shopifyContext: LooseRecord | null, researchNotes: Array<{ title: string; link: string; snippet?: string }>): Promise<PolicyDocument> {
  const adaptationNotes = [
    "Adapt the policy deeply to the specific business, not just the broad industry.",
    "Replace generic grocery assumptions with halal, cultural, imported, and hard-to-find product considerations when appropriate.",
    "Use the connected Shopify sample context to infer taxonomy, title conventions, variant dimensions, and metafield opportunities.",
    "Document the Shopify product structure and custom metafields clearly in the Attributes & Metafields Schema section, including type, requiredness, and fill rules.",
    "Only include metafields that exist in the connected store or are explicitly justified by the business context.",
    "Examples, taxonomy, checklist details, and merchandising guidance should feel specific to this store."
  ].join(" ");
  const response = await createOpenAIJsonResponse<LooseRecord>({
    apiKey: provider.credential.value,
    model: provider.provider.model ?? "gpt-5",
    instructions: [
      "You are creating a Shopify catalog policy.",
      "Keep the exact policy structure you are asked to fill.",
      "Return JSON only.",
      "Use the store context and sample Shopify structure if provided.",
      "Do not invent sections outside the required structure.",
      adaptationNotes
    ].join(" "),
    input: JSON.stringify({
      requested_policy_template: starterPolicy,
      business_context: {
        business_name: input.businessName ?? "Demo Store",
        business_description: input.businessDescription ?? "",
        industry: input.industry ?? "generic",
        target_market: input.targetMarket ?? "General ecommerce shoppers",
        operating_mode: input.operatingMode ?? "both",
        store_url: input.storeUrl ?? "",
        notes: input.notes ?? ""
      },
      shopify_context: shopifyContext,
      optional_research_notes: researchNotes
    }, null, 2),
    schema: buildPolicySchema(),
    maxOutputTokens: 5000,
    reasoningEffort: "low"
  });

  return normalizeGeneratedPolicy(starterPolicy, response.json, input, shopifyContext ? "gpt-5-with-shopify-context" : "gpt-5");
}

export async function runExpertGenerate({ root, jobId, input }: { root: string; jobId: string; input: LooseRecord }) {
  const paths = getCatalogPaths(root);
  const llmProvider = await resolveProvider(root, "catalogue-expert", "llm_provider");
  const reasoning: string[] = [];
  const warnings: string[] = [];
  const shopifyContext = await getShopifyContext(root);
  const starterPolicy = applyShopifyContextToStarterPolicy(buildStarterPolicy(input), shopifyContext);
  let policy: PolicyDocument = starterPolicy;
  const shouldResearch = Boolean(input.research);
  let researchNotes: Array<{ title: string; link: string; snippet?: string }> = [];

  if (shopifyContext) {
    reasoning.push("Fetched sample Shopify product structure to adapt the policy to the connected store.");
  }

  if (shouldResearch) {
    try {
      researchNotes = await getResearchNotes(root, input);
      if (researchNotes.length > 0) {
        reasoning.push(`Collected ${researchNotes.length} optional research note(s) for policy generation.`);
      }
    } catch (error) {
      warnings.push(`Optional research failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (providerReady(llmProvider) && llmProvider.provider.type === "openai") {
    try {
      policy = await generateWithOpenAI(llmProvider, input, starterPolicy, shopifyContext, researchNotes);
      reasoning.push(`Generated the policy pack with ${llmProvider.providerAlias}.`);
    } catch (error) {
      warnings.push(`GPT-5 policy generation failed: ${error instanceof Error ? error.message : String(error)}`);
      reasoning.push("Fell back to the starter policy template because GPT-5 policy generation was unavailable.");
    }
  } else {
    reasoning.push("No ready OpenAI provider was configured for catalogue-expert; generated a starter template policy.");
  }

  await writeJson(paths.policyJson, policy);
  await writeText(paths.policyMarkdown, renderPolicyMarkdown(policy));
  await writeText(paths.learningMarkdown, initialLearningMarkdown(policy));

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
      "Initialized the learning file for future review outcomes."
    ],
    artifacts: {
      provider_used: providerReady(llmProvider) ? llmProvider.providerAlias : null,
      shopify_context_used: Boolean(shopifyContext),
      research_used: shouldResearch && researchNotes.length > 0
    },
    nextActions: [
      "Review the generated policy files before running enrichment and QA workflows.",
      "Use `catalog expert generate --research true` only when you explicitly want web research folded into the policy."
    ]
  });
}
