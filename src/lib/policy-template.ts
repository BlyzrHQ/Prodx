import { applyCatalogGuideCompatibility, getGuideDescriptionSections, getGuideMetafields, getGuideVariantDimensions } from "./catalog-guide.js";
import type { PolicyDocument, ProductMetafieldValue } from "../types.js";

const REVIEW_SENTINEL = "requires_review";

const INDUSTRY_TEMPLATES: Record<string, {
  hierarchy: string[];
  categoryTree: unknown[];
  titleFormula: string;
  titleExamples: string[];
  descriptionSections: string[];
  variantDimensions: string[];
  metafields: ProductMetafieldValue[];
  imageTypes: string[];
}> = {
  food_and_beverage: {
    hierarchy: ["Aisle", "Sub-section", "Product type"],
    categoryTree: [
      { aisle: "Dairy & Eggs", sub_sections: ["Milk", "Yogurt", "Cheese", "Eggs"] },
      { aisle: "Produce", sub_sections: ["Fruits", "Vegetables", "Herbs"] },
      { aisle: "Pantry", sub_sections: ["Rice", "Pasta", "Canned Food", "Sauces"] }
    ],
    titleFormula: "Brand + Product + Key Attribute + Size",
    titleExamples: ["Almarai Fresh Milk Full Fat 1L", "Baladna Greek Yogurt Plain 500g"],
    descriptionSections: ["Overview", "Key Product Details", "Ingredients Or Composition", "Storage Or Handling"],
    variantDimensions: ["Size", "Type"],
    metafields: [
      {
        namespace: "custom",
        key: "aisle",
        type: "single_line_text_field",
        value: REVIEW_SENTINEL,
        description: "Primary aisle used for navigation, filtering, and collection logic.",
        required: true,
        source_field: "product_type",
        source: "derived",
        validation_rules: ["Must match an approved aisle value from the taxonomy design."],
        example_values: ["Dairy & Eggs", "Produce", "Pantry"],
        usage: ["filtering", "display", "internal logic"],
        automation_mode: "safe_if_taxonomy_match",
        inferred: false
      },
      {
        namespace: "custom",
        key: "dietary_preferences",
        type: "list.single_line_text_field",
        value: REVIEW_SENTINEL,
        description: "Dietary or certification attributes that support customer filtering and trust.",
        required: false,
        source_field: "tags",
        source: "automation",
        validation_rules: ["Use approved values only.", "Do not infer certifications without source evidence."],
        example_values: ["halal", "organic", "vegetarian"],
        usage: ["filtering", "SEO", "display"],
        automation_mode: "review_required",
        inferred: false
      }
    ],
    imageTypes: ["hero", "pack shot", "detail"]
  },
  apparel: {
    hierarchy: ["Department", "Category", "Silhouette"],
    categoryTree: [
      { department: "Women", categories: ["Dresses", "Tops", "Bottoms", "Outerwear"] },
      { department: "Men", categories: ["Shirts", "Trousers", "Outerwear", "Basics"] },
      { department: "Accessories", categories: ["Scarves", "Bags", "Belts"] }
    ],
    titleFormula: "Brand + Product + Key Attribute + Primary Variant + Secondary Variant",
    titleExamples: ["Uniqlo Oversized Cotton T-Shirt Black Medium", "Nike Club Fleece Joggers Grey Large"],
    descriptionSections: ["Overview", "Key Features", "Material And Fit", "Care Or Usage"],
    variantDimensions: ["Size", "Color"],
    metafields: [
      {
        namespace: "custom",
        key: "material",
        type: "single_line_text_field",
        value: REVIEW_SENTINEL,
        description: "Primary fabric or material composition for filtering and product education.",
        required: false,
        source_field: "product copy or care label",
        source: "manual",
        validation_rules: ["Use the dominant material first.", "Avoid unsupported blends when the source is ambiguous."],
        example_values: ["100% cotton", "polyester blend"],
        usage: ["filtering", "display", "SEO"],
        automation_mode: "review_required",
        inferred: false
      },
      {
        namespace: "custom",
        key: "fit",
        type: "single_line_text_field",
        value: REVIEW_SENTINEL,
        description: "Fit or silhouette guidance such as oversized, regular, slim, or relaxed.",
        required: false,
        source_field: "product copy",
        source: "automation",
        validation_rules: ["Use approved fit vocabulary only."],
        example_values: ["oversized", "regular", "relaxed"],
        usage: ["filtering", "display"],
        automation_mode: "safe_if_explicit",
        inferred: false
      }
    ],
    imageTypes: ["hero", "lifestyle", "detail"]
  },
  electronics: {
    hierarchy: ["Department", "Category", "Device Type"],
    categoryTree: [
      { department: "Power", categories: ["Chargers", "Power Banks", "Cables"] },
      { department: "Audio", categories: ["Headphones", "Speakers", "Microphones"] },
      { department: "Mobile Accessories", categories: ["Cases", "Screen Protection", "Mounts"] }
    ],
    titleFormula: "Brand + Product + Core Specification + Compatibility Or Variant",
    titleExamples: ["Anker 20W USB-C Wall Charger", "JBL Tune 520BT Wireless Headphones Black"],
    descriptionSections: ["Overview", "Key Features", "Technical Specifications", "Compatibility And What Is Included", "Care Or Usage"],
    variantDimensions: ["Color", "Storage"],
    metafields: [
      {
        namespace: "custom",
        key: "mpn",
        type: "single_line_text_field",
        value: REVIEW_SENTINEL,
        description: "Manufacturer part number for compatibility and search precision.",
        required: false,
        source_field: "spec sheet",
        source: "manual",
        validation_rules: ["Use the exact manufacturer part number when available."],
        example_values: ["A2149", "B2C-20W-USB-C"],
        usage: ["search", "internal logic", "compatibility"],
        automation_mode: "manual_only",
        inferred: false
      },
      {
        namespace: "custom",
        key: "dimensions",
        type: "single_line_text_field",
        value: REVIEW_SENTINEL,
        description: "Physical dimensions of the device or packaging.",
        required: false,
        source_field: "spec sheet",
        source: "manual",
        validation_rules: ["Use a consistent L x W x H format."],
        example_values: ["7 x 4 x 3 cm"],
        usage: ["display", "shipping", "comparison"],
        automation_mode: "manual_only",
        inferred: false
      }
    ],
    imageTypes: ["hero", "detail", "infographic"]
  }
};

