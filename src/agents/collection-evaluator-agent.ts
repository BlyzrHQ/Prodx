import { createAnthropicJsonResponse } from "../connectors/anthropic.js";
import { createGeminiJsonResponse } from "../connectors/gemini.js";
import { createOpenAIJsonResponse } from "../connectors/openai.js";
import { resolveProvider } from "../lib/providers.js";
import { mergeProviderUsages } from "../lib/provider-usage.js";
import { buildAgentAttempt } from "./shared.js";
import type {
  AgentAttempt,
  CollectionCandidate,
  CollectionEvaluation,
  CollectionRegistryEntry,
  ConnectorJsonResponse,
  ModuleResult,
  ProviderUsage
} from "../types.js";

interface EvaluatorOutput extends CollectionEvaluation {}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildSchema() {
  return {
    name: "collection_evaluator",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["decision", "summary", "reasons", "retry_instructions"],
      properties: {
        decision: { type: "string", enum: ["APPROVE", "FEEDBACK", "ESCALATE", "REJECT"] },
        summary: { type: "string" },
        reasons: { type: "array", items: { type: "string" } },
        retry_instructions: { type: "array", items: { type: "string" } }
      }
    }
  };
}

function buildFallbackEvaluation(args: {
  candidate: CollectionCandidate;
  proposal: {
    title: string;
    handle: string;
    description_html: string;
    rationale: string;
  };
  registry: CollectionRegistryEntry[];
}): EvaluatorOutput {
  const duplicate = args.registry.find((entry) =>
    normalize(entry.source_value) === normalize(args.candidate.source_value)
    && entry.source_key === args.candidate.source_key
    && entry.source_type === args.candidate.source_type
  );
  if (duplicate) {
    return {
      decision: "REJECT",
      summary: "Equivalent collection already exists in the local registry.",
      reasons: [`Matched existing registry entry ${duplicate.id}`],
      retry_instructions: []
    };
  }

  if (args.candidate.product_count < args.candidate.min_products_per_collection) {
    return {
      decision: "REJECT",
      summary: "Candidate does not meet the minimum product count.",
      reasons: [`Only ${args.candidate.product_count} matching products were found.`],
      retry_instructions: []
    };
  }

  if (!args.proposal.title.trim() || !args.proposal.handle.trim()) {
    return {
      decision: "REJECT",
      summary: "Proposal is missing a title or handle.",
      reasons: ["A usable collection title and handle are required."],
      retry_instructions: []
    };
  }

  if (args.candidate.source_type === "metafield" && normalize(args.proposal.title) === normalize(args.candidate.source_value)) {
    return {
      decision: "FEEDBACK",
      summary: "Metafield collection title needs more context.",
      reasons: ["The proposed title repeats only the raw value and should mention what shoppers are browsing by."],
      retry_instructions: [`Revise the title so it includes the meaning of ${args.candidate.source_key}, not just the value.`]
    };
  }

  return {
    decision: "APPROVE",
    summary: "This collection is specific enough to be useful and meets the minimum product threshold.",
    reasons: [`Matched ${args.candidate.product_count} products from the generated ledger.`],
    retry_instructions: []
  };
}

function buildInstructions(candidate: CollectionCandidate): string {
  return [
    "You are evaluating a Shopify smart collection proposal for a local CLI workflow.",
    "Approve only collections that are clear, reusable, and not redundant.",
    "Reject duplicates and low-value collections.",
    "If the idea is good but the naming or explanation is weak, return FEEDBACK with concise retry instructions.",
    `Candidate source: ${candidate.source_type} / ${candidate.source_key}`,
    `Candidate value: ${candidate.source_value}`,
    `Matched products: ${candidate.product_count}`
  ].join("\n");
}

async function callProvider<T>(args: {
  providerType: string;
  credential: string;
  model: string;
  prompt: unknown;
  instructions: string;
}): Promise<ConnectorJsonResponse<T>> {
  if (args.providerType === "openai") {
    return createOpenAIJsonResponse<T>({
      apiKey: args.credential,
      model: args.model,
      instructions: args.instructions,
      input: args.prompt,
      schema: buildSchema()
    });
  }
  if (args.providerType === "gemini") {
    return createGeminiJsonResponse<T>({
      apiKey: args.credential,
      model: args.model,
      systemInstruction: args.instructions,
      textPrompt: JSON.stringify(args.prompt),
      schema: buildSchema()
    });
  }
  if (args.providerType === "anthropic") {
    return createAnthropicJsonResponse<T>({
      apiKey: args.credential,
      model: args.model,
      systemInstruction: args.instructions,
      textPrompt: JSON.stringify(args.prompt)
    });
  }
  throw new Error(`Unsupported collection evaluator provider type: ${args.providerType}`);
}

