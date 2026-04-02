import { createBaseResult } from "./shared.js";
import { resolveProvider } from "../lib/providers.js";
import { createOpenAIJsonResponse } from "../connectors/openai.js";
import { createGeminiJsonResponse } from "../connectors/gemini.js";
import { createAnthropicJsonResponse } from "../connectors/anthropic.js";
import { getGuideAgenticDescriptionRequirements, getGuideAgenticRecommendedMetafields, getGuideAgenticRequiredSignals, getGuideAllowedFields, getGuideDescriptionSections, getGuidePassingScore, getGuideRequiredFields, getGuideVariantDimensions } from "../lib/catalog-guide.js";
import { buildQaPromptPayload, buildSystemPrompt, getQaPromptSpec } from "../lib/prompt-specs.js";
import { readText } from "../lib/fs.js";
import { getCatalogPaths } from "../lib/paths.js";
import { mergeProviderUsages } from "../lib/provider-usage.js";
import { getProductFieldValue, hasPopulatedProductField, hasReviewPlaceholder, htmlToText } from "../lib/product.js";
import { appendLearningLessons, deriveLessonsFromQa } from "./learn.js";
import type { LooseRecord, PolicyDocument, ProductRecord, ProviderUsage, QaFinding, QaOutput, ResolvedProvider } from "../types.js";

const CATEGORY_WEIGHTS = {
  title: 15,
  description: 15,
  variants: 10,
  taxonomy: 10,
  metafields: 20,
  images: 10,
  seo: 10,
  compliance: 10
} as const;

const DEDUCTIONS = {
  critical: 10,
  major: 5,
  minor: 2
} as const;

function providerReady(resolved: ResolvedProvider | null): resolved is ResolvedProvider {
  return Boolean(resolved?.provider && resolved?.credential?.value);
}

function getMissingFields(input: ProductRecord, requiredFields: string[]): string[] {
  return requiredFields.filter((field) => {
    return !hasPopulatedProductField(input, field);
  });
}

function buildQaSchema() {
  return {
    name: "catalog_qa",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        score: { type: "number" },
        status: { type: "string", enum: ["PASS", "FAIL"] },
        confidence: { type: "number" },
        summary: {
          type: "object",
          additionalProperties: false,
          properties: {
            critical_issues: { type: "number" },
            major_issues: { type: "number" },
            minor_issues: { type: "number" }
          },
          required: ["critical_issues", "major_issues", "minor_issues"]
        },
        findings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              field: { type: "string" },
              issue_type: { type: "string" },
              severity: { type: "string", enum: ["critical", "major", "minor"] },
              message: { type: "string" },
              expected: { type: "string" },
              actual: { type: "string" },
              deduction: { type: "number" }
            },
            required: ["field", "issue_type", "severity", "message", "expected", "actual", "deduction"]
          }
        },
        skipped_reasons: { type: "array", items: { type: "string" } }
      },
      required: ["score", "status", "confidence", "summary", "findings", "skipped_reasons"]
    }
  };
}

function createFinding(field: string, issueType: string, severity: "critical" | "major" | "minor", message: string, expected: string, actual: string): QaFinding {
  return {
    field,
    issue_type: issueType,
    severity,
    message,
    expected,
    actual,
    deduction: DEDUCTIONS[severity]
  };
}

function normalizeQaFieldName(field: string): string {
  return field === "body_html" ? "description_html" : field;
}

function looksLikeHandle(handle: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle);
}