export const INDUSTRY_OPTIONS = [
  "food_and_beverage",
  "apparel",
  "beauty_and_personal_care",
  "electronics",
  "home_and_living",
  "health_and_wellness",
  "baby_and_kids",
  "sports_and_outdoors",
  "automotive",
  "pet_supplies",
  "books_and_stationery",
  "jewelry_and_accessories",
  "other"
] as const;

export function normalizeIndustry(industry: string): string {
  const normalized = industry.toLowerCase().trim().replace(/\s+/g, "_").replace(/&/g, "and").replace(/-+/g, "_");
  if (normalized === "grocery") return "food_and_beverage";
  if (normalized === "clothing" || normalized === "clothes" || normalized === "fashion") return "apparel";
  if (normalized === "tech" || normalized === "consumer_electronics") return "electronics";
  return normalized;
}

function getIndustryTemplate(industry: string) {
  return INDUSTRY_TEMPLATES[normalizeIndustry(industry)] ?? {
    hierarchy: ["Department", "Category", "Subcategory"],
    categoryTree: [{ department: "General", categories: ["Core", "Featured", "Seasonal"] }],
    titleFormula: "Brand + Product + Key Attribute + Primary Variant",
    titleExamples: ["Acme Core Product Blue Medium"],
    descriptionSections: ["Overview", "Key Features", "Specifications Or Materials", "Care Or Usage"],
    variantDimensions: ["Size", "Color"],
    metafields: [],
    imageTypes: ["hero", "detail"]
  };
}

