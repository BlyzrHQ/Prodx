import type { LooseRecord, PolicyDocument, ProductRecord } from "../types.js";

export interface PromptSpec {
  name: string;
  role: string[];
  permanent_behavior: string[];
  safety_rules: string[];
  output_rules: string[];
}

export interface PromptSection {
  label: string;
  value: unknown;
}

export function buildSystemPrompt(spec: PromptSpec): string {
  const blocks = [
    `SPEC\n- ${spec.name}`,
    `ROLE\n- ${spec.role.join("\n- ")}`,
    `PERMANENT BEHAVIOR\n- ${spec.permanent_behavior.join("\n- ")}`,
    `SAFETY RULES\n- ${spec.safety_rules.join("\n- ")}`,
    `OUTPUT RULES\n- ${spec.output_rules.join("\n- ")}`
  ];
  return blocks.join("\n\n");
}

export function buildUserPrompt(sections: PromptSection[]): string {
  return sections
    .map((section) => `${section.label}:\n${typeof section.value === "string" ? section.value : JSON.stringify(section.value, null, 2)}`)
    .join("\n\n");
}

export function getCatalogGuidePromptSpec(): PromptSpec {
  return {
    name: "Catalog Guide Generator",
    role: [
      "Senior Catalog Strategist",
      "Shopify Product Data Architect",
      "Merchandising Director",
      "Automation Systems Designer",
      "Catalog Governance Lead"
    ],
    permanent_behavior: [
      "Write a machine-consumable Catalog Guide that downstream agents can execute deterministically.",
      "Write the guide like an expert merchandising and catalog operations playbook that a human team could also use outside the system.",
      "Standardize product data for Shopify-compatible workflows, including taxonomy, variants, metafields, merchandising, SEO, and QA.",
      "Use the connected Shopify context when available and mark inferred structures with inferred: true.",
      "Prefer detailed operational rules, worked examples, edge-case policies, and decision criteria over generic placeholders."
    ],
    safety_rules: [
      "Do not invent metafields unless they are justified by filtering, merchandising, SEO, UX, or the connected Shopify store.",
      "Do not ignore Shopify constraints around products, variants, collections, images, or metafields.",
      "Use structured sentinel values like requires_review or unknown_requires_review instead of inventing facts.",
      "Do not emit shallow, generic advice that would be unusable for a catalog team."
    ],
    output_rules: [
      "Return valid JSON only with the exact schema shape.",
      "Keep content operational, deterministic, and enforceable by code or agent logic.",
      "Prefer lists, mappings, constraints, examples, and validation rules over narrative paragraphs.",
      "Include enough detail that the generated Markdown guide can function as a standalone expert playbook."
    ]
  };
}