function hasVariantProblems(input: ProductRecord, guideDimensions: string[]): QaFinding[] {
  if (!Array.isArray(input.variants) || input.variants.length === 0) return [];
  const findings: QaFinding[] = [];
  const seen = new Set<string>();
  for (const variant of input.variants) {
    const signature = [variant.option1, variant.option2, variant.option3].map((item) => String(item ?? "")).join("|");
    if (seen.has(signature)) {
      findings.push(createFinding("variants", "invalid", "critical", "Duplicate variant signature detected.", "Each variant option combination must be unique.", signature));
    }
    seen.add(signature);
  }

  if (guideDimensions.length > 0) {
    const usesPlaceholderDimension = input.variants.some((variant) =>
      [variant.option1, variant.option2, variant.option3].some((value) => String(value ?? "").trim().toLowerCase() === "default title")
    );
    if (usesPlaceholderDimension) {
      findings.push(createFinding("variants", "format", "major", "Variant structure uses placeholder values instead of real shopper-facing options.", guideDimensions.join(", "), "Default Title"));
    }
  }

  return findings;
}

function hasVariantTitleProblems(input: ProductRecord): QaFinding[] {
  const findings: QaFinding[] = [];
  if (!Array.isArray(input.variants) || input.variants.length === 0 || typeof input.title !== "string" || !input.title.trim()) {
    return findings;
  }

  const normalizedTitle = input.title.toLowerCase();
  const uniqueOptionValues = [...new Set(
    input.variants
      .flatMap((variant) => [variant.option1, variant.option2, variant.option3])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value.toLowerCase() !== "default title")
  )];

  const repeatedInTitle = uniqueOptionValues.filter((value) => normalizedTitle.includes(value.toLowerCase()));
  if (repeatedInTitle.length > 0) {
    findings.push(createFinding(
      "title",
      "format",
      "major",
      "Base product title repeats variant option values that should usually live in option fields.",
      "Stable family-level base title with shopper-facing differentiators in variant options unless the category explicitly requires them in title.",
      repeatedInTitle.join(", ")
    ));
  }

  return findings;
}

function getUpstreamImageReview(input: ProductRecord): LooseRecord | null {
  const value = input._catalog_image_review;
  return value && typeof value === "object" ? value as LooseRecord : null;
}

function upstreamImageReviewPassed(input: ProductRecord): boolean {
  const review = getUpstreamImageReview(input);
  if (!review) return false;
  const status = typeof review.status === "string" ? review.status.toUpperCase() : "";
  const confidence = Number(review.confidence ?? 0);
  const hero = review.selected && typeof review.selected === "object"
    ? (review.selected as LooseRecord).hero
    : null;
  const heroUrl = hero && typeof hero === "object" ? String((hero as LooseRecord).url ?? "") : "";
  return status === "PASS" && confidence >= 0.7 && heroUrl.length > 0;
}

function sectionCanBeSafelyOmitted(section: string, input: ProductRecord): boolean {
  const normalized = section.toLowerCase();
  const metafieldIndex = buildMetafieldIndex(input);

  if (/ingredient|composition/.test(normalized)) {
    return !hasNonEmptyString(input.ingredients_text)
      && !hasNonEmptyString(input.allergen_note)
      && !metafieldIndex.has("custom.ingredients_text")
      && !metafieldIndex.has("custom.allergens")
      && !metafieldIndex.has("custom.allergen_note");
  }

  if (/storage|handling|care/.test(normalized)) {
    return !hasNonEmptyString(input.storage_instructions);
  }

  if (/technical|specification|compatib|material|dimension|nutrition/.test(normalized)) {
    return !hasNonEmptyString(input.nutritional_facts)
      && !metafieldIndex.has("custom.nutrition_facts")
      && !metafieldIndex.has("custom.nutritional_facts")
      && !metafieldIndex.has("custom.technical_specs")
      && !metafieldIndex.has("custom.compatibility")
      && !metafieldIndex.has("custom.material")
      && !metafieldIndex.has("custom.dimensions");
  }

  return false;
}

function isOptionalComplianceMetafield(identifier: string, policy: PolicyDocument): boolean {
  const normalized = identifier.toLowerCase();
  const guideField = (policy.attributes_metafields_schema?.metafields ?? []).find(
    (field) => `${field.namespace}.${field.key}`.toLowerCase() === normalized
  );
  if (guideField?.required) return false;
  return [
    "custom.ingredients_text",
    "custom.allergens",
    "custom.allergen_note",
    "custom.nutrition_facts",
    "custom.nutritional_facts"
  ].includes(normalized);
}

