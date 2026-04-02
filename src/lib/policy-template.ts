import { applyCatalogGuideCompatibility, getGuideDescriptionSections, getGuideMetafields, getGuideVariantDimensions } from "./catalog-guide.js";
import type { PolicyDocument, ProductMetafieldValue, RecommendedMetafield } from "../types.js";

const REVIEW_SENTINEL = "requires_review";

function makeRecommendedMetafield(
  namespace: string,
  key: string,
  type: string,
  purpose: string,
  example_values: string[]
): RecommendedMetafield {
  return { namespace, key, type, purpose, example_values };
}

function buildAgenticRecommendedMetafields(industry: string): RecommendedMetafield[] {
  const base = [
    makeRecommendedMetafield("custom", "use_case", "single_line_text_field", "Captures the primary shopper or agent intent the product solves.", ["daily essential", "giftable", "quick meal", "desk accessory"]),
    makeRecommendedMetafield("custom", "audience", "single_line_text_field", "Identifies who the product is best suited for.", ["adults", "kids", "family", "travelers"]),
    makeRecommendedMetafield("custom", "key_attributes", "list.single_line_text_field", "Summarizes the strongest selection-driving attributes in a structured way.", ["cotton", "lightweight", "wireless", "ready to eat"]),
    makeRecommendedMetafield("custom", "faq_summary", "multi_line_text_field", "Stores short decision-ready FAQ content that helps AI channels answer buyer questions.", ["Who it is for, when to use it, and key limitations."])
  ];

  if (industry === "food_and_beverage") {
    return [
      ...base,
      makeRecommendedMetafield("custom", "occasion", "single_line_text_field", "Captures the meal, event, or occasion the product is suited for.", ["ramadan", "breakfast", "after iftar", "family dinner"]),
      makeRecommendedMetafield("custom", "ingredients_text", "multi_line_text_field", "Provides exact ingredient text for recommendation, trust, and compliance-sensitive discovery.", ["Paste exact label ingredients here."]),
      makeRecommendedMetafield("custom", "allergen_note", "multi_line_text_field", "Provides exact allergen disclosures when available.", ["Contains milk and soy."]),
      makeRecommendedMetafield("custom", "nutritional_facts", "multi_line_text_field", "Stores verified nutrition highlights or label facts in plain text.", ["Per 100g: Energy 120 kcal, Protein 4g."])
    ];
  }

  if (industry === "apparel") {
    return [
      ...base,
      makeRecommendedMetafield("custom", "material", "single_line_text_field", "Improves matching for material-specific shopping intent.", ["100% cotton", "linen blend"]),
      makeRecommendedMetafield("custom", "fit", "single_line_text_field", "Improves matching for fit- and silhouette-led search intent.", ["regular fit", "oversized", "slim fit"])
    ];
  }

  if (industry === "electronics") {
    return [
      ...base,
      makeRecommendedMetafield("custom", "compatibility", "multi_line_text_field", "Helps AI channels match the product to device, platform, or setup intent.", ["Compatible with USB-C iPhone and Android devices."]),
      makeRecommendedMetafield("custom", "technical_specs", "multi_line_text_field", "Captures key technical specs in concise plain text.", ["20W USB-C PD output."])
    ];
  }

  return base;
}

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
        "Do not repeat the brand twice.",
        "Do not stuff multiple variant attributes into the base title when those values belong in option fields."
      ],
      seo_rules: [
        "Keep the highest-intent search terms in the first half of the title.",
        "Prioritize brand, product family, and the strongest decision-driving attribute."
      ],
      edge_case_rules: [
        "Bundle titles must clearly signal the bundle or kit structure.",
        "Variant values belong in the title only when the store and category require it.",
        "When products are represented as variants, keep the base title at the family level and move size, color, storage, pack size, or similar values into variant options unless the category explicitly requires title-level distinction.",
        "If a category requires a variant descriptor in title, include only the minimum shopper-facing differentiator needed to avoid ambiguity."
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
        "Include only details that can be supported by input data, store context, or approved inference rules.",
        "Write descriptions so a catalog specialist can understand exactly what is auto-generated, what is source-backed, and what still requires review."
      ]
    },
    variant_architecture: {
      allowed_dimensions: template.variantDimensions,
      split_vs_variant_rules: [
        "Use variants only when the product family stays meaningfully the same across shopper-facing options.",
        "Split into separate products when identity, compatibility, or buying intent changes materially.",
        "Keep the parent product title, handle, and taxonomy stable across safe variants in the same family."
      ],
      max_variant_logic: [
        "Avoid variant structures that become hard to browse, search, or sync safely.",
        "Escalate oversized matrices for manual review."
      ],
      naming_conventions: [
        "Use clean shopper-facing option names like Size, Color, Storage, or Pack Size.",
        "Do not emit placeholder option names without real values.",
        "Option names must represent how customers actually compare products."
      ],
      duplicate_rules: [
        "Generic values like Default Title are not real differentiators.",
        "Different shopper-facing values within the same family may form variants if the category supports it.",
        "A duplicate should be skipped immediately; a safe new variant should attach to the matched parent product."
      ]
    },
    attributes_metafields_schema: {
      required_fields: ["title", "handle", "description_html", "vendor", "product_type"],
      optional_fields: ["featured_image", "compare_at_price", "tags", "images", "seo_title", "seo_description", "barcode", "sku"],
      standard_shopify_fields: [
        "title",
        "handle",
        "description_html",
        "vendor",
        "product_type",
        "product_category",
        "tags",
        "price",
        "compare_at_price",
        "sku",
        "barcode",
        "images",
        "image_alt_text",
        "seo_title",
        "seo_description"
      ],
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
        "Image replacement decisions.",
        "Variant attachment decisions when parent mapping is ambiguous."
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
        "Title must follow the approved formula and avoid disallowed patterns.",
        "When a product is represented as a variant family, the base title must not repeat option values that belong in variant fields unless the guide explicitly allows it."
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
    },
    agentic_commerce_readiness: {
      principles: [
        "Optimize product listings for AI-driven discovery and recommendation, not just page-level SEO.",
        "Structured, explicit, and decision-ready product data improves recommendation fitness across agentic commerce surfaces.",
        "Products should communicate what they are, who they are for, when they are useful, and why they are a good fit."
      ],
      required_signals: [
        "Clear product identity with stable title, vendor/brand, product type, and pricing.",
        "Decision-driving attributes such as material, ingredients, compatibility, size, fit, flavor, or pack size.",
        "Intent-supporting signals such as use case, audience, occasion, or scenario when relevant to the category.",
        "Reliable product availability, pricing, and media quality signals."
      ],
      description_requirements: [
        "Descriptions should state what the product is, who it is for, when to use it, and the strongest reasons to choose it.",
        "Descriptions should include explicit selection-driving attributes that help AI systems disambiguate the product from similar alternatives.",
        "Descriptions should avoid vague marketing fluff and instead reduce decision uncertainty."
      ],
      faq_requirements: [
        "Add concise decision-ready FAQ content when the category benefits from buyer clarification.",
        "FAQ content should answer the most likely agent or shopper questions about suitability, usage, compatibility, or experience."
      ],
      catalog_mapping_recommendations: [
        "Map Shopify Catalog attributes and grouping logic so variants and duplicate items are represented consistently.",
        "Prefer explicit structured fields or metafields over title parsing wherever possible.",
        "Keep titles, options, tags, and metafields aligned so AI channels see a consistent product identity."
      ],
      recommended_metafields: buildAgenticRecommendedMetafields(normalizedIndustry),
      scoring_model: [
        "Agentic readiness should be evaluated across structured data completeness, decision-ready description quality, intent signal coverage, and recommended field adoption.",
        "Missing recommended metafields should produce actionable recommendations even when they are not yet hard requirements."
      ]
    }
  };

  return applyCatalogGuideCompatibility(policy);
}

