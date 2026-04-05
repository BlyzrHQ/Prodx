import type { ProviderCostEstimate, ProviderUsage, WorkflowRunSummary } from "../types.js";

type PriceCard = {
  pricing_basis: string;
  input_per_million?: number;
  output_per_million?: number;
  cached_input_per_million?: number;
  cache_creation_input_per_million?: number;
  cache_read_input_per_million?: number;
};

const MODEL_PRICING: Record<string, PriceCard> = {
  "openai:gpt-5": {
    pricing_basis: "Estimated from public OpenAI API pricing as of 2026-04-05",
    input_per_million: 1.25,
    output_per_million: 10,
    cached_input_per_million: 0.125
  },
  "openai:gpt-5-mini": {
    pricing_basis: "Estimated from public OpenAI API pricing as of 2026-04-05",
    input_per_million: 0.25,
    output_per_million: 2,
    cached_input_per_million: 0.025
  },
  "openai:gpt-4.1": {
    pricing_basis: "Estimated from public OpenAI API pricing as of 2026-04-05",
    input_per_million: 2,
    output_per_million: 8,
    cached_input_per_million: 0.5
  },
  "openai:gpt-4.1-mini": {
    pricing_basis: "Estimated from public OpenAI API pricing as of 2026-04-05",
    input_per_million: 0.4,
    output_per_million: 1.6,
    cached_input_per_million: 0.1
  },
  "gemini:gemini-2.5-flash": {
    pricing_basis: "Estimated from public Gemini API pricing as of 2026-04-05",
    input_per_million: 0.3,
    output_per_million: 2.5
  },
  "gemini:gemini-2.5-pro": {
    pricing_basis: "Estimated from public Gemini API pricing as of 2026-04-05",
    input_per_million: 1.25,
    output_per_million: 10
  },
  "gemini:gemini-2.0-flash": {
    pricing_basis: "Estimated from public Gemini API pricing as of 2026-04-05",
    input_per_million: 0.1,
    output_per_million: 0.4
  },
  "anthropic:claude-sonnet-4-20250514": {
    pricing_basis: "Estimated from public Anthropic API pricing as of 2026-04-05",
    input_per_million: 3,
    output_per_million: 15,
    cache_creation_input_per_million: 3.75,
    cache_read_input_per_million: 0.3
  },
  "anthropic:claude-opus-4-20250514": {
    pricing_basis: "Estimated from public Anthropic API pricing as of 2026-04-05",
    input_per_million: 15,
    output_per_million: 75,
    cache_creation_input_per_million: 18.75,
    cache_read_input_per_million: 1.5
  },
  "anthropic:claude-3-7-sonnet-latest": {
    pricing_basis: "Estimated from public Anthropic API pricing as of 2026-04-05",
    input_per_million: 3,
    output_per_million: 15,
    cache_creation_input_per_million: 3.75,
    cache_read_input_per_million: 0.3
  }
};

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function ratePerMillion(tokens: number | undefined, rate: number | undefined): number {
  if (!tokens || !rate) return 0;
  return (tokens / 1_000_000) * rate;
}

function getPricingCard(usage: ProviderUsage): PriceCard | undefined {
  const provider = String(usage.provider ?? "").toLowerCase().trim();
  const model = String(usage.model ?? "").trim();
  if (!provider || !model) return undefined;
  return MODEL_PRICING[`${provider}:${model}`];
}

export function estimateProviderCost(usage: ProviderUsage | null | undefined): ProviderCostEstimate | undefined {
  if (!usage) return undefined;
  const pricing = getPricingCard(usage);
  const estimatedInput = ratePerMillion(usage.input_tokens, pricing?.input_per_million);
  const estimatedOutput = ratePerMillion(usage.output_tokens, pricing?.output_per_million);
  const estimatedCached = ratePerMillion(usage.cache_read_input_tokens, pricing?.cache_read_input_per_million ?? pricing?.cached_input_per_million)
    + ratePerMillion(usage.cache_creation_input_tokens, pricing?.cache_creation_input_per_million);
  const total = estimatedInput + estimatedOutput + estimatedCached;

  return {
    provider: usage.provider,
    model: usage.model,
    pricing_basis: pricing?.pricing_basis ?? "No pricing card matched this provider/model; cost treated as 0.",
    currency: "USD",
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    total_tokens: usage.total_tokens,
    estimated_input_cost_usd: roundUsd(estimatedInput),
    estimated_output_cost_usd: roundUsd(estimatedOutput),
    estimated_cache_cost_usd: roundUsd(estimatedCached),
    estimated_total_cost_usd: roundUsd(total),
    estimation_note: pricing ? undefined : "Search/API request fees outside tracked token usage are not included."
  };
}

export function summarizeWorkflowCosts(results: Array<{ module: string; job_id: string; artifacts?: Record<string, unknown> }>): WorkflowRunSummary["cost_summary"] {
  const stages = results.map((item) => {
    const cost = item.artifacts?.provider_cost as ProviderCostEstimate | undefined;
    return {
      module: item.module,
      job_id: item.job_id,
      provider: cost?.provider,
      model: cost?.model,
      total_tokens: Number(cost?.total_tokens ?? 0),
      estimated_total_cost_usd: roundUsd(Number(cost?.estimated_total_cost_usd ?? 0))
    };
  });
  return {
    currency: "USD",
    total_tokens: stages.reduce((sum, stage) => sum + Number(stage.total_tokens ?? 0), 0),
    estimated_total_cost_usd: roundUsd(stages.reduce((sum, stage) => sum + Number(stage.estimated_total_cost_usd ?? 0), 0)),
    stages
  };
}
