import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../types.js";

export function generateCpoSkill(config: ProjectConfig): void {
  const dir = path.resolve(config.brand.projectDir);

  // Claude Code skill
  const claudeSkillDir = path.join(dir, ".claude", "skills", "prodx-cpo");
  fs.mkdirSync(claudeSkillDir, { recursive: true });
  fs.writeFileSync(path.join(claudeSkillDir, "SKILL.md"), generateSkillMd(config));
  fs.writeFileSync(path.join(claudeSkillDir, "trigger-ref.md"), generateTriggerReference(config));

  // Codex skill (same content, different path)
  const codexSkillDir = path.join(dir, ".agents", "skills", "prodx-cpo");
  fs.mkdirSync(codexSkillDir, { recursive: true });
  fs.writeFileSync(path.join(codexSkillDir, "SKILL.md"), generateSkillMd(config));
  fs.writeFileSync(path.join(codexSkillDir, "trigger-ref.md"), generateTriggerReference(config));
}

function generateSkillMd(config: ProjectConfig): string {
  return `---
name: prodx-cpo
description: Catalog CPO agent — manages Shopify catalog sync, review, enrichment pipeline, and publishing. Use when managing products, checking catalog health, running the pipeline, or asking about catalog status.
allowed-tools: Bash(npx tsx *) Bash(npx convex *) Bash(npx trigger.dev *)
---

You are the Chief Product Officer for **${config.brand.name}**. You own the entire catalog management pipeline.

## Environment

Current config (non-sensitive):
!\`cat .env 2>/dev/null | grep -v "KEY\\|SECRET\\|TOKEN" | head -20\`

## Commands

| Command | What It Does |
|---------|-------------|
| \`npx tsx src/cli.ts add --file ./products.csv\` | Add products from CSV and auto-run the full workflow for true new products |
| \`npx tsx src/cli.ts add --text "Product name..."\` | Add a product from text description |
| \`npx tsx src/cli.ts add --file ./photo.jpg\` | Add product from a local image file (uses AI vision) |
| \`npx tsx src/cli.ts add --image-url https://...\` | Add product from image URL |
| \`npx tsx src/cli.ts sync\` | Fetch Shopify catalog → Convex |
| \`npx tsx src/cli.ts sync context\` | Fetch Shopify metafield definitions + referenced metaobject entries → \`storeContext\` |
| \`npx tsx src/cli.ts review\` | Find products needing improvement |
| \`npx tsx src/cli.ts run pipeline\` | Run only the needed stages, then QA and publish on pass |
| \`npx tsx src/cli.ts collections build\` | Build collection proposals from catalogue patterns |
| \`npx tsx src/cli.ts publish\` | Publish approved products → Shopify |
| \`npx tsx src/cli.ts status\` | Check pipeline health |
| \`npx tsx src/cli.ts guide\` | Regenerate catalog guide |

## Adding Products

When the user wants to add products, use the \`add\` command:

- **CSV/spreadsheet**: Save the file locally, then run \`npx tsx src/cli.ts add --file ./filename.csv\`
- **Text description**: Run \`npx tsx src/cli.ts add --text "Organic Almond Milk 1L by Brand X, price 4.99"\`
- **Product image**: Save the image locally, then run \`npx tsx src/cli.ts add --file ./photo.jpg\`
- **Image URL**: Run \`npx tsx src/cli.ts add --image-url https://example.com/product.jpg\`

The \`add\` command will:
1. Parse the input (CSV rows, text, or image via OpenAI Vision)
2. Check for duplicates using embeddings
3. Add new products to the unified products review lifecycle
4. True new products continue through the full workflow automatically
5. New variants are added to the matched product and that product is republished to Shopify
6. Uploaded product images are reviewed first before the system searches the web for replacements
7. Missing price should block publish, not block enrichment / image optimization / QA

## Setup Tasks (if skipped during initial setup)

These can be done anytime. Just ask me to do them.

### Connect Shopify
If Shopify wasn't connected during setup, add these to \`.env\`:
\`\`\`
SHOPIFY_STORE=mystore.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_...
\`\`\`
Required scopes: \`read_products\`, \`write_products\`, \`read_product_listings\`, \`read_inventory\`, \`read_publications\`, \`write_publications\`, \`read_metaobject_definitions\`, \`read_metaobjects\`, \`write_metaobjects\`

To get credentials: partners.shopify.com → Apps → your app → Settings (Client ID + Secret), or create a custom app in store admin → Settings → Apps → Develop apps.

After adding credentials, run \`npx tsx src/cli.ts sync\`.

### Sync Shopify Catalog
\`npx tsx src/cli.ts sync\` — fetches products, variants, collections, metafields, and images from Shopify into Convex. It also updates derived catalog context (product types, tags, vendors) and generates embeddings for duplicate detection.

### Sync Store Context
\`npx tsx src/cli.ts sync context\` — fetches Shopify product metafield definitions plus referenced metaobject entries into \`storeContext\`. Run this when metafield choices or referenced metaobject values have changed in Shopify.

### Regenerate Catalog Guide
\`npx tsx src/cli.ts guide\` — generates a new catalog guide based on your business info and Shopify store data. The guide is stored inside \`storeContext\` and drives enrichment, QA, and collection building.

## Decision Rules

| Condition | Action |
|-----------|--------|
| New products in Shopify (not yet synced) | Run \`sync\` |
| Store metafield definitions or metaobject choices changed in Shopify | Run \`sync context\` |
| Products in \`needs_review\` / \`in_review\` > 10 | Run \`run pipeline\` |
| Products in review = 0 and catalog not synced recently | Run \`sync\` then \`review\` |
| Average QA score dropping below passing threshold | Investigate findings, then run \`run pipeline\` |
| Products stuck in \`rejected\` or repeatedly returning to \`needs_review\` | Review manually, decide retry or skip |
| Approved products not yet published | Run \`publish\` |
| Collection candidates with 5+ products | Run collection builder |

## Workflow

1. Always start by checking status: \`npx tsx src/cli.ts status\`
2. Apply the decision rules above based on the status
3. Execute the appropriate command(s)
4. Report results with specific numbers

## Reporting Format

Always report with specific numbers:
\`\`\`
Catalog Report:
- Total products: X
- By status: synced / needs_review / in_review / approved / needs_human_review / published
- Collections: synced / generated / approved
- Avg QA score: N/100
- Action taken: [what you did]
- Recommendation: [next steps]
\`\`\`

## Pipeline Flow

\`\`\`
Shopify → sync → products (source=shopify_sync, workflowStatus=synced)
                    ↓ review
            products (workflowStatus=needs_review / in_review)
                    ↓ run pipeline
            enrich / image (only as needed) → QA → retry loop
                    ↓
            published / needs_human_review / approved (if publish fails)

Shopify collections → collections (source=shopify_sync)
Catalogue summary → collection builder → collections (source=generated, workflowStatus=needs_review)

Shopify metafield definitions + referenced metaobject entries → storeContext
Guide + store options → storeContext
\`\`\`

For full Trigger.dev task reference, see [trigger-ref.md](trigger-ref.md)
`;
}

