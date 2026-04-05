import type { AgentAttempt, LooseRecord, ModuleResult, ProviderUsage } from "../types.js";

function sanitizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen));
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  const source = value as LooseRecord;
  const clone: LooseRecord = {};
  for (const [key, item] of Object.entries(source)) {
    if (key === "_catalog_stage_metrics") continue;
    clone[key] = sanitizeValue(item, seen) as any;
  }
  return clone;
}

export function asLooseRecord(value: unknown): LooseRecord {
  return value && typeof value === "object" ? sanitizeValue(value) as LooseRecord : {};
}

export function getProviderUsageFromResult(result: ModuleResult): ProviderUsage | null {
  const usage = result.artifacts?.provider_usage;
  return usage && typeof usage === "object" ? usage as ProviderUsage : null;
}

export function buildAgentAttempt(args: {
  agentId: string;
  module: string;
  attemptNumber: number;
  startedAt: string;
  completedAt: string;
  inputSnapshot: unknown;
  result: ModuleResult;
  retryReason?: string;
  parentAttempt?: number | null;
  accepted?: boolean;
}): AgentAttempt {
  const { agentId, module, attemptNumber, startedAt, completedAt, inputSnapshot, result, retryReason, parentAttempt, accepted } = args;
  return {
    agent_id: agentId,
    module,
    attempt_number: attemptNumber,
    started_at: startedAt,
    completed_at: completedAt,
    retry_reason: retryReason,
    parent_attempt: parentAttempt ?? null,
    accepted,
    needs_review: result.needs_review,
    status: result.status,
    summary: result.reasoning[0] ?? result.warnings[0] ?? result.status,
    provider_usage: getProviderUsageFromResult(result),
    input_snapshot: asLooseRecord(inputSnapshot),
    output_snapshot: {
      proposed_changes: asLooseRecord(result.proposed_changes),
      warnings: result.warnings,
      errors: result.errors,
      artifacts: asLooseRecord(result.artifacts)
    }
  };
}
