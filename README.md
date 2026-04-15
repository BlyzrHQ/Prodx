# Prodx

Open-source Shopify catalog management CLI powered by AI agents. Set up once, then use Claude Code or OpenAI Codex to manage your entire product catalog through natural language.

Prodx connects your Shopify store to an AI-powered pipeline that analyzes, enriches, validates, and publishes products — with duplicate detection, image optimization, and smart collection creation built in.

## How It Works

```
You (or CPO skill)
    |
    v
[ Add products ] -----> CSV, text, or product image
    |
    v
[ Analyzer ] ---------> LLM parses & normalizes input
    |
    v
[ Matcher ] ----------> Embedding search + LLM decides:
    |                    DUPLICATE (skip) | NEW_VARIANT (add to parent) | NEW_PRODUCT (full pipeline) | UNCERTAIN (save for review)
    v
[ Enricher ] ---------> LLM + web research builds title, description, SEO, metafields
    |
    v
[ Image Optimizer ] --> Reviews uploaded image first, then falls back to web search + Convex storage upload
    |
    v
[ QA Agent ] ---------> Scores product against Catalog Guide rules
    |
    v
[ Retry Loop ] -------> PASS → publish | FAIL → targeted retry | REVIEW → human
    |
    v
[ Publish ] ----------> Push to Shopify via GraphQL
```

## Quick Start

```bash
git clone https://github.com/BlyzrHQ/prodx.git
cd prodx
npm install
npm run setup
```

The setup wizard walks you through:
1. Business name, description, industry
2. LLM provider (OpenAI, Gemini, or Anthropic) + model selection
3. Embedding model for duplicate detection
4. Shopify store connection (recommended)
5. Convex database deployment (automatic)
6. Trigger.dev project linking (`TRIGGER_PROJECT_ID` + `TRIGGER_SECRET_KEY`)
7. Catalog guide generation via LLM

If you connect Shopify, the app should include these Admin API scopes:
- `read_products`
- `write_products`
- `read_product_listings`
- `read_inventory`
- `read_publications`
- `write_publications`
- `read_metaobject_definitions`
- `read_metaobjects`
- `write_metaobjects`

After setup, use the CPO skill in Claude Code or Codex:

```
/prodx-cpo sync my Shopify catalog
/prodx-cpo add products from this CSV
/prodx-cpo run the enrichment pipeline
/prodx-cpo check catalog status
```

Setup generates the runtime app back into this same repository: `convex/*`, `src/agents/*`, `src/services/*`, `src/cli.ts`, Trigger task files, and `.catalog/guide/*`.
This scaffold already owns `trigger.config.ts` and `src/trigger/*`, so you do not run `trigger init` as part of normal setup. `TRIGGER_PROJECT_ID` must be set in `.env` before running Trigger.dev commands.

## Commands

| Command | What It Does |
|---------|-------------|
| `npx tsx src/cli.ts add --file ./products.csv` | Add products from CSV and run the full workflow for true new products |
| `npx tsx src/cli.ts add --text "Product name..."` | Add from text description |
| `npx tsx src/cli.ts add --file ./photo.jpg` | Add from a local product image file (AI vision) |
| `npx tsx src/cli.ts add --image-url https://...` | Add from a product image URL |
| `npx tsx src/cli.ts sync` | Sync Shopify catalog to Convex |
| `npx tsx src/cli.ts sync context` | Sync Shopify metafield definitions and referenced metaobject entries to `storeContext` directly |
| `npx tsx src/cli.ts review` | Find products needing improvement |
| `npx tsx src/cli.ts run pipeline` | Run the needed pipeline stages (enrich and/or image, then QA, then publish on pass) |
| `npx tsx src/cli.ts publish` | Push generated products to Shopify |
| `npx tsx src/cli.ts status` | Check pipeline health |
| `npx tsx src/cli.ts guide` | Regenerate catalog guide |

## Data Flow

```
Shopify Store
    | (sync)
    v
products (source=shopify_sync, workflowStatus=synced) <-----------+
    | (review)                                                     |
    v                                                              |
products (workflowStatus=needs_review / in_review)                 |
    | (run pipeline)                                               |
    v                                                              |
enrich / image (only as needed) --> QA --> retry loop              |
    |                                                              |
    +-- pass --------------> products (workflowStatus=published) --+--> Shopify
    +-- fail after retries -> products (workflowStatus=needs_human_review)

Shopify Collections ---> collections (source=shopify_sync, workflowStatus=synced)
Catalogue summary ---> collection builder ---> collections (source=generated, workflowStatus=needs_review)

Store metadata + generated guide ---> storeContext
```