function validateDeterministically(input: ProductRecord, policy: PolicyDocument): QaOutput {
  const findings: QaFinding[] = [];
  const skippedReasons: string[] = [];
  const requiredFields = getGuideRequiredFields(policy);
  const allowedFields = getGuideAllowedFields(policy);
  const missingFields = getMissingFields(input, requiredFields);
  const titleFormula = String(policy.product_title_system?.formula ?? "");
  const descriptionSections = getGuideDescriptionSections(policy);
  const variantDimensions = getGuideVariantDimensions(policy);
  const passingScore = getGuidePassingScore(policy);
  const descriptionHtml = getProductFieldValue(input, "description_html");
  const descriptionText = typeof descriptionHtml === "string" && descriptionHtml.trim()
    ? htmlToText(descriptionHtml)
    : String(input.description ?? "");
  const hasTrustedImageReview = upstreamImageReviewPassed(input);

  for (const field of missingFields) {
    findings.push(createFinding(field, "missing", "critical", "Required field is missing.", "Field must be present.", "missing"));
  }

  if (titleFormula && (!input.title || input.title.trim().length === 0)) {
    findings.push(createFinding("title", "missing", "critical", "Title is required and missing.", titleFormula, "missing"));
  }

  if (titleFormula && input.title && !input.title.toLowerCase().includes(String(input.vendor ?? input.brand ?? "").toLowerCase()) && (input.vendor || input.brand)) {
    findings.push(createFinding("title", "format", "major", "Title does not appear to include the expected brand token from the guide formula.", titleFormula, input.title));
  }

  for (const section of descriptionSections) {
    if (sectionCanBeSafelyOmitted(section, input)) continue;
    if (!descriptionText.toLowerCase().includes(section.toLowerCase())) {
      findings.push(createFinding("description_html", "format", "major", "Description is missing a required section.", section, descriptionText || "missing"));
    }
  }
  if (descriptionText && hasReviewPlaceholder(descriptionText)) {
    findings.push(createFinding(
      "description_html",
      "incomplete",
      "critical",
      "Customer-facing description contains internal review placeholder text.",
      "Publishable customer-facing copy without internal review notes.",
      descriptionText
    ));
  }

  if (typeof input.handle === "string" && input.handle && !looksLikeHandle(input.handle)) {
    findings.push(createFinding("handle", "format", "major", "Handle format is invalid.", "lowercase-hyphenated", input.handle));
  }

  if (typeof input.product_type !== "string" || !input.product_type.trim()) {
    findings.push(createFinding("product_type", "missing", "critical", "Product type is required for taxonomy mapping.", "Guide-approved product type", String(input.product_type ?? "missing")));
  }

  if (Array.isArray(input.metafields)) {
    const allowedMetafields = new Map((policy.attributes_metafields_schema?.metafields ?? []).map((field) => [`${field.namespace}.${field.key}`, field]));
    for (const metafield of input.metafields) {
      const identifier = `${metafield.namespace}.${metafield.key}`;
      const expected = allowedMetafields.get(identifier);
      if (!expected) {
        findings.push(createFinding(identifier, "mismatch", "major", "Metafield is not defined in the Catalog Guide.", "Guide-defined metafield", identifier));
        continue;
      }
      if (expected.type && metafield.type !== expected.type) {
        findings.push(createFinding(identifier, "invalid", "critical", "Metafield type does not match the guide.", expected.type, metafield.type));
      }
      if (expected.required && (!metafield.value || !metafield.value.trim() || metafield.value === "requires_review" || metafield.value === "unknown_requires_review")) {
        findings.push(createFinding(identifier, "missing", "critical", "Required metafield is missing or unverified.", "Verified value", metafield.value || "missing"));
      }
    }
  } else if ((policy.attributes_metafields_schema?.metafields ?? []).some((field) => field.required)) {
    findings.push(createFinding("metafields", "missing", "critical", "Required metafields are missing.", "Guide-required metafields", "missing"));
  }

  for (const fieldName of ["ingredients_text", "allergen_note"]) {
    const value = input[fieldName];
    if (typeof value === "string" && ["requires_review", "unknown_requires_review"].includes(value.trim().toLowerCase())) {
      findings.push(createFinding(fieldName, "incomplete", "critical", "Factual field is still a placeholder review sentinel.", "Verified factual value", value));
    }
  }

  findings.push(...hasVariantProblems(input, variantDimensions));
  findings.push(...hasVariantTitleProblems(input));

  const upstreamImageReview = getUpstreamImageReview(input);
  if (!upstreamImageReview && !input.featured_image && (!Array.isArray(input.images) || input.images.length === 0)) {
    findings.push(createFinding("images", "missing", "major", "No primary image is attached.", "At least one compliant product image", "missing"));
  }

  if (!hasTrustedImageReview && upstreamImageReview?.status && String(upstreamImageReview.status).toUpperCase() === "FAIL") {
    findings.push(createFinding(
      "images",
      "invalid",
      "critical",
      "Upstream image review failed to approve a compliant hero image.",
      "A passing upstream image review with a compliant hero image.",
      String(getUpstreamImageReview(input)?.status ?? "FAIL")
    ));
  }

  if (allowedFields.length === 0) {
    skippedReasons.push("guide_allowed_fields_undefined");
  }

  const score = Math.max(0, 100 - findings.reduce((sum, finding) => sum + finding.deduction, 0));
  const summary = {
    critical_issues: findings.filter((item) => item.severity === "critical").length,
    major_issues: findings.filter((item) => item.severity === "major").length,
    minor_issues: findings.filter((item) => item.severity === "minor").length
  };
  const hasBlockingIssue = findings.some((item) => item.severity === "critical");
  const status: "PASS" | "FAIL" = hasBlockingIssue || score < passingScore ? "FAIL" : "PASS";
  const confidence = skippedReasons.length > 0 ? 0.8 : 1.0;

  return {
    score,
    status,
    confidence,
    summary,
    findings,
    skipped_reasons: skippedReasons
  };
}