export function buildStarterPolicy({
  businessName = "Demo Store",
  businessDescription = "",
  industry = "generic",
  targetMarket = "",
  operatingMode = "local_files",
  storeUrl = "",
  notes = ""
} = {}): PolicyDocument {
  const normalizedIndustry = normalizeIndustry(industry);
  const template = getIndustryTemplate(normalizedIndustry);

  const policy: PolicyDocument = {
    meta: {
      business_name: businessName,
      business_description: businessDescription,
      industry: normalizedIndustry,
      target_market: targetMarket,
      operating_mode: operatingMode,
      store_url: storeUrl,
      generated_at: new Date().toISOString(),
      generation_method: "starter_template"
    },
    industry_business_context: {
      summary: businessDescription || `${businessName} operates in ${normalizedIndustry}.`,
      audience: targetMarket || REVIEW_SENTINEL,
      notes,
      operating_mode: operatingMode
    },
    eligibility_rules: {
      accept: [
        "Products aligned with the store's industry, merchandising standards, and customer promise.",
        "Products with enough source data to identify, classify, enrich, and validate safely."
      ],
      reject: [
        "Products outside the store's category, compliance, or merchandising strategy.",
        "Products with contradictory, misleading, or unusable source data."
      ]
    },
    taxonomy_design: {
      hierarchy: template.hierarchy,
      category_tree: template.categoryTree,
      collection_logic: [
        "Use automated collections where tags, product types, or metafields can enforce repeatable rules.",
        "Use manual collections only for campaigns, editorial curation, or short-lived merchandising needs."
      ],
      tagging_system: [
        "Tags must be machine-consistent, lowercase where possible, and grouped by purpose.",
        "Do not duplicate product type or obvious title words unless they improve filtering or merchandising."
      ],
      product_type_rules: [
        "Product type should describe the item family customers shop for.",
        "Keep the product type stable across variants in the same family."
      ],
      handle_structure_rules: [
        "Use lowercase hyphenated handles.",
        "Favor stable product identity terms over promotional language."
      ]
    },
    product_title_system: {
      formula: template.titleFormula,
      examples: template.titleExamples,
      disallowed_patterns: [
        "Do not use all caps.",
        "Do not include unsupported claims, emojis, or excessive punctuation.",
        "Do not repeat the brand twice."
      ],
      seo_rules: [
        "Keep the highest-intent search terms in the first half of the title.",
        "Prioritize brand, product family, and the strongest decision-driving attribute."
      ],
      edge_case_rules: [
        "Bundle titles must clearly signal the bundle or kit structure.",
        "Variant values belong in the title only when the store and category require it."
      ]
    },
    product_description_system: {
      structure_template: template.descriptionSections,
      tone_rules: [
        "Keep the tone factual, clear, and conversion-oriented.",
        "Avoid unsupported claims and vague marketing language."
      ],
      length_rules: [
        "Target 80 to 180 words for core ecommerce PDP copy unless the category requires specs-heavy content."
      ],
      formatting_rules: [
        "Use HTML-friendly section structure with headings, paragraphs, and list items.",
        "Keep scannability high."
      ],
      auto_generatable: [
        "Overview section from known product identity data.",
        "Basic feature bullets when the source data is explicit."
      ],
      manual_required: [
        "Compliance-sensitive claims.",
        "Complex technical or ingredient details when the source is incomplete."
      ],
      guidance: [
        "Lead with product identity and strongest customer decision points.",
        "Include only details that can be supported by input data, store context, or approved inference rules."
      ]
    },
    variant_architecture: {
      allowed_dimensions: template.variantDimensions,
      split_vs_variant_rules: [
        "Use variants only when the product family stays meaningfully the same across shopper-facing options.",
        "Split into separate products when identity, compatibility, or buying intent changes materially."
      ],
      max_variant_logic: [
        "Avoid variant structures that become hard to browse, search, or sync safely.",
        "Escalate oversized matrices for manual review."
      ],
      naming_conventions: [
        "Use clean shopper-facing option names like Size, Color, Storage, or Pack Size.",
        "Do not emit placeholder option names without real values."
      ],
      duplicate_rules: [
        "Generic values like Default Title are not real differentiators.",
        "Different shopper-facing values within the same family may form variants if the category supports it."
      ]
    },
    attributes_metafields_schema: {
      required_fields: ["title", "handle", "description_html", "vendor", "product_type"],
      optional_fields: ["featured_image", "compare_at_price", "tags", "images"],
      standard_shopify_fields: ["title", "handle", "body_html", "vendor", "product_type", "tags", "images"],
      metafields: template.metafields,
      fill_rules: [
        "Only populate metafields that exist in Shopify or are explicitly approved in the guide.",
        "Use explicit source data first and infer only when the guide marks the field safe for automation.",
        "If a required field or metafield cannot be filled safely, route the product to review."
      ],
      guidance: "Use structured attributes and metafields to improve filtering, UX, merchandising, SEO, and internal logic."
    },
    image_media_standards: {
      image_types: template.imageTypes,
      background_rules: [
        normalizedIndustry === "food_and_beverage"
          ? "Prefer clean white or neutral backgrounds for hero images."
          : "Use clean, category-appropriate backgrounds that keep the product unmistakable."
      ],
      aspect_ratios: ["1:1", "4:5"],
      naming_conventions: [
        "Use stable product identity in image file naming when the source system supports it."
      ],
      alt_text_rules: [
        "Describe the exact product shown with brand, product family, and key visible differentiator.",
        "Do not stuff keywords."
      ],
      automation_tagging_rules: [
        "Hero image selection can be automated when the product is clear, centered, readable, and category-compliant.",
        "Lifestyle or infographic tagging requires review when the intent is ambiguous."
      ],
      avoid: ["Watermarks", "Pixelation", "Wrong product", "Unreadable labels"]
    },
    merchandising_rules: {
      collection_sorting_logic: [
        "Default to relevance, best sellers, new arrivals, or category-specific buying logic.",
        "Promotional overrides must be explicit and time-bounded."
      ],
      cross_sell_rules: [
        "Recommend adjacent complements, not loose keyword matches."
      ],
      upsell_rules: [
        "Upsells should remain in the same product family or a clearly superior compatible option."
      ],
      product_grouping_logic: [
        "Group products by shared identity and buying intent, not by vague similarity."
      ],
      seasonal_overrides: [
        "Seasonal collections can override default ranking when the campaign is active."
      ],
      featured_product_logic: [
        "Featured products must align with category demand, campaign strategy, or margin goals."
      ]
    },
    seo_discovery_rules: {
      meta_title_format: [
        "Meta title should mirror the best customer-facing title structure with minimal extra filler."
      ],
      meta_description_rules: [
        "Keep meta descriptions concise, helpful, and under 160 characters where possible."
      ],
      url_handle_rules: [
        "Use lowercase hyphenated handles with stable identity terms."
      ],
      internal_linking_logic: [
        "Use collection and related-product structures to reinforce high-intent discovery paths."
      ],
      keyword_usage_patterns: [
        "Use real buyer terms grounded in brand, product type, and strongest selection criteria."
      ]
    },
    automation_playbook: {
      fully_automated: [
        "Handle generation from approved title rules.",
        "Basic HTML description structure from explicit source fields.",
        "Guide-approved metafields when source evidence is explicit."
      ],
      validation_checkpoints: [
        "Variant structure changes.",
        "Inferred attributes or metafields.",
        "Image replacement decisions."
      ],
      human_approval_required: [
        "Compliance-sensitive claims.",
        "Compatibility-sensitive technical assertions.",
        "Fields marked manual_only or never_auto_fill."
      ],
      transformation_logic: [
        "Input -> normalized product identity -> guide-compliant output fields -> review gating."
      ],
      fallback_rules: [
        "Use requires_review or unknown_requires_review instead of inventing unsupported data.",
        "Keep the existing source value when confidence is low."
      ],
      error_handling_rules: [
        "Provider failure should fall back to deterministic logic when possible.",
        "Missing critical data should route the product to review, not silent autofill."
      ]
    },
    qa_validation_system: {
      title_validation: [
        "Title must follow the approved formula and avoid disallowed patterns."
      ],
      variant_validation: [
        "Variant dimensions must be real shopper-facing options, not placeholders."
      ],
      metafield_completeness: [
        "Required metafields must be populated or explicitly routed to review."
      ],
      image_checks: [
        "Hero image must match the product, be clear, and satisfy category image standards."
      ],
      seo_checks: [
        "Handle and meta behavior must follow the discovery rules."
      ],
      pass_fail_conditions: [
        "Pass when required fields are complete, the QA score meets threshold, and no blocking policy violations remain."
      ],
      auto_fix_rules: [
        "Handles can be regenerated automatically when only formatting is wrong.",
        "Whitespace, casing, and simple taxonomy normalization can be auto-fixed when the intended value is obvious."
      ],
      passing_score: 85
    }
  };

  return applyCatalogGuideCompatibility(policy);
}

