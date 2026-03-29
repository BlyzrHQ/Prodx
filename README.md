# Shopify Catalog Toolkit

Local-first Shopify catalog operations toolkit built from [the PRD](C:\Users\Abood\Cataluge Manager\PRD-shopify-catalog-management-system.md).

## Quick Start

If you want the fastest path from zero to a working local workflow, use this:

```bash
npm install
npm run typecheck
npm run build
node .\dist\cli.js init
node .\dist\cli.js doctor
```

Then, after setup:

```bash
node .\dist\cli.js workflow run --input .\products.json --catalog .\catalog.json
```

Recommended project convention for source files:

```text
input/
  shopify-export.csv
  supplier-feed.csv
  products.json
```

The CLI does not require a special file name. The user can place product source files anywhere in the project and pass them with `--input`, but using an `input/` folder keeps the workflow clearer.

If you only want to test one product first:

```bash
node .\dist\cli.js enrich --input .\examples\product.json
node .\dist\cli.js review <job-id> --action approve
node .\dist\cli.js apply <job-id>
```

## Overview

This project is designed as a review-first catalog operations system for Shopify teams.

It gives you:

- a TypeScript codebase under `src/`
- a `catalog` CLI for running each workflow step locally
- human-readable CLI output by default, with `--json` for scripts and agents
- terminal progress indicators for longer-running commands in interactive mode
- portable `agents/*.md` playbooks for agent-driven usage
- a project-local `.catalog/` workspace for policy, learning, config, indexes, and run artifacts
- durable generated outputs under `.catalog/generated/products` and `.catalog/generated/images`
- bring-your-own providers for OpenAI, Gemini, Serper, and Shopify

The current module set is:

- `catalogue-expert`
- `catalogue-ingest`
- `catalogue-match`
- `product-enricher`
- `image-optimizer`
- `catalogue-qa`
- `shopify-sync`
- `feedback-learn`

## Tech Setup

### Prerequisites

- Node.js `22+`
- npm
- Shopify Admin API credentials if you want live Shopify reads or writes
- OpenAI and/or Gemini credentials if you want provider-backed enrichment
- Serper credentials if you want provider-backed image search

### Install

From [shopify-catalog-toolkit](C:\Users\Abood\Cataluge Manager\shopify-catalog-toolkit):

```bash
npm install
```

### TypeScript Workflow

This project now has a real TypeScript toolchain.

Use:

```bash
npm run typecheck
npm run build
```

What those do:

- `npm run typecheck`
  Type-checks the shipped TypeScript source under `src/`
- `npm run build`
  Compiles the CLI and source into `dist/`
- `npm test`
  Builds the project first, then runs the local test suite

The installed `catalog` binary uses the compiled build in `dist/`, so run `npm run build` after pulling changes or before using the packaged bin directly.

For complex commands with many flags, the simplest direct form is:

```bash
node .\dist\cli.js <command> ...
```

## First-Time Project Setup

### 1. Initialize the local catalog workspace

```bash
npm run catalog -- init
```

By default, `init` can launch a guided setup wizard in an interactive terminal. It can help the user:

- choose business name and industry
- describe the business in plain language
- choose the operating mode: local files, Shopify, or both
- enter provider/API credentials up front
- generate the policy pack immediately after setup
- decide which providers to configure
- optionally store provider credentials
- optionally set Shopify store domain

Use this if you want raw initialization only:

```bash
node .\dist\cli.js init --no-wizard
```

This creates:

- `.catalog/policy/`
- `.catalog/learning/`
- `.catalog/config/`
- `.catalog/index/`
- `.catalog/runs/`
- `.catalog/generated/products/`
- `.catalog/generated/images/`

If you want the wizard:

```bash
node .\dist\cli.js init
```

If you want only the folders with no prompts:

```bash
node .\dist\cli.js init --no-wizard
```

### 2. Generate the store policy pack

```bash
node .\dist\cli.js expert generate --industry grocery --business-name "Demo Store" --business-description "A grocery store focused on fresh dairy and pantry staples." --operating-mode both
```

This writes:

- `.catalog/policy/catalog-policy.md`
- `.catalog/policy/catalog-policy.json`
- `.catalog/learning/catalog-learning.md`

Behavior:

- if `catalogue-expert` has a ready OpenAI provider, it uses `gpt-5`
- if Shopify is connected, it can inspect sample product structure and metafields to adapt the policy
- web research is off by default
- if you explicitly want research, use `--research true`
- if providers are missing or unavailable, it falls back to a strong local starter template

The policy keeps the same business-facing structure either way. The model fills the content inside that structure rather than replacing it with a different format.

### 3. Configure providers and credentials

You can configure providers in two ways:

- store credentials through the CLI
- use environment variables from [.env.example](C:\Users\Abood\Cataluge Manager\shopify-catalog-toolkit\.env.example)

Recommended path for real users:

- use `catalog auth set` for secrets
- use `catalog config set` for non-secret runtime settings
- use shell env vars mainly for CI, automation, or temporary testing

Important:

- the toolkit reads real environment variables from the shell
- it does not automatically load a `.env` file by itself
- so a plain `.env` file is not enough unless you load it into the environment before running the CLI

#### CLI credential setup

```bash
npm run catalog -- auth set --provider openai --value sk-example
npm run catalog -- auth set --provider gemini --value gemini-example
npm run catalog -- auth set --provider serper --value srp-example
npm run catalog -- auth set --provider shopify --value shpat_example
```

#### Environment variable setup

Copy [.env.example](C:\Users\Abood\Cataluge Manager\shopify-catalog-toolkit\.env.example) into your local env workflow and fill in:

- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `SERPER_API_KEY`
- `SHOPIFY_ADMIN_TOKEN`
- optionally `SHOPIFY_STORE_DOMAIN`

If you use PowerShell, this means setting values in the shell session before running the CLI, for example:

```bash
$env:OPENAI_API_KEY="..."
$env:GEMINI_API_KEY="..."
$env:SERPER_API_KEY="..."
$env:SHOPIFY_ADMIN_TOKEN="..."
```

### 4. Set the Shopify store domain

```bash
npm run catalog -- config set providers.shopify_default.store your-store.myshopify.com
```

### 5. Verify runtime readiness

```bash
npm run catalog -- doctor
```

`doctor` shows:

- which credential aliases are available
- which module slots are mapped to which providers
- which module/provider slots are actually ready
- whether the configured Shopify store is present in runtime config

## Provider Map

This is the easiest way to understand which external service is used by which part of the system.

| Module / Step | What it does | Provider used |
| --- | --- | --- |
| `catalogue-expert` | Generates the store policy | OpenAI GPT-5 |
| `catalogue-expert` | Optional external research before policy generation | Serper |
| `product-enricher` | Enriches title, description, tags, product type | OpenAI or Gemini |
| `image-optimizer` | Searches for image candidates | Serper |
| `image-optimizer` | Reviews image quality / fit | OpenAI Vision or Gemini |
| `catalogue-qa` | Scores listings against the policy | OpenAI + deterministic checks |
| `catalogue-match` | Pulls live Shopify catalog when `--catalog` is not used | Shopify |
| `catalogue-match` | Optional reasoning provider slot | OpenAI |
| `shopify-sync` | Builds and optionally applies Shopify payloads | Shopify |

Important:

- provider choice is different from agent choice
- `Codex` and `Claude Code` are ways to use the CLI and playbooks
- `OpenAI`, `Gemini`, `Serper`, and `Shopify` are the actual runtime providers

## Runtime Config

The runtime config lives at:

- `.catalog/config/runtime.json`

It controls which provider alias each module uses.

Typical defaults:

- `product-enricher`
  - primary: `openai_default`
  - fallback: `gemini_flash_default`
- `catalogue-expert`
  - policy generation: `openai_default`
  - research: `serper_default`
- `image-optimizer`
  - search: `serper_default`
  - vision: `openai_vision_default`
- `catalogue-match`
  - catalog source: `shopify_default`
  - reasoning provider: `openai_default`
- `shopify-sync`
  - Shopify target: `shopify_default`

Useful examples:

```bash
npm run catalog -- config set modules.product-enricher.llm_provider openai_default
npm run catalog -- config set modules.product-enricher.fallback_llm_provider gemini_flash_default
npm run catalog -- config set modules.image-optimizer.search_provider serper_default
npm run catalog -- config set modules.image-optimizer.vision_provider openai_vision_default
npm run catalog -- config set providers.shopify_default.api_version 2025-04
```

