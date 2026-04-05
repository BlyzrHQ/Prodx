# Prodx

Local-first Shopify catalog toolkit with an agentic workflow core and a simple Prodx homepage.

Prodx helps you prepare Shopify products with a guided workflow:

1. create a Catalog Guide
2. ingest products from JSON or CSV
3. detect duplicates and variants
4. enrich product content
5. find and review product images
6. run QA
7. generate a Shopify import file
8. propose smart collections from accepted product types and approved metafields
9. publish only safe products

Everything is written locally into `.catalog/`, so every run is inspectable and repeatable.
The guide is meant to work both as:

- the machine-readable contract for the workflow
- a human-readable operating playbook for catalog, merchandising, and QA teams

## Prodx Web

This repo includes a lightweight **Next.js + React** frontend in [`apps/web`](./apps/web).

The current web surface is a homepage for the project:

- product overview
- local install steps
- example workflow commands
- output summary

It keeps the same visual system and branding, but the working product surface remains the local CLI.

## Project Structure

```text
prodx/
├── apps/
│   └── web/                     # Prodx homepage
├── examples/                    # Grocery, apparel, electronics, variants, and alt-structure fixtures
├── src/
│   ├── agents/                  # Guide, enrich, image, QA, supervisor, and collection agent wrappers
│   ├── connectors/              # OpenAI, Gemini, Anthropic, Shopify, and Serper integrations
│   ├── lib/                     # Paths, runtime config, collections, exports, pricing, guide helpers, artifacts
│   ├── modules/                 # Deterministic engines and compatibility modules
│   └── workflows/               # Shared orchestration, retry loops, collection workflow, and workflow graph
├── tests/                       # End-to-end and fixture-backed regression tests
└── .catalog/                    # Local workspace outputs created at runtime
```

## Architecture

Prodx keeps the CLI and local workspace model stable, while the internal workflow is now more agentic:

- `catalogue-match`
  - stays deterministic
  - decides `DUPLICATE`, `NEW_VARIANT`, `NEW_PRODUCT`, or review-needed outcomes
- `guide-agent`
  - generates the Catalog Guide
- `enrich-agent`
  - drafts product content and structured fields
- `image-agent`
  - searches and reviews product images
- `qa-agent`
  - produces structured findings, retry targets, and review blockers
- `supervisor-agent`
  - decides whether to accept, retry, or escalate
- `collection-builder-agent`
  - drafts smart collection proposals from accepted product types and approved metafield values
- `collection-evaluator-agent`
  - approves, retries, or rejects collection proposals before apply
- `shopify-sync`
  - stays deterministic
  - prepares safe export and publish payloads

The user-facing CLI commands stay consistent. `init`, `guide generate`, `workflow run`, `review`, `publish`, the single-module commands, and the new `collections` command family all work locally from the same workspace.

## What It Handles

- Catalog Guide generation
- Duplicate detection
- New variant detection
- Product enrichment with LLMs
- Image search and image review
- QA scoring and review queueing
- Smart collection proposals from `product_type` and approved metafields
- Local collection registry with duplicate protection
- Shopify CSV export
- Safe local publish and optional live publish
- Provider usage logging in run artifacts

## How It Works

The workflow is:

1. `catalogue-match`
   - compares incoming products against accepted/generated products and any optional external catalog
   - stops immediately for true duplicates or review-only matches

2. `product-enricher`
   - uses the Catalog Guide plus trusted research to improve title, description, tags, and supported fields
   - fills verified facts
   - skips unverified facts

3. `image-optimizer`
   - searches for product images
   - reviews candidates
   - picks the best valid hero image if one exists

4. `catalogue-qa`
   - scores the product against the guide
   - creates findings and review recommendations
   - includes agentic-commerce readiness scoring and recommendations

5. `shopify-sync`
   - prepares a Shopify-ready payload
   - supports safe variant attach mode for `NEW_VARIANT`

6. `collections propose`
   - summarizes accepted/generated products by `product_type` and guide-approved metafield values
   - only considers values that meet the minimum product threshold
   - checks duplicates against the local collection registry
   - runs a builder/evaluator loop before saving proposals

7. `collections apply`
   - creates evaluator-approved smart collections in Shopify
   - writes created or skipped results back into the local collection registry

## Smart Collections

Prodx now includes a local-first smart collection workflow.

It is designed to stay aligned with the rest of the toolkit:

- source of truth is the accepted/generated product ledger
- duplicate checking is local-registry-first
- Shopify is only used for one-time collection import and explicit apply
- collections are proposed before they are ever created live

The default flow is:

1. `collections import`
   - imports existing Shopify smart collections into the local registry
2. `collections propose`
   - groups accepted products by `product_type` and guide-approved metafield values
   - only keeps values with `5` or more matching products by default
   - runs the collection builder/evaluator loop
3. `collections show`
   - shows the saved summary, registry, and latest proposal results
4. `collections apply`
   - creates only evaluator-approved smart collections in Shopify

The first version intentionally keeps scope narrow:

- smart collections only
- automatic rules from `product_type` and guide-approved metafields only
- no manual/editorial collections
- no seasonal campaign logic

## Workspace Output

The toolkit writes everything into `.catalog/`.

Important files:

- `.catalog/guide/catalog-guide.md`
  - human-readable Catalog Guide
- `.catalog/guide/catalog-guide.json`
  - machine-readable Catalog Guide
- `.catalog/generated/products/`
  - generated product JSON files
- `.catalog/generated/images/`
  - image metadata and downloads
- `.catalog/generated/workflow-products.json`
  - running accepted/generated product ledger
- `.catalog/generated/collections/collections.csv`
  - local collection registry for imported, proposed, created, and skipped collections
- `.catalog/generated/collections/collections.json`
  - structured collection registry with rule payloads and statuses
- `.catalog/generated/collections/summary.json`
  - grouped `product_type` and approved metafield values with counts
- `.catalog/generated/collections/proposals.json`
  - latest smart collection proposals and evaluator decisions
- `.catalog/generated/collections/apply-results.json`
  - results from explicit collection apply runs
- `.catalog/generated/shopify-import.csv`
  - Shopify import file
- `.catalog/generated/catalog-review.xlsx`
  - review workbook
- `.catalog/generated/review-queue.csv`
  - review queue export
- `.catalog/runs/<job-id>/`
  - raw module artifacts for each run
  - includes provider usage metadata when available

## Quick Start

Install and build:

```powershell
npm install
npm run build
npm test
npm run web:check
npm run web:build
```

Run the web app locally:

```powershell
npm run web:dev
```

Initialize the workspace:

```powershell
node .\dist\cli.js init
node .\dist\cli.js doctor
```

`init` still works the same way after the agentic refactor. The retry loop, learning, and cost tracking are internal workflow changes, not CLI-surface changes.

During `init`, the guided setup can now:

- connect OpenAI with a local Codex-backed auth import when a reusable OpenAI API key is available
- connect Gemini with API key or OAuth
- connect Anthropic with API key
- let the user choose the model for each provider during onboarding

Generate a guide:

```powershell
node .\dist\cli.js guide generate --industry apparel --business-name "Demo Store" --business-description "A store testing catalog workflows." --operating-mode both
```

Run the full workflow:

```powershell
node .\dist\cli.js workflow run --input .\examples\apparel\products-match.json --catalog .\examples\apparel\catalog-match.json
```

Or paste product text directly:

