import { createAnthropicJsonResponse } from "../connectors/anthropic.js";
import { createGeminiJsonResponse } from "../connectors/gemini.js";
import { createOpenAIJsonResponse } from "../connectors/openai.js";
import { resolveProvider } from "../lib/providers.js";
import { mergeProviderUsages } from "../lib/provider-usage.js";
import { buildCollectionRuleForCandidate } from "../lib/collections.js";
import { buildAgentAttempt } from "./shared.js";
import type {
  AgentAttempt,
  CollectionCandidate,
  CollectionProposal,
  CollectionRule,
  ConnectorJsonResponse,
  LooseRecord,
  ModuleResult,
  PolicyDocument,
  ProviderUsage
} from "../types.js";

interface BuilderOutput {
  title: string;
  handle: string;
  description_html: string;
  rationale: string;
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ")
    .trim();
}

function humanizeKey(value: string): string {
  return value
    .split(".")
    .pop()
    ?.replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) ?? value;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "collection";
}

function buildFallbackOutput(candidate: CollectionCandidate, feedback?: string[]): BuilderOutput {
  const valueTitle = titleCase(candidate.source_value);
  const needsMetafieldContext = candidate.source_type === "metafield" && (!feedback || feedback.length === 0);
  const title = candidate.source_type === "product_type"
    ? valueTitle
    : needsMetafieldContext
      ? valueTitle
      : `${humanizeKey(candidate.source_key)}: ${valueTitle}`;

  const description_html = candidate.source_type === "product_type"
    ? `<p>Products grouped by product type <strong>${candidate.source_value}</strong>.</p>`
    : `<p>Products where <strong>${humanizeKey(candidate.source_key)}</strong> is <strong>${candidate.source_value}</strong>.</p>`;

  return {
    title,
    handle: slugify(`${candidate.source_type === "product_type" ? "type" : humanizeKey(candidate.source_key)}-${candidate.source_value}`),
    description_html,
    rationale: candidate.source_type === "product_type"
      ? `This collection groups ${candidate.product_count} products that already share the product type ${candidate.source_value}.`
      : `This collection groups ${candidate.product_count} products that share the metafield value ${candidate.source_value} for ${humanizeKey(candidate.source_key)}.`
  };
}

function buildSchema() {
  return {
    name: "collection_builder",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "handle", "description_html", "rationale"],
      properties: {
        title: { type: "string" },
        handle: { type: "string" },
        description_html: { type: "string" },
        rationale: { type: "string" }
      }
    }
  };
}

function buildInstructions(candidate: CollectionCandidate, feedback?: string[]): string {
  const lines = [
    "You are building a Shopify smart collection proposal for a local CLI workflow.",
    "Return concise JSON only.",
    "Keep the collection useful, obvious, and reusable for any merchant.",
    "Do not invent editorial campaigns or seasonal collections.",
    "Use the candidate source exactly as given.",
    "Prefer short clear collection titles and a stable URL handle."
  ];
  if (feedback && feedback.length > 0) {
    lines.push(`Previous evaluator feedback: ${feedback.join(" | ")}`);
    lines.push("Revise the proposal to address that feedback.");
  }
  lines.push(`Candidate source: ${candidate.source_type} / ${candidate.source_key}`);
  lines.push(`Candidate value: ${candidate.source_value}`);
  lines.push(`Matched products: ${candidate.product_count}`);
  return lines.join("\n");
}

function buildPrompt(candidate: CollectionCandidate, policy: PolicyDocument, feedback?: string[]): LooseRecord {
  return {
    candidate,
    guide_collection_logic: policy.categorization_taxonomy?.collection_logic ?? policy.taxonomy_design?.collection_logic ?? [],
    guide_merchandising_rules: policy.collections_merchandising_rules?.guidance ?? policy.merchandising_rules?.collection_sorting_logic ?? [],
    evaluator_feedback: feedback ?? []
  };
}

async function callProvider<T>(args: {
  providerType: string;
  credential: string;
  model: string;
  prompt: LooseRecord;
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
  throw new Error(`Unsupported collection builder provider type: ${args.providerType}`);
}

export async function runCollectionBuilderAgent(args: {
  root: string;
  jobId: string;
  candidate: CollectionCandidate;
  policy: PolicyDocument;
  attemptNumber?: number;
  retryReason?: string;
  parentAttempt?: number | null;
  feedback?: string[];
}): Promise<{ result: ModuleResult; attempt: AgentAttempt; proposal: BuilderOutput }> {
  const startedAt = new Date().toISOString();
  const primary = await resolveProvider(args.root, "collection-builder", "llm_provider");
  const fallback = await resolveProvider(args.root, "collection-builder", "fallback_llm_provider");
  const instructions = buildInstructions(args.candidate, args.feedback);
  const prompt = buildPrompt(args.candidate, args.policy, args.feedback);
  const usages: Array<ProviderUsage | null | undefined> = [];
  let output = buildFallbackOutput(args.candidate, args.feedback);
  const warnings: string[] = [];

  const tryResolved = async (resolved: typeof primary): Promise<BuilderOutput | null> => {
    if (!resolved?.provider?.type || !resolved.credential?.value || !resolved.provider.model) return null;
    const response = await callProvider<BuilderOutput>({
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
    const primaryOutput = await tryResolved(primary);
    if (primaryOutput) {
      output = {
        ...primaryOutput,
        handle: slugify(primaryOutput.handle || primaryOutput.title)
      };
    }
  } catch (error) {
    warnings.push(`Primary builder provider failed: ${error instanceof Error ? error.message : String(error)}`);
    if (fallback) {
      try {
        const fallbackOutput = await tryResolved(fallback);
        if (fallbackOutput) {
          output = {
            ...fallbackOutput,
            handle: slugify(fallbackOutput.handle || fallbackOutput.title)
          };
        }
      } catch (fallbackError) {
        warnings.push(`Fallback builder provider failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
      }
    }
  }

  const proposalRule: CollectionRule = buildCollectionRuleForCandidate(args.candidate);
  const completedAt = new Date().toISOString();
  const result: ModuleResult = {
    job_id: args.jobId,
    module: "collection-builder",
    status: "success",
    needs_review: false,
    proposed_changes: {
      collection_proposal: {
        ...output,
        rule: proposalRule
      }
    },
    warnings,
    errors: [],
    reasoning: [output.rationale],
    artifacts: {
      provider_usage: mergeProviderUsages(usages),
      candidate_id: args.candidate.id
    },
    next_actions: ["Run collection evaluator"]
  };
  const attempt = buildAgentAttempt({
    agentId: "collection-builder-agent",
    module: result.module,
    attemptNumber: args.attemptNumber ?? 1,
    startedAt,
    completedAt,
    inputSnapshot: {
      candidate: args.candidate,
      feedback: args.feedback ?? []
    },
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
        accepted_attempt: attempt.attempt_number
      }
    },
    attempt,
    proposal: output
  };
}
