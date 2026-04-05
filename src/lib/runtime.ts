import fs from "node:fs/promises";
import { ensureDir, readJson, writeJson, writeText, exists } from "./fs.js";
import { getCatalogPaths } from "./paths.js";
import { setByPath, getByPath } from "./json-path.js";
import type { RuntimeConfig } from "../types.js";

export function defaultRuntimeConfig(): RuntimeConfig {
  return {
    providers: {
      openai_default: { type: "openai", credential: "openai", model: "gpt-5" },
      gemini_flash_default: { type: "gemini", credential: "gemini", model: "gemini-2.5-flash" },
      anthropic_default: { type: "anthropic", credential: "anthropic", model: "claude-sonnet-4-20250514" },
      openai_vision_default: { type: "openai", credential: "openai", model: "gpt-4.1-mini" },
      serper_default: { type: "serper", credential: "serper" },
      shopify_default: { type: "shopify", credential: "shopify", store: "", api_version: "2025-04" }
    },
    modules: {
      "catalogue-expert": { llm_provider: "openai_default", research_provider: "serper_default" },
      "product-enricher": { llm_provider: "openai_default", fallback_llm_provider: "gemini_flash_default" },
      "image-optimizer": { search_provider: "serper_default", vision_provider: "openai_vision_default" },
      "catalogue-qa": { llm_provider: "openai_default" },
      "catalogue-match": { catalog_provider: "shopify_default", reasoning_provider: "openai_default" },
      "shopify-sync": { shopify_provider: "shopify_default" },
      "collection-builder": { llm_provider: "openai_default", fallback_llm_provider: "gemini_flash_default" },
      "collection-evaluator": { llm_provider: "openai_default", fallback_llm_provider: "gemini_flash_default" }
    },
    agentic: {
      enabled: true,
      max_enrich_retries: 1,
      max_image_retries: 1,
      max_iterations_per_product: 4,
      strict_cost_guardrail: true,
      agents: {
        "guide-agent": { enabled: true, primary_provider: "openai_default" },
        "enrich-agent": { enabled: true, primary_provider: "openai_default", fallback_provider: "gemini_flash_default" },
        "image-agent": { enabled: true, primary_provider: "openai_vision_default" },
        "qa-agent": { enabled: true, primary_provider: "openai_default" },
        "supervisor-agent": { enabled: true },
        "collection-builder-agent": { enabled: true, primary_provider: "openai_default", fallback_provider: "gemini_flash_default" },
        "collection-evaluator-agent": { enabled: true, primary_provider: "openai_default", fallback_provider: "gemini_flash_default" }
      }
    },
    collections: {
      enabled: true,
      min_products_per_collection: 5,
      max_iterations_per_candidate: 2,
      allowed_rule_sources: ["product_type", "guide_metafields"],
      auto_apply: false
    }
  };
}

export async function initWorkspace(root: string) {
  const paths = getCatalogPaths(root);
  await ensureDir(paths.guideDir);
  await ensureDir(paths.learningDir);
  await ensureDir(paths.configDir);
  await ensureDir(paths.indexDir);
  await ensureDir(paths.runsDir);
  await ensureDir(paths.generatedDir);
  await ensureDir(paths.generatedProductsDir);
  await ensureDir(paths.generatedImagesDir);
  await ensureDir(paths.generatedCollectionsDir);
  if (!(await exists(paths.guideJson)) && (await exists(paths.legacyPolicyJson))) {
    await fs.copyFile(paths.legacyPolicyJson, paths.guideJson);
  }
  if (!(await exists(paths.guideMarkdown)) && (await exists(paths.legacyPolicyMarkdown))) {
    await fs.copyFile(paths.legacyPolicyMarkdown, paths.guideMarkdown);
  }
  if (!(await exists(paths.runtimeJson))) await writeJson(paths.runtimeJson, defaultRuntimeConfig());
  if (!(await exists(paths.learningMarkdown))) await writeText(paths.learningMarkdown, "# Catalog Learning\n\n- No lessons recorded yet.\n");
  return paths;
}

export async function loadRuntimeConfig(root: string): Promise<RuntimeConfig> {
  const paths = getCatalogPaths(root);
  return (await readJson(paths.runtimeJson, defaultRuntimeConfig())) ?? defaultRuntimeConfig();
}

export async function saveRuntimeConfig(root: string, config: RuntimeConfig): Promise<void> {
  const paths = getCatalogPaths(root);
  await writeJson(paths.runtimeJson, config);
}

export async function setRuntimeValue(root: string, pathExpression: string, value: string): Promise<RuntimeConfig> {
  const config = await loadRuntimeConfig(root);
  setByPath(config, pathExpression, value);
  await saveRuntimeConfig(root, config);
  return config;
}

export async function getRuntimeValue(root: string, pathExpression: string) {
  const config = await loadRuntimeConfig(root);
  return getByPath(config, pathExpression);
}