export async function runCollectionEvaluatorAgent(args: {
  root: string;
  jobId: string;
  candidate: CollectionCandidate;
  proposal: {
    title: string;
    handle: string;
    description_html: string;
    rationale: string;
  };
  registry: CollectionRegistryEntry[];
  attemptNumber?: number;
  retryReason?: string;
  parentAttempt?: number | null;
}): Promise<{ result: ModuleResult; attempt: AgentAttempt; evaluation: CollectionEvaluation }> {
  const startedAt = new Date().toISOString();
  const primary = await resolveProvider(args.root, "collection-evaluator", "llm_provider");
  const fallback = await resolveProvider(args.root, "collection-evaluator", "fallback_llm_provider");
  const prompt = {
    candidate: args.candidate,
    proposal: args.proposal,
    registry_matches: args.registry
      .filter((entry) => entry.source_key === args.candidate.source_key && normalize(entry.source_value) === normalize(args.candidate.source_value))
      .map((entry) => ({ id: entry.id, title: entry.title, handle: entry.handle, status: entry.status }))
  };
  const instructions = buildInstructions(args.candidate);
  const usages: Array<ProviderUsage | null | undefined> = [];
  const warnings: string[] = [];
  let evaluation = buildFallbackEvaluation({
    candidate: args.candidate,
    proposal: args.proposal,
    registry: args.registry
  });

  const tryResolved = async (resolved: typeof primary): Promise<EvaluatorOutput | null> => {
    if (!resolved?.provider?.type || !resolved.credential?.value || !resolved.provider.model) return null;
    const response = await callProvider<EvaluatorOutput>({
      providerType: resolved.provider.type,
      credential: resolved.credential.value,
      model: String(resolved.provider.model),
      prompt,
      instructions
    });
    usages.push(response.usage);
    return response.json;
  };

  try {
    const primaryEvaluation = await tryResolved(primary);
    if (primaryEvaluation) evaluation = primaryEvaluation;
  } catch (error) {
    warnings.push(`Primary evaluator provider failed: ${error instanceof Error ? error.message : String(error)}`);
    if (fallback) {
      try {
        const fallbackEvaluation = await tryResolved(fallback);
        if (fallbackEvaluation) evaluation = fallbackEvaluation;
      } catch (fallbackError) {
        warnings.push(`Fallback evaluator provider failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
      }
    }
  }

  const completedAt = new Date().toISOString();
  const status = evaluation.decision === "APPROVE"
    ? "passed"
    : evaluation.decision === "FEEDBACK"
      ? "needs_retry"
      : evaluation.decision === "ESCALATE"
        ? "needs_review"
        : "failed";
  const result: ModuleResult = {
    job_id: args.jobId,
    module: "collection-evaluator",
    status,
    needs_review: evaluation.decision === "ESCALATE",
    proposed_changes: {
      collection_evaluation: evaluation
    },
    warnings,
    errors: [],
    reasoning: [evaluation.summary, ...evaluation.reasons],
    artifacts: {
      provider_usage: mergeProviderUsages(usages),
      candidate_id: args.candidate.id
    },
    next_actions: evaluation.decision === "FEEDBACK" ? ["Retry collection builder with evaluator feedback"] : []
  };
  const attempt = buildAgentAttempt({
    agentId: "collection-evaluator-agent",
    module: result.module,
    attemptNumber: args.attemptNumber ?? 1,
    startedAt,
    completedAt,
    inputSnapshot: { candidate: args.candidate, proposal: args.proposal },
    result,
    retryReason: args.retryReason,
    parentAttempt: args.parentAttempt ?? null
  });

  return {
    result: {
      ...result,
      agent_run: {
        workflow: "collection-propose",
        attempts: [attempt],
        supervisor_decisions: [],
        accepted_attempt: evaluation.decision === "APPROVE" ? attempt.attempt_number : null
      }
    },
    attempt,
    evaluation
  };
}
