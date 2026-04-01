import type { LooseRecord, PolicyDocument, ProductMetafieldValue } from "../types.js";

function asStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.map((item) => String(item)).filter((item) => item.trim().length > 0);
}

function asObject(value: unknown): LooseRecord {
  return value && typeof value === "object" ? value as LooseRecord : {};
}

export function applyCatalogGuideCompatibility(policy: PolicyDocument): PolicyDocument {
  const taxonomy = asObject(policy.taxonomy_design);
  const title = asObject(policy.product_title_system);
  const description = asObject(policy.product_description_system);
  const variant = asObject(policy.variant_architecture);
  const image = asObject(policy.image_media_standards);
  const seo = asObject(policy.seo_discovery_rules);
  const merchandising = asObject(policy.merchandising_rules);
  const automation = asObject(policy.automation_playbook);
  const qa = asObject(policy.qa_validation_system);
  const existingAttributeSchema = asObject(policy.attributes_metafields_schema);

  const compatible: PolicyDocument = {
    ...policy,
    product_title_structure: {
      pattern: typeof title.formula === "string" ? title.formula : policy.product_title_structure?.pattern,
      examples: asStringArray(title.examples, policy.product_title_structure?.examples ?? []),
      disallowed_patterns: asStringArray(title.disallowed_patterns, policy.product_title_structure?.disallowed_patterns ?? []),
      seo_rules: asStringArray(title.seo_rules, policy.product_title_structure?.seo_rules ?? []),
      edge_case_rules: asStringArray(title.edge_case_rules, policy.product_title_structure?.edge_case_rules ?? [])
    },
    description_structure: {
      tone: asStringArray(description.tone_rules).join(" | ") || policy.description_structure?.tone,
      word_count: asStringArray(description.length_rules).join(" | ") || policy.description_structure?.word_count,
      guidance: asStringArray(description.guidance).join(" | ") || policy.description_structure?.guidance,
      required_sections: asStringArray(description.structure_template, policy.description_structure?.required_sections ?? []),
      formatting_rules: asStringArray(description.formatting_rules, policy.description_structure?.formatting_rules ?? []),
      auto_generatable: asStringArray(description.auto_generatable, policy.description_structure?.auto_generatable ?? []),
      manual_required: asStringArray(description.manual_required, policy.description_structure?.manual_required ?? [])
    },
    categorization_taxonomy: {
      type: asStringArray(taxonomy.hierarchy).join(" > ") || policy.categorization_taxonomy?.type,
      tree: Array.isArray(taxonomy.category_tree) ? taxonomy.category_tree : policy.categorization_taxonomy?.tree ?? [],
      guidance: asStringArray(taxonomy.collection_logic).join(" | ") || policy.categorization_taxonomy?.guidance,
      collection_logic: asStringArray(taxonomy.collection_logic, policy.categorization_taxonomy?.collection_logic ?? []),
      tagging_rules: asStringArray(taxonomy.tagging_system, policy.categorization_taxonomy?.tagging_rules ?? []),
      product_type_rules: asStringArray(taxonomy.product_type_rules, policy.categorization_taxonomy?.product_type_rules ?? [])
    },
    image_requirements: {
      primary_image: asStringArray(image.image_types)[0] || policy.image_requirements?.primary_image,
      background: asStringArray(image.background_rules).join(" | ") || policy.image_requirements?.background,
      preferred_styles: asStringArray(image.image_types, policy.image_requirements?.preferred_styles ?? []),
      avoid: asStringArray(image.avoid, policy.image_requirements?.avoid ?? []),
      media_types: asStringArray(image.image_types, policy.image_requirements?.media_types ?? []),
      aspect_ratios: asStringArray(image.aspect_ratios, policy.image_requirements?.aspect_ratios ?? []),
      alt_text_rules: asStringArray(image.alt_text_rules, policy.image_requirements?.alt_text_rules ?? [])
    },
    seo_handle_rules: {
      handle_format: asStringArray(seo.url_handle_rules).join(" | ") || policy.seo_handle_rules?.handle_format,
      seo_description_pattern: asStringArray(seo.meta_description_rules).join(" | ") || policy.seo_handle_rules?.seo_description_pattern,
      title_guidance: asStringArray(seo.meta_title_format).join(" | ") || policy.seo_handle_rules?.title_guidance
    },
    variant_structure: {
      primary_dimensions: asStringArray(variant.allowed_dimensions, policy.variant_structure?.primary_dimensions ?? []),
      guidance: asStringArray(variant.split_vs_variant_rules).join(" | ") || policy.variant_structure?.guidance,
      duplicate_rules: asStringArray(variant.duplicate_rules, policy.variant_structure?.duplicate_rules ?? []),
      split_vs_variant_rules: asStringArray(variant.split_vs_variant_rules, policy.variant_structure?.split_vs_variant_rules ?? []),
      max_variant_logic: asStringArray(variant.max_variant_logic, policy.variant_structure?.max_variant_logic ?? []),
      naming_conventions: asStringArray(variant.naming_conventions, policy.variant_structure?.naming_conventions ?? [])
    },
    pricing_discount_display_rules: {
      compare_at_price: asStringArray(seo.meta_description_rules).join(" | ") || policy.pricing_discount_display_rules?.compare_at_price,
      pricing_copy: asStringArray(seo.keyword_usage_patterns).join(" | ") || policy.pricing_discount_display_rules?.pricing_copy,
      bundles: asStringArray(variant.split_vs_variant_rules).join(" | ") || policy.pricing_discount_display_rules?.bundles,
      unit_pricing: asStringArray(seo.internal_linking_logic).join(" | ") || policy.pricing_discount_display_rules?.unit_pricing
    },
    collections_merchandising_rules: {
      status: policy.collections_merchandising_rules?.status ?? "guide_defined",
      guidance: asStringArray(merchandising.collection_sorting_logic).join(" | ") || policy.collections_merchandising_rules?.guidance,
      default_collection_types: asStringArray(merchandising.featured_product_logic, policy.collections_merchandising_rules?.default_collection_types ?? [])
    },
    automation_review_guidance: {
      safe_to_automate: asStringArray(automation.fully_automated, policy.automation_review_guidance?.safe_to_automate ?? []),
      requires_review: asStringArray(automation.validation_checkpoints, policy.automation_review_guidance?.requires_review ?? []),
      escalation_rules: asStringArray(automation.human_approval_required, policy.automation_review_guidance?.escalation_rules ?? []),
      never_auto_fill: asStringArray(automation.human_approval_required, policy.automation_review_guidance?.never_auto_fill ?? []),
      fallback_rules: asStringArray(automation.fallback_rules, policy.automation_review_guidance?.fallback_rules ?? []),
      error_handling_rules: asStringArray(automation.error_handling_rules, policy.automation_review_guidance?.error_handling_rules ?? [])
    },
    qa_scoring_criteria: {
      passing_score: typeof qa.passing_score === "number" ? qa.passing_score : policy.qa_scoring_criteria?.passing_score,
      success_definition: asStringArray(qa.pass_fail_conditions).join(" | ") || policy.qa_scoring_criteria?.success_definition,
      weights: policy.qa_scoring_criteria?.weights ?? {},
      weighted_areas: [
        ...new Set([
          ...asStringArray(qa.title_validation),
          ...asStringArray(qa.variant_validation),
          ...asStringArray(qa.metafield_completeness),
          ...asStringArray(qa.image_checks),
          ...asStringArray(qa.seo_checks)
        ])
      ]
    },
    product_listing_checklist: {
      required: asStringArray(existingAttributeSchema.required_fields, policy.product_listing_checklist?.required ?? []),
      optional: asStringArray(existingAttributeSchema.optional_fields, policy.product_listing_checklist?.optional ?? [])
    },
    attributes_metafields_schema: {
      required_fields: asStringArray(existingAttributeSchema.required_fields, policy.attributes_metafields_schema?.required_fields ?? []),
      optional_fields: asStringArray(existingAttributeSchema.optional_fields, policy.attributes_metafields_schema?.optional_fields ?? []),
      standard_shopify_fields: asStringArray(existingAttributeSchema.standard_shopify_fields, policy.attributes_metafields_schema?.standard_shopify_fields ?? []),
      metafields: Array.isArray(existingAttributeSchema.metafields)
        ? existingAttributeSchema.metafields as ProductMetafieldValue[]
        : policy.attributes_metafields_schema?.metafields ?? [],
      fill_rules: asStringArray(existingAttributeSchema.fill_rules, policy.attributes_metafields_schema?.fill_rules ?? []),
      guidance: typeof existingAttributeSchema.guidance === "string"
        ? existingAttributeSchema.guidance
        : policy.attributes_metafields_schema?.guidance
    }
  };

  return compatible;
}

