# Shopify Catalog Toolkit

Local-first Shopify catalog operations toolkit for generating a Catalog Guide, enriching products, selecting images, validating quality, preparing Shopify payloads, and publishing only safe products.

## What This Project Does

The toolkit helps you take product data from local files or Shopify-compatible sources and run it through a structured workflow:

1. Generate a store-specific Catalog Guide
2. Read products from JSON or CSV
3. Match products against accepted/generated products and optional external catalog data
4. Enrich product content with LLMs
5. Search and review product images
6. Run QA against the Catalog Guide
7. Prepare Shopify sync payloads
8. Publish only products that pass QA and sync safety checks

The project is local-first:

- all project state lives in `.catalog/`
- all generated outputs are written to disk
- all module runs are auditable
- live Shopify writes happen only when you explicitly request them

## Mental Model

Think of the project in 5 layers:

1. CLI layer
   - Commands such as `init`, `guide generate`, `workflow run`, and `publish`
2. Module layer
   - Each workflow step is a module: expert, match, enrich, image, QA, sync, learn
3. Prompt/spec layer
   - Shared prompt rules for all LLM-backed modules
4. Connector layer
   - OpenAI, Gemini, Anthropic, Shopify, Serper integrations
5. Workspace/output layer
   - `.catalog/` contains guides, runs, generated products, images, CSVs, and workbooks

## Project Structure

### Main source folders

```text
src/
  cli.ts
  connectors/
  lib/
  modules/
examples/
.catalog/
```

### What each part is for

- `src/cli.ts`
  - Main command entrypoint
  - Wires CLI commands to workflow modules

- `src/modules/`
  - Business workflow units
  - Main modules:
    - `expert.ts`
    - `match.ts`
    - `enrich.ts`
    - `image-optimize.ts`
    - `qa.ts`
    - `sync.ts`
    - `learn.ts`
    - `ingest.ts`

- `src/lib/`
  - Shared helpers and internal system logic
  - Important files:
    - `prompt-specs.ts`
    - `catalog-guide.ts`
    - `policy-template.ts`
    - `generated.ts`
    - `change-records.ts`
    - `product.ts`
    - `paths.ts`
    - `runtime.ts`

- `src/connectors/`
  - External service integrations
  - Main connectors:
    - `openai.ts`
    - `gemini.ts`
    - `anthropic.ts`
    - `shopify.ts`
    - `serper.ts`

- `examples/`
  - Test fixtures and sample input files for grocery, apparel, electronics, and alternate input structures

- `.catalog/`
  - Generated project workspace
  - Created by the CLI during init/workflow runs

## Shared Prompt/Spec System

The shared prompt/spec system lives in:

- `src/lib/prompt-specs.ts`

This file centralizes the durable instructions for LLM-backed modules. Instead of writing unrelated prompt text inside every module, the project keeps the core behavior in one place.

That means the following modules all follow a consistent contract:

- `guide` / `expert`
- `enrich`
- `qa`
- `image`

Each prompt/spec defines things like:

- role
- permanent behavior
- safety rules
- output rules

Then the module adds the runtime payload for the current product, guide, or workflow step.

In practice:

- `prompt-specs.ts` says how the model should behave
- `src/modules/*.ts` build the real payload for the current job
- `src/connectors/*.ts` send that request to the chosen provider

## Catalog Guide Helpers

These files manage the Catalog Guide:

- `src/lib/policy-template.ts`
  - starter guide shape
  - industry templates
  - Markdown rendering

- `src/lib/catalog-guide.ts`
  - helper functions for reading and using guide sections in other modules

The Catalog Guide is the main operating contract for the whole workflow. It drives:

- titles
- descriptions
- taxonomy
- variants
- metafields
- image standards
- SEO
- QA
- automation boundaries

## Providers and What They Do

### LLM providers

- OpenAI
- Gemini
- Anthropic

Used for:

- Catalog Guide generation
- product enrichment
- QA scoring/validation
- image review

