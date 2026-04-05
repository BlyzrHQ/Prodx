import type { QaRetryFeedback, RuntimeConfig, SupervisorDecision, WorkflowMemory } from "../types.js";

function getRetryBudget(config: RuntimeConfig, key: "max_enrich_retries" | "max_image_retries" | "max_iterations_per_product", fallback: number): number {
  const value = Number(config.agentic?.[key] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function decideSupervisorAction(args: {
  runtimeConfig: RuntimeConfig;
  memory: WorkflowMemory;
  qaPassed: boolean;
  qaNeedsReview: boolean;
  qaFeedback: QaRetryFeedback;
  lastModuleStatus: string;
}): SupervisorDecision {
  const { runtimeConfig, memory, qaPassed, qaNeedsReview, qaFeedback, lastModuleStatus } = args;
  const maxEnrichRetries = getRetryBudget(runtimeConfig, "max_enrich_retries", 1);
  const maxImageRetries = getRetryBudget(runtimeConfig, "max_image_retries", 1);
  const maxIterations = getRetryBudget(runtimeConfig, "max_iterations_per_product", 4);

  if (qaPassed && !qaNeedsReview) {
    return {
      action: "accept",
      reason: "QA passed and no further retries are required.",
      next_agent: null,
      qa_feedback: qaFeedback
    };
  }

  if (lastModuleStatus === "failed") {
    return {
      action: "reject",
      reason: "A module failed outright, so the supervisor is stopping instead of looping.",
      next_agent: null,
      qa_feedback: qaFeedback
    };
  }

  if (memory.total_iterations >= maxIterations) {
    return {
      action: "review",
      reason: "Reached the maximum agent iterations for this product.",
      next_agent: null,
      qa_feedback: qaFeedback
    };
  }

  if (qaFeedback.hard_blockers.length > 0 && qaFeedback.fixable_findings.length === 0) {
    return {
      action: "review",
      reason: "QA reported hard blockers that should not be auto-fixed.",
      next_agent: null,
      qa_feedback: qaFeedback
    };
  }

  if (qaFeedback.review_blockers.length > 0 && qaFeedback.fixable_findings.length === 0) {
    return {
      action: "review",
      reason: "Only manual-review blockers remain after QA.",
      next_agent: null,
      qa_feedback: qaFeedback
    };
  }

  const wantsEnrich = qaFeedback.retry_targets.includes("enrich-agent");
  const wantsImage = qaFeedback.retry_targets.includes("image-agent");
  const canRetryEnrich = wantsEnrich && memory.enrich_retries < maxEnrichRetries;
  const canRetryImage = wantsImage && memory.image_retries < maxImageRetries;

  if (canRetryEnrich && canRetryImage) {
    return {
      action: "retry_both",
      reason: "QA surfaced fixable content and image issues, and both retry budgets are still available.",
      next_agent: "enrich-agent",
      qa_feedback: qaFeedback
    };
  }

  if (canRetryEnrich) {
    return {
      action: "retry_enrich",
      reason: "QA surfaced fixable content issues and enrich retry budget is still available.",
      next_agent: "enrich-agent",
      qa_feedback: qaFeedback
    };
  }

  if (canRetryImage) {
    return {
      action: "retry_image",
      reason: "QA surfaced fixable image issues and image retry budget is still available.",
      next_agent: "image-agent",
      qa_feedback: qaFeedback
    };
  }

  return {
    action: "review",
    reason: "Fixable issues remain, but the retry budget is exhausted.",
    next_agent: null,
    qa_feedback: qaFeedback
  };
}
