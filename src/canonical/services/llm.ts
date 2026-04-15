import { getConfig } from "../config.js";

interface JsonSchemaEnvelope {
  name: string;
  schema: Record<string, unknown>;
}

interface CallLlmInput {
  systemPrompt: string;
  userPrompt: string;
  schema?: JsonSchemaEnvelope;
  webSearch?: boolean;
}

export async function callLlm<T = unknown>(input: CallLlmInput): Promise<T> {
  const config = getConfig();
  const provider = config.primaryLlm;
  const model = config.primaryModel;

  try {
    return await callProvider<T>(provider, model, input);
  } catch (primaryError) {
    if (!config.fallbackLlm || !config.fallbackModel) {
      throw new Error(
        "Primary LLM failed (" + provider + " / " + model + "): " + formatError(primaryError)
      );
    }

    try {
      return await callProvider<T>(config.fallbackLlm, config.fallbackModel, input);
    } catch (fallbackError) {
      throw new Error(
        "Primary LLM failed (" +
          provider +
          " / " +
          model +
          "): " +
          formatError(primaryError) +
          "\nFallback LLM failed (" +
          config.fallbackLlm +
          " / " +
          config.fallbackModel +
          "): " +
          formatError(fallbackError)
      );
    }
  }
}

async function callProvider<T>(
  provider: string,
  model: string,
  input: CallLlmInput
): Promise<T> {
  if (provider === "openai") {
    return callOpenAi<T>(model, input);
  }
  if (provider === "gemini") {
    return callGemini<T>(model, input);
  }
  if (provider === "anthropic") {
    return callAnthropic<T>(model, input);
  }
  throw new Error("Unsupported LLM provider: " + provider);
}

async function callOpenAi<T>(model: string, input: CallLlmInput): Promise<T> {
  const { openaiApiKey } = getConfig();
  if (!openaiApiKey) throw new Error("OPENAI_API_KEY not configured");

  const responseFormat = input.schema
    ? {
        type: "json_schema",
        json_schema: {
          name: input.schema.name,
          strict: true,
          schema: normalizeOpenAiSchema(input.schema.schema),
        },
      }
    : { type: "json_object" as const };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + openaiApiKey,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ],
      response_format: responseFormat,
    }),
  });

  if (!response.ok) {
    throw new Error("OpenAI error: " + response.status + " " + (await response.text()));
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned no content");
  return JSON.parse(content) as T;
}

async function callGemini<T>(model: string, input: CallLlmInput): Promise<T> {
  const { geminiApiKey } = getConfig();
  if (!geminiApiKey) throw new Error("GEMINI_API_KEY not configured");

  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: input.systemPrompt }] },
    contents: [{ parts: [{ text: input.userPrompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
    },
  };

  if (input.schema) {
    (body.generationConfig as Record<string, unknown>).responseSchema = normalizeGeminiSchema(
      input.schema.schema
    );
  }

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
      model +
      ":generateContent?key=" +
      geminiApiKey,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    throw new Error("Gemini error: " + response.status + " " + (await response.text()));
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error("Gemini returned no content");
  return JSON.parse(content) as T;
}

async function callAnthropic<T>(model: string, input: CallLlmInput): Promise<T> {
  const { anthropicApiKey } = getConfig();
  if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: input.systemPrompt,
      messages: [{ role: "user", content: input.userPrompt }],
    }),
  });

  if (!response.ok) {
    throw new Error("Anthropic error: " + response.status + " " + (await response.text()));
  }

  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = data.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Anthropic returned no content");
  return extractJsonFromText<T>(text);
}

function normalizeOpenAiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return normalizeJsonSchema(schema, {
    includeAdditionalProperties: true,
    forceAdditionalPropertiesFalse: true,
    forceAllObjectKeysRequired: true,
  });
}

function normalizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return normalizeJsonSchema(schema, {
    includeAdditionalProperties: false,
    forceAdditionalPropertiesFalse: false,
    forceAllObjectKeysRequired: false,
  });
}

function normalizeJsonSchema(
  schema: Record<string, unknown>,
  options: {
    includeAdditionalProperties: boolean;
    forceAdditionalPropertiesFalse: boolean;
    forceAllObjectKeysRequired: boolean;
  }
): Record<string, unknown> {
  const type = schema.type;
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      normalized.properties = Object.fromEntries(
        Object.entries(value).map(([propertyKey, propertyValue]) => [
          propertyKey,
          normalizeJsonSchema(propertyValue as Record<string, unknown>, options),
        ])
      );
      continue;
    }

    if (key === "items") {
      if (Array.isArray(value)) {
        normalized.items = value.map((item) =>
          normalizeJsonSchema(item as Record<string, unknown>, options)
        );
      } else if (value && typeof value === "object") {
        normalized.items = normalizeJsonSchema(value as Record<string, unknown>, options);
      } else {
        normalized.items = value;
      }
      continue;
    }

    if (key === "additionalProperties" && !options.includeAdditionalProperties) {
      continue;
    }

    if (key === "required" && options.forceAllObjectKeysRequired && type === "object") {
      continue;
    }

    normalized[key] = value;
  }

  if (type === "object") {
    const propertyKeys = Object.keys((normalized.properties as Record<string, unknown>) ?? {});
    if (options.forceAllObjectKeysRequired) {
      normalized.required = propertyKeys;
    } else if (!Array.isArray(normalized.required)) {
      normalized.required = Array.isArray(schema.required) ? schema.required : [];
    }

    if (options.forceAdditionalPropertiesFalse) {
      normalized.additionalProperties = false;
    }
  }

  return normalized;
}

function extractJsonFromText<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON object found in model response");
  }
  return JSON.parse(text.slice(start, end + 1)) as T;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