function mergeQaEvaluations(deterministic: QaOutput, providerEvaluation: QaOutput, passingScore: number): QaOutput {
  const combinedFindings = [...deterministic.findings];
  for (const finding of providerEvaluation.findings ?? []) {
    const duplicate = combinedFindings.some((item) =>
      item.field === finding.field
      && item.issue_type === finding.issue_type
      && item.severity === finding.severity
      && item.message === finding.message
    );
    if (!duplicate) combinedFindings.push(finding);
  }

  const combinedSkippedReasons = [...new Set([
    ...(deterministic.skipped_reasons ?? []),
    ...(providerEvaluation.skipped_reasons ?? [])
  ])];
  const recomputedScore = Math.max(0, 100 - combinedFindings.reduce((sum, finding) => sum + Number(finding.deduction ?? 0), 0));
  const summary = {
    critical_issues: combinedFindings.filter((item) => item.severity === "critical").length,
    major_issues: combinedFindings.filter((item) => item.severity === "major").length,
    minor_issues: combinedFindings.filter((item) => item.severity === "minor").length
  };
  const blocking = summary.critical_issues > 0;

  return {
    score: Math.min(providerEvaluation.score ?? recomputedScore, recomputedScore),
    status: blocking || recomputedScore < passingScore ? "FAIL" : "PASS",
    confidence: Math.min(
      Number(deterministic.confidence ?? 1),
      Number(providerEvaluation.confidence ?? 1),
      combinedSkippedReasons.length > 0 ? 0.8 : 1
    ),
    summary,
    findings: combinedFindings,
    skipped_reasons: combinedSkippedReasons
  };
}

