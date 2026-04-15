import { getConfig } from "../config.js";

export async function embedText(text: string): Promise<number[]> {
  const { openaiApiKey } = getConfig();
  if (!openaiApiKey) throw new Error("OPENAI_API_KEY required for embeddings");

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + openaiApiKey,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: text,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error("Embeddings API error: " + res.status + " " + body);
      }

      const data = (await res.json()) as any;
      return data.data[0].embedding;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await delay(500 * attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(
    "Embeddings request failed after retries: " +
      (lastError instanceof Error ? lastError.message : String(lastError))
  );
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