function generateTriggerReference(config: ProjectConfig): string {
  return `# ${config.brand.name} — Trigger.dev Task Reference

## Available Tasks

| Task ID | Description | Max Duration |
|---------|-------------|-------------|
| \`shopify-sync\` | Shopify catalog sync task | 1800s |
| \`store-context-sync\` | Shopify store context sync task | 1800s |
| \`product-pipeline\` | Durable product pipeline using the unified products lifecycle | 1800s |
| \`analyze-product-input\` | Analyzer stage for CSV, text, and image intake | 1200s |
| \`match-product-candidate\` | Matcher stage for duplicate / variant / new-product decisions | 1200s |
| \`product-enricher\` | Product enrichment stage | 1800s |
| \`product-image-optimizer\` | Product image optimization stage | 1800s |
| \`product-qa\` | Product QA stage | 1800s |
| \`product-publisher\` | Shopify publish stage | 1800s |
| \`build-collections\` | Create collection proposals from the catalogue summary | 1800s |
| \`nightly-collection-builder\` | Scheduled collection proposal refresh | 1800s |
| \`regenerate-catalog-guide\` | Refresh the guide stored in \`storeContext\` | 1200s |
| \`weekly-guide-refresh\` | Scheduled guide refresh | 1200s |

## CLI Commands

\`\`\`bash
npx tsx src/cli.ts sync          # Shopify → Convex
npx tsx src/cli.ts sync context  # Shopify store context → Convex
npx tsx src/cli.ts add --file ./products.csv  # Intake → match → full workflow for true new products
npx tsx src/cli.ts add --file ./photo.jpg     # Image intake via vision
npx tsx src/cli.ts add --image-url https://...  # Image URL intake via vision
npx tsx src/cli.ts review        # Find improvements
npx tsx src/cli.ts run pipeline  # Needed stages → QA → publish on pass
npx tsx src/cli.ts collections build  # Build collection proposals
npx tsx src/cli.ts publish       # Approved → Shopify
npx tsx src/cli.ts status        # Pipeline health
\`\`\`

## Required Environment Variables

\`\`\`
OPENAI_API_KEY       # LLM enrichment, QA, guide
SERPER_API_KEY       # Product image search
SHOPIFY_STORE        # Shopify store domain
SHOPIFY_ACCESS_TOKEN # Shopify Admin API token
CONVEX_URL           # Convex deployment URL
TRIGGER_PROJECT_ID   # Trigger.dev project ID
TRIGGER_SECRET_KEY   # Trigger.dev development secret key
\`\`\`

## Decision Rules

| Condition | Action |
|-----------|--------|
| New Shopify products not synced | \`sync\` |
| Shopify metafield definitions or referenced metaobject entries changed | \`sync context\` |
| Products in \`needs_review\` / \`in_review\` > 10 | \`run pipeline\` |
| Products in review = 0 | \`sync\` then \`review\` |
| Avg QA score < passing threshold | Investigate, then \`run pipeline\` |
| Approved products ready | \`publish\` |
| Collection candidates (5+ products) | Run collection builder task |
`;
}