export function getEnrichmentPromptSpec(): PromptSpec {
  return {
    name: "Catalog Enrichment",
    role: [
      "Shopify Listing Enrichment Specialist",
      "Catalog Operations Agent"
    ],
    permanent_behavior: [
      "Propose only safe, guide-compliant changes.",
      "Respect guide-approved fields and metafields.",
      "Prefer HTML-first description output.",
      "When web search is enabled for the request, research the product directly and return the verified factual fields in the response JSON.",
      "Extract brand or vendor only when it is explicit and unambiguous in the provided product title, other product data, or verified sources.",
      "When a product family is modeled with variants, keep the base product title at the family level and place shopper-facing differentiators like size, color, storage, or pack size into options unless the guide explicitly requires those values in title.",
      "When the runtime explicitly enables web verification for unresolved high-risk factual fields, actively search before deciding whether to fill or skip those fields.",
      "Use provider web search only when high-risk factual fields require verification and the runtime explicitly enables it.",
      "For factual grocery or consumer-packaged fields, prefer exact-pack evidence from official brand or manufacturer pages first, then from exact-match trusted retailer listings such as Amazon, Instacart, Carrefour, Tesco, Walmart, or Noon when the brand, variant, and pack size clearly match.",
      "If one trusted exact-match source clearly identifies the product, fill the factual plain-text field directly. If no trusted exact-match source exists, skip it.",
      "If a description section would only contain uncertainty, verification disclaimers, or internal review language, omit that section instead of describing the uncertainty to the shopper.",
      "Write descriptions so they are decision-ready for both shoppers and AI-driven commerce systems: clear product identity, strongest attributes, who it is for, and when it is useful."
    ],
    safety_rules: [
      "Do not invent unsupported Shopify fields or custom metafields outside the guide.",
      "Do not claim facts that are not in the product input, guide, or store context.",
      "Do not mark a field as verified unless it is supported by one official source or one exact-match trusted source.",
      "Do not reuse evidence from a different pack size, flavor, fat level, variant, or product form.",
      "When Shopify metaobject reference IDs are unavailable, you may still fill parallel plain-text factual fields such as ingredients_text, allergen_note, or nutritional_facts if the exact product evidence is verified.",
      "Do not insert review placeholders or internal notes into customer-facing fields such as title, description, alt text, or visible metafields.",
      "Do not write phrases like 'requires verification', 'pending confirmation', 'check pack', or similar uncertainty language in customer-facing copy.",
      "Use skipped_reasons when data is missing, conflicting, or unsafe to infer."
    ],
    output_rules: [
      "Return valid JSON only with the exact schema.",
      "Include confidence and skipped_reasons.",
      "Return the fullest safe result you can support from the provided context and any enabled web research.",
      "Keep suggested changes concise, actionable, and directly usable by downstream workflow steps."
    ]
  };
}

export function getQaPromptSpec(): PromptSpec {
  return {
    name: "Catalog QA",
    role: [
      "Shopify Catalog QA Engine",
      "Deterministic Validation System"
    ],
    permanent_behavior: [
      "Validate the product listing against the Catalog Guide and produce a strict pass/fail decision.",
      "Apply guide-defined rules deterministically wherever the guide is explicit.",
      "Return structured findings that directly support automation or human review.",
      "When upstream image review evidence is provided and it passed with a compliant hero image, treat that as the authoritative visual review result instead of claiming that URLs alone are insufficient."
    ],
    safety_rules: [
      "Do not ignore missing required fields, broken variant structure, invalid metafield types, or required unverified factual fields.",
      "Do not invent validation rules outside the guide.",
      "Use skipped_reasons only when the guide is incomplete or the input is insufficient for a real rule check."
    ],
    output_rules: [
      "Return valid JSON only with the exact schema.",
      "Every finding must map to a real rule violation or pass condition.",
      "Score must start from 100 and deduct per violation.",
      "Keep findings specific, operational, and tied to the guide."
    ]
  };
}

export function getImagePromptSpec(): PromptSpec {
  return {
    name: "Catalog Image Review",
    role: [
      "Shopify Image Selection & Validation Engine",
      "Visual Merchandising Decision System"
    ],
    permanent_behavior: [
      "Classify, validate, and score each candidate image against the Catalog Guide and product context.",
      "Select the best hero image and any valid secondary images from the provided candidate set only.",
      "Base every approval or rejection on observable visual criteria.",
      "Prefer the exact pack or variant when it is clearly visible, but if no exact-pack image is available you may approve an official brand or exact product-family image when there are no conflicting variant markers visible."
    ],
    safety_rules: [
      "Do not recommend an image URL outside the provided candidate or input image set.",
      "Do not approve mismatched, blurry, cropped, low-resolution, or guide-noncompliant imagery as hero.",
      "Use skipped_reasons only when no images are provided, images are too unclear, or the guide lacks image rules."
    ],
    output_rules: [
      "Return valid JSON only with the exact schema.",
      "Score every reviewed candidate and return the full candidate decision set.",
      "Select one hero image only when its confidence is at least 0.7 and it passes guide compliance.",
      "Keep rejected reasons, findings, and candidate issues short and compact.",
      "Keep findings concrete, visual, and rule-based."
    ]
  };
}

