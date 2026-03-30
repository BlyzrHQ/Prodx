import { createBaseResult } from "./shared.js";
import { resolveProvider } from "../lib/providers.js";
import { createOpenAIJsonResponse } from "../connectors/openai.js";
import { createGeminiJsonResponse } from "../connectors/gemini.js";
import { createAnthropicJsonResponse } from "../connectors/anthropic.js";
import { getGuideAllowedFields, getGuideDescriptionSections, getGuidePassingScore, getGuideRequiredFields, getGuideVariantDimensions } from "../lib/catalog-guide.js";
import { buildQaPromptPayload, buildSystemPrompt, getQaPromptSpec } from "../lib/prompt-specs.js";
import { readText } from "../lib/fs.js";
import { getCatalogPaths } from "../lib/paths.js";
import { hasReviewPlaceholder, htmlToText } from "../lib/product.js";
import { appendLearningLessons, deriveLessonsFromQa } from "./learn.js";
import type { LooseRecord, PolicyDocument, ProductRecord, QaFinding, QaOutput, ResolvedProvider } from "../types.js";

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
    const value = input[field];
    return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
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
  return status === "PASS" && confidence >= 0.8 && heroUrl.length > 0;
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
  const descriptionText = typeof input.description_html === "string" && input.description_html.trim()
    ? htmlToText(input.description_html)
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

  if (!input.featured_image && (!Array.isArray(input.images) || input.images.length === 0)) {
    findings.push(createFinding("images", "missing", "major", "No primary image is attached.", "At least one compliant product image", "missing"));
  }

  if (!hasTrustedImageReview && getUpstreamImageReview(input)?.status && String(getUpstreamImageReview(input)?.status).toUpperCase() === "FAIL") {
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

async function evaluateWithProvider(
  provider: ResolvedProvider,
  input: ProductRecord,
  policy: PolicyDocument,
  deterministicBaseline: QaOutput,
  learningText: string
): Promise<QaOutput> {
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
    return response.json;
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
    return response.json;
  }

  if (provider.provider.type === "anthropic") {
    const response = await createAnthropicJsonResponse<QaOutput>({
      apiKey: provider.credential.value,
      model: provider.provider.model ?? "claude-sonnet-4-20250514",
      systemInstruction: instructions,
      textPrompt: `${payload}\nReturn valid JSON matching this schema exactly: ${JSON.stringify((schema as { schema: unknown }).schema)}`,
      maxTokens: 2600
    });
    return response.json;
  }

  throw new Error(`Unsupported QA provider type: ${provider.provider.type}`);
}

function sanitizeQaEvaluationForImageEvidence(input: ProductRecord, evaluation: QaOutput): QaOutput {
  if (!upstreamImageReviewPassed(input)) return evaluation;
  const filteredSkippedReasons = (evaluation.skipped_reasons ?? []).filter(
    (reason) => !/image|watermark|label match|urls alone|upstream image-optimizer/i.test(reason)
  );
  return {
    ...evaluation,
    skipped_reasons: filteredSkippedReasons
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

  const provider = await resolveProvider(root, "catalogue-qa", "llm_provider");
  if (providerReady(provider)) {
    try {
      finalEvaluation = mergeQaEvaluations(
        deterministic,
        await evaluateWithProvider(provider, input, policy, deterministic, learningText),
        passingScore
      );
      finalEvaluation = sanitizeQaEvaluationForImageEvidence(input, finalEvaluation);
      providerUsed = provider.providerAlias;
      reasoning.push(`Used ${provider.providerAlias} to validate the listing against the Catalog Guide.`);
      reasoning.push(`Provider confidence: ${Number(finalEvaluation.confidence ?? 0).toFixed(2)}`);
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
      skipped_reasons: finalEvaluation.skipped_reasons
    },
    warnings: [...new Set([
      ...warnings,
      ...finalEvaluation.skipped_reasons.map((reason) => `Skipped: ${reason}`)
    ])],
    reasoning,
    artifacts: {
      ...(providerUsed ? { provider_used: providerUsed } : {}),
      learning_updates: appendedLessons
    },
    nextActions: passed ? ["Ready for sync proposal."] : ["Fix QA findings before applying or syncing."]
  });
}
