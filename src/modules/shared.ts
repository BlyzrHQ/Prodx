import type { AgentRun, LooseRecord, ModuleResult } from "../types.js";

export function createBaseResult({
  jobId,
  module,
  status = "success",
  needsReview = true,
  proposedChanges = {},
  warnings = [],
  errors = [],
  reasoning = [],
  nextActions = [],
  artifacts = {},
  agentRun
}: {
  jobId: string;
  module: string;
  status?: string;
  needsReview?: boolean;
  proposedChanges?: LooseRecord;
  warnings?: string[];
  errors?: string[];
  reasoning?: string[];
  nextActions?: string[];
  artifacts?: LooseRecord;
  agentRun?: AgentRun;
}): ModuleResult {
  return {
    job_id: jobId,
    module,
    status,
    needs_review: needsReview,
    proposed_changes: proposedChanges,
    warnings,
    errors,
    reasoning,
    artifacts,
    next_actions: nextActions,
    agent_run: agentRun
  };
}