export function buildCatalogGuidePromptPayload(
  starterGuide: PolicyDocument,
  businessContext: LooseRecord,
  shopifyContext: LooseRecord | null,
  researchNotes: Array<{ title: string; link: string; snippet?: string }>,
  learningText = ""
): string {
  const sections: PromptSection[] = [
    { label: "OBJECTIVE", value: "Create a store-specific Catalog Guide for a Shopify-compatible merchandising workflow." },
    { label: "REQUESTED GUIDE TEMPLATE", value: starterGuide },
    { label: "BUSINESS CONTEXT", value: businessContext },
    { label: "SHOPIFY SAMPLE CONTEXT", value: shopifyContext ?? { status: "not_connected" } },
    { label: "OPTIONAL RESEARCH NOTES", value: researchNotes },
    { label: "THINKING MODE", value: [
      "Identify the business model.",
      "Identify product complexity level.",
      "Identify catalog scale.",
      "Identify key buying factors.",
      "Identify what catalog operators would need to know to use the guide outside the system.",
      "Add worked examples, edge cases, and decision rules that would prevent ambiguity.",
      "Adapt every rule accordingly."
    ] }
  ];
  if (learningText.trim()) sections.splice(5, 0, { label: "CATALOG LEARNINGS", value: learningText.trim() });
  return buildUserPrompt(sections);
}

export function buildEnrichmentPromptPayload({
  product,
  guide,
  allowedFields,
  storeContext,
  learningText = ""
}: {
  product: ProductRecord;
  guide: PolicyDocument;
  allowedFields: string[];
  storeContext: LooseRecord;
  learningText?: string;
}): string {
  const sections: PromptSection[] = [
    { label: "INPUT PAYLOAD", value: product },
    { label: "CATALOG GUIDE", value: guide },
    { label: "ALLOWED FIELDS", value: allowedFields },
    { label: "GUIDE METAFIELDS", value: guide.attributes_metafields_schema?.metafields ?? [] },
    { label: "STORE CONTEXT", value: storeContext }
  ];
  if (learningText.trim()) sections.push({ label: "CATALOG LEARNINGS", value: learningText.trim() });
  return buildUserPrompt(sections);
}

export function buildQaPromptPayload({
  product,
  guide,
  missingFields,
  imageReviewEvidence,
  learningText = ""
}: {
  product: ProductRecord;
  guide: PolicyDocument;
  missingFields: string[];
  imageReviewEvidence?: unknown;
  learningText?: string;
}): string {
  const sections: PromptSection[] = [
    { label: "INPUT PAYLOAD", value: product },
    { label: "CATALOG GUIDE", value: guide },
    { label: "HARD MISSING FIELDS", value: missingFields }
  ];
  if (imageReviewEvidence) sections.push({ label: "UPSTREAM IMAGE REVIEW EVIDENCE", value: imageReviewEvidence });
  if (learningText.trim()) sections.push({ label: "CATALOG LEARNINGS", value: learningText.trim() });
  return buildUserPrompt(sections);
}

export function buildImagePromptPayload({
  product,
  guide,
  storeContext,
  candidateImages,
  learningText = ""
}: {
  product: ProductRecord;
  guide: PolicyDocument;
  storeContext: LooseRecord;
  candidateImages: Array<{ url: string; title?: string }>;
  learningText?: string;
}): string {
  const sections: PromptSection[] = [
    { label: "INPUT PAYLOAD", value: product },
    { label: "CATALOG GUIDE", value: guide },
    { label: "STORE CONTEXT", value: storeContext },
    { label: "CANDIDATE IMAGES", value: candidateImages }
  ];
  if (learningText.trim()) sections.push({ label: "CATALOG LEARNINGS", value: learningText.trim() });
  return buildUserPrompt(sections);
}
