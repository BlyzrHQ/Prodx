import type { ConnectorJsonResponse, ProviderUsage } from "../types.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

function extractAnthropicUsage(raw: any, model: string): ProviderUsage | undefined {
  const usage = raw?.usage;
  if (!usage || typeof usage !== "object") return undefined;

  return {
    provider: "anthropic",
    model,
    input_tokens: Number(usage.input_tokens ?? 0),
    output_tokens: Number(usage.output_tokens ?? 0),
    total_tokens: Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0),
    cache_creation_input_tokens: Number(usage.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: Number(usage.cache_read_input_tokens ?? 0),
    raw: usage
  };
}

export async function createAnthropicJsonResponse<T>({
  apiKey,
  model,
  systemInstruction,
  textPrompt,
  maxTokens = 2200,
  webSearch
}: {
  apiKey: string;
  model: string;
  systemInstruction?: string;
  textPrompt: string;
  maxTokens?: number;
  webSearch?: {
    enabled: boolean;
    maxUses?: number;
    allowedDomains?: string[];
    blockedDomains?: string[];
  };
}): Promise<ConnectorJsonResponse<T>> {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemInstruction,
      ...(webSearch?.enabled ? {
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: webSearch.maxUses ?? 3,
            ...(Array.isArray(webSearch.allowedDomains) && webSearch.allowedDomains.length > 0
              ? { allowed_domains: webSearch.allowedDomains }
              : {}),
            ...(Array.isArray(webSearch.blockedDomains) && webSearch.blockedDomains.length > 0
              ? { blocked_domains: webSearch.blockedDomains }
              : {})
          }
        ]
      } : {}),
      messages: [
        {
          role: "user",
          content: textPrompt
        }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Anthropic request failed: ${response.status} ${JSON.stringify(data)}`);
  }

  const text = extractAnthropicText(data);
  return {
    raw: data,
    text,
    json: JSON.parse(text) as T,
    usage: extractAnthropicUsage(data, model)
  };
}

export function extractAnthropicWebSources(raw: unknown): Array<{ title?: string; url?: string; snippet?: string }> {
  const discovered: Array<{ title?: string; url?: string; snippet?: string }> = [];

  function visit(value: unknown, depth = 0): void {
    if (depth > 8 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    const url = typeof record.url === "string"
      ? record.url
      : typeof record.uri === "string"
        ? record.uri
        : undefined;
    const title = typeof record.title === "string"
      ? record.title
      : typeof record.name === "string"
        ? record.name
        : undefined;
    const snippet = typeof record.snippet === "string"
      ? record.snippet
      : typeof record.text === "string"
        ? record.text
        : undefined;

    if (url || title) {
      discovered.push({ title, url, snippet });
    }

    Object.values(record).forEach((child) => visit(child, depth + 1));
  }

  visit(raw);

  const seen = new Set<string>();
  return discovered.filter((item) => {
    const key = `${item.url ?? ""}|${item.title ?? ""}`;
    if (!item.url && !item.title) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractAnthropicText(response: any): string {
  const text = (response.content ?? [])
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("")
    .trim();

  if (!text) {
    throw new Error("Anthropic response did not contain text output.");
  }

  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  const start = [firstBrace, firstBracket].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? -1;
  if (start > 0) {
    return text.slice(start);
  }
  return text;
}
