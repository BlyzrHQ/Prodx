/**
 * Catalog Guide Template
 *
 * Reusable structure for the catalog guide. Same template for every business — only content changes.
 * The LLM fills each section based on business context, Shopify data, and industry.
 *
 * Agents treat this as a deterministic contract:
 * - Enricher: uses title formula, description structure, metafield definitions, eligibility rules
 * - QA: uses passing_score, validation rules, auto-fix rules
 * - Image: uses image standards, alt text rules
 * - Matcher: uses variant architecture, eligibility rules
 * - Collection Builder: uses taxonomy, merchandising rules
 * - Supervisor: uses automation playbook boundaries
 */

export interface GuideContext {
  businessName: string;
  businessDescription: string;
  industry: string;
  storeUrl?: string;
  shopifyMetafields: Array<{ namespace: string; key: string; type: string; description?: string; validations?: Array<{ name: string; value: string }> }>;
  shopifyProductTypes: string[];
  shopifyTags: string[];
  shopifyVendors: string[];
  metaobjectTypes: string[];
  sampleProducts?: Array<{ title: string; productType: string; vendor: string; metafields?: string[] }>;
}

/**
 * Build the LLM prompt to generate the guide.
 */
export function buildGuidePrompt(ctx: GuideContext): { system: string; user: string } {
  const metafieldList = ctx.shopifyMetafields.length > 0
    ? ctx.shopifyMetafields.map((m) => {
        let line = `- ${m.namespace}.${m.key} (${m.type})`;
        if (m.description) line += `: ${m.description}`;
        if (m.validations?.length) line += ` [validations: ${m.validations.map((v) => `${v.name}=${v.value}`).join(", ")}]`;
        return line;
      }).join("\n")
    : "None discovered";

  const system = `You are a Senior Catalog Strategist and Shopify Product Data Architect.

Generate a comprehensive Catalog Guide as a JSON object. This guide is the operating playbook for catalog creation, enrichment, QA, merchandising, and Shopify publishing. Teams use it manually, and AI agents treat it as a deterministic contract.

CRITICAL RULES:
- Every section must contain specific, actionable content for THIS business — no generic placeholders.
- Use the Shopify store data provided (product types, tags, vendors, metafields, metaobjects) to make all rules concrete.
- ALL existing Shopify metafield definitions must appear in attributes_metafields_schema.metafields with their actual type, namespace, key, and validation rules.
- You may recommend additional metafields for AI-commerce readiness beyond what exists.
- The guide must be executable by both humans and AI agents without ambiguity.

Return a JSON object with EXACTLY these top-level keys:

"at_a_glance": {
  "name": string, "industry": string, "operating_mode": string, "store_url": string,
  "primary_audience": string, "store_summary": string, "notes": string
}

"quick_start_playbook": string[] (5-6 key operational rules — eligibility check, title formula, description structure, variant dimensions, publish gate)

"eligibility_rules": {
  "accept_when": string[] (specific criteria for accepting products into this catalog),
  "reject_when": string[] (specific criteria for rejecting products)
}

"taxonomy": {
  "hierarchy": string[] (e.g. ["Aisle", "Sub-section", "Product type"]),
  "category_map": Array<{ "name": string, "department": string, "category": string, "groups": string[], "notes": string }>,
  "collection_logic": string,
  "tagging_system": string (specific tag format rules with examples),
  "product_type_rules": string,
  "handle_structure_rules": string,
  "edge_cases": { "duplicates": string, "near_duplicates": string, "new_variants": string, "bundles": string }
}

"product_title_system": {
  "formula": string (e.g. "Brand + Product + Key Attribute + Size"),
  "good_examples": string[] (3-5 realistic examples for this business),
  "do_rules": string[],
  "avoid_rules": string[],
  "edge_cases": { "bundles": string, "multipacks": string, "flavor_led": string, "multi_variant": string }
}

"product_description_system": {
  "structure_template": string[] (ordered section names e.g. ["Overview", "Key Product Details", "Ingredients Or Composition", "Storage Or Handling"]),
  "tone_rules": string[],
  "length_rules": string,
  "formatting_rules": string,
  "auto_generatable": string[] (sections safe to auto-generate),
  "manual_required": string[] (sections requiring human input),
  "guidance": string[],
  "edge_cases": string[]
}

"variant_architecture": {
  "allowed_dimensions": string[] (e.g. ["Size", "Type", "Form", "Pack Size"]),
  "split_vs_variant_rules": string[],
  "max_variant_logic": string,
  "naming_conventions": string,
  "duplicate_rules": string,
  "decision_playbook": { "new_product": string, "new_variant": string, "duplicate": string, "needs_review": string }
}

"attributes_metafields_schema": {
  "required_fields": string[] (Shopify core fields that must be filled),
  "optional_fields": string[],
  "standard_shopify_fields": string[] (all standard fields in scope),
  "fill_rules": string[],
  "guidance": string,
  "metafields": Array<{
    "namespace": string, "key": string, "type": string, "required": boolean,
    "automation_mode": string (one of: "safe_if_taxonomy_match", "review_required", "manual_only"),
    "source_field": string, "description": string,
    "validation_rules": string[], "example_values": string[], "primary_usage": string
  }>
}

"image_media_standards": {
  "image_types": string[] (e.g. ["hero", "pack shot", "detail", "lifestyle"]),
  "background_rules": string,
  "aspect_ratios": string[],
  "alt_text_rules": string,
  "automation_tagging_rules": string,
  "avoid": string[],
  "edge_cases": string[]
}

"merchandising_rules": {
  "collection_sorting_logic": string,
  "cross_sell_rules": string,
  "upsell_rules": string,
  "product_grouping_logic": string
}

"seo_discovery_rules": {
  "meta_title_format": string (e.g. "Brand + Product + Key Attribute + Size | StoreName"),
  "meta_description_rules": string,
  "url_handle_rules": string,
  "keyword_usage_patterns": string
}

"agentic_commerce_readiness": {
  "principles": string[],
  "required_signals": string[],
  "description_requirements": string[],
  "faq_requirements": string[],
  "catalog_mapping_recommendations": string[],
  "recommended_metafields": Array<{ "metafield": string, "type": string, "why": string, "example_values": string[] }>,
  "scoring_model": string
}

"automation_playbook": {
  "safe_to_automate": string[],
  "validation_checkpoints": string[],
  "human_approval_required": string[],
  "fallback_rules": string[],
  "error_handling_rules": string[]
}

"qa_validation_system": {
  "passing_score": number (0-100),
  "title_validation": string[],
  "variant_validation": string[],
  "metafield_completeness": string[],
  "image_checks": string[],
  "seo_checks": string[],
  "pass_fail_conditions": string[],
  "auto_fix_rules": string[]
}`;

  const user = `## Business
- Name: ${ctx.businessName}
- Description: ${ctx.businessDescription}
- Industry: ${ctx.industry}
${ctx.storeUrl ? `- Store URL: ${ctx.storeUrl}` : ""}

## Existing Shopify Product Types (${ctx.shopifyProductTypes.length})
${ctx.shopifyProductTypes.slice(0, 60).join(", ")}${ctx.shopifyProductTypes.length > 60 ? "..." : ""}

## Existing Tags (${ctx.shopifyTags.length})
${ctx.shopifyTags.slice(0, 40).join(", ")}${ctx.shopifyTags.length > 40 ? "..." : ""}

## Existing Vendors (${ctx.shopifyVendors.length})
${ctx.shopifyVendors.slice(0, 40).join(", ")}${ctx.shopifyVendors.length > 40 ? "..." : ""}

## Metaobject Types
${ctx.metaobjectTypes.join(", ") || "None"}

## Existing Metafield Definitions (MUST all appear in the guide)
${metafieldList}

${ctx.sampleProducts?.length ? `## Sample Products (for context)\n${ctx.sampleProducts.slice(0, 10).map((p) => `- ${p.vendor} ${p.title} (${p.productType})${p.metafields?.length ? ` [metafields: ${p.metafields.join(", ")}]` : ""}`).join("\n")}` : ""}

Generate the complete Catalog Guide as a single JSON object with all sections filled.`;

  return { system, user };
}

/**
 * Convert the JSON guide to a human-readable markdown document.
 */
export function guideToMarkdown(guide: Record<string, unknown>, ctx: GuideContext): string {
  const g = guide as any;
  const lines: string[] = [];

  lines.push("# Catalog Guide\n");
  lines.push("> This guide is the operating playbook for catalog creation, enrichment, QA, merchandising, and Shopify publishing. Teams can use it manually, and agents should treat it as a deterministic contract.\n");

  // ── At a Glance ──
  const aa = g.at_a_glance ?? {};
  lines.push("## At a Glance");
  lines.push(`- Business: ${aa.name ?? ctx.businessName}`);
  lines.push(`- Industry: ${aa.industry ?? ctx.industry}`);
  lines.push(`- Operating mode: ${aa.operating_mode ?? "both"}`);
  if (ctx.storeUrl) lines.push(`- Store URL: ${ctx.storeUrl}`);
  if (aa.primary_audience) lines.push(`- Primary audience: ${aa.primary_audience}`);
  if (aa.store_summary) lines.push(`- Store summary: ${aa.store_summary}`);
  if (aa.notes) lines.push(`- Notes: ${aa.notes}`);
  lines.push("");

  // ── Quick Start Playbook ──
  const qsp = g.quick_start_playbook ?? [];
  if (Array.isArray(qsp) && qsp.length > 0) {
    lines.push("## Quick Start Playbook");
    for (const rule of qsp) lines.push(`- ${rule}`);
    lines.push("");
  }

  // ── How To Use ──
  lines.push("## How To Use This Guide");
  lines.push("- Inside the system: agents should follow explicit rules here as deterministic operating constraints.");
  lines.push("- Outside the system: catalog, merchandising, and operations teams can use the same rules for onboarding, audits, manual listing work, and approvals.\n");

  // ── Eligibility Rules ──
  const er = g.eligibility_rules ?? {};
  lines.push("## Business Context");
  lines.push("### Eligibility Rules");
  if (er.accept_when?.length) {
    lines.push("#### Accept when");
    for (const r of er.accept_when) lines.push(`- ${r}`);
  }
  if (er.reject_when?.length) {
    lines.push("\n#### Reject when");
    for (const r of er.reject_when) lines.push(`- ${r}`);
  }
  lines.push("");

  // ── Taxonomy ──
  const tax = g.taxonomy ?? {};
  lines.push("## Taxonomy & Categorization");
  if (tax.hierarchy?.length) {
    lines.push("### Hierarchy");
    for (const h of tax.hierarchy) lines.push(`- ${h}`);
  }
  if (tax.category_map?.length) {
    lines.push("\n### Category Map");
    for (const cat of tax.category_map) {
      lines.push(`- ${cat.name}`);
      if (cat.department) lines.push(`  - Department: ${cat.department} | Category: ${cat.category ?? cat.name}`);
      if (cat.groups?.length) lines.push(`  - Shopper-facing groups: ${cat.groups.join(", ")}`);
      if (cat.notes) lines.push(`  - Notes: ${cat.notes}`);
    }
  }
  if (tax.collection_logic) lines.push(`\n### Collection Logic\n${tax.collection_logic}`);
  if (tax.tagging_system) lines.push(`\n### Tagging System\n${tax.tagging_system}`);
  if (tax.product_type_rules) lines.push(`\n### Product Type Rules\n${tax.product_type_rules}`);
  if (tax.handle_structure_rules) lines.push(`\n### Handle Structure Rules\n${tax.handle_structure_rules}`);
  if (tax.edge_cases) {
    lines.push("\n### Categorization Edge Cases");
    for (const [k, v] of Object.entries(tax.edge_cases)) {
      lines.push(`- ${k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}: ${v}`);
    }
  }
  lines.push("");

  // ── Product Title ──
  const pts = g.product_title_system ?? {};
  lines.push("## Product Title Playbook");
  if (pts.formula) lines.push(`- Formula: ${pts.formula}`);
  if (pts.good_examples?.length) {
    lines.push("- Good examples:");
    for (const ex of pts.good_examples) lines.push(`  - ${ex}`);
  }
  if (pts.do_rules?.length) {
    lines.push("- Do:");
    for (const r of pts.do_rules) lines.push(`  - ${r}`);
  }
  if (pts.avoid_rules?.length) {
    lines.push("- Avoid:");
    for (const r of pts.avoid_rules) lines.push(`  - ${r}`);
  }
  if (pts.edge_cases) {
    lines.push("- Edge cases:");
    for (const [k, v] of Object.entries(pts.edge_cases)) {
      lines.push(`  - ${k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}: ${v}`);
    }
  }
  lines.push("");

  // ── Product Description ──
  const pds = g.product_description_system ?? {};
  lines.push("## Product Description Playbook");
  if (pds.structure_template?.length) lines.push(`- Structure template:\n  - ${pds.structure_template.join("\n  - ")}`);
  if (pds.tone_rules?.length) {
    lines.push("- Tone rules:");
    for (const r of pds.tone_rules) lines.push(`  - ${r}`);
  }
  if (pds.length_rules) lines.push(`- Length rules: ${pds.length_rules}`);
  if (pds.formatting_rules) lines.push(`- Formatting rules: ${pds.formatting_rules}`);
  if (pds.auto_generatable?.length) lines.push(`- Auto-generatable: ${pds.auto_generatable.join(", ")}`);
  if (pds.manual_required?.length) lines.push(`- Manual-required: ${pds.manual_required.join(", ")}`);
  if (pds.guidance?.length) {
    lines.push("- Guidance:");
    for (const r of pds.guidance) lines.push(`  - ${r}`);
  }
  if (pds.edge_cases?.length) {
    lines.push("\n### Description Edge Cases");
    for (const r of pds.edge_cases) lines.push(`- ${r}`);
  }
  lines.push("");

  // ── Variant Architecture ──
  const va = g.variant_architecture ?? {};
  lines.push("## Variant Architecture");
  if (va.allowed_dimensions?.length) lines.push(`- Allowed dimensions: ${va.allowed_dimensions.join(", ")}`);
  if (va.split_vs_variant_rules?.length) {
    lines.push("- Split vs variant rules:");
    for (const r of va.split_vs_variant_rules) lines.push(`  - ${r}`);
  }
  if (va.max_variant_logic) lines.push(`- Max variant logic: ${va.max_variant_logic}`);
  if (va.naming_conventions) lines.push(`- Naming conventions: ${va.naming_conventions}`);
  if (va.duplicate_rules) lines.push(`- Duplicate rules: ${va.duplicate_rules}`);
  if (va.decision_playbook) {
    lines.push("\n### Variant Decision Playbook");
    for (const [k, v] of Object.entries(va.decision_playbook)) {
      lines.push(`- ${k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}: ${v}`);
    }
  }
  lines.push("");

  // ── Metafields ──
  const ams = g.attributes_metafields_schema ?? {};
  lines.push("## Shopify Fields & Metafields");
  if (ams.required_fields?.length) lines.push(`- Required fields: ${ams.required_fields.join(", ")}`);
  if (ams.optional_fields?.length) lines.push(`- Optional fields: ${ams.optional_fields.join(", ")}`);
  if (ams.standard_shopify_fields?.length) lines.push(`- Standard Shopify fields in scope: ${ams.standard_shopify_fields.join(", ")}`);
  if (ams.fill_rules?.length) {
    lines.push("- Fill rules:");
    for (const r of ams.fill_rules) lines.push(`  - ${r}`);
  }
  if (ams.guidance) lines.push(`- Guidance: ${ams.guidance}`);

  if (ams.metafields?.length) {
    lines.push("\n## Metafield Definitions");
    for (const mf of ams.metafields) {
      lines.push(`### \`${mf.namespace}.${mf.key}\``);
      lines.push(`- Type: ${mf.type}`);
      if (mf.required != null) lines.push(`- Required: ${mf.required ? "Yes" : "No"}`);
      if (mf.automation_mode) lines.push(`- Automation mode: ${mf.automation_mode}`);
      if (mf.source_field) lines.push(`- Source field: ${mf.source_field}`);
      if (mf.description) lines.push(`- Why it exists: ${mf.description}`);
      if (mf.validation_rules?.length) lines.push(`- Validation rules: ${mf.validation_rules.join(", ")}`);
      if (mf.example_values?.length) lines.push(`- Example values: ${mf.example_values.join(", ")}`);
      if (mf.primary_usage) lines.push(`- Primary usage: ${mf.primary_usage}`);
      lines.push("");
    }
  }

  // ── Image Standards ──
  const ims = g.image_media_standards ?? {};
  lines.push("## Image & Media Standards");
  if (ims.image_types?.length) lines.push(`- Image types: ${ims.image_types.join(", ")}`);
  if (ims.background_rules) lines.push(`- Background rules: ${ims.background_rules}`);
  if (ims.aspect_ratios?.length) lines.push(`- Aspect ratios: ${ims.aspect_ratios.join(", ")}`);
  if (ims.alt_text_rules) lines.push(`- Alt text rules: ${ims.alt_text_rules}`);
  if (ims.automation_tagging_rules) lines.push(`- Automation tagging rules: ${ims.automation_tagging_rules}`);
  if (ims.avoid?.length) lines.push(`- Avoid: ${ims.avoid.join(", ")}`);
  if (ims.edge_cases?.length) {
    lines.push("\n### Image Edge Cases");
    for (const r of ims.edge_cases) lines.push(`- ${r}`);
  }
  lines.push("");

  // ── Merchandising ──
  const mr = g.merchandising_rules ?? {};
  lines.push("## Merchandising Playbook");
  if (mr.collection_sorting_logic) lines.push(`### Collection Sorting Logic\n${mr.collection_sorting_logic}`);
  if (mr.cross_sell_rules) lines.push(`\n### Cross-sell Rules\n${mr.cross_sell_rules}`);
  if (mr.upsell_rules) lines.push(`\n### Upsell Rules\n${mr.upsell_rules}`);
  if (mr.product_grouping_logic) lines.push(`\n### Product Grouping Logic\n${mr.product_grouping_logic}`);
  lines.push("");

  // ── SEO ──
  const seo = g.seo_discovery_rules ?? {};
  lines.push("## SEO & Discovery Rules");
  if (seo.meta_title_format) lines.push(`### Meta Title Format\n${seo.meta_title_format}`);
  if (seo.meta_description_rules) lines.push(`\n### Meta Description Rules\n${seo.meta_description_rules}`);
  if (seo.url_handle_rules) lines.push(`\n### URL Handle Rules\n${seo.url_handle_rules}`);
  if (seo.keyword_usage_patterns) lines.push(`\n### Keyword Usage Patterns\n${seo.keyword_usage_patterns}`);
  lines.push("");

  // ── Agentic Commerce ──
  const acr = g.agentic_commerce_readiness ?? {};
  lines.push("## Agentic Commerce Readiness");
  if (acr.principles?.length) {
    lines.push("### Principles");
    for (const p of acr.principles) lines.push(`- ${p}`);
  }
  if (acr.required_signals?.length) {
    lines.push("\n### Required Signals");
    for (const r of acr.required_signals) lines.push(`- ${r}`);
  }
  if (acr.description_requirements?.length) {
    lines.push("\n### Description Requirements");
    for (const r of acr.description_requirements) lines.push(`- ${r}`);
  }
  if (acr.catalog_mapping_recommendations?.length) {
    lines.push("\n### Catalog Mapping Recommendations");
    for (const r of acr.catalog_mapping_recommendations) lines.push(`- ${r}`);
  }
  if (acr.recommended_metafields?.length) {
    lines.push("\n### Recommended Metafields To Add");
    lines.push("| Metafield | Type | Why it matters | Example values |");
    lines.push("| --- | --- | --- | --- |");
    for (const m of acr.recommended_metafields) {
      const vals = Array.isArray(m.example_values) ? m.example_values.join(", ") : (m.example_values ?? "");
      lines.push(`| \`${m.metafield}\` | ${m.type} | ${m.why} | ${vals} |`);
    }
  }
  if (acr.scoring_model) lines.push(`\n### Scoring Model\n${acr.scoring_model}`);
  lines.push("");

  // ── Automation ──
  const ap = g.automation_playbook ?? {};
  lines.push("## Automation & Review Boundaries");
  if (ap.safe_to_automate?.length) {
    lines.push("- Safe to automate:");
    for (const r of ap.safe_to_automate) lines.push(`  - ${r}`);
  }
  if (ap.validation_checkpoints?.length) {
    lines.push("- Validation checkpoints:");
    for (const r of ap.validation_checkpoints) lines.push(`  - ${r}`);
  }
  if (ap.human_approval_required?.length) {
    lines.push("- Human approval required:");
    for (const r of ap.human_approval_required) lines.push(`  - ${r}`);
  }
  if (ap.fallback_rules?.length) {
    lines.push("- Fallback rules:");
    for (const r of ap.fallback_rules) lines.push(`  - ${r}`);
  }
  if (ap.error_handling_rules?.length) {
    lines.push("- Error handling rules:");
    for (const r of ap.error_handling_rules) lines.push(`  - ${r}`);
  }
  lines.push("");

  // ── QA ──
  const qa = g.qa_validation_system ?? {};
  lines.push("## QA & Validation System");
  if (qa.passing_score) lines.push(`- Passing Score: ${qa.passing_score}`);
  if (qa.title_validation?.length) {
    lines.push("- Title validation:");
    for (const r of qa.title_validation) lines.push(`  - ${r}`);
  }
  if (qa.variant_validation?.length) {
    lines.push("- Variant validation:");
    for (const r of qa.variant_validation) lines.push(`  - ${r}`);
  }
  if (qa.metafield_completeness?.length) {
    lines.push("- Metafield completeness:");
    for (const r of qa.metafield_completeness) lines.push(`  - ${r}`);
  }
  if (qa.image_checks?.length) {
    lines.push("- Image checks:");
    for (const r of qa.image_checks) lines.push(`  - ${r}`);
  }
  if (qa.seo_checks?.length) {
    lines.push("- SEO checks:");
    for (const r of qa.seo_checks) lines.push(`  - ${r}`);
  }
  if (qa.pass_fail_conditions?.length) {
    lines.push("- Pass/fail conditions:");
    for (const r of qa.pass_fail_conditions) lines.push(`  - ${r}`);
  }
  if (qa.auto_fix_rules?.length) {
    lines.push("- Auto-fix rules:");
    for (const r of qa.auto_fix_rules) lines.push(`  - ${r}`);
  }
  lines.push("");

  return lines.join("\n");
}