### Search provider

- Serper

Used for:

- product image candidate search
- optional research support

### Shopify

Used for:

- catalog snapshot reads
- policy/store context
- sync payload application
- live publish

## `.catalog/` Workspace Layout

The toolkit writes all operational state into `.catalog/`.

```text
.catalog/
  policy/
  learning/
  config/
  index/
  runs/
  generated/
    products/
    images/
    workflow-products.json
    review-queue.csv
    shopify-import.csv
    catalog-review.xlsx
```

### Important files

- `.catalog/policy/catalog-policy.json`
  - machine-readable Catalog Guide

- `.catalog/policy/catalog-policy.md`
  - human-readable Catalog Guide

- `.catalog/learning/catalog-learning.md`
  - lessons learned from QA and review outcomes

- `.catalog/config/runtime.json`
  - provider aliases and module-to-provider mapping

- `.catalog/index/catalog-index.json`
  - local match index

- `.catalog/runs/<job-id>/`
  - per-run artifacts

- `.catalog/generated/products/<product-key>.json`
  - durable generated product files

- `.catalog/generated/images/<product-key>/`
  - selected image metadata and downloads

- `.catalog/generated/workflow-products.json`
  - running accepted/generated product ledger used during workflow

- `.catalog/generated/shopify-import.csv`
  - Shopify-compatible CSV export

- `.catalog/generated/catalog-review.xlsx`
  - workbook for workflow review and export visibility

## How Matching Works

Matching is based on generated product state, not only raw input rows.

Current behavior:

- the workflow creates a running generated-product ledger
- as products are accepted/generated, they are written into that ledger
- later products are matched against that generated-product state
- optional external catalog data can also be included with `--catalog`

This is why:

- duplicate rows in the same workflow run can be caught
- accepted products become the comparison set for later products
- export CSVs are mirrors of the accepted ledger, not the source of truth

## How Enrichment Works

The enricher uses:

- product input
- Catalog Guide
- allowed fields
- guide metafields
- store context
- optional web search when needed

The rule is intentionally simple:

- if trusted exact-match evidence exists, fill the field
- if not, skip it
- do not invent unsupported facts
- do not insert internal notes into customer-facing fields

For high-risk factual fields such as:

- ingredients
- allergen notes
- nutritional facts
- materials
- dimensions
- compatibility
- certifications

the provider can use web search when runtime allows it.

## How Image Optimization Works

The image optimizer does this:

1. build an image search query from the product title
2. fetch image candidates from Serper
3. review candidates one by one with vision
4. score the candidates
5. pick the best valid hero image
6. save the selection and metadata

Important:

- candidates are reviewed one by one
- one broken URL does not kill the whole batch anymore
- the optimizer only selects from the provided candidate set

## How QA Works

QA validates products against the Catalog Guide and produces:

- `PASS` / `FAIL`
- score
- findings
- skipped reasons

QA acts as the safety gate before publish.

Products should only be published when:

- `qa_status = PASS`
- score meets threshold
- sync has no blocking issues

## Typical Command Flow

## 1. Install

```bash
npm install
npm run typecheck
npm run build
```

## 2. Initialize

```bash
node .\dist\cli.js init
node .\dist\cli.js doctor
```

If you want raw workspace creation without the wizard:

```bash
node .\dist\cli.js init --no-wizard
```

## 3. Generate the Catalog Guide

```bash
node .\dist\cli.js guide generate --industry food_and_beverage --business-name "Demo Store" --business-description "A grocery store focused on dairy and pantry staples." --operating-mode both
```

## 4. Run the workflow

```bash
node .\dist\cli.js workflow run --input .\products.json --catalog .\catalog.json
```

## 5. Check outputs

Look at:

- `.catalog/generated/workflow-products.json`
- `.catalog/generated/shopify-import.csv`
- `.catalog/generated/catalog-review.xlsx`
- `.catalog/generated/products/`
- `.catalog/generated/images/`

## 6. Publish safe products

