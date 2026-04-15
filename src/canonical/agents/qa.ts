import { callLlm } from "../services/llm.js";

interface QaFinding {
  category: string;
  field: string;
  severity: "critical" | "major" | "minor";
  message: string;
  issueType: string;
  source: string;
}

type QaCheck = {
  score: number;
  issues: string[];
  passed: boolean;
};

export interface QaResult {
  score: number;
  status: "PASS" | "FAIL" | "NEEDS_REVIEW";
  findings: QaFinding[];
  needsReview: boolean;
  retryTarget: "enrich" | "image" | "review" | null;
  checks: Record<string, QaCheck>;
  critical_issues: string[];
  suggested_fixes: {
    needs_enrichment: boolean;
    needs_image_optimization: boolean;
    needs_manual_review: boolean;
    specific_fields: string[];
    feedback_for_enricher: string;
  };
  summary: string;
}

export async function runQaAgent(input: {
  product: Record<string, unknown>;
  guide: Record<string, unknown>;
  passingScore?: number;
}): Promise<QaResult> {
  const { product, guide } = input;
  const passingScore =
    input.passingScore ??
    Number((guide as any)?.qa_validation_system?.passing_score ?? 70);

  const systemPrompt = `You are a senior Quality Assurance specialist for a Shopify e-commerce catalog. You are the final gate before products go live. Your standards are high — if you would not trust this listing as a shopper, it does not pass.

## YOUR MINDSET
Think like a demanding online shopper and a catalog manager:
- Would I buy this product based on this listing?
- Is every fact accurate and verifiable?
- Would I find this product where it is categorized?
- Is anything misleading, incomplete, or unprofessional?

GOLDEN RULE: When in doubt, flag it. A false positive is better than publishing bad data.

## YOUR TASK
Score the product against the Catalog Guide rules. Every check should reference the guide, not generic ecommerce advice.

## SCORING CATEGORIES
1. Title
2. Description
3. Classification
4. Metafields
5. Images
6. SEO
7. Variants

## HARD RULES
- Missing price is a hard blocker for publish.
- Missing or clearly wrong image is a hard blocker for publish.
- If customer-facing description contains citations, URLs, or source notes, fail it.
- Description must include a clean overview in the body.
- If the product title includes obvious size, weight, volume, or pack-count tokens, flag it unless the guide explicitly allows that pattern.
- Missing SEO, tags, or fixable metafields should stay LLM-retryable.
- Only send to human review for blockers the LLM cannot reliably fix.

## SUGGESTED FIXES ROUTING
- Use retryTarget = "image" only when the main blocker is imagery.
- Use retryTarget = "enrich" when content, classification, metafields, or SEO are the main blockers.
- Use retryTarget = "review" only when the case truly needs human judgment.
- specific_fields should list only real product fields that need work next.
- feedback_for_enricher should be short, actionable, and directly reusable.
`;

  const userPrompt = `## Passing Score
${passingScore}

## Guide
${JSON.stringify(buildQaGuideContext(guide), null, 2)}

## Product
${JSON.stringify(product, null, 2)}

Review this product now and return structured QA output.`;

  const schema = {
    name: "qa_review",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        score: { type: "number" },
        status: { type: "string", enum: ["PASS", "FAIL", "NEEDS_REVIEW"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              category: { type: "string" },
              field: { type: "string" },
              severity: { type: "string", enum: ["critical", "major", "minor"] },
              message: { type: "string" },
              issueType: { type: "string" },
              source: { type: "string" },
            },
            required: ["category", "field", "severity", "message", "issueType", "source"],
          },
        },
        needsReview: { type: "boolean" },
        retryTarget: { type: ["string", "null"], enum: ["enrich", "image", "review", null] },
        checks: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              score: { type: "number" },
              issues: { type: "array", items: { type: "string" } },
              passed: { type: "boolean" },
            },
            required: ["score", "issues", "passed"],
          },
        },
        critical_issues: { type: "array", items: { type: "string" } },
        suggested_fixes: {
          type: "object",
          additionalProperties: false,
          properties: {
            needs_enrichment: { type: "boolean" },
            needs_image_optimization: { type: "boolean" },
            needs_manual_review: { type: "boolean" },
            specific_fields: { type: "array", items: { type: "string" } },
            feedback_for_enricher: { type: "string" },
          },
          required: [
            "needs_enrichment",
            "needs_image_optimization",
            "needs_manual_review",
            "specific_fields",
            "feedback_for_enricher",
          ],
        },
        summary: { type: "string" },
      },
      required: [
        "score",
        "status",
        "findings",
        "needsReview",
        "retryTarget",
        "checks",
        "critical_issues",
        "suggested_fixes",
        "summary",
      ],
    },
  } as const;

  try {
    const result = (await callLlm({
      systemPrompt,
      userPrompt,
      schema,
    })) as QaResult;
    return normalizeQaResult(result, passingScore, product);
  } catch (error) {
    return buildFallbackQa(product, passingScore, error);
  }
}

function buildQaGuideContext(guide: Record<string, unknown>): Record<string, unknown> {
  const g = guide as any;
  return {
    product_title_system: g?.product_title_system ?? {},
    product_description_system: g?.product_description_system ?? {},
    seo_discovery_rules: g?.seo_discovery_rules ?? {},
    taxonomy: g?.taxonomy ?? {},
    variant_architecture: g?.variant_architecture ?? {},
    attributes_metafields_schema: g?.attributes_metafields_schema ?? {},
    image_media_standards: g?.image_media_standards ?? {},
    qa_validation_system: g?.qa_validation_system ?? {},
    eligibility_rules: g?.eligibility_rules ?? {},
  };
}