function renderList(items: string[], empty = "- None defined"): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function renderIndentedList(items: string[], empty = "  - None defined"): string {
  return items.length > 0 ? items.map((item) => `  - ${item}`).join("\n") : empty;
}

export function renderPolicyMarkdown(policy: PolicyDocument) {
  const taxonomyTree = Array.isArray(policy.taxonomy_design?.category_tree)
    ? policy.taxonomy_design.category_tree.map((entry) => `- ${JSON.stringify(entry)}`).join("\n")
    : "- None defined";
  const metafields = getGuideMetafields(policy);
  const descriptionSections = getGuideDescriptionSections(policy);
  const variantDimensions = getGuideVariantDimensions(policy);

  return `# Catalog Guide

## Industry & Business Context
- Business: ${policy.meta?.business_name ?? "Not provided"}
- Business Description: ${policy.meta?.business_description ?? "Not provided"}
- Industry: ${policy.meta?.industry ?? "Not provided"}
- Operating Mode: ${policy.meta?.operating_mode ?? "Not provided"}
- Store URL: ${policy.meta?.store_url || "Not provided"}
- Summary: ${policy.industry_business_context?.summary ?? "Not provided"}

## Taxonomy Design
### Hierarchy
${renderList(Array.isArray(policy.taxonomy_design?.hierarchy) ? policy.taxonomy_design.hierarchy : [])}

### Category Tree
${taxonomyTree}

### Collection Logic
${renderList(Array.isArray(policy.taxonomy_design?.collection_logic) ? policy.taxonomy_design.collection_logic : [])}

### Tagging System
${renderList(Array.isArray(policy.taxonomy_design?.tagging_system) ? policy.taxonomy_design.tagging_system : [])}

## Product Title System
- Formula: ${policy.product_title_system?.formula ?? "Not defined"}
- Examples:
${renderIndentedList(Array.isArray(policy.product_title_system?.examples) ? policy.product_title_system.examples : [])}
- Disallowed patterns:
${renderIndentedList(Array.isArray(policy.product_title_system?.disallowed_patterns) ? policy.product_title_system.disallowed_patterns : [])}

## Product Description System
- Structure template:
${renderIndentedList(descriptionSections)}
- Tone rules:
${renderIndentedList(Array.isArray(policy.product_description_system?.tone_rules) ? policy.product_description_system.tone_rules : [])}
- Formatting rules:
${renderIndentedList(Array.isArray(policy.product_description_system?.formatting_rules) ? policy.product_description_system.formatting_rules : [])}

## Variant Architecture
- Allowed dimensions: ${variantDimensions.join(", ") || "Not defined"}
- Split vs variant rules:
${renderIndentedList(Array.isArray(policy.variant_architecture?.split_vs_variant_rules) ? policy.variant_architecture.split_vs_variant_rules : [])}

## Attributes & Metafields Schema
- Required Fields: ${JSON.stringify(policy.attributes_metafields_schema?.required_fields ?? [])}
- Optional Fields: ${JSON.stringify(policy.attributes_metafields_schema?.optional_fields ?? [])}
- Standard Shopify Fields: ${JSON.stringify(policy.attributes_metafields_schema?.standard_shopify_fields ?? [])}
- Metafields:
${metafields.length > 0
  ? metafields.map((field) => [
      `  - ${field.namespace}.${field.key}`,
      `    - Type: ${field.type}`,
      `    - Required: ${field.required ? "true" : "false"}`,
      `    - Source: ${field.source ?? "unknown"}`,
      `    - Source Field: ${field.source_field ?? ""}`,
      `    - Automation Mode: ${field.automation_mode ?? "review_required"}`,
      `    - Description: ${field.description ?? ""}`,
      `    - Validation Rules: ${(field.validation_rules ?? []).join(" | ") || "None defined"}`,
      `    - Example Values: ${(field.example_values ?? []).join(" | ") || "None defined"}`,
      `    - Usage: ${(field.usage ?? []).join(" | ") || "None defined"}`,
      `    - Inferred: ${field.inferred ? "true" : "false"}`
    ].join("\n")).join("\n")
  : "  - []"}

## Image & Media Standards
- Image types:
${renderIndentedList(Array.isArray(policy.image_media_standards?.image_types) ? policy.image_media_standards.image_types : [])}
- Background rules:
${renderIndentedList(Array.isArray(policy.image_media_standards?.background_rules) ? policy.image_media_standards.background_rules : [])}
- Alt text rules:
${renderIndentedList(Array.isArray(policy.image_media_standards?.alt_text_rules) ? policy.image_media_standards.alt_text_rules : [])}

## Merchandising Rules
${renderList(Array.isArray(policy.merchandising_rules?.collection_sorting_logic) ? policy.merchandising_rules.collection_sorting_logic : [])}

## SEO & Discovery Rules
${renderList(Array.isArray(policy.seo_discovery_rules?.url_handle_rules) ? policy.seo_discovery_rules.url_handle_rules : [])}

## Automation Playbook
- Fully automated:
${renderIndentedList(Array.isArray(policy.automation_playbook?.fully_automated) ? policy.automation_playbook.fully_automated : [])}
- Validation checkpoints:
${renderIndentedList(Array.isArray(policy.automation_playbook?.validation_checkpoints) ? policy.automation_playbook.validation_checkpoints : [])}
- Human approval required:
${renderIndentedList(Array.isArray(policy.automation_playbook?.human_approval_required) ? policy.automation_playbook.human_approval_required : [])}

## QA & Validation System
- Passing Score: ${policy.qa_validation_system?.passing_score ?? "Not defined"}
- Pass/fail conditions:
${renderIndentedList(Array.isArray(policy.qa_validation_system?.pass_fail_conditions) ? policy.qa_validation_system.pass_fail_conditions : [])}
`;
}

export function initialLearningMarkdown(policy: PolicyDocument) {
  return `# Catalog Learning

- Initialized for ${policy.meta?.business_name ?? "Unknown Store"} (${policy.meta?.industry ?? "unknown"}) on ${policy.meta?.generated_at ?? new Date().toISOString()}
- Add distilled lessons here as review outcomes accumulate.
`;
}
