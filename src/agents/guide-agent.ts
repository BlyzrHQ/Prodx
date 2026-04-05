import { runExpertGenerate } from "../modules/expert.js";
import { buildAgentAttempt } from "./shared.js";
import type { AgentAttempt, LooseRecord, ModuleResult } from "../types.js";

export async function runGuideAgent(args: { root: string; jobId: string; input: LooseRecord; attemptNumber?: number; retryReason?: string | undefined }): Promise<{ result: ModuleResult; attempt: AgentAttempt }> {
  const startedAt = new Date().toISOString();
  const result = await runExpertGenerate({ root: args.root, jobId: args.jobId, input: args.input });
  const completedAt = new Date().toISOString();
  const attempt = buildAgentAttempt({
    agentId: "guide-agent",
    module: result.module,
    attemptNumber: args.attemptNumber ?? 1,
    startedAt,
    completedAt,
    inputSnapshot: args.input,
    result,
    retryReason: args.retryReason
  });
  return {
    result: {
      ...result,
      agent_run: { workflow: "guide", attempts: [attempt], supervisor_decisions: [], accepted_attempt: attempt.attempt_number }
    },
    attempt
  };
}
