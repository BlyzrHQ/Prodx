const GROCERY_TAXONOMY = [
  { aisle: "Dairy & Eggs", sub_sections: ["Milk", "Yogurt", "Cheese", "Eggs"] },
  { aisle: "Produce", sub_sections: ["Fruits", "Vegetables", "Herbs"] },
  { aisle: "Pantry", sub_sections: ["Rice", "Pasta", "Canned Food", "Sauces"] }
];

export function buildStarterPolicy({
  businessName = "Demo Store",
  businessDescription = "",
  industry = "generic",
  targetMarket = "General ecommerce shoppers",
  operatingMode = "local_files",
  storeUrl = "",
  notes = ""
} = {}) {
  const isGrocery = industry.toLowerCase() === "grocery";
  const taxonomy = isGrocery
    ? { type: "Aisle > Sub-section", tree: GROCERY_TAXONOMY }
    : { type: "Department > Category > Subcategory", tree: [{ department: "General", categories: ["Core", "Featured", "Seasonal"] }] };

  return {
    meta: {
      business_name: businessName,
      business_description: businessDescription,
      industry,
      target_market: targetMarket,
      operating_mode: operatingMode,
      store_url: storeUrl,
      generated_at: new Date().toISOString(),
      generation_method: "starter_template"
    },
    industry_business_context: {
      summary: businessDescription || `${businessName} operates in ${industry}.`,
      audience: targetMarket,
      notes,
      operating_mode: operatingMode
    },
    eligibility_rules: {
      accept: [
        "Products aligned with the store's industry and quality standards",
        "Products with enough source data to identify and review safely"
      ],
      reject: [
        "Products outside the store's industry or compliance scope",
        "Products with obviously misleading or unusable source data"
      ]
    },
    product_title_structure: isGrocery
      ? { pattern: "[Brand] [Product] [Size]", examples: ["Almarai Fresh Milk 1L", "Baladna Greek Yogurt 500g"] }
      : { pattern: "[Brand] [Product] [Primary Variant] [Secondary Variant]", examples: ["Acme Trail Jacket Olive Large"] },
    description_structure: {
      tone: "Clear, factual, conversion-friendly",
      word_count: "80-140 words",
      guidance: isGrocery
        ? "Lead with the product identity, then list key product details, ingredients or composition, and storage guidance."
        : "Lead with the product identity, then list core features, specifications, and care or usage guidance.",
      required_sections: isGrocery
        ? ["Overview", "Key product details", "Ingredients or composition", "Storage or handling"]
        : ["Overview", "Key features", "Materials or specifications", "Care or usage"]
    },
    categorization_taxonomy: taxonomy,
    attributes_metafields_schema: {
      required_fields: ["title", "handle", "description", "brand", "product_type"],
      optional_fields: ["ingredients_text", "allergen_note", "usage_tips", "featured_image"],
      standard_shopify_fields: ["title", "handle", "body_html", "vendor", "product_type", "tags", "images"],
      metafields: [
        {
          namespace: "custom",
          key: "aisle",
          type: "single_line_text_field",
          value: "",
          description: "Primary aisle used for merchandising and filtering.",
          required: true,
          source_field: "product_type"
        },
        {
          namespace: "custom",
          key: "dietary_preferences",
          type: "list.single_line_text_field",
          value: "",
          description: "Dietary or certification attributes such as halal, vegetarian, or organic.",
          required: false,
          source_field: "tags"
        }
      ],
      fill_rules: [
        "Only populate metafields that exist in Shopify or are explicitly approved in the policy.",
        "Use product source data first; infer values only when policy allows it.",
        "If a required metafield cannot be filled safely, route the listing to review."
      ],
      guidance: "Use metafields for structured attributes that affect filtering, merchandising, compliance, or customer decision-making."
    },
    product_listing_checklist: {
      required: ["title", "description", "brand", "product_type", "featured_image"],
      optional: ["compare_at_price", "usage_tips", "additional_images"]
    },
    qa_scoring_criteria: {
      passing_score: 85,
      success_definition: "A listing is successful when it is accurate, complete, easy to understand, well categorized, and ready for confident customer purchase decisions.",
      weights: {
        title: 15,
        description: 15,
        classification: 20,
        images: 15,
        required_fields: 15,
        attributes: 10,
        additional_information: 10
      }
    },
    image_requirements: {
      primary_image: "Clear product-first pack shot",
      background: isGrocery ? "Clean neutral or white background preferred" : "Category-appropriate clean background",
      avoid: ["Watermarks", "Pixelation", "Wrong product", "Unreadable labels"]
    },
    seo_handle_rules: {
      handle_format: "lowercase-hyphenated",
      seo_description_pattern: "Concise keyword-rich description under 160 characters"
    },
    variant_structure: isGrocery
      ? { primary_dimensions: ["Size", "Type"], guidance: "Generic values like Default or Regular are not differentiating variants on their own." }
      : { primary_dimensions: ["Size", "Color"], guidance: "Variants should follow the industry's primary shopper decision dimensions." },
    pricing_discount_display_rules: {
      compare_at_price: "Only set when a real discount exists",
      pricing_copy: "Do not embed discount claims in the title unless policy explicitly allows it",
      bundles: "Bundle pricing must be explicit and machine-readable"
    },
    collections_merchandising_rules: {
      status: "Prepared for future collection-builder support",
      guidance: "Collections should reflect taxonomy, merchandising intent, and seasonal campaigns."
    }
  };
}

