import type { ConnectorJsonResponse } from "../types.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1/responses";

export async function createOpenAIJsonResponse<T>({
  apiKey,
  model,
  instructions,
  input,
  schema,
  maxOutputTokens = 1200,
  reasoningEffort,
  webSearch
}: {
  apiKey: string;
  model: string;
  instructions: string;
  input: unknown;
  schema: { name?: string; schema: unknown };
  maxOutputTokens?: number;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  webSearch?: {
    enabled: boolean;
    allowedDomains?: string[];
    externalWebAccess?: boolean;
    includeSources?: boolean;
  };
}): Promise<ConnectorJsonResponse<T>> {
  const buildRequestBody = (tokenBudget: number, instructionOverride?: string) => ({
    model,
    instructions: instructionOverride ?? instructions,
    input,
    max_output_tokens: tokenBudget,
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    ...(webSearch?.enabled ? {
      tools: [
        {
          type: "web_search",
          ...(Array.isArray(webSearch.allowedDomains) && webSearch.allowedDomains.length > 0
            ? { filters: { allowed_domains: webSearch.allowedDomains } }
            : {}),
          ...(typeof webSearch.externalWebAccess === "boolean"
            ? { external_web_access: webSearch.externalWebAccess }
            : {})
        }
      ],
      tool_choice: "auto",
      ...(webSearch.includeSources ? { include: ["web_search_call.action.sources"] } : {})
    } : {}),
    text: {
      format: {
        type: "json_schema",
        name: schema.name,
        schema: schema.schema,
        strict: true
      }
    }
  });

  const requestBody = buildRequestBody(maxOutputTokens);
  const response = await fetch(OPENAI_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${JSON.stringify(data)}`);
  }

  if (data?.status === "incomplete" && data?.incomplete_details?.reason === "max_output_tokens") {
    const retryBody = buildRequestBody(Math.max(maxOutputTokens + 2000, Math.ceil(maxOutputTokens * 1.5)), `${instructions} Return concise minified JSON only. Keep field values compact and avoid unnecessary prose.`);
    const retryResponse = await fetch(OPENAI_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(retryBody)
    });
    const retryData = await retryResponse.json();
    if (!retryResponse.ok) {
      throw new Error(`OpenAI retry request failed: ${retryResponse.status} ${JSON.stringify(retryData)}`);
    }
    const retryText = extractOpenAIText(retryData);
    const retryParsed = parseJsonWithRecovery<T>(retryText);
    if (!retryParsed.ok) {
      const retryError = (retryParsed as { ok: false; error: string }).error;
      throw new Error(`OpenAI returned invalid JSON after truncation retry: ${retryError}`);
    }
    return {
      raw: retryData,
      text: retryText,
      json: retryParsed.value
    };
  }

  let text = extractOpenAIText(data);
  let parsed = parseJsonWithRecovery<T>(text);
  if (!parsed.ok) {
    const retryResponse = await fetch(OPENAI_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        ...requestBody,
        instructions: `${instructions} Return valid minified JSON only. Do not include markdown, comments, or unfinished strings.`
      })
    });
    const retryData = await retryResponse.json();
    if (!retryResponse.ok) {
      throw new Error(`OpenAI retry request failed: ${retryResponse.status} ${JSON.stringify(retryData)}`);
    }
    text = extractOpenAIText(retryData);
    parsed = parseJsonWithRecovery<T>(text);
    if (!parsed.ok) {
      const retryError = (parsed as { ok: false; error: string }).error;
      throw new Error(`OpenAI returned invalid JSON after retry: ${retryError}`);
    }
    return {
      raw: retryData,
      text,
      json: parsed.value
    };
  }

  return {
    raw: data,
    text,
    json: parsed.value
  };
}

export async function analyzeImageWithOpenAI<T>({
  apiKey,
  model,
  instructions,
  prompt,
  imageUrl,
  imageUrls,
  schema,
  maxOutputTokens = 1200
}: {
  apiKey: string;
  model: string;
  instructions: string;
  prompt: string;
  imageUrl?: string;
  imageUrls?: string[];
  schema: { name?: string; schema: unknown };
  maxOutputTokens?: number;
}): Promise<ConnectorJsonResponse<T>> {
  const resolvedImageUrls = Array.isArray(imageUrls) && imageUrls.length > 0
    ? imageUrls
    : imageUrl
      ? [imageUrl]
      : [];

  return createOpenAIJsonResponse<T>({
    apiKey,
    model,
    instructions,
    maxOutputTokens,
    schema,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: prompt
          },
          ...resolvedImageUrls.map((url) => ({
            type: "input_image" as const,
            image_url: url
          }))
        ]
      }
    ]
  });
}

export function extractOpenAIWebSources(raw: unknown): Array<{ title?: string; url?: string; snippet?: string }> {
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

function extractOpenAIText(response: any): string {
  if (response.output_parsed) {
    return JSON.stringify(response.output_parsed);
  }

  const discovered = findStructuredPayload(response.output) ?? findStructuredPayload(response.text);
  if (discovered) {
    return discovered;
  }

  if (typeof response.output_text === "string" && response.output_text) {
    return response.output_text;
  }

  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "refusal") {
        const refusalText = typeof content.refusal === "string" ? content.refusal : typeof content.text === "string" ? content.text : "";
        throw new Error(`OpenAI returned a refusal${refusalText ? `: ${refusalText}` : "."}`);
      }

      if (content.type === "output_text") {
        if (typeof content.text === "string" && content.text) {
          return content.text;
        }
        if (typeof content.text?.value === "string" && content.text.value) {
          return content.text.value;
        }
      }

      if (content.type === "output_json" && content.json) {
        return JSON.stringify(content.json);
      }

      if (content.json) {
        return JSON.stringify(content.json);
      }

      if (typeof content.text === "string" && content.text.trim().startsWith("{")) {
        return content.text;
      }

      if (typeof content.text?.value === "string" && content.text.value.trim().startsWith("{")) {
        return content.text.value;
      }
    }
  }

  const outputPreview = safePreview(response.output);
  const incompleteDetails = safePreview(response.incomplete_details);
  throw new Error(
    `OpenAI response did not contain structured output text. Status: ${String(response?.status ?? "unknown")}. ` +
    `Response keys: ${Object.keys(response ?? {}).join(", ")}. Incomplete details: ${incompleteDetails}. Output preview: ${outputPreview}`
  );
}

function findStructuredPayload(value: unknown, depth = 0): string | null {
  if (depth > 5 || value === null || value === undefined) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      return trimmed;
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStructuredPayload(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["parsed", "json", "arguments", "output_text", "text", "value"]) {
      const found = findStructuredPayload(record[key], depth + 1);
      if (found) return found;
    }

    for (const child of Object.values(record)) {
      const found = findStructuredPayload(child, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function safePreview(value: unknown): string {
  try {
    const raw = JSON.stringify(value);
    return raw.length > 600 ? `${raw.slice(0, 597)}...` : raw;
  } catch {
    return "[unserializable]";
  }
}

function parseJsonWithRecovery<T>(text: string): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (error) {
    const repaired = repairLikelyTruncatedJson(text);
    if (repaired !== text) {
      try {
        return { ok: true, value: JSON.parse(repaired) as T };
      } catch {
        // fall through to error below
      }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function repairLikelyTruncatedJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;

  let output = "";
  let inString = false;
  let escaping = false;
  let curly = 0;
  let square = 0;

  for (const char of trimmed) {
    output += char;
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") curly += 1;
    if (char === "}") curly = Math.max(0, curly - 1);
    if (char === "[") square += 1;
    if (char === "]") square = Math.max(0, square - 1);
  }

  if (inString) output += "\"";
  output += "]".repeat(square);
  output += "}".repeat(curly);
  return output;
}
