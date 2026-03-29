import { createBaseResult } from "./shared.js";
import { resolveProvider } from "../lib/providers.js";
import { createOpenAIJsonResponse } from "../connectors/openai.js";
import type { LooseRecord, PolicyDocument, ProductRecord, ResolvedProvider } from "../types.js";

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
        qa_score: { type: "number" },
        verdict: { type: "string" },
        success_criteria_summary: { type: "string" },
        policy_findings: { type: "array", items: { type: "string" } },
        warnings: { type: "array", items: { type: "string" } }
      },
      required: ["qa_score", "verdict", "success_criteria_summary", "policy_findings", "warnings"]
    }
  };
}

async function evaluateWithOpenAI(provider: ResolvedProvider, input: ProductRecord, policy: PolicyDocument, missingFields: string[]): Promise<LooseRecord> {
  const response = await createOpenAIJsonResponse<LooseRecord>({
    apiKey: provider.credential.value,
    model: provider.provider.model ?? "gpt-5",
    instructions: [
      "You are scoring a Shopify product listing against a catalog policy.",
      "Use the policy as the success criteria.",
      "Return JSON only.",
      "Penalize listings that do not meet the policy, but do not ignore the hard missing fields provided."
    ].join(" "),
    input: JSON.stringify({
      policy,
      product: input,
      hard_missing_fields: missingFields
    }, null, 2),
    schema: buildQaSchema(),
    maxOutputTokens: 2200,
    reasoningEffort: "low"
  });
  return response.json;
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
  const required = policy.product_listing_checklist?.required ?? [];
  const missing = getMissingFields(input, required);
  const passingScore = Number(policy.qa_scoring_criteria?.passing_score ?? 85);
  const deterministicScore = Math.max(0, passingScore - missing.length * 15);
  const warnings = missing.map((field) => `Missing required field: ${field}`);
  const reasoning = [
    "Evaluated required fields from the catalog policy checklist.",
    `Calculated base QA score ${deterministicScore} against passing score ${passingScore}.`
  ];

  let finalScore = deterministicScore;
  let policyFindings: string[] = [];
  let successSummary = "";
  let providerUsed: string | null = null;

  const provider = await resolveProvider(root, "catalogue-qa", "llm_provider");
  if (providerReady(provider) && provider.provider.type === "openai") {
    try {
      const evaluation = await evaluateWithOpenAI(provider, input, policy, missing);
      finalScore = Math.max(0, Math.min(100, Number(evaluation.qa_score ?? deterministicScore)));
      policyFindings = Array.isArray(evaluation.policy_findings) ? evaluation.policy_findings.map(String) : [];
      successSummary = String(evaluation.success_criteria_summary ?? "");
      warnings.push(...(Array.isArray(evaluation.warnings) ? evaluation.warnings.map(String) : []));
      providerUsed = provider.providerAlias;
      reasoning.push(`Used ${provider.providerAlias} to score the listing against the policy success criteria.`);
      if (evaluation.verdict) reasoning.push(`QA verdict: ${String(evaluation.verdict)}`);
    } catch (error) {
      warnings.push(`Policy-based QA provider failed: ${error instanceof Error ? error.message : String(error)}`);
      reasoning.push("Fell back to deterministic QA because the provider-backed scoring step failed.");
    }
  } else {
    reasoning.push("No ready OpenAI provider was configured for catalogue-qa; used deterministic QA only.");
  }

  const passed = missing.length === 0 && finalScore >= passingScore;

  return createBaseResult({
    jobId,
    module: "catalogue-qa",
    status: passed ? "passed" : "needs_review",
    needsReview: !passed,
    proposedChanges: {
      qa_score: finalScore,
      missing_fields: missing,
      policy_findings: policyFindings,
      success_criteria_summary: successSummary
    },
    warnings: [...new Set(warnings)],
    reasoning,
    artifacts: providerUsed ? { provider_used: providerUsed } : {},
    nextActions: passed ? ["Ready for sync proposal."] : ["Fix missing fields and QA findings before applying or syncing."]
  });
}