```powershell
node .\dist\cli.js workflow run --text "Uniqlo Club T-Shirt - 29.00`nNike Club Fleece Joggers Grey Large - 65.00"
```

Publish only safe products:

```powershell
node .\dist\cli.js publish
```

Generate smart collections locally:

```powershell
node .\dist\cli.js collections import
node .\dist\cli.js collections propose --min-products 5
node .\dist\cli.js collections show
node .\dist\cli.js collections apply
```

Live publish to Shopify:

```powershell
node .\dist\cli.js publish --live
```

## Most Useful Commands

Initialize:

```powershell
node .\dist\cli.js init
node .\dist\cli.js doctor
```

Guide:

```powershell
node .\dist\cli.js guide generate --industry food_and_beverage --business-name "Demo Store" --business-description "A grocery store focused on pantry staples." --operating-mode both
node .\dist\cli.js guide show
```

Single modules:

```powershell
node .\dist\cli.js match --input .\examples\product.json --catalog .\examples\catalog.json
node .\dist\cli.js enrich --input .\examples\product.json
node .\dist\cli.js image --input .\examples\product.json
node .\dist\cli.js qa --input .\examples\product.json
node .\dist\cli.js sync --input .\examples\product.json
```

Single-product pasted text also works:

```powershell
node .\dist\cli.js enrich --text "Uniqlo Club T-Shirt - 29.00"
node .\dist\cli.js match --text "JBL Tune 520BT Wireless On-Ear Headphones Black - 199" --catalog .\examples\electronics\catalog-match.json
```

Review:

```powershell
node .\dist\cli.js review queue
node .\dist\cli.js review <job-id>
node .\dist\cli.js review <job-id> --action approve
node .\dist\cli.js apply <job-id>
```

Collections:

```powershell
node .\dist\cli.js collections import
node .\dist\cli.js collections propose --min-products 5
node .\dist\cli.js collections show
node .\dist\cli.js collections apply
```

Auth and model setup:

```powershell
node .\dist\cli.js auth login --provider openai --model gpt-5
node .\dist\cli.js auth login --provider gemini --client-id <id> --client-secret <secret> --project-id <project> --model gemini-2.5-flash
node .\dist\cli.js auth set --provider anthropic --value <api-key> --model claude-sonnet-4-20250514
```

## Input Files

The workflow accepts:

- JSON
- CSV
- TXT files
- plain text

It also normalizes common alternate structures, including:

- nested JSON record arrays
- alternate header names
- common aliases such as:
  - `product_name` -> `title`
- `sale_price` -> `price`
- `brand_name` -> `brand`
- `image_url` -> `featured_image`
- `body_html` -> `description_html`

Plain text is supported in two useful forms:

1. simple title/price lines

```text
Almarai Fresh Milk Low Fat 1L - 8.50
Baladna Greek Yogurt Plain 500g - 12.50
```

2. key/value blocks

```text
title: Uniqlo Club T-Shirt
brand: Uniqlo
price: 29.00
size: Large
```

You can paste product text directly with `--text`:

```powershell
node .\dist\cli.js workflow run --text "Almarai Fresh Milk Low Fat 1L - 8.50`nBaladna Greek Yogurt Plain 500g - 12.50" --catalog .\examples\grocery\catalog-match.json
```

## Matching Rules

The workflow compares products against the running generated-product ledger, not just the raw input file.

That means:

- later rows can match earlier accepted rows
- duplicates are skipped early
- safe new variants can attach to the matched parent family
- Shopify export is built from accepted/generated products

## Enrichment Rules

The enrich behavior is intentionally simple:

- use the Catalog Guide
- research when needed
- fill facts only when the evidence is trusted
- skip facts that cannot be verified
- never put internal review notes into customer-facing text
- keep the customer-facing description clean even when factual fields are skipped

## Image Rules

The image workflow:

- searches with exact product-title-based queries
- checks more than one search query pattern
- filters obviously bad URLs before vision review
- reviews candidates in batches
- avoids using obvious brand assets as hero images

If it still fails, the usual reason is that the web does not surface a good exact product image.

## Variants

The toolkit now supports:

- duplicate skip
- `NEW_VARIANT` detection
- parent/child export rows under the same Shopify handle
- variant attach payload generation

For live Shopify attach, the parent product must exist in Shopify and be resolvable to a real Shopify product ID.

## Guide Quality

The generated Catalog Guide is intentionally richer than a basic config dump. It includes:

- taxonomy and category design
- title and description playbooks
- variant and duplicate rules
- metafield definitions
- image and QA standards
- agentic-commerce readiness guidance
- worked examples and edge cases

If live guide generation fails, the command now fails cleanly instead of silently pretending a fallback guide is the final result.

## Examples

Use the sample fixtures in:

- `examples/grocery/`
- `examples/apparel/`
- `examples/electronics/`
- `examples/alt-structure/`

These are useful for:

- duplicate testing
- variant testing
- alternate input structure testing
- cross-industry workflow checks

## Manual Category Tests

You can test the same workflow end to end with the provided fixtures.

Start from a clean local workspace each time:

```powershell
Remove-Item -Recurse -Force .\.catalog -ErrorAction SilentlyContinue
node .\dist\cli.js init
```

Grocery:

```powershell
node .\dist\cli.js workflow run --input .\examples\grocery\products-match.json --catalog .\examples\grocery\catalog-match.json
```

Apparel:

```powershell
node .\dist\cli.js workflow run --input .\examples\apparel\products-match.json --catalog .\examples\apparel\catalog-match.json
```

Electronics:

```powershell
node .\dist\cli.js workflow run --input .\examples\electronics\products-match.json --catalog .\examples\electronics\catalog-match.json
```

You can also test pasted text:

```powershell
node .\dist\cli.js workflow run --text "Almarai Fresh Milk Low Fat 1L - 8.50`nJBL Tune 520BT Wireless On-Ear Headphones Black - 199" --catalog .\examples\grocery\catalog-match.json
```

## Credentials And Config

Common auth commands:

```powershell
node .\dist\cli.js auth set --provider openai --value <key>
node .\dist\cli.js auth set --provider gemini --value <key>
node .\dist\cli.js auth set --provider anthropic --value <key>
node .\dist\cli.js auth set --provider serper --value <key>
node .\dist\cli.js auth set --provider shopify --value <token>
```

Common config commands:

```powershell
node .\dist\cli.js config set providers.shopify_default.store your-store.myshopify.com
node .\dist\cli.js config set modules.product-enricher.llm_provider openai_default
node .\dist\cli.js config set modules.image-optimizer.search_provider serper_default
node .\dist\cli.js config set modules.image-optimizer.vision_provider openai_vision_default
```

You can also tune the new agentic runtime settings:

```powershell
node .\dist\cli.js config set agentic.max_enrich_retries 1
node .\dist\cli.js config set agentic.max_image_retries 1
node .\dist\cli.js config set agentic.max_iterations_per_product 4
node .\dist\cli.js config set agentic.strict_cost_guardrail true
```

## Customization

Prodx is designed to be customized both through config and through code.

Config-driven customization:

- change provider defaults and models in `.catalog/config/runtime.json`
- change agent retry caps and guardrails in `.catalog/config/runtime.json`
- change module-to-provider routing with `catalog config set ...`
- switch Shopify store targets and API credentials without changing code

Code-driven customization:

- add new agent wrappers in [src/agents](C:/Users/Abood/Cataluge%20Manager/shopify-catalog-toolkit/src/agents)
- extend orchestration in [src/workflows](C:/Users/Abood/Cataluge%20Manager/shopify-catalog-toolkit/src/workflows)
- add or refine deterministic logic in [src/modules](C:/Users/Abood/Cataluge%20Manager/shopify-catalog-toolkit/src/modules)
- adjust guide rendering and export behavior in [src/lib](C:/Users/Abood/Cataluge%20Manager/shopify-catalog-toolkit/src/lib)
- extend input normalization in [src/modules/ingest.ts](C:/Users/Abood/Cataluge%20Manager/shopify-catalog-toolkit/src/modules/ingest.ts)

Typical extension points:

- cost-estimator agent
- image-input agent
- compliance agent
- SEO agent
- custom Shopify metafield export rules

## Cost Estimation

Prodx now tracks token usage and estimated USD cost as part of the local workflow artifacts.

What is stored:

| Level | File | What it contains |
| --- | --- | --- |
| Per module run | `.catalog/runs/<job-id>/usage-cost.json` | Provider usage and estimated USD cost for that run |
| Per module run | `.catalog/runs/<job-id>/result.json` | Full result plus `artifacts.provider_usage` and `artifacts.provider_cost` |
| Per generated product | `.catalog/generated/products/<product-key>.json` | Stage-level metrics under `_catalog_stage_metrics` |
| Per workflow batch | `.catalog/generated/workflow-costs.json` | Rolled-up token totals and estimated USD cost across workflow runs |

How to think about these numbers:

- they are estimates, not billing statements
- they are based on model-specific pricing cards in [src/lib/provider-cost.ts](C:/Users/Abood/Cataluge%20Manager/shopify-catalog-toolkit/src/lib/provider-cost.ts)
- provider pricing changes over time, so the numbers should be treated as operational estimates
- token-tracked model calls are included
- external services that do not expose token usage may not be fully priced

## Safety

- live Shopify writes only happen with `--live`
- QA is the main publish gate
- duplicate and review-blocked products do not get exported for publish
- the toolkit prefers skipping uncertain data over guessing

## Known Limitations

- image quality still depends on what trusted exact-match sources exist on the web
- provider quality and factual source quality still affect the final result
- cost estimates are helpful operationally but are not exact provider invoices
- the current web app is a homepage only; the operational workflow still lives in the CLI
- live Shopify publish still depends on real store credentials and store-side product state

## Contributing

PRs welcome. Please open an issue first to discuss what you'd like to change.

## Credits

Built by BlyzrHQ.

Powered by:

- OpenAI
- Google Gemini
- Anthropic
- Shopify
- Serper

## Verification

Before pushing changes:

```powershell
npm run build
npm test
```