function isReviewSentinel(value: unknown): boolean {
  return typeof value === "string" && /requires_review|unknown_requires_review/i.test(value.trim());
}

function cleanInlineText(value: unknown, fallback = "Not defined"): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || isReviewSentinel(trimmed)) return fallback;
  return trimmed;
}

function renderList(items: string[], empty = "- None defined"): string {
  const cleaned = items.map((item) => item.trim()).filter((item) => item.length > 0 && !isReviewSentinel(item));
  return cleaned.length > 0 ? cleaned.map((item) => `- ${item}`).join("\n") : empty;
}

function renderIndentedList(items: string[], empty = "  - None defined"): string {
  const cleaned = items.map((item) => item.trim()).filter((item) => item.length > 0 && !isReviewSentinel(item));
  return cleaned.length > 0 ? cleaned.map((item) => `  - ${item}`).join("\n") : empty;
}

function renderCategoryTree(entries: unknown[]): string {
  if (!Array.isArray(entries) || entries.length === 0) return "- None defined";

  return entries.map((entry) => {
    if (!entry || typeof entry !== "object") return "- Uncategorized branch";
    const record = entry as Record<string, unknown>;
    const heading = cleanInlineText(record.label ?? record.department ?? record.category ?? record.aisle ?? "Category branch", "Category branch");
    const categories = Array.isArray(record.categories) ? record.categories.map((item) => String(item)).filter(Boolean) : [];
    const children = Array.isArray(record.children) ? record.children.map((item) => String(item)).filter(Boolean) : [];
    const details = [
      record.department ? `Department: ${cleanInlineText(record.department, "")}` : "",
      record.category ? `Category: ${cleanInlineText(record.category, "")}` : "",
      record.subcategory ? `Subcategory: ${cleanInlineText(record.subcategory, "")}` : "",
      record.device_type ? `Device type: ${cleanInlineText(record.device_type, "")}` : ""
    ].filter(Boolean);
    const notes = cleanInlineText(record.notes, "");
    return [
      `- ${heading}`,
      ...(details.length > 0 ? [`  - ${details.join(" | ")}`] : []),
      ...(categories.length > 0 ? [`  - Shopper-facing groups: ${categories.join(", ")}`] : []),
      ...(children.length > 0 ? [`  - Child nodes: ${children.join(", ")}`] : []),
      ...(notes ? [`  - Notes: ${notes}`] : [])
    ].join("\n");
  }).join("\n");
}