## Project Workspace Layout

The toolkit writes all project-specific operational state into `.catalog/`.

High-level tree:

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
```

### Policy

- `.catalog/policy/catalog-policy.md`
  Human-readable business policy
- `.catalog/policy/catalog-policy.json`
  Machine-readable version of the same policy

### Learning

- `.catalog/learning/catalog-learning.md`
  Distilled lessons learned from review and human feedback

### Config

- `.catalog/config/runtime.json`
  Provider aliases, module-to-provider mapping, and Shopify runtime config

### Index

- `.catalog/index/catalog-index.json`
  Local cached catalog index used by matching logic

### Runs

Each module invocation gets its own run folder:

- `.catalog/runs/<job-id>/input.json`
- `.catalog/runs/<job-id>/result.json`
- `.catalog/runs/<job-id>/changes.json`
- `.catalog/runs/<job-id>/review.json`
- `.catalog/runs/<job-id>/review.md`
- `.catalog/runs/<job-id>/decision.json`
- `.catalog/runs/<job-id>/apply.json`

### Generated outputs

These are the durable outputs that survive beyond any single run:

- `.catalog/generated/products/<product-key>.json`
  Canonical generated product data after enrichment, QA, sync prep, and apply
- `.catalog/generated/images/<product-key>/metadata.json`
  Image review/search metadata, selected image URL, and download notes
- `.catalog/generated/images/<product-key>/selected.<ext>`
  Downloaded selected image when a remote image URL is available and download succeeds
- `.catalog/generated/review-queue.csv`
  Spreadsheet-friendly CSV summary of workflow output and review status
- `.catalog/generated/shopify-import.csv`
  Shopify-compatible CSV export so a user can import products through Shopify if they prefer CSV over live sync
- `.catalog/generated/catalog-review.xlsx`
  Excel workbook with separate sheets for runs, generated products, and Shopify import rows

This means:

- run folders are your audit trail
- generated folders are your durable working outputs

## CLI Reference

## User Journey

The easiest mental model for a new user is:

1. initialize the toolkit
2. tell it what business you run
3. let it generate the catalog policy
4. connect the providers you want
5. run one product or a whole file
6. review what it proposes
7. apply locally or live
8. keep improving the policy and learning files over time

There are two normal ways to use the system:

### Single-product mode

Use this when you want to test safely or work on one product at a time.

Typical flow:

```bash
node .\dist\cli.js enrich --input .\examples\product.json
node .\dist\cli.js review <job-id>
node .\dist\cli.js review <job-id> --action approve
node .\dist\cli.js apply <job-id>
```

### File / batch / workflow mode

Use this when you already have a local JSON or CSV file with many products.

Typical flow:

```bash
node .\dist\cli.js workflow run --input .\products.json --catalog .\catalog.json
```

Recommended convention:

- place source files under an `input/` folder
- use any descriptive name such as:
  - `input/shopify-export.csv`
  - `input/incoming-products.json`
  - `input/supplier-feed.csv`

Examples:

```bash
node .\dist\cli.js workflow run --input .\input\shopify-export.csv
node .\dist\cli.js batch enrich --input .\input\incoming-products.json
```

The toolkit will:

- read the file
- split it into individual product records
- process each product one by one
- show live per-product and per-step progress in interactive terminal mode
- create run folders for every module step
- save durable product outputs under `.catalog/generated/products`
- save image metadata and downloaded images under `.catalog/generated/images`
- write a spreadsheet-friendly review queue to `.catalog/generated/review-queue.csv`
- write a Shopify import CSV to `.catalog/generated/shopify-import.csv`
- write an Excel workbook to `.catalog/generated/catalog-review.xlsx`

### Output modes

By default, CLI commands print human-readable text for operators.

If you want machine-readable output for automation or agent tooling, add:

```bash
--json
```

Examples:

```bash
node .\dist\cli.js doctor
node .\dist\cli.js doctor --json
```

### `catalog init`

Initializes the `.catalog/` workspace for the current project.

In an interactive terminal, it can also launch the guided setup wizard unless `--no-wizard` is used.

The wizard is the best first-time path because it asks for:

- business name
- short business description
- industry
- operating mode: local files, Shopify, or both
- provider/API setup
- Shopify store domain
- whether to generate the policy immediately

### `catalog auth`

Credential management.

Commands:

- `catalog auth set --provider <name> --value <secret>`
- `catalog auth list`
- `catalog auth test --provider <name>`

Use this for:

- OpenAI keys
- Gemini keys
- Serper keys
- Shopify Admin tokens

### `catalog config`

Runtime configuration management.

Commands:

- `catalog config set <path> <value>`
- `catalog config get <path>`

Use this to:

- point modules at different providers
- set Shopify store domain
- adjust provider models

### `catalog doctor`

Checks which providers and module slots are ready.

Use this after setup or when debugging missing provider configuration.

### `catalog review`

Review packets and approval actions.

Commands:

- `catalog review <job-id>`
- `catalog review <job-id> --action approve`
- `catalog review <job-id> --action reject`
- `catalog review queue`
- `catalog review queue --module shopify-sync`
- `catalog review queue --product prod-100`
- `catalog review bulk --action approve`
- `catalog review bulk --action approve --module shopify-sync`
- `catalog review bulk --action approve --product prod-100`

Use this to:

- inspect one run in detail
- see the review queue after a workflow
- approve or reject directly in terminal
- bulk-approve reviewable runs when you are comfortable with the generated output

### `catalog expert generate`

Creates the initial store policy pack and initializes the learning file.

Example:

```bash
npm run catalog -- expert generate --industry grocery --business-name "Demo Store"
```

Recommended real use:

```bash
node .\dist\cli.js expert generate --industry grocery --business-name "Demo Store" --business-description "A neighborhood grocery store selling dairy, produce, and pantry products online." --operating-mode both
```

The policy generated here is the source of truth for:

- title structure
- description structure
- taxonomy
- checklist rules
- QA scoring
- image requirements
- SEO and handle rules
- variant logic
- pricing and discount rules
- attributes and metafields
- collections and merchandising guidance

Default behavior:

- GPT-5 fills a fixed policy template
- no web research is used unless you pass `--research true`
- if Shopify is connected, sample product structure and metafields can be used as store context

### `catalog ingest`

Normalizes JSON or CSV input into records for downstream modules.

Example:

```bash
node .\dist\cli.js ingest --input .\path\to\source.json
```

### `catalog match`

Determines whether an incoming item is:

- `NEW_PRODUCT`
- `NEW_VARIANT`
- `DUPLICATE`
- `NEEDS_REVIEW`

Examples:

```bash
npm run catalog -- match --input ./examples/product.json --catalog ./examples/catalog.json
```

or, if Shopify is configured:

```bash
npm run catalog -- match --input ./examples/product.json --first 50
```

Notes:

- if `--catalog` is provided, the local file is used
- if `--catalog` is omitted, the CLI tries the configured Shopify provider
- the local catalog index is refreshed during the match flow

### `catalog enrich`

Runs policy-guided product enrichment.

Behavior:

- tries the configured LLM provider first
- falls back to the configured fallback provider if present
- falls back again to deterministic local logic if no provider is ready

Example:

```bash
node .\dist\cli.js enrich --input .\examples\product.json
```

### `catalog image`

Runs image optimization logic.

Behavior:

- uses Serper for image search when no image exists and search is configured
- uses OpenAI Vision or Gemini vision-style review for image quality analysis when configured
- otherwise creates a review task packet with guidance

Example:

```bash
node .\dist\cli.js image --input .\examples\product.json
```

### `catalog qa`

Scores the listing against the policy checklist and QA criteria.

Example:

```bash
node .\dist\cli.js qa --input .\examples\product.json
```

Behavior:

- always performs deterministic QA checks first
- if OpenAI is configured for `catalogue-qa`, it also scores the product against the policy success criteria
- combines hard missing-field checks with policy-based quality assessment

### `catalog sync`

Builds a Shopify-ready payload and creates a review packet for sync.

Example:

```bash
node .\dist\cli.js sync --input .\examples\product.json
```

Important:

- `sync` itself does not write immediately
- it prepares the payload for review and later apply

### `catalog review`

Shows or records a review decision for a run.

Examples:

```bash
node .\dist\cli.js review <job-id>
node .\dist\cli.js review <job-id> --action approve
node .\dist\cli.js review <job-id> --action approve_with_edits --edits .\edits.json
node .\dist\cli.js review <job-id> --action reject
node .\dist\cli.js review <job-id> --action defer
```

### `catalog apply`

Applies an approved run.

Examples:

```bash
node .\dist\cli.js apply <job-id>
node .\dist\cli.js apply <job-id> --live
```

Behavior:

- without `--live`, apply is local-only and writes `apply.json`
- with `--live`, apply is only supported for approved `shopify-sync` runs
- live apply requires a ready Shopify provider

### `catalog learn`

Adds distilled lessons to `catalog-learning.md`.

Examples:

```bash
node .\dist\cli.js learn --lesson "Use weight before flavor in grocery titles."
node .\dist\cli.js learn --run <job-id> --lesson "Do not treat Regular as a valid differentiating variant."
```

### `catalog batch`

Processes local product files product-by-product.

Supported operations:

- `enrich`
- `qa`
- `match`
- `image`
- `sync`

Examples:

```bash
node .\dist\cli.js batch enrich --input .\products.json
node .\dist\cli.js batch qa --input .\products.csv
node .\dist\cli.js batch match --input .\products.json --catalog .\catalog.json
node .\dist\cli.js batch sync --input .\products.json
```

Behavior:

- reads a local JSON or CSV file
- normalizes it into individual product records
- processes products one by one
- creates one run per product
- prints a batch summary with the generated job IDs

Use `--limit <n>` if you want to test only the first few records.

### `catalog workflow run`

Runs the end-to-end local workflow on each product record:

- optional `match`
- `enrich`
- `image`
- `qa`
- `sync`

Examples:

```bash
node .\dist\cli.js workflow run --input .\products.json --catalog .\catalog.json
node .\dist\cli.js workflow run --input .\products.csv --limit 5
```

Behavior:

- reads JSON or CSV products from disk
- processes products one by one
- prints live per-product and per-step progress in interactive terminal mode
- creates standard run artifacts for every module step
- saves the durable product JSON under `.catalog/generated/products`
- saves image metadata and downloads under `.catalog/generated/images`
- prints a review queue summary at the end of the run

Typical follow-up commands:

```bash
node .\dist\cli.js review queue
node .\dist\cli.js review bulk --action approve
```

This is the closest thing to the “full system” command today.

## Typical Workflow

### Local-first product flow

```bash
node .\dist\cli.js init --no-wizard
node .\dist\cli.js expert generate --industry grocery --business-name "Demo Store" --business-description "A grocery store focused on dairy and pantry staples." --operating-mode both
node .\dist\cli.js enrich --input .\examples\product.json
node .\dist\cli.js review <job-id> --action approve
node .\dist\cli.js apply <job-id>
```

### Full local workflow from product files

```bash
node .\dist\cli.js init
node .\dist\cli.js workflow run --input .\products.json --catalog .\catalog.json
```

What you get:

- one run folder per module step under `.catalog/runs`
- a generated product JSON file per product under `.catalog/generated/products`
- an image folder per product under `.catalog/generated/images`
- a workflow summary showing which module runs need review
- a Shopify-compatible import CSV under `.catalog/generated/shopify-import.csv`

## Full Example

This is a realistic first run for a new user with local product files.

### Step 1: install and build

```bash
npm install
npm run typecheck
npm run build
```

### Step 2: initialize and configure

```bash
node .\dist\cli.js init
node .\dist\cli.js doctor
```

### Step 3: generate the policy

```bash
node .\dist\cli.js expert generate --industry grocery --business-name "Demo Store" --business-description "An online grocery store focused on dairy and pantry staples." --operating-mode both
```

### Step 4: run the full workflow on your products file

```bash
node .\dist\cli.js workflow run --input .\products.json --catalog .\catalog.json
```

### Step 5: inspect outputs

Look in:

- `.catalog/runs/`
- `.catalog/generated/products/`
- `.catalog/generated/images/`
- `.catalog/generated/review-queue.csv`
- `.catalog/generated/catalog-review.xlsx`

### Step 6: review and approve

For any run that needs review:

```bash
node .\dist\cli.js review <job-id>
node .\dist\cli.js review <job-id> --action approve
node .\dist\cli.js apply <job-id>
```

If the run is a `shopify-sync` run and you are using a safe test store:

```bash
node .\dist\cli.js apply <job-id> --live
```

### Shopify-backed matching flow

```bash
node .\dist\cli.js config set providers.shopify_default.store your-store.myshopify.com
node .\dist\cli.js auth set --provider shopify --value shpat_example
node .\dist\cli.js match --input .\examples\product.json --first 50
```

### Live Shopify sync flow

```bash
node .\dist\cli.js sync --input .\examples\product.json
node .\dist\cli.js review <job-id> --action approve
node .\dist\cli.js apply <job-id> --live
```

## Agent Playbooks

Portable playbooks live in [agents](C:\Users\Abood\Cataluge Manager\shopify-catalog-toolkit\agents).

These are intended for Codex, Claude Code, or any similar agent workflow.

Available playbooks:

- [agents/catalogue-expert.md](C:\Users\Abood\Cataluge Manager\shopify-catalog-toolkit\agents\catalogue-expert.md)
- [agents/catalogue-match.md](C:\Users\Abood\Cataluge Manager\shopify-catalog-toolkit\agents\catalogue-match.md)
- [agents/product-enricher.md](C:\Users\Abood\Cataluge Manager\shopify-catalog-toolkit\agents\product-enricher.md)
- [agents/image-optimizer.md](C:\Users\Abood\Cataluge Manager\shopify-catalog-toolkit\agents\image-optimizer.md)
- [agents/catalogue-qa.md](C:\Users\Abood\Cataluge Manager\shopify-catalog-toolkit\agents\catalogue-qa.md)
- [agents/review-and-apply.md](C:\Users\Abood\Cataluge Manager\shopify-catalog-toolkit\agents\review-and-apply.md)
- [agents/feedback-learn.md](C:\Users\Abood\Cataluge Manager\shopify-catalog-toolkit\agents\feedback-learn.md)

## Safety Notes

- The toolkit is review-first by default.
- Live Shopify writes are explicitly gated behind `--live`.
- Live apply currently supports products with zero or one variant only.
- Multi-variant live writes are intentionally blocked for manual review.
- If providers are not configured, the toolkit degrades gracefully where possible and surfaces review tasks instead of silently guessing.
- `catalogue-expert` uses GPT-5 plus optional research when available, but always falls back safely to a starter policy if providers are missing.

## Common Mistakes

### npm flag forwarding on Windows

If you use `npm run catalog -- ...` with many flags, npm on Windows can parse flags awkwardly.

The most reliable form is:

```bash
node .\dist\cli.js <command> ...
```

Example:

```bash
node .\dist\cli.js expert generate --industry grocery --business-name "Demo Store"
```

### `doctor` says everything is missing

That usually means one of these:

- you have not stored credentials yet
- you have not loaded your `.env`
- you have not set the Shopify store domain in runtime config

Use:

```bash
node .\dist\cli.js auth list
node .\dist\cli.js auth test --provider openai
node .\dist\cli.js auth test --provider shopify
```

### Policy generation falls back to template

That is expected when OpenAI is not configured or the GPT request fails.

The command still works. It just means the policy came from the local starter template instead of GPT-5-generated content.

### Live Shopify apply is blocked

That can happen because:

- the run was not approved first
- Shopify provider is not configured
- the payload is not supported safely for live apply
- the product has multiple variants, which are still intentionally blocked for manual review

### You want machine-readable output

Add:

```bash
--json
```

to almost any command.

### Terminal spinner does not show

The progress indicator only shows in interactive text mode.

It will not show when:

- you use `--json`
- output is redirected
- the terminal is not interactive

### Excel workbook

The toolkit now writes a real Excel workbook:

- `.catalog/generated/catalog-review.xlsx`

You can open this file directly in Excel. It contains separate sheets for:

- `Runs`
- `Generated Products`
- `Shopify Import`

This gives the user one workbook to review operational status, generated product outputs, and Shopify-ready import rows without opening many JSON files manually.

## Verification

Use these commands to verify the project locally:

```bash
npm run typecheck
npm run build
npm test
node .\bin\catalog.js help
```