export function getGuideAllowedFields(policy: PolicyDocument): string[] {
  return asStringArray(policy.attributes_metafields_schema?.standard_shopify_fields, []);
}

export function getGuideMetafields(policy: PolicyDocument): ProductMetafieldValue[] {
  return Array.isArray(policy.attributes_metafields_schema?.metafields)
    ? policy.attributes_metafields_schema.metafields
    : [];
}

export function getGuideTitleFormula(policy: PolicyDocument): string {
  return String(policy.product_title_system?.formula ?? policy.product_title_structure?.pattern ?? "");
}

export function getGuideDescriptionSections(policy: PolicyDocument): string[] {
  return asStringArray(policy.product_description_system?.structure_template, policy.description_structure?.required_sections ?? []);
}

export function getGuideDescriptionGuidance(policy: PolicyDocument): string[] {
  const direct = asStringArray(policy.product_description_system?.guidance, []);
  if (direct.length > 0) return direct;
  return asStringArray(policy.description_structure?.guidance ? [policy.description_structure.guidance] : [], []);
}

export function getGuideRequiredFields(policy: PolicyDocument): string[] {
  return asStringArray(policy.attributes_metafields_schema?.required_fields, policy.product_listing_checklist?.required ?? []);
}

export function getGuidePassingScore(policy: PolicyDocument): number {
  return Number(policy.qa_validation_system?.passing_score ?? policy.qa_scoring_criteria?.passing_score ?? 85);
}