function renderMetafieldBlocks(metafields: ProductMetafieldValue[]): string {
  if (metafields.length === 0) return "- No guide-defined metafields yet.";

  return metafields.map((field) => [
    `### \`${field.namespace}.${field.key}\``,
    `- Type: ${cleanInlineText(field.type)}`,
    `- Required: ${field.required ? "Yes" : "No"}`,
    `- Automation mode: ${cleanInlineText(field.automation_mode, "review_required")}`,
    `- Source expectation: ${cleanInlineText(field.source, "Guide-defined")}`,
    `- Source field: ${cleanInlineText(field.source_field, "Not specified")}`,
    `- Why it exists: ${cleanInlineText(field.description, "No description provided.")}`,
    `- Validation rules: ${(field.validation_rules ?? []).filter((value) => !isReviewSentinel(value)).join(" | ") || "None defined"}`,
    `- Example values: ${(field.example_values ?? []).filter((value) => !isReviewSentinel(value)).join(" | ") || "None defined"}`,
    `- Primary usage: ${(field.usage ?? []).filter((value) => !isReviewSentinel(value)).join(" | ") || "None defined"}`
  ].join("\n")).join("\n\n");
}

function renderRecommendedMetafields(fields: RecommendedMetafield[]): string {
  if (fields.length === 0) return "- No additional recommended metafields defined.";
  return [
    "| Metafield | Type | Why it matters | Example values |",
    "| --- | --- | --- | --- |",
    ...fields.map((field) => `| \`${field.namespace}.${field.key}\` | ${cleanInlineText(field.type)} | ${cleanInlineText(field.purpose)} | ${(field.example_values ?? []).filter((value) => !isReviewSentinel(value)).join("<br>") || "None defined"} |`)
  ].join("\n");
}

