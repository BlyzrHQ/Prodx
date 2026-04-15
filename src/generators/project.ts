import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../types.js";

export function scaffoldProject(config: ProjectConfig): void {
  const dir = path.resolve(config.brand.projectDir);

  // Create only the NEW directories needed for generated files
  const dirs = [
    "src/agents",
    "src/services",
    ".catalog/guide",
    ".catalog/config",
  ];

  if (config.services.convex) dirs.push("convex");
  // Trigger task files are created after trigger.config.ts is established.

  for (const d of dirs) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }

  // .env — always write (contains user's answers from onboarding)
  const envLines = [
    `# LLM Providers`,
    `OPENAI_API_KEY=${config.keys.openaiApiKey}`,
    `GEMINI_API_KEY=${config.keys.geminiApiKey || ""}`,
    `ANTHROPIC_API_KEY=${config.keys.anthropicApiKey || ""}`,
    `SERPER_API_KEY=${config.keys.serperApiKey || ""}`,
    ``,
    `# LLM Configuration`,
    `PRIMARY_LLM_PROVIDER=${config.llm.primary}`,
    `PRIMARY_LLM_MODEL=${config.llm.primaryModel}`,
    `FALLBACK_LLM_PROVIDER=${config.llm.fallback || ""}`,
    `FALLBACK_LLM_MODEL=${config.llm.fallbackModel || ""}`,
    ``,
    `# Embeddings`,
    `EMBEDDING_MODEL=${config.embedding.model}`,
    `EMBEDDING_PROVIDER=${config.embedding.provider}`,
    `EMBEDDING_DIMENSIONS=${config.embedding.dimensions}`,
    ``,
  ];

  if (config.hasShopify) {
    envLines.push(
      `# Shopify`,
      `SHOPIFY_STORE=${config.keys.shopifyStore || ""}`,
      `SHOPIFY_ACCESS_TOKEN=${config.keys.shopifyAccessToken || ""}`,
      ``
    );
  }

  if (config.services.convex) {
    envLines.push(`# Convex`, `CONVEX_URL=`, `CONVEX_AUTH_TOKEN=`, ``);
  }

  if (config.services.trigger) {
    envLines.push(
      `# Trigger.dev`,
      `TRIGGER_PROJECT_ID=`,
      `TRIGGER_SECRET_KEY=`,
      ``
    );
  }

  fs.writeFileSync(path.join(dir, ".env"), envLines.join("\n"));

  // GitHub Actions for Trigger.dev deploy
  if (config.services.trigger) {
    const ghDir = path.join(dir, ".github", "workflows");
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghDir, "deploy.yml"),
      `name: Deploy Trigger.dev Tasks
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx trigger.dev@latest deploy
        env:
          TRIGGER_ACCESS_TOKEN: \${{ secrets.TRIGGER_ACCESS_TOKEN }}
`
    );
  }
}
