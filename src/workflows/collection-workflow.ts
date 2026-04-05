import { runCollectionBuilderAgent } from "../agents/collection-builder-agent.js";
import { runCollectionEvaluatorAgent } from "../agents/collection-evaluator-agent.js";
import { buildCollectionRuleForCandidate } from "../lib/collections.js";
import type {
  CollectionCandidate,
  CollectionEvaluation,
  CollectionProposal,
  CollectionRegistryEntry,
  ModuleResult,
  PolicyDocument,
  RuntimeConfig
} from "../types.js";

export interface CollectionExecutedModule {
  job_id: string;
  run_dir: string;
  result: ModuleResult;
}

function getIterationBudget(runtimeConfig: RuntimeConfig): number {
  const value = Number(runtimeConfig.collections?.max_iterations_per_candidate ?? 2);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 2;
}

export async function runCollectionProposalWorkflow(args: {
  root: string;
  candidate: CollectionCandidate;
  policy: PolicyDocument;
  runtimeConfig: RuntimeConfig;
  registry: CollectionRegistryEntry[];
  executeModule: (
    moduleName: string,
    input: Record<string, unknown>,
    handler: (jobId: string) => Promise<ModuleResult> | ModuleResult
  ) => Promise<CollectionExecutedModule>;
}): Promise<{ proposal: CollectionProposal; executions: CollectionExecutedModule[] }> {
  const now = new Date().toISOString();
  const executions: CollectionExecutedModule[] = [];
  const builderAttempts: CollectionProposal["attempts"]["builder"] = [];
  const evaluatorAttempts: CollectionProposal["attempts"]["evaluator"] = [];
  const maxIterations = getIterationBudget(args.runtimeConfig);
  let feedback: string[] = [];
  let lastEvaluation: CollectionEvaluation = {
    decision: "REJECT",
    summary: "No evaluation was produced.",
    reasons: [],
    retry_instructions: []
  };
  let lastProposal = {
    title: args.candidate.source_value,
    handle: args.candidate.source_value,
    description_html: "",
    rationale: ""
  };

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const builderRun = await args.executeModule("collection-builder", {
      candidate: args.candidate,
      feedback
    }, async (jobId) => {
      const execution = await runCollectionBuilderAgent({
        root: args.root,
        jobId,
        candidate: args.candidate,
        policy: args.policy,
        attemptNumber: iteration,
        retryReason: feedback.join(" | ") || undefined,
        parentAttempt: iteration > 1 ? iteration - 1 : null,
        feedback
      });
      builderAttempts.push(execution.attempt);
      lastProposal = execution.proposal;
      return execution.result;
    });
    executions.push(builderRun);

    const evaluatorRun = await args.executeModule("collection-evaluator", {
      candidate: args.candidate,
      proposal: lastProposal
    }, async (jobId) => {
      const execution = await runCollectionEvaluatorAgent({
        root: args.root,
        jobId,
        candidate: args.candidate,
        proposal: lastProposal,
        registry: args.registry,
        attemptNumber: iteration,
        retryReason: feedback.join(" | ") || undefined,
        parentAttempt: iteration > 1 ? iteration - 1 : null
      });
      evaluatorAttempts.push(execution.attempt);
      lastEvaluation = execution.evaluation;
      return execution.result;
    });
    executions.push(evaluatorRun);

    if (lastEvaluation.decision !== "FEEDBACK") {
      break;
    }

    feedback = lastEvaluation.retry_instructions.length > 0
      ? lastEvaluation.retry_instructions
      : lastEvaluation.reasons;
  }

  const status = lastEvaluation.decision === "APPROVE"
    ? "approved"
    : lastEvaluation.decision === "FEEDBACK"
      ? "feedback"
      : lastEvaluation.decision === "ESCALATE"
        ? "escalated"
        : "rejected";

  return {
    proposal: {
      id: args.candidate.id,
      candidate_id: args.candidate.id,
      title: lastProposal.title,
      handle: lastProposal.handle,
      description_html: lastProposal.description_html,
      rationale: lastProposal.rationale,
      source_type: args.candidate.source_type,
      source_key: args.candidate.source_key,
      source_label: args.candidate.source_label,
      ...(args.candidate.namespace ? { namespace: args.candidate.namespace } : {}),
      ...(args.candidate.key ? { key: args.candidate.key } : {}),
      source_value: args.candidate.source_value,
      normalized_value: args.candidate.normalized_value,
      product_count: args.candidate.product_count,
      product_ids: args.candidate.product_ids,
      product_keys: args.candidate.product_keys,
      rule: buildCollectionRuleForCandidate(args.candidate),
      evaluator_decision: lastEvaluation.decision,
      evaluation: lastEvaluation,
      status,
      attempts: {
        builder: builderAttempts,
        evaluator: evaluatorAttempts
      },
      created_at: now,
      updated_at: new Date().toISOString()
    },
    executions
  };
}