export function renderPolicyMarkdown(policy: PolicyDocument) {
  const metafields = getGuideMetafields(policy);
  const descriptionSections = getGuideDescriptionSections(policy);
  const variantDimensions = getGuideVariantDimensions(policy);
  const titleExamples = Array.isArray(policy.product_title_system?.examples) ? policy.product_title_system.examples.filter((item) => !isReviewSentinel(item)) : [];
  const titleEdgeCases = Array.isArray(policy.product_title_system?.edge_case_rules) ? policy.product_title_system.edge_case_rules : [];
  const descriptionGuidance = Array.isArray(policy.product_description_system?.guidance) ? policy.product_description_system.guidance : [];
  const imageAvoid = Array.isArray(policy.image_media_standards?.avoid) ? policy.image_media_standards.avoid : [];
  const agentic = policy.agentic_commerce_readiness ?? {};
  const businessName = cleanInlineText(policy.meta?.business_name, "Store");
  const summary = cleanInlineText(policy.industry_business_context?.summary, cleanInlineText(policy.meta?.business_description, "No summary provided."));
  const audience = cleanInlineText(policy.industry_business_context?.audience, "General shoppers in the target market.");
  const notes = cleanInlineText(policy.industry_business_context?.notes, "");

  return `# Catalog Guide

> This guide is the operating playbook for catalog creation, enrichment, QA, merchandising, and Shopify publishing. Teams can use it manually, and agents should treat it as a deterministic contract.

## At a Glance
- Business: ${businessName}
- Industry: ${cleanInlineText(policy.meta?.industry)}
- Operating mode: ${cleanInlineText(policy.meta?.operating_mode)}
- Store URL: ${cleanInlineText(policy.meta?.store_url, "Not provided")}
- Primary audience: ${audience}
- Store summary: ${summary}
${notes ? `- Notes: ${notes}` : ""}

## Quick Start Playbook
- Confirm the product is eligible for the store before enrichment begins.
- Build listings around this title formula: ${cleanInlineText(policy.product_title_system?.formula)}.
- Use this description structure in order: ${descriptionSections.join(" -> ") || "guide-defined description sections"}.
- Keep shopper-facing variant dimensions limited to: ${variantDimensions.join(", ") || "guide-defined dimensions"}.
- Do not publish until required Shopify fields and required metafields are complete or explicitly reviewed.

## How To Use This Guide
- Inside the system: agents should follow explicit rules here as deterministic operating constraints.
- Outside the system: catalog, merchandising, and operations teams can use the same rules for onboarding, audits, manual listing work, and approvals.

## Business Context
### Eligibility Rules
#### Accept when
${renderList(Array.isArray(policy.eligibility_rules?.accept) ? policy.eligibility_rules.accept : [])}

#### Reject when
${renderList(Array.isArray(policy.eligibility_rules?.reject) ? policy.eligibility_rules.reject : [])}

## Taxonomy & Categorization
### Hierarchy
${renderList(Array.isArray(policy.taxonomy_design?.hierarchy) ? policy.taxonomy_design.hierarchy : [])}

### Category Map
${renderCategoryTree(Array.isArray(policy.taxonomy_design?.category_tree) ? policy.taxonomy_design.category_tree : [])}

### Collection Logic
${renderList(Array.isArray(policy.taxonomy_design?.collection_logic) ? policy.taxonomy_design.collection_logic : [])}

### Tagging System
${renderList(Array.isArray(policy.taxonomy_design?.tagging_system) ? policy.taxonomy_design.tagging_system : [])}

### Product Type Rules
${renderList(Array.isArray(policy.taxonomy_design?.product_type_rules) ? policy.taxonomy_design.product_type_rules : [])}

### Handle Structure Rules
${renderList(Array.isArray(policy.taxonomy_design?.handle_structure_rules) ? policy.taxonomy_design.handle_structure_rules : [])}

### Categorization Edge Cases
- Duplicates: A duplicate should be skipped, not re-enriched as a new product.
- Near duplicates: Route to review when the product family is similar but the distinction is not yet safe.
- New variants: Attach to the parent family when the shopper-facing option mapping is clear.
- Bundles and multipacks: Treat as separate products when the buying intent is materially different from the single unit.

## Product Title Playbook
- Formula: ${cleanInlineText(policy.product_title_system?.formula)}
- Good examples:
${renderIndentedList(titleExamples)}
- Do:
${renderIndentedList(Array.isArray(policy.product_title_system?.seo_rules) ? policy.product_title_system.seo_rules : [])}
- Avoid:
${renderIndentedList(Array.isArray(policy.product_title_system?.disallowed_patterns) ? policy.product_title_system.disallowed_patterns : [])}
- Edge cases:
${renderIndentedList(titleEdgeCases)}

## Product Description Playbook
- Structure template:
${renderIndentedList(descriptionSections)}
- Tone rules:
${renderIndentedList(Array.isArray(policy.product_description_system?.tone_rules) ? policy.product_description_system.tone_rules : [])}
- Length rules:
${renderIndentedList(Array.isArray(policy.product_description_system?.length_rules) ? policy.product_description_system.length_rules : [])}
- Formatting rules:
${renderIndentedList(Array.isArray(policy.product_description_system?.formatting_rules) ? policy.product_description_system.formatting_rules : [])}
- Auto-generatable:
${renderIndentedList(Array.isArray(policy.product_description_system?.auto_generatable) ? policy.product_description_system.auto_generatable : [])}
- Manual-required:
${renderIndentedList(Array.isArray(policy.product_description_system?.manual_required) ? policy.product_description_system.manual_required : [])}
- Guidance:
${renderIndentedList(descriptionGuidance)}

### Description Edge Cases
- If exact factual data is verified from trusted sources, include it in the appropriate section.
- If exact factual data is not verified, leave it empty rather than inserting placeholder or internal review text.
- Keep customer-facing copy clean: no internal notes, no review text, and no “check pack” style language.

## Variant Architecture
- Allowed dimensions: ${variantDimensions.join(", ") || "Not defined"}
- Split vs variant rules:
${renderIndentedList(Array.isArray(policy.variant_architecture?.split_vs_variant_rules) ? policy.variant_architecture.split_vs_variant_rules : [])}
- Max variant logic:
${renderIndentedList(Array.isArray(policy.variant_architecture?.max_variant_logic) ? policy.variant_architecture.max_variant_logic : [])}
- Naming conventions:
${renderIndentedList(Array.isArray(policy.variant_architecture?.naming_conventions) ? policy.variant_architecture.naming_conventions : [])}
- Duplicate rules:
${renderIndentedList(Array.isArray(policy.variant_architecture?.duplicate_rules) ? policy.variant_architecture.duplicate_rules : [])}

### Variant Decision Playbook
- New product: use when identity, compatibility, or buying intent materially changes.
- New variant: use when the family stays the same and the shopper-facing difference is a safe option dimension.
- Duplicate: skip when the product identity and variant signature already exist.
- Needs review: use when family similarity is high but the safe attachment path is unclear.

## Shopify Fields & Metafields
- Required fields: ${(policy.attributes_metafields_schema?.required_fields ?? []).join(", ") || "None defined"}
- Optional fields: ${(policy.attributes_metafields_schema?.optional_fields ?? []).join(", ") || "None defined"}
- Standard Shopify fields in scope: ${(policy.attributes_metafields_schema?.standard_shopify_fields ?? []).join(", ") || "None defined"}
- Fill rules:
${renderIndentedList(Array.isArray(policy.attributes_metafields_schema?.fill_rules) ? policy.attributes_metafields_schema.fill_rules : [])}
- Guidance: ${cleanInlineText(policy.attributes_metafields_schema?.guidance, "Use metafields to improve filtering, merchandising, SEO, UX, and internal decision logic.")}

## Metafield Definitions
${renderMetafieldBlocks(metafields)}

## Image & Media Standards
- Image types:
${renderIndentedList(Array.isArray(policy.image_media_standards?.image_types) ? policy.image_media_standards.image_types : [])}
- Background rules:
${renderIndentedList(Array.isArray(policy.image_media_standards?.background_rules) ? policy.image_media_standards.background_rules : [])}
- Aspect ratios:
${renderIndentedList(Array.isArray(policy.image_media_standards?.aspect_ratios) ? policy.image_media_standards.aspect_ratios : [])}
- Alt text rules:
${renderIndentedList(Array.isArray(policy.image_media_standards?.alt_text_rules) ? policy.image_media_standards.alt_text_rules : [])}
- Automation tagging rules:
${renderIndentedList(Array.isArray(policy.image_media_standards?.automation_tagging_rules) ? policy.image_media_standards.automation_tagging_rules : [])}
- Avoid:
${renderIndentedList(imageAvoid)}

### Image Edge Cases
- If exact-pack imagery is available and compliant, prefer it.
- If exact-pack imagery is unavailable, only use a same-family fallback when there are no conflicting visible markers.
- Reject logo-only, unrelated, cropped, unreadable, or clearly mismatched product images.

## Merchandising Playbook
### Collection Sorting Logic
${renderList(Array.isArray(policy.merchandising_rules?.collection_sorting_logic) ? policy.merchandising_rules.collection_sorting_logic : [])}

### Cross-sell Rules
${renderList(Array.isArray(policy.merchandising_rules?.cross_sell_rules) ? policy.merchandising_rules.cross_sell_rules : [])}

### Upsell Rules
${renderList(Array.isArray(policy.merchandising_rules?.upsell_rules) ? policy.merchandising_rules.upsell_rules : [])}

### Product Grouping Logic
${renderList(Array.isArray(policy.merchandising_rules?.product_grouping_logic) ? policy.merchandising_rules.product_grouping_logic : [])}

## SEO & Discovery Rules
### Meta Title Format
${renderList(Array.isArray(policy.seo_discovery_rules?.meta_title_format) ? policy.seo_discovery_rules.meta_title_format : [])}

### Meta Description Rules
${renderList(Array.isArray(policy.seo_discovery_rules?.meta_description_rules) ? policy.seo_discovery_rules.meta_description_rules : [])}

### URL Handle Rules
${renderList(Array.isArray(policy.seo_discovery_rules?.url_handle_rules) ? policy.seo_discovery_rules.url_handle_rules : [])}

### Keyword Usage Patterns
${renderList(Array.isArray(policy.seo_discovery_rules?.keyword_usage_patterns) ? policy.seo_discovery_rules.keyword_usage_patterns : [])}

## Agentic Commerce Readiness
### Principles
${renderList(Array.isArray(agentic.principles) ? agentic.principles : [])}

### Required Signals
${renderList(Array.isArray(agentic.required_signals) ? agentic.required_signals : [])}

### Description Requirements
${renderList(Array.isArray(agentic.description_requirements) ? agentic.description_requirements : [])}

### FAQ Requirements
${renderList(Array.isArray(agentic.faq_requirements) ? agentic.faq_requirements : [])}

### Catalog Mapping Recommendations
${renderList(Array.isArray(agentic.catalog_mapping_recommendations) ? agentic.catalog_mapping_recommendations : [])}

### Recommended Metafields To Add
${renderRecommendedMetafields(Array.isArray(agentic.recommended_metafields) ? agentic.recommended_metafields : [])}

### Scoring Model
${renderList(Array.isArray(agentic.scoring_model) ? agentic.scoring_model : [])}

## Automation & Review Boundaries
- Safe to automate:
${renderIndentedList(Array.isArray(policy.automation_playbook?.fully_automated) ? policy.automation_playbook.fully_automated : [])}
- Validation checkpoints:
${renderIndentedList(Array.isArray(policy.automation_playbook?.validation_checkpoints) ? policy.automation_playbook.validation_checkpoints : [])}
- Human approval required:
${renderIndentedList(Array.isArray(policy.automation_playbook?.human_approval_required) ? policy.automation_playbook.human_approval_required : [])}
- Fallback rules:
${renderIndentedList(Array.isArray(policy.automation_playbook?.fallback_rules) ? policy.automation_playbook.fallback_rules : [])}
- Error handling rules:
${renderIndentedList(Array.isArray(policy.automation_playbook?.error_handling_rules) ? policy.automation_playbook.error_handling_rules : [])}

## QA & Validation System
- Passing Score: ${policy.qa_validation_system?.passing_score ?? "Not defined"}
- Title validation:
${renderIndentedList(Array.isArray(policy.qa_validation_system?.title_validation) ? policy.qa_validation_system.title_validation : [])}
- Variant validation:
${renderIndentedList(Array.isArray(policy.qa_validation_system?.variant_validation) ? policy.qa_validation_system.variant_validation : [])}
- Metafield completeness:
${renderIndentedList(Array.isArray(policy.qa_validation_system?.metafield_completeness) ? policy.qa_validation_system.metafield_completeness : [])}
- Image checks:
${renderIndentedList(Array.isArray(policy.qa_validation_system?.image_checks) ? policy.qa_validation_system.image_checks : [])}
- SEO checks:
${renderIndentedList(Array.isArray(policy.qa_validation_system?.seo_checks) ? policy.qa_validation_system.seo_checks : [])}
- Pass/fail conditions:
${renderIndentedList(Array.isArray(policy.qa_validation_system?.pass_fail_conditions) ? policy.qa_validation_system.pass_fail_conditions : [])}
- Auto-fix rules:
${renderIndentedList(Array.isArray(policy.qa_validation_system?.auto_fix_rules) ? policy.qa_validation_system.auto_fix_rules : [])}

## Worked Examples & Operator Guidance
- Good title example: ${cleanInlineText(titleExamples[0], "Use the guide title formula with a stable family identity.")}
- Good description sections example: ${descriptionSections.join(" -> ") || "Not defined"}
- Variant example: Parent title stays stable, option values carry the shopper-facing differentiation.
- Duplicate example: If identity and variant signature already exist, skip instead of re-creating.
- Missing factual data example: Leave unverifiable ingredients, nutrition, or specs empty rather than inventing them.
`;
}

export function initialLearningMarkdown(policy: PolicyDocument) {
  return `# Catalog Learning

- Initialized for ${policy.meta?.business_name ?? "Unknown Store"} (${policy.meta?.industry ?? "unknown"}) on ${policy.meta?.generated_at ?? new Date().toISOString()}
- Add distilled lessons here as review outcomes accumulate.
`;
}