export function sanitizeProviderEvaluationAgainstInput(input: ProductRecord, evaluation: QaOutput): QaOutput {
  const filteredFindings = (evaluation.findings ?? [])
    .filter((finding) => {
      const issueType = String(finding.issue_type ?? "").toLowerCase();
      if (!issueType.includes("missing")) return true;
      return !hasPopulatedProductField(input, finding.field);
    })
    .map((finding) => ({
      ...finding,
      field: normalizeQaFieldName(finding.field)
    }));

  const summary = {
    critical_issues: filteredFindings.filter((item) => item.severity === "critical").length,
    major_issues: filteredFindings.filter((item) => item.severity === "major").length,
    minor_issues: filteredFindings.filter((item) => item.severity === "minor").length
  };

  return {
    ...evaluation,
    score: Math.max(0, 100 - filteredFindings.reduce((sum, finding) => sum + Number(finding.deduction ?? 0), 0)),
    status: summary.critical_issues > 0 ? "FAIL" : evaluation.status,
    summary,
    findings: filteredFindings
  };
}

async function evaluateWithProvider(
  provider: ResolvedProvider,
  input: ProductRecord,
  policy: PolicyDocument,
  deterministicBaseline: QaOutput,
  learningText: string
): Promise<{ evaluation: QaOutput; usage?: ProviderUsage }> {
  const instructions = buildSystemPrompt(getQaPromptSpec());
  const payload = buildQaPromptPayload({
    guide: policy,
    product: input,
    missingFields: deterministicBaseline.findings.filter((item) => item.issue_type === "missing").map((item) => item.field),
    imageReviewEvidence: getUpstreamImageReview(input),
    learningText
  });
  const schema = buildQaSchema();

  if (provider.provider.type === "openai") {
    const response = await createOpenAIJsonResponse<QaOutput>({
      apiKey: provider.credential.value,
      model: provider.provider.model ?? "gpt-5",
      instructions,
      input: payload,
      schema,
      maxOutputTokens: 2600,
      reasoningEffort: "low"
    });
    return { evaluation: response.json, usage: response.usage };
  }

  if (provider.provider.type === "gemini") {
    const response = await createGeminiJsonResponse<QaOutput>({
      apiKey: provider.credential.source === "oauth" ? undefined : provider.credential.value,
      accessToken: provider.credential.source === "oauth" ? provider.credential.value : undefined,
      googleProjectId: provider.credential.source === "oauth" ? String(provider.credential.metadata?.project_id ?? "") : undefined,
      model: provider.provider.model ?? "gemini-2.5-flash",
      systemInstruction: instructions,
      textPrompt: payload,
      schema
    });
    return { evaluation: response.json, usage: response.usage };
  }

  if (provider.provider.type === "anthropic") {
    const response = await createAnthropicJsonResponse<QaOutput>({
      apiKey: provider.credential.value,
      model: provider.provider.model ?? "claude-sonnet-4-20250514",
      systemInstruction: instructions,
      textPrompt: `${payload}\nReturn valid JSON matching this schema exactly: ${JSON.stringify((schema as { schema: unknown }).schema)}`,
      maxTokens: 2600
    });
    return { evaluation: response.json, usage: response.usage };
  }

  throw new Error(`Unsupported QA provider type: ${provider.provider.type}`);
}