```bash
node .\dist\cli.js publish
```

Live publish to Shopify:

```bash
node .\dist\cli.js publish --live
```

## Common Commands

### Initialize

```bash
node .\dist\cli.js init
node .\dist\cli.js doctor
```

### Generate or show the guide

```bash
node .\dist\cli.js guide generate --industry apparel --business-name "Demo Apparel Store" --business-description "An apparel store focused on everyday essentials." --operating-mode both
node .\dist\cli.js guide show
```

### Run modules individually

```bash
node .\dist\cli.js match --input .\examples\product.json --catalog .\examples\catalog.json
node .\dist\cli.js enrich --input .\examples\product.json
node .\dist\cli.js image --input .\examples\product.json
node .\dist\cli.js qa --input .\examples\product.json
node .\dist\cli.js sync --input .\examples\product.json
```

### Batch mode

```bash
node .\dist\cli.js batch enrich --input .\products.json
node .\dist\cli.js batch qa --input .\products.csv
node .\dist\cli.js batch match --input .\products.json --catalog .\catalog.json
```

### Workflow mode

```bash
node .\dist\cli.js workflow run --input .\products.json --catalog .\catalog.json
```

### Review and apply

```bash
node .\dist\cli.js review queue
node .\dist\cli.js review <job-id>
node .\dist\cli.js review <job-id> --action approve
node .\dist\cli.js apply <job-id>
```

## Input File Support

The workflow accepts:

- JSON
- CSV

And it can normalize alternate structures, including:

- different top-level JSON shapes
- different column names
- common aliases such as:
  - `product_name` -> `title`
  - `sale_price` -> `price`
  - `brand_name` -> `brand`
  - `image_url` -> `featured_image`

## Examples

Sample fixtures live under:

- `examples/grocery/`
- `examples/apparel/`
- `examples/electronics/`
- `examples/alt-structure/`

These are useful for:

- duplicate testing
- cross-industry workflow tests
- alternate input structure tests

## Runtime Config

Runtime config lives at:

- `.catalog/config/runtime.json`

It controls:

- provider definitions
- module-to-provider mapping
- Shopify API version and store domain

Examples:

```bash
node .\dist\cli.js config set providers.shopify_default.store your-store.myshopify.com
node .\dist\cli.js config set modules.product-enricher.llm_provider openai_default
node .\dist\cli.js config set modules.image-optimizer.search_provider serper_default
node .\dist\cli.js config set modules.image-optimizer.vision_provider openai_vision_default
```

## Credentials

You can provide credentials through:

- `catalog auth set`
- OAuth flows where supported
- environment variables

Examples:

```bash
node .\dist\cli.js auth set --provider openai --value sk-example
node .\dist\cli.js auth set --provider gemini --value gemini-example
node .\dist\cli.js auth set --provider anthropic --value anthropic-example
node .\dist\cli.js auth set --provider serper --value srp-example
node .\dist\cli.js auth set --provider shopify --value shpat-example
```

## Safety

- live Shopify writes require explicit `--live`
- publish only applies safe sync-ready products
- QA is the main publish gate
- the toolkit prefers skipping unsafe data over guessing
- customer-facing fields should never contain internal notes or placeholders

## Verification

Use these commands before shipping changes:

```bash
npm run typecheck
npm run build
npm test
```

## Recommended First Run

If you want the simplest end-to-end first run:

```bash
cd .\shopify-catalog-toolkit
Remove-Item -Recurse -Force .\.catalog
npm run build
node .\dist\cli.js init
node .\dist\cli.js doctor
node .\dist\cli.js guide generate --industry food_and_beverage --business-name "Demo Store" --business-description "A grocery store focused on dairy and pantry staples." --operating-mode both
node .\dist\cli.js workflow run --input .\examples\grocery\products-match.json --catalog .\examples\grocery\catalog-match.json
node .\dist\cli.js publish
```

If you want live Shopify publish for eligible products:

```bash
node .\dist\cli.js publish --live
```