## Architecture

```
prodx/
  src/
    generators/          # Scaffold CLI — generates all project files
      project.ts         # Directories, .env, .gitignore
      convex.ts          # Convex schema (5 canonical tables) + functions
      agents.ts          # All agent code (analyzer, matcher, enricher, QA, image, etc.)
      runtime.ts         # Config, services, shared pipeline helpers, CLI
      trigger.ts         # Trigger.dev config + task wrappers
      cpo-skill.ts       # CPO skill for Claude Code + Codex
      guide-template.ts  # Catalog guide template + markdown renderer
    index.ts             # Setup wizard entry point
    types.ts             # TypeScript interfaces
  apps/web/              # Next.js marketing site (Cloudflare Workers)
```

### What Gets Generated

```
src/
  agents/                # AI agents (all logic + LLM prompts)
    analyzer.ts          # Parses CSV/text/image into structured products
    matcher.ts           # Two-step LLM: variant validator + product matcher
    enrich.ts            # Expert merchandiser with web research
    image.ts             # Visual merchandising with tiered image search
    qa.ts                # Strict quality gate with scoring
    guide.ts             # Catalog guide generation
    collection-builder.ts
    collection-evaluator.ts
  services/              # External service clients
    llm.ts               # LLM abstraction (OpenAI, Gemini, Anthropic)
    convex.ts            # Convex HTTP client
    shopify.ts           # Shopify GraphQL with pagination
    embeddings.ts        # Text embeddings for duplicate detection
    image-upload.ts      # Convex file storage upload
    pipeline.ts          # Shared sync / review / pipeline / collections logic
  trigger/               # Trigger.dev task wrappers (generated from trigger.config.ts)
  config.ts              # Environment config loader
  cli.ts                 # Project CLI
convex/
  schema.ts              # 5 tables (products, variants, productEmbeddings, collections, storeContext)
.claude/skills/prodx-cpo/  # CPO skill for Claude Code
.agents/skills/prodx-cpo/  # CPO skill for Codex
.catalog/guide/            # Generated catalog guide (JSON + Markdown)
.env                       # API keys and config
```

## Convex Tables

| Table | Purpose |
|-------|---------|
| `products` | Unified product lifecycle table for synced, manual, approved, rejected, and published products |
| `variants` | Synced and generated variants linked to `products` |
| `productEmbeddings` | Product title embeddings for duplicate and variant detection |
| `collections` | Synced Shopify collections and generated collection proposals/results |
| `storeContext` | Store options, metaobject choices, sync metadata, and the generated catalog guide |

## Trigger.dev Tasks

| Task | What It Does |
|------|-------------|
| `product-pipeline` | Orchestrates the durable product workflow used by the local CLI |
| `analyze-product-input` | Analyzer stage for CSV, text, and image intake |
| `match-product-candidate` | Matcher stage for duplicate / variant / new-product decisions |
| `product-enricher` | Enrichment stage task |
| `product-image-optimizer` | Product image selection and Convex upload stage |
| `product-qa` | QA review stage |
| `product-publisher` | Shopify publish stage for approved products and variant updates |
| `shopify-sync` | Syncs Shopify catalog data into Convex |
| `store-context-sync` | Syncs Shopify metafield definitions and referenced metaobject entries into `storeContext` |
| `build-collections` | Builds collection proposals from the catalogue summary with duplicate checks |
| `nightly-collection-builder` | Scheduled collection build refresh |
| `regenerate-catalog-guide` | Regenerates the guide stored in `storeContext` |
| `weekly-guide-refresh` | Scheduled guide refresh |

## Agents

### Analyzer
Parses any input format into structured product data:
- **CSV/TSV**: LLM formats each row (cleans abbreviations, extracts brand/size)
- **Text**: LLM parses natural language descriptions
- **Image**: OpenAI Vision extracts product info from photos

### Matcher (Two-Step LLM)
1. **Variant Validator**: Extracts brand, generates handle, identifies variant options, creates search text
2. **Product Matcher**: RAG search + variant lookup + LLM decision (NEW_PRODUCT / NEW_VARIANT / DUPLICATE / UNCERTAIN)

