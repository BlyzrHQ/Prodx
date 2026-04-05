import { runImageOptimize } from "../modules/image-optimize.js";
import { buildAgentAttempt } from "./shared.js";
import type { AgentAttempt, ModuleResult, PolicyDocument, ProductRecord, RuntimeConfig } from "../types.js";

export async function runImageAgent(args: {
  root: string;
  jobId: string;
  input: ProductRecord;
  policy: PolicyDocument;
  runtimeConfig: RuntimeConfig;
  attemptNumber?: number;
  retryReason?: string;
  parentAttempt?: number | null;
}): Promise<{ result: ModuleResult; attempt: AgentAttempt }> {
  const startedAt = new Date().toISOString();
  const result = await runImageOptimize({
    root: args.root,
    jobId: args.jobId,
    input: args.input,
    policy: args.policy,
    runtimeConfig: args.runtimeConfig
  });
  const completedAt = new Date().toISOString();
  const attempt = buildAgentAttempt({
    agentId: "image-agent",
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