function normalizeQaResult(
  result: QaResult,
  passingScore: number,
  product: Record<string, unknown>
): QaResult {
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const specificFields = new Set(
    Array.isArray(result.suggested_fixes?.specific_fields)
      ? result.suggested_fixes.specific_fields.map(String).filter(Boolean)
      : []
  );
  const description = String(product.description ?? product.descriptionHtml ?? "");
  const hasPrice = String(product.price ?? "").trim().length > 0;
  const hasImage =
    String(product.featuredImage ?? "").trim().length > 0 ||
    (Array.isArray(product.images) && product.images.length > 0);

  if (!hasPrice) {
    findings.push({
      category: "pricing",
      field: "price",
      severity: "critical",
      message: "Price is missing",
      issueType: "missing_field",
      source: "price",
    });
    specificFields.add("price");
  }

  if (!hasImage) {
    findings.push({
      category: "images",
      field: "images",
      severity: "critical",
      message: "Product image is missing",
      issueType: "missing_field",
      source: "image",
    });
    specificFields.add("images");
  }

  if (/\b(source|sources|citation|citations)\s*:/i.test(description) || /https?:\/\//i.test(description)) {
    findings.push({
      category: "description",
      field: "description",
      severity: "major",
      message: "Description contains sources or links",
      issueType: "content_leak",
      source: "description",
    });
    specificFields.add("description");
    specificFields.add("descriptionHtml");
  }

  if (hasVariantTokensInTitle(String(product.title ?? ""))) {
    findings.push({
      category: "title",
      field: "title",
      severity: "major",
      message: "Product title contains variant tokens like size or pack count",
      issueType: "variant_token_in_title",
      source: "title",
    });
    specificFields.add("title");
    if (!String(product.handle ?? "").trim()) {
      specificFields.add("handle");
    }
  }

  const criticalIssues = findings
    .filter((finding) => finding.severity === "critical")
    .map((finding) => finding.message);

  const needsManualReview =
    Boolean(result.suggested_fixes?.needs_manual_review) ||
    findings.some(
      (finding) =>
        finding.field === "price" ||
        finding.message.toLowerCase().includes("identity") ||
        finding.message.toLowerCase().includes("ambiguous image")
    );

  const retryTarget =
    !hasImage || findings.some((finding) => finding.field === "images")
      ? "image"
      : findings.some((finding) =>
            [
              "title",
              "description",
              "descriptionHtml",
              "seoTitle",
              "seoDescription",
              "metafields",
              "tags",
              "productType",
              "vendor",
              "price",
            ].includes(finding.field)
          )
        ? "enrich"
        : needsManualReview
          ? "review"
          : null;

  const score = Math.max(
    0,
    Math.min(
      Number(result.score ?? 0),
      criticalIssues.length > 0 ? passingScore - 1 : Number(result.score ?? 0)
    )
  );

  const status =
    criticalIssues.length > 0 || score < passingScore
      ? "FAIL"
      : needsManualReview || result.needsReview || result.retryTarget === "review"
        ? "NEEDS_REVIEW"
        : "PASS";

  return {
    score,
    status,
    findings,
    needsReview: status === "NEEDS_REVIEW",
    retryTarget: status === "PASS" ? null : retryTarget,
    checks: result.checks ?? {},
    critical_issues: criticalIssues,
    suggested_fixes: {
      needs_enrichment: retryTarget === "enrich",
      needs_image_optimization: retryTarget === "image",
      needs_manual_review: needsManualReview || status === "NEEDS_REVIEW",
      specific_fields: [...specificFields],
      feedback_for_enricher: String(result.suggested_fixes?.feedback_for_enricher ?? "").trim(),
    },
    summary: String(result.summary ?? ""),
  };
}

function buildFallbackQa(
  product: Record<string, unknown>,
  passingScore: number,
  error: unknown
): QaResult {
  const findings: QaFinding[] = [];

  if (!product.title) {
    findings.push({
      category: "title",
      field: "title",
      severity: "critical",
      message: "Title is missing",
      issueType: "missing_field",
      source: "title",
    });
  }
  if (!product.description && !product.descriptionHtml) {
    findings.push({
      category: "description",
      field: "description",
      severity: "major",
      message: "Description is missing",
      issueType: "missing_field",
      source: "description",
    });
  }
  if (!product.featuredImage && (!Array.isArray(product.images) || product.images.length === 0)) {
    findings.push({
      category: "images",
      field: "images",
      severity: "major",
      message: "Product image is missing",
      issueType: "missing_field",
      source: "image",
    });
  }

  const specificFields = [...new Set(findings.map((finding) => finding.field))];
  const score = Math.max(0, passingScore - findings.length * 15);

  return {
    score,
    status: findings.length === 0 ? "PASS" : "FAIL",
    findings,
    needsReview: false,
    retryTarget:
      findings.some((finding) => finding.category === "images")
        ? "image"
        : findings.length > 0
          ? "enrich"
          : null,
    checks: {},
    critical_issues: findings
      .filter((finding) => finding.severity === "critical")
      .map((finding) => finding.message),
    suggested_fixes: {
      needs_enrichment: findings.some((finding) => finding.category !== "images"),
      needs_image_optimization: findings.some((finding) => finding.category === "images"),
      needs_manual_review: false,
      specific_fields: specificFields,
      feedback_for_enricher:
        "QA fallback was used because the LLM reviewer failed: " +
        (error instanceof Error ? error.message : String(error)),
    },
    summary:
      findings.length === 0
        ? "Fallback QA found no obvious blockers."
        : "Fallback QA found issues that should be corrected before publishing.",
  };
}

function hasVariantTokensInTitle(title: string): boolean {
  return /\b\d+(\.\d+)?\s?(g|kg|oz|lb|ml|l|pack|pcs|pc|dozen)\b/i.test(title) || /\b\d+-pack\b/i.test(title);
}
