import type { LooseRecord, ProviderUsage } from "../types.js";

function numeric(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function mergeProviderUsages(usages: Array<ProviderUsage | null | undefined>): ProviderUsage | undefined {
  const present = usages.filter((usage): usage is ProviderUsage => Boolean(usage));
  if (present.length === 0) return undefined;

  const first = present[0];
  const mergedRaw: LooseRecord = {};
  present.forEach((usage, index) => {
    mergedRaw[`call_${index + 1}`] = usage.raw ?? {};
  });

  return {
    provider: first.provider,
    model: first.model,
    input_tokens: present.reduce((sum, usage) => sum + (numeric(usage.input_tokens) ?? 0), 0),
    output_tokens: present.reduce((sum, usage) => sum + (numeric(usage.output_tokens) ?? 0), 0),
    total_tokens: present.reduce((sum, usage) => sum + (numeric(usage.total_tokens) ?? 0), 0),
    cache_creation_input_tokens: present.reduce((sum, usage) => sum + (numeric(usage.cache_creation_input_tokens) ?? 0), 0),
    cache_read_input_tokens: present.reduce((sum, usage) => sum + (numeric(usage.cache_read_input_tokens) ?? 0), 0),
    reasoning_tokens: present.reduce((sum, usage) => sum + (numeric(usage.reasoning_tokens) ?? 0), 0),
    raw: mergedRaw
  };
}
