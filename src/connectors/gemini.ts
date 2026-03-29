import type { ConnectorJsonResponse } from "../types.js";

export async function createGeminiJsonResponse<T>({
  apiKey,
  model,
  systemInstruction,
  textPrompt,
  schema,
  imageUrl = null
}: {
  apiKey: string;
  model: string;
  systemInstruction?: string;
  textPrompt: string;
  schema: unknown;
  imageUrl?: string | null;
}): Promise<ConnectorJsonResponse<T>> {
  const rawSchema = typeof schema === "object" && schema !== null && "schema" in (schema as Record<string, unknown>)
    ? (schema as Record<string, unknown>).schema
    : schema;
  const normalizedSchema = sanitizeGeminiSchema(rawSchema);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const parts = [];

  if (textPrompt) {
    parts.push({ text: textPrompt });
  }
  if (imageUrl) {
    parts.push({
      file_data: {
        mime_type: "image/jpeg",
        file_uri: imageUrl
      }
    });
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      system_instruction: systemInstruction
        ? {
            parts: [{ text: systemInstruction }]
          }
        : undefined,
      contents: [
        {
          parts
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: normalizedSchema
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status} ${JSON.stringify(data)}`);
  }

  const text = extractGeminiText(data);
  return {
    raw: data,
    text,
    json: JSON.parse(text) as T
  };
}

function sanitizeGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeGeminiSchema(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(record)) {
    if (key === "additionalProperties") continue;
    output[key] = sanitizeGeminiSchema(entry);
  }

  return output;
}

function extractGeminiText(response: any): string {
  const text = response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!text) {
    throw new Error("Gemini response did not contain text output.");
  }
  return text;
}
