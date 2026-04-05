import { runEnrich } from "../modules/enrich.js";
import { buildAgentAttempt } from "./shared.js";
import type { AgentAttempt, ModuleResult, PolicyDocument, ProductRecord } from "../types.js";

export async function runEnrichAgent(args: {
  root: string;
  jobId: string;
  input: ProductRecord;
  policy: PolicyDocument;
  attemptNumber?: number;
  retryReason?: string;
  parentAttempt?: number | null;
}): Promise<{ result: ModuleResult; attempt: AgentAttempt }> {
  const startedAt = new Date().toISOString();
  const result = await runEnrich({ root: args.root, jobId: args.jobId, input: args.input, policy: args.policy });
  const completedAt = new Date().toISOString();
  const attempt = buildAgentAttempt({
    agentId: "enrich-agent",
    module: result.module,
    attemptNumber: args.attemptNumber ?? 1,
    startedAt,
    completedAt,
    inputSnapshot: args.input,
    result,
    retryReason: args.retryReason,
    parentAttempt: args.parentAttempt ?? null
  });
  return {
    result: {
      ...result,
      agent_run: { workflow: "product-workflow", attempts: [attempt], supervisor_decisions: [], accepted_attempt: null }
    },
    attempt
  };
}