export function renderPolicyMarkdown(policy) {
  const taxonomyLines = Array.isArray(policy.categorization_taxonomy.tree)
    ? policy.categorization_taxonomy.tree.map((entry) => {
        if (typeof entry === "string") return `- ${entry}`;
        return `- ${Object.values(entry)[0]}: ${JSON.stringify(Object.values(entry)[1])}`;
      }).join("\n")
    : "- See structured policy JSON";
  const titleExamples = Array.isArray(policy.product_title_structure?.examples)
    ? policy.product_title_structure.examples.map((item) => `  - ${item}`).join("\n")
    : "  - No examples provided";
  const descriptionSections = Array.isArray(policy.description_structure?.required_sections)
    ? policy.description_structure.required_sections.map((item) => `  - ${item}`).join("\n")
    : "  - No sections provided";
  const listingRequired = Array.isArray(policy.product_listing_checklist?.required)
    ? policy.product_listing_checklist.required.map((item) => `  - ${item}`).join("\n")
    : "  - Not defined";
  const listingOptional = Array.isArray(policy.product_listing_checklist?.optional)
    ? policy.product_listing_checklist.optional.map((item) => `  - ${item}`).join("\n")
    : "  - Not defined";
  const variantDimensions = Array.isArray(policy.variant_structure?.primary_dimensions)
    ? policy.variant_structure.primary_dimensions.join(", ")
    : "Not defined";

  return `# Catalog Policy

## Industry & Business Context
- Business: ${policy.meta.business_name}
- Business Description: ${policy.meta.business_description || "Not provided"}
- Industry: ${policy.meta.industry}
- Audience: ${policy.meta.target_market}
- Operating Mode: ${policy.meta.operating_mode || "Not provided"}
- Store URL: ${policy.meta.store_url || "Not provided"}
- Summary: ${policy.industry_business_context.summary}

## Eligibility Rules
### Accept
${policy.eligibility_rules.accept.map((item) => `- ${item}`).join("\n")}

### Reject
${policy.eligibility_rules.reject.map((item) => `- ${item}`).join("\n")}

## Product Title Structure
- Pattern: ${policy.product_title_structure.pattern}
- Examples:
${titleExamples}

## Description Structure
- Tone: ${policy.description_structure.tone}
- Word Count: ${policy.description_structure.word_count}
- Required Sections:
${descriptionSections}

## Categorization Taxonomy
- Model: ${policy.categorization_taxonomy.type}
${taxonomyLines}

## Product Listing Checklist
### Required
${listingRequired}

### Optional
${listingOptional}

## QA Scoring Criteria
- Passing Score: ${policy.qa_scoring_criteria?.passing_score ?? "Not defined"}
- Weights: ${JSON.stringify(policy.qa_scoring_criteria?.weights ?? {})}

## Attributes & Metafields Schema
- Required Fields: ${JSON.stringify(policy.attributes_metafields_schema?.required_fields ?? [])}
- Optional Fields: ${JSON.stringify(policy.attributes_metafields_schema?.optional_fields ?? [])}
- Standard Shopify Fields: ${JSON.stringify(policy.attributes_metafields_schema?.standard_shopify_fields ?? [])}
- Metafields:
${Array.isArray(policy.attributes_metafields_schema?.metafields) && policy.attributes_metafields_schema.metafields.length > 0
  ? policy.attributes_metafields_schema.metafields.map((field) => `  - ${field.namespace}.${field.key} (${field.type})${field.required ? " [required]" : ""}${field.source_field ? ` <- ${field.source_field}` : ""}`).join("\n")
  : "  - []"}
- Fill Rules:
${Array.isArray(policy.attributes_metafields_schema?.fill_rules) && policy.attributes_metafields_schema.fill_rules.length > 0
  ? policy.attributes_metafields_schema.fill_rules.map((rule) => `  - ${rule}`).join("\n")
  : "  - Not defined"}

## Image Requirements
- Primary Image: ${policy.image_requirements?.primary_image ?? "Not defined"}
- Background: ${policy.image_requirements?.background ?? "Not defined"}
- Avoid: ${JSON.stringify(policy.image_requirements?.avoid ?? [])}

## SEO & Handle Rules
- Handle Format: ${policy.seo_handle_rules?.handle_format ?? "Not defined"}
- SEO Pattern: ${policy.seo_handle_rules?.seo_description_pattern ?? "Not defined"}

## Pricing & Discount Display Rules
- Compare-at price: ${policy.pricing_discount_display_rules?.compare_at_price ?? "Not defined"}
- Pricing copy: ${policy.pricing_discount_display_rules?.pricing_copy ?? "Not defined"}
- Bundles: ${policy.pricing_discount_display_rules?.bundles ?? "Not defined"}

## Variant Structure
- Primary dimensions: ${variantDimensions}
- Guidance: ${policy.variant_structure?.guidance ?? "Not defined"}

## Collections & Merchandising Rules
- Status: ${policy.collections_merchandising_rules?.status ?? "Not defined"}
- Guidance: ${policy.collections_merchandising_rules?.guidance ?? "Not defined"}
`;
}

export function initialLearningMarkdown(policy) {
  return `# Catalog Learning

- Initialized for ${policy.meta.business_name} (${policy.meta.industry}) on ${policy.meta.generated_at}
- Add distilled lessons here as review outcomes accumulate.
`;
}