export function getGuideVariantDimensions(policy: PolicyDocument): string[] {
  return asStringArray(policy.variant_architecture?.allowed_dimensions, policy.variant_structure?.primary_dimensions ?? []);
}

export function getGuideImageRequirementSummary(policy: PolicyDocument): string {
  const styles = asStringArray(policy.image_media_standards?.image_types, policy.image_requirements?.preferred_styles ?? []);
  const backgrounds = asStringArray(policy.image_media_standards?.background_rules, policy.image_requirements?.background ? [String(policy.image_requirements.background)] : []);
  const avoid = asStringArray(policy.image_media_standards?.avoid, policy.image_requirements?.avoid ?? []);
  return [...styles, ...backgrounds, ...avoid.map((item) => `avoid:${item}`)].join(", ");
}

export function getGuideAgenticRequiredSignals(policy: PolicyDocument): string[] {
  return asStringArray(policy.agentic_commerce_readiness?.required_signals, []);
}

export function getGuideAgenticDescriptionRequirements(policy: PolicyDocument): string[] {
  return asStringArray(policy.agentic_commerce_readiness?.description_requirements, []);
}

export function getGuideAgenticRecommendedMetafields(policy: PolicyDocument): Array<{ namespace: string; key: string; type: string; purpose: string; example_values?: string[] }> {
  const value = policy.agentic_commerce_readiness?.recommended_metafields;
  return Array.isArray(value) ? value.map((item) => ({
    namespace: String(item.namespace ?? ""),
    key: String(item.key ?? ""),
    type: String(item.type ?? ""),
    purpose: String(item.purpose ?? ""),
    example_values: Array.isArray(item.example_values) ? item.example_values.map(String) : []
  })).filter((item) => item.namespace && item.key) : [];
}
