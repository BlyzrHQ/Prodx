import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../types.js";

const CANONICAL_RUNTIME_FILES = [
  ["services/llm.ts", "src/canonical/services/llm.ts"],
  ["services/shopify.ts", "src/canonical/services/shopify.ts"],
  ["services/embeddings.ts", "src/canonical/services/embeddings.ts"],
  ["services/image-upload.ts", "src/canonical/services/image-upload.ts"],
  ["services/pipeline.ts", "src/canonical/services/pipeline.ts"],
  ["cli.ts", "src/canonical/cli.ts"],
] as const;

export function generateRuntimeFiles(config: ProjectConfig): void {
  const srcDir = path.resolve(config.brand.projectDir, "src");
  const servicesDir = path.join(srcDir, "services");
  fs.mkdirSync(servicesDir, { recursive: true });

  fs.writeFileSync(path.join(srcDir, "config.ts"), generateConfig(config));
  fs.writeFileSync(path.join(servicesDir, "convex.ts"), generateConvexService());

  for (const [targetRelativePath, canonicalRelativePath] of CANONICAL_RUNTIME_FILES) {
    const targetPath = path.join(srcDir, targetRelativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, loadCanonicalRuntimeSource(canonicalRelativePath));
  }
}

function loadCanonicalRuntimeSource(relativePath: string): string {
  const absolutePath = path.resolve(relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(
      `Missing canonical runtime source: ${relativePath}. ` +
        `The scaffold expects src/canonical to be the source of truth for generated runtime files.`
    );
  }

  return fs.readFileSync(absolutePath, "utf-8");
}

function generateConfig(config: ProjectConfig): string {
  return `import "dotenv/config";

export interface Config {
  openaiApiKey: string | undefined;
  geminiApiKey: string | undefined;
  anthropicApiKey: string | undefined;
  serperApiKey: string | undefined;
  primaryLlm: string;
  primaryModel: string;
  fallbackLlm: string | undefined;
  fallbackModel: string | undefined;
  convexUrl: string | undefined;
  convexAuthToken: string | undefined;
  shopifyStore: string | undefined;
  shopifyAccessToken: string | undefined;
  triggerProjectId: string | undefined;
  triggerSecretKey: string | undefined;
}

let cachedConfig: Config | null = null;

export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;

  cachedConfig = {
    openaiApiKey: process.env.OPENAI_API_KEY || undefined,
    geminiApiKey: process.env.GEMINI_API_KEY || undefined,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    serperApiKey: process.env.SERPER_API_KEY || undefined,
    primaryLlm: process.env.PRIMARY_LLM_PROVIDER || "${config.llm.primary}",
    primaryModel: process.env.PRIMARY_LLM_MODEL || "${config.llm.primaryModel}",
    fallbackLlm: process.env.FALLBACK_LLM_PROVIDER || undefined,
    fallbackModel: process.env.FALLBACK_LLM_MODEL || undefined,
    convexUrl: process.env.CONVEX_URL || undefined,
    convexAuthToken: process.env.CONVEX_AUTH_TOKEN || undefined,
    shopifyStore: process.env.SHOPIFY_STORE || undefined,
    shopifyAccessToken: process.env.SHOPIFY_ACCESS_TOKEN || undefined,
    triggerProjectId: process.env.TRIGGER_PROJECT_ID || undefined,
    triggerSecretKey: process.env.TRIGGER_SECRET_KEY || undefined,
  };

  return cachedConfig;
}
`;
}

function generateConvexService(): string {
  return `import { getConfig } from "../config.js";

export async function convexQuery<T = unknown>(path: string, args: Record<string, unknown> = {}): Promise<T> {
  const { convexUrl, convexAuthToken } = getConfig();
  if (!convexUrl) throw new Error("CONVEX_URL not configured");

  const res = await fetch(convexUrl + "/api/query", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(convexAuthToken ? { Authorization: "Bearer " + convexAuthToken } : {}),
    },
    body: JSON.stringify({ path, args, format: "json" }),
  });

  if (!res.ok) throw new Error("Convex query [" + path + "] failed: " + res.status);
  const data = (await res.json()) as any;
  return data.value as T;
}

export async function convexMutation<T = unknown>(path: string, args: Record<string, unknown> = {}): Promise<T> {
  const { convexUrl, convexAuthToken } = getConfig();
  if (!convexUrl) throw new Error("CONVEX_URL not configured");

  const res = await fetch(convexUrl + "/api/mutation", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(convexAuthToken ? { Authorization: "Bearer " + convexAuthToken } : {}),
    },
    body: JSON.stringify({ path, args, format: "json" }),
  });

  if (!res.ok) throw new Error("Convex mutation [" + path + "] failed: " + res.status);
  const data = (await res.json()) as any;
  return data.value as T;
}

export async function convexAction<T = unknown>(path: string, args: Record<string, unknown> = {}): Promise<T> {
  const { convexUrl, convexAuthToken } = getConfig();
  if (!convexUrl) throw new Error("CONVEX_URL not configured");

  const res = await fetch(convexUrl + "/api/action", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(convexAuthToken ? { Authorization: "Bearer " + convexAuthToken } : {}),
    },
    body: JSON.stringify({ path, args, format: "json" }),
  });

  if (!res.ok) throw new Error("Convex action [" + path + "] failed: " + res.status);
  const data = (await res.json()) as any;
  return data.value as T;
}
`;
}