function sanitizeQaEvaluationForImageEvidence(input: ProductRecord, evaluation: QaOutput): QaOutput {
  const upstreamReview = getUpstreamImageReview(input);
  const filteredFindings = (evaluation.findings ?? []).filter((finding) => {
    if (!upstreamReview) return true;
    const field = String(finding.field ?? "").toLowerCase();
    const message = String(finding.message ?? "").toLowerCase();
    if (String(upstreamReview.status ?? "").toUpperCase() === "FAIL" && ["images", "image.hero", "_catalog_image_review"].includes(field)) {
      return field === "images" && finding.issue_type === "invalid";
    }
    if (upstreamImageReviewPassed(input) && (field.includes("image") || /urls alone|watermark|label match/.test(message))) {
      return false;
    }
    return true;
  });
  const filteredSkippedReasons = (evaluation.skipped_reasons ?? []).filter((reason) => {
    if (upstreamImageReviewPassed(input)) {
      return !/image|watermark|label match|urls alone|upstream image-optimizer/i.test(reason);
    }
    return true;
  });
  return {
    ...evaluation,
    findings: filteredFindings,
    score: Math.max(0, 100 - filteredFindings.reduce((sum, finding) => sum + Number(finding.deduction ?? 0), 0)),
    summary: {
      critical_issues: filteredFindings.filter((item) => item.severity === "critical").length,
      major_issues: filteredFindings.filter((item) => item.severity === "major").length,
      minor_issues: filteredFindings.filter((item) => item.severity === "minor").length
    },
    skipped_reasons: filteredSkippedReasons
  };
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function buildMetafieldIndex(input: ProductRecord): Set<string> {
  const values = new Set<string>();
  for (const metafield of Array.isArray(input.metafields) ? input.metafields : []) {
    if (!metafield || typeof metafield !== "object") continue;
    if (!hasNonEmptyString(metafield.namespace) || !hasNonEmptyString(metafield.key)) continue;
    values.add(`${metafield.namespace}.${metafield.key}`);
  }
  return values;
}

function computeAgenticReadiness(input: ProductRecord, policy: PolicyDocument): {
  score: number;
  strengths: string[];
  recommendations: string[];
  recommended_metafields: Array<{ namespace: string; key: string; type: string; purpose: string }>;
} {
  let score = 0;
  const strengths: string[] = [];
  const recommendations: string[] = [];
  const missingRecommendedMetafields: Array<{ namespace: string; key: string; type: string; purpose: string }> = [];
  const descriptionHtml = getProductFieldValue(input, "description_html");
  const descriptionText = typeof descriptionHtml === "string" && descriptionHtml.trim()
    ? htmlToText(descriptionHtml)
    : String(input.description ?? "");
  const lowerDescription = descriptionText.toLowerCase();
  const metafieldIndex = buildMetafieldIndex(input);
  const requiredSignals = getGuideAgenticRequiredSignals(policy);
  const recommendedMetafields = getGuideAgenticRecommendedMetafields(policy);
  const descriptionRequirements = getGuideAgenticDescriptionRequirements(policy);

  if (hasNonEmptyString(input.title) && hasNonEmptyString(input.vendor ?? input.brand) && hasNonEmptyString(input.product_type) && hasNonEmptyString(input.handle) && hasNonEmptyString(input.price)) {
    score += 30;
    strengths.push("Core product identity fields are present for AI-driven discovery.");
  } else {
    recommendations.push("Ensure title, vendor or brand, product type, handle, and price are all present and stable.");
  }

  if (hasNonEmptyString(descriptionText) && descriptionRequirements.some((rule) => /who it is for|when to use|what the product is|strongest attributes/i.test(rule)) ) {
    const heuristicHits = [
      /\bfor\b/.test(lowerDescription),
      /\buse\b/.test(lowerDescription) || /\bideal\b/.test(lowerDescription) || /\bperfect\b/.test(lowerDescription),
      /\bmade of\b/.test(lowerDescription) || /\bingredient\b/.test(lowerDescription) || /\bmaterial\b/.test(lowerDescription) || /\bcompatib/i.test(lowerDescription)
    ].filter(Boolean).length;
    if (heuristicHits >= 2) {
      score += 25;
      strengths.push("Description appears decision-ready for both shoppers and AI recommendation systems.");
    } else {
      recommendations.push("Strengthen the description with clearer use-case, audience, and decision-driving attributes.");
    }
  } else if (hasNonEmptyString(descriptionText)) {
    score += 10;
  } else {
    recommendations.push("Add a structured, decision-ready description that explains what the product is, who it is for, and when it is useful.");
  }

  const signalCoverage = requiredSignals.filter((signal) => {
    const normalized = signal.toLowerCase();
    if (normalized.includes("use case")) return metafieldIndex.has("custom.use_case") || /\buse\b|\bideal\b|\bperfect\b/.test(lowerDescription);
    if (normalized.includes("audience")) return metafieldIndex.has("custom.audience") || /\bkids\b|\badults\b|\bfamily\b|\bguests\b/.test(lowerDescription);
    if (normalized.includes("occasion")) return metafieldIndex.has("custom.occasion") || /\bramadan\b|\beid\b|\bbreakfast\b|\bgift\b/.test(lowerDescription);
    if (normalized.includes("ingredient")) return hasNonEmptyString(input.ingredients_text) || metafieldIndex.has("custom.ingredients_text");
    if (normalized.includes("material")) return metafieldIndex.has("custom.material") || /\bcotton\b|\blinen\b|\bpolyester\b/.test(lowerDescription);
    if (normalized.includes("compatib")) return metafieldIndex.has("custom.compatibility") || /\bcompatible\b/.test(lowerDescription);
    return false;
  }).length;
  if (requiredSignals.length > 0) {
    const ratio = signalCoverage / requiredSignals.length;
    score += Math.round(ratio * 20);
    if (ratio >= 0.6) {
      strengths.push("The listing includes useful intent and recommendation signals for agentic commerce.");
    } else {
      recommendations.push("Add more explicit intent signals such as use case, audience, occasion, compatibility, material, or ingredient context.");
    }
  }

  for (const field of recommendedMetafields) {
    const identifier = `${field.namespace}.${field.key}`;
    if (!metafieldIndex.has(identifier)) {
      missingRecommendedMetafields.push({
        namespace: field.namespace,
        key: field.key,
        type: field.type,
        purpose: field.purpose
      });
    }
  }
  const fulfilledRecommendedMetafields = recommendedMetafields.length - missingRecommendedMetafields.length;
  if (recommendedMetafields.length > 0) {
    score += Math.round((fulfilledRecommendedMetafields / recommendedMetafields.length) * 15);
    if (missingRecommendedMetafields.length > 0) {
      recommendations.push(`Consider adding recommended metafields to improve agentic commerce readiness: ${missingRecommendedMetafields.map((field) => `${field.namespace}.${field.key}`).join(", ")}.`);
    } else {
      strengths.push("Recommended AI-discovery metafields are already present.");
    }
  }

  if ((Array.isArray(input.images) && input.images.length > 0) || hasNonEmptyString(input.featured_image)) {
    score += 10;
    strengths.push("The product has image coverage for visual recommendation surfaces.");
  } else {
    recommendations.push("Add at least one strong product image because AI channels rely on visual confidence too.");
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    strengths,
    recommendations,
    recommended_metafields: missingRecommendedMetafields
  };
}

export async function runQa({
  root,
  jobId,
  input,
  policy
}: {
  root: string;
  jobId: string;
  input: ProductRecord;
  policy: PolicyDocument;
}) {
  const learningText = await readText(getCatalogPaths(root).learningMarkdown, "");
  const deterministic = validateDeterministically(input, policy);
  const passingScore = getGuidePassingScore(policy);
  const warnings = deterministic.skipped_reasons.map((reason) => `Skipped: ${reason}`);
  const reasoning = [
    `Deterministic QA baseline score: ${deterministic.score}.`,
    `Baseline QA status: ${deterministic.status}.`
  ];

  let finalEvaluation = deterministic;
  let providerUsed: string | null = null;
  let providerUsage: ProviderUsage | undefined;

  const provider = await resolveProvider(root, "catalogue-qa", "llm_provider");
  if (providerReady(provider)) {
    try {
      const providerEvaluation = await evaluateWithProvider(provider, input, policy, deterministic, learningText);
      const sanitizedProviderEvaluation = sanitizeProviderEvaluationAgainstInput(input, providerEvaluation.evaluation);
      finalEvaluation = mergeQaEvaluations(
        deterministic,
        sanitizedProviderEvaluation,
        passingScore
      );
      finalEvaluation = {
        ...finalEvaluation,
        findings: finalEvaluation.findings.filter((finding) => {
          const field = String(finding.field ?? "");
          const issueType = String(finding.issue_type ?? "").toLowerCase();
          if (issueType.includes("missing") && isOptionalComplianceMetafield(field, policy)) {
            return false;
          }
          if (
            field === "description_html"
            && issueType === "format"
            && sectionCanBeSafelyOmitted(String(finding.expected ?? ""), input)
          ) {
            return false;
          }
          return true;
        })
      };
      finalEvaluation = {
        ...finalEvaluation,
        score: Math.max(0, 100 - finalEvaluation.findings.reduce((sum, finding) => sum + Number(finding.deduction ?? 0), 0)),
        summary: {
          critical_issues: finalEvaluation.findings.filter((item) => item.severity === "critical").length,
          major_issues: finalEvaluation.findings.filter((item) => item.severity === "major").length,
          minor_issues: finalEvaluation.findings.filter((item) => item.severity === "minor").length
        }
      };
      finalEvaluation = {
        ...finalEvaluation,
        status: finalEvaluation.summary.critical_issues > 0 || finalEvaluation.score < passingScore ? "FAIL" : "PASS"
      };
      finalEvaluation = sanitizeQaEvaluationForImageEvidence(input, finalEvaluation);
      providerUsed = provider.providerAlias;
      providerUsage = mergeProviderUsages([providerEvaluation.usage]);
      reasoning.push(`Used ${provider.providerAlias} to validate the listing against the Catalog Guide.`);
      reasoning.push(`Provider confidence: ${Number(finalEvaluation.confidence ?? 0).toFixed(2)}`);
      if (providerUsage?.total_tokens) {
        reasoning.push(`Provider usage: ${providerUsage.input_tokens ?? 0} input tokens, ${providerUsage.output_tokens ?? 0} output tokens.`);
      }
    } catch (error) {
      warnings.push(`QA provider failed: ${error instanceof Error ? error.message : String(error)}`);
      reasoning.push("Fell back to deterministic QA because the provider-backed validation step failed.");
      finalEvaluation = deterministic;
    }
  } else {
    reasoning.push("No ready LLM provider was configured for catalogue-qa; used deterministic QA only.");
  }

  const findings = Array.isArray(finalEvaluation.findings) ? finalEvaluation.findings : [];
  const blockingFindings = findings.filter((item) => item.severity === "critical");
  const passed = finalEvaluation.status === "PASS" && blockingFindings.length === 0 && finalEvaluation.score >= passingScore;
  const appendedLessons = await appendLearningLessons(root, deriveLessonsFromQa(findings));
  if (appendedLessons.length > 0) {
    reasoning.push(`Captured ${appendedLessons.length} durable learning(s) from QA findings.`);
  }
  const agenticReadiness = computeAgenticReadiness(input, policy);

  return createBaseResult({
    jobId,
    module: "catalogue-qa",
    status: passed ? "passed" : "needs_review",
    needsReview: !passed,
    proposedChanges: {
      qa_score: finalEvaluation.score,
      qa_status: finalEvaluation.status,
      qa_summary: finalEvaluation.summary,
      qa_findings: finalEvaluation.findings,
      skipped_reasons: finalEvaluation.skipped_reasons,
      agentic_commerce_readiness_score: agenticReadiness.score,
      agentic_commerce_strengths: agenticReadiness.strengths,
      agentic_commerce_recommendations: agenticReadiness.recommendations,
      recommended_metafields_to_add: agenticReadiness.recommended_metafields
    },
    warnings: [...new Set([
      ...warnings,
      ...finalEvaluation.skipped_reasons.map((reason) => `Skipped: ${reason}`)
    ])],
    reasoning,
    artifacts: {
      ...(providerUsed ? { provider_used: providerUsed } : {}),
      ...(providerUsage ? { provider_usage: providerUsage } : {}),
      learning_updates: appendedLessons
    },
    nextActions: passed ? ["Ready for sync proposal."] : ["Fix QA findings before applying or syncing."]
  });
}
