import { runQa } from "../modules/qa.js";
import { buildAgentAttempt } from "./shared.js";
import type { AgentAttempt, ModuleResult, PolicyDocument, ProductRecord, QaFinding, QaRetryFeedback } from "../types.js";

function isImageFinding(finding: QaFinding): boolean {
  return /image|hero|featured_image/i.test(`${finding.field} ${finding.issue_type} ${finding.message}`);
}

function isEnrichFinding(finding: QaFinding): boolean {
  return /title|description|seo|vendor|brand|product_type|tag|metafield|handle/i.test(`${finding.field} ${finding.issue_type} ${finding.message}`);
}

function isReviewFinding(finding: QaFinding): boolean {
  return /ambig|unsafe|manual|human|review|identity/i.test(`${finding.issue_type} ${finding.message} ${finding.expected} ${finding.actual}`)
    || /variant/i.test(finding.field) && finding.severity === "critical";
}

function deriveRetryFeedback(result: ModuleResult): QaRetryFeedback {
  const findings = Array.isArray(result.proposed_changes?.qa_findings) ? result.proposed_changes.qa_findings as QaFinding[] : [];
  const fixableFindings = findings.filter((finding) => isImageFinding(finding) || isEnrichFinding(finding));
  const reviewBlockers = findings.filter((finding) => isReviewFinding(finding) && !fixableFindings.includes(finding));
  const hardBlockers = findings.filter((finding) => finding.severity === "critical" && !fixableFindings.includes(finding) && !reviewBlockers.includes(finding));
  const retryTargets = Array.from(new Set([
    ...(fixableFindings.some(isEnrichFinding) ? ["enrich-agent"] : []),
    ...(fixableFindings.some(isImageFinding) ? ["image-agent"] : [])
  ]));
  const retryInstructions: string[] = [];

  if (retryTargets.includes("enrich-agent")) {
    retryInstructions.push("Regenerate shopper-facing content, SEO, and structured fields to address QA findings.");
  }
  if (retryTargets.includes("image-agent")) {
    retryInstructions.push("Retry image selection using stricter exact-match and hero-image quality cues from QA.");
  }
  if (reviewBlockers.length > 0) {
    retryInstructions.push("Escalate unresolved identity, safety, or variant-structure issues to manual review.");
  }
  if (hardBlockers.length > 0) {
    retryInstructions.push("Stop automatic retries for hard blockers that cannot be fixed safely in-place.");
  }

  return {
    fixable_findings: fixableFindings,
    hard_blockers: hardBlockers,
    review_blockers: reviewBlockers,
    retry_targets: retryTargets,
    retry_instructions: retryInstructions,
    confidence_delta: findings.length === 0 ? 0 : -Math.min(0.4, findings.length * 0.05),
    recommended_next_agent: retryTargets[0] ?? (reviewBlockers.length > 0 ? "supervisor-agent" : null)
  };
}

export async function runQaAgent(args: {
  root: string;
  jobId: string;
  input: ProductRecord;
  policy: PolicyDocument;
  attemptNumber?: number;
  retryReason?: string;
  parentAttempt?: number | null;
}): Promise<{ result: ModuleResult; attempt: AgentAttempt; feedback: QaRetryFeedback }> {
  const startedAt = new Date().toISOString();
  const result = await runQa({ root: args.root, jobId: args.jobId, input: args.input, policy: args.policy });
  const completedAt = new Date().toISOString();
  const feedback = deriveRetryFeedback(result);
  const attempt = buildAgentAttempt({
    agentId: "qa-agent",
    module: result.module,
    attemptNumber: args.attemptNumber ?? 1,
    startedAt,
    completedAt,
    inputSnapshot: args.input,
    result: {
      ...result,
      artifacts: { ...result.artifacts, qa_retry_feedback: feedback }
    },
    retryReason: args.retryReason,
    parentAttempt: args.parentAttempt ?? null
  });
  return {
    result: {
      ...result,
      artifacts: { ...result.artifacts, qa_retry_feedback: feedback },
      agent_run: { workflow: "product-workflow", attempts: [attempt], supervisor_decisions: [], accepted_attempt: null }
    },
    attempt,
    feedback
  };
}
