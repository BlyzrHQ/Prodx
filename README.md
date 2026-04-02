# Shopify Catalog Toolkit

Local-first toolkit for preparing Shopify products with a guided workflow:

1. create a Catalog Guide
2. ingest products from JSON or CSV
3. detect duplicates and variants
4. enrich product content
5. find and review product images
6. run QA
7. generate a Shopify import file
8. publish only safe products

Everything is written locally into `.catalog/`, so every run is inspectable and repeatable.
The guide is meant to work both as:

- the machine-readable contract for the workflow
- a human-readable operating playbook for catalog, merchandising, and QA teams

## What It Handles

- Catalog Guide generation
- Duplicate detection
- New variant detection
- Product enrichment with LLMs
- Image search and image review
- QA scoring and review queueing
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

## Workspace Output

The toolkit writes everything into `.catalog/`.

Important files:

- `.catalog/policy/catalog-policy.md`
  - human-readable Catalog Guide
- `.catalog/policy/catalog-policy.json`
  - machine-readable Catalog Guide
- `.catalog/generated/products/`
  - generated product JSON files
- `.catalog/generated/images/`
  - image metadata and downloads
- `.catalog/generated/workflow-products.json`
  - running accepted/generated product ledger
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
```

Initialize the workspace:

```powershell
node .\dist\cli.js init
node .\dist\cli.js doctor
```

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

## Safety

- live Shopify writes only happen with `--live`
- QA is the main publish gate
- duplicate and review-blocked products do not get exported for publish
- the toolkit prefers skipping uncertain data over guessing

## Verification

Before pushing changes:

```powershell
npm run build
npm test
```
