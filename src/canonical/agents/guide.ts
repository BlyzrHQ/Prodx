import { getConfig } from "../config.js";
import { callLlm } from "../services/llm.js";
import fs from "node:fs";
import path from "node:path";

interface GuideInput {
  businessName: string;
  businessDescription: string;
  industry: string;
  shopifyContext?: Record<string, unknown>;
}

export async function runGuideAgent(input: GuideInput): Promise<Record<string, unknown>> {
  const config = getConfig();
  const systemPrompt = `You are a Senior Catalog Strategist and Shopify Product Data Architect. Generate a comprehensive Catalog Guide as JSON. This guide is the operating playbook for catalog creation, enrichment, QA, merchandising, and Shopify publishing.`;

  const userPrompt = `Business: ${input.businessName}\nDescription: ${input.businessDescription}\nIndustry: ${input.industry}\n${input.shopifyContext ? "Shopify Context: " + JSON.stringify(input.shopifyContext, null, 2) : ""}\n\nGenerate the complete Catalog Guide as JSON.`;

  const schema = { name: "catalog_guide", schema: { type: "object", properties: { at_a_glance: { type: "object" }, product_title_system: { type: "object" }, product_description_system: { type: "object" }, attributes_metafields_schema: { type: "object" }, qa_validation_system: { type: "object" }, taxonomy: { type: "object" }, variant_architecture: { type: "object" }, image_media_standards: { type: "object" }, seo_discovery_rules: { type: "object" }, agentic_commerce_readiness: { type: "object" }, automation_playbook: { type: "object" }, merchandising_rules: { type: "object" }, eligibility_rules: { type: "object" }, quick_start_playbook: { type: "array" } }, required: ["product_title_system", "product_description_system", "attributes_metafields_schema", "qa_validation_system"] } };

  return (await callLlm({ systemPrompt, userPrompt, schema })) as Record<string, unknown>;
}

export function saveGuide(projectDir: string, guide: Record<string, unknown>): void {
  const guideDir = path.join(projectDir, ".catalog", "guide");
  fs.mkdirSync(guideDir, { recursive: true });
  fs.writeFileSync(path.join(guideDir, "catalog-guide.json"), JSON.stringify(guide, null, 2));
}