Brand-aware: different brands are never variants of each other.

### Enricher
Expert merchandiser with web research:
- Builds titles per guide formula
- Writes descriptions per guide structure
- Fills metafields respecting automation modes
- Researches high-risk fields (ingredients, allergens) from trusted sources only
- Creates new store context values when nothing fits

### QA Agent
LLM-driven quality gate with deterministic safety guards:
- Scores the product against the generated catalog guide
- Returns exact fields to fix plus reusable feedback for the enricher
- Auto-fails on critical blockers like missing price, placeholder values, unsupported customer-facing citations, required metafield gaps, and bad imagery
- Routes fixes to enricher or image agent based on findings

### Publish + Retry Flow
- QA returns a score plus fix guidance tied to the catalog guide
- Only the needed stages rerun on retry
- Products retry up to 3 times
- Passing products are pushed back to Shopify automatically
- Products with missing price can still go through enrich / image / QA, but they are blocked from publish until price exists
- Products that still fail move to `needs_human_review` with the issues saved

## Catalog Guide

The guide is the operating playbook for the entire pipeline. Generated during setup based on your business, industry, and Shopify store data. It includes:

- Business context and eligibility rules
- Product title formula and examples
- Description structure and tone rules
- Variant architecture and dimensions
- Metafield definitions with automation modes
- Image and media standards
- SEO rules
- QA passing score and validation rules
- Collection building logic

The guide is stored in both `.catalog/guide/` (local) and Convex (for Trigger.dev tasks).

## CPO Skill

After setup, a CPO (Chief Product Officer) skill is installed for both Claude Code and Codex. It knows all commands and decision rules. Use it to manage your catalog through natural language:

```
/prodx-cpo check my catalog status
/prodx-cpo add these products [attach CSV]
/prodx-cpo sync my Shopify store
/prodx-cpo run the pipeline on pending products
/prodx-cpo regenerate the catalog guide
```

## Supported LLM Providers

| Provider | Models | Used For |
|----------|--------|----------|
| OpenAI | gpt-5, gpt-5-mini, gpt-4.1, gpt-4.1-mini, o3, o4-mini | Enrichment, QA, guide, vision |
| Google Gemini | gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite | Enrichment, QA, guide |
| Anthropic | claude-opus-4.6, claude-sonnet-4.6, claude-opus-4, claude-sonnet-4 | Enrichment, QA, guide |

## Built With

<p>
  <a href="https://convex.dev"><img src="https://img.shields.io/badge/Convex-Database-orange" alt="Convex"></a>
  <a href="https://trigger.dev"><img src="https://img.shields.io/badge/Trigger.dev-Background%20Tasks-green" alt="Trigger.dev"></a>
  <a href="https://openai.com"><img src="https://img.shields.io/badge/OpenAI-LLM%20%2B%20Vision-blue" alt="OpenAI"></a>
  <a href="https://www.shopify.com"><img src="https://img.shields.io/badge/Shopify-E--commerce-brightgreen" alt="Shopify"></a>
  <a href="https://serper.dev"><img src="https://img.shields.io/badge/Serper-Image%20Search-yellow" alt="Serper"></a>
  <a href="https://ai.google.dev"><img src="https://img.shields.io/badge/Google%20Gemini-LLM-red" alt="Gemini"></a>
  <a href="https://anthropic.com"><img src="https://img.shields.io/badge/Anthropic-LLM-purple" alt="Anthropic"></a>
</p>

- **[Convex](https://convex.dev)** — Real-time database with vector search, file storage, and scheduled functions
- **[Trigger.dev](https://trigger.dev)** — Background task orchestration with retries, scheduling, and monitoring
- **[OpenAI](https://openai.com)** — LLM for enrichment, QA, guide generation + Vision for image analysis
- **[Shopify](https://shopify.com)** — E-commerce platform (GraphQL Admin API for catalog sync)
- **[Serper](https://serper.dev)** — Google search API for product image discovery
- **[Google Gemini](https://ai.google.dev)** — Alternative LLM provider
- **[Anthropic Claude](https://anthropic.com)** — Alternative LLM provider

## Contributing

PRs welcome. Please open an issue first to discuss what you'd like to change.

## License

MIT

## Credits

Built by [BlyzrHQ](https://github.com/BlyzrHQ).
