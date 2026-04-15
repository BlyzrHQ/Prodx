#!/usr/bin/env node
import * as p from "@clack/prompts";
import pc from "picocolors";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import type { ProjectConfig, ApiKeys, MetafieldDefinition, EmbeddingConfig, StoreContext } from "./types.js";
import { INDUSTRY_OPTIONS, LLM_PROVIDERS, LLM_MODELS, LLM_DEFAULT_MODELS, EMBEDDING_MODELS } from "./types.js";
import { scaffoldProject } from "./generators/project.js";
import { generateConvexFiles } from "./generators/convex.js";
import { generateAgentFiles } from "./generators/agents.js";
import { generateRuntimeFiles } from "./generators/runtime.js";
import { generateTriggerFiles } from "./generators/trigger.js";
import { generateCpoSkill } from "./generators/cpo-skill.js";
import { buildGuidePrompt, guideToMarkdown } from "./generators/guide-template.js";
import type { GuideContext } from "./generators/guide-template.js";

async function main() {
  p.intro(pc.bgCyan(pc.black(" prodx — Shopify Catalog Management ")));

  const projectDir = process.cwd();

  // ─── BUSINESS INFO ─────────────────────────────────────────

  const businessName = await p.text({
    message: "What is your business name?",
    placeholder: "Demo Store",
    defaultValue: "Demo Store",
  });
  if (p.isCancel(businessName)) return cancel();

  const businessDescription = await p.text({
    message: "Describe your business in a sentence",
    placeholder: "A Shopify business selling curated products",
    defaultValue: "A Shopify business selling curated products",
  });
  if (p.isCancel(businessDescription)) return cancel();

  const industry = await p.select({
    message: "What industry are you in?",
    options: INDUSTRY_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
  });
  if (p.isCancel(industry)) return cancel();

  let industryValue = industry as string;
  if (industryValue === "other") {
    const custom = await p.text({
      message: "Enter your industry",
      placeholder: "generic",
      defaultValue: "generic",
    });
    if (p.isCancel(custom)) return cancel();
    industryValue = custom;
  }

  // ─── LLM PROVIDER ─────────────────────────────────────────

  const primaryLlm = await p.select({
    message: "Primary LLM provider",
    options: LLM_PROVIDERS.map((o) => ({ value: o.value, label: o.label })),
  });
  if (p.isCancel(primaryLlm)) return cancel();

  const primaryModel = await p.select({
    message: `Model for ${primaryLlm}`,
    options: (LLM_MODELS[primaryLlm as string] ?? []).map((m) => ({ value: m, label: m })),
    initialValue: LLM_DEFAULT_MODELS[primaryLlm as string],
  });
  if (p.isCancel(primaryModel)) return cancel();

  // Auth for primary LLM
  const apiKey = await collectLlmAuth(primaryLlm as string);
  if (apiKey === null) return cancel();

  // Fallback LLM
  const fallbackOptions = LLM_PROVIDERS.filter((o) => o.value !== primaryLlm);
  const fallbackLlm = await p.select({
    message: "Fallback LLM provider (optional)",
    options: [
      { value: "none", label: "None" },
      ...fallbackOptions.map((o) => ({ value: o.value, label: o.label })),
    ],
  });
  if (p.isCancel(fallbackLlm)) return cancel();

  let fallbackModel = "";
  let fallbackApiKey = "";
  if (fallbackLlm !== "none") {
    const fm = await p.select({
      message: `Model for ${fallbackLlm}`,
      options: (LLM_MODELS[fallbackLlm as string] ?? []).map((m) => ({ value: m, label: m })),
      initialValue: LLM_DEFAULT_MODELS[fallbackLlm as string],
    });
    if (p.isCancel(fm)) return cancel();
    fallbackModel = fm as string;

    const fk = await collectLlmAuth(fallbackLlm as string);
    if (fk === null) return cancel();
    fallbackApiKey = fk;
  }

  // ─── EMBEDDING MODEL ──────────────────────────────────────

  const embeddingChoice = await p.select({
    message: "Embedding model (for duplicate detection)",
    options: EMBEDDING_MODELS.map((m) => ({ value: m.value, label: m.label })),
  });
  if (p.isCancel(embeddingChoice)) return cancel();
  const embeddingDef = EMBEDDING_MODELS.find((m) => m.value === embeddingChoice)!;
  const embedding: EmbeddingConfig = {
    model: embeddingDef.value,
    provider: embeddingDef.provider,
    dimensions: embeddingDef.dimensions,
  };

  // ─── SERPER ────────────────────────────────────────────────

  p.log.info(
    `${pc.bold("Serper API key")} — required for product image search\n` +
    `  1. Go to ${pc.cyan("https://serper.dev")}\n` +
    `  2. Sign up (free tier: 2,500 searches)\n` +
    `  3. Copy your API key from the dashboard`
  );

  const serperKey = await p.text({
    message: "Serper API key",
    placeholder: "Enter your key...",
    validate: (v: string) => { if (!v.trim()) return "Serper API key is required for product image search"; },
  });
  if (p.isCancel(serperKey)) return cancel();

  // ─── SHOPIFY ───────────────────────────────────────────────

  p.log.info(
    `${pc.bold("Shopify connection")} — connecting your store allows Prodx to:\n` +
    `  ${pc.cyan("-")} Sync your existing catalog for AI-powered improvements\n` +
    `  ${pc.cyan("-")} Discover your metafields, product types, and tags\n` +
    `  ${pc.cyan("-")} Discover product-referenced metaobjects and their entries\n` +
    `  ${pc.cyan("-")} Generate a catalog guide tailored to your actual products\n` +
    `  ${pc.cyan("-")} Create new metaobject entries when enrichment needs a new valid value\n` +
    `  ${pc.cyan("-")} Publish enriched products back to your store\n\n` +
    `  ${pc.dim("Required Shopify API scopes:")}\n` +
    `  ${pc.dim("read_products, write_products, read_product_listings,")}\n` +
    `  ${pc.dim("read_inventory, read_publications, write_publications,")}\n` +
    `  ${pc.dim("read_metaobject_definitions, read_metaobjects, write_metaobjects")}\n\n` +
    `  ${pc.dim("You can skip this now and connect Shopify later via /prodx-cpo")}`
  );

  const hasShopify = await p.confirm({
    message: "Connect your Shopify store? (recommended)",
    initialValue: true,
  });
  if (p.isCancel(hasShopify)) return cancel();

  let shopifyStore = "";
  let shopifyToken = "";
  if (hasShopify) {
    const shopifyAuth = await collectShopifyAuth();
    if (shopifyAuth === null) return cancel();
    shopifyStore = shopifyAuth.store;
    shopifyToken = shopifyAuth.token;
  }

  // Convex and Trigger.dev are always enabled — they're core to the pipeline
  const enableConvex = true;
  const enableTrigger = true;

  let syncShopify = false;
  if (hasShopify) {
    const sync = await p.confirm({
      message: "Sync your Shopify catalog to Convex after setup?",
      initialValue: true,
    });
    if (p.isCancel(sync)) return cancel();
    syncShopify = sync;
  }

  // ─── BUILD KEYS ────────────────────────────────────────────

  const keys: ApiKeys = {
    openaiApiKey: "",
    geminiApiKey: "",
    anthropicApiKey: "",
    serperApiKey: serperKey ?? "",
    shopifyStore,
    shopifyAccessToken: shopifyToken,
  };
  if (primaryLlm === "openai") keys.openaiApiKey = apiKey;
  else if (primaryLlm === "gemini") keys.geminiApiKey = apiKey;
  else if (primaryLlm === "anthropic") keys.anthropicApiKey = apiKey;
  if (fallbackLlm === "openai") keys.openaiApiKey = keys.openaiApiKey || fallbackApiKey;
  else if (fallbackLlm === "gemini") keys.geminiApiKey = keys.geminiApiKey || fallbackApiKey;
  else if (fallbackLlm === "anthropic") keys.anthropicApiKey = keys.anthropicApiKey || fallbackApiKey;

  // Ensure embedding provider has a key
  if (embedding.provider === "openai" && !keys.openaiApiKey) {
    const ek = await p.text({
      message: "OpenAI API key (needed for embeddings)",
      placeholder: "sk-...",
      validate: (v: string) => { if (!v.trim()) return "Required for embeddings"; },
    });
    if (p.isCancel(ek)) return cancel();
    keys.openaiApiKey = ek;
  } else if (embedding.provider === "gemini" && !keys.geminiApiKey) {
    const ek = await p.text({
      message: "Gemini API key (needed for embeddings)",
      validate: (v: string) => { if (!v.trim()) return "Required for embeddings"; },
    });
    if (p.isCancel(ek)) return cancel();
    keys.geminiApiKey = ek;
  }

  const resolvedDir = path.resolve(projectDir);

  // ═══════════════════════════════════════════════════════════
  // PHASE 1: FETCH SHOPIFY METAFIELD DEFINITIONS
  // ═══════════════════════════════════════════════════════════

  let shopifyMetafields: MetafieldDefinition[] = [];
  let storeContext: StoreContext | null = null;

  if (hasShopify && shopifyStore && shopifyToken) {
    const metaSpinner = p.spinner();
    metaSpinner.start("Fetching Shopify store context (metafields, types, tags, metaobject options)...");
    try {
      const [mfDefs, ctx] = await Promise.all([
        fetchShopifyMetafieldDefinitions(shopifyStore, shopifyToken),
        fetchShopifyStoreContext(shopifyStore, shopifyToken),
      ]);
      shopifyMetafields = mfDefs;
      storeContext = ctx;
      metaSpinner.stop(
        `Found ${mfDefs.length} metafield${mfDefs.length === 1 ? "" : "s"}, ${ctx.productTypes.length} product types, ${ctx.tags.length} tags, ${ctx.metaobjectOptions.length} metaobject option groups`
      );
    } catch {
      metaSpinner.stop("Could not fetch store context — continuing without it");
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 2: GENERATE CATALOG GUIDE
  // ═══════════════════════════════════════════════════════════

  let guide: Record<string, unknown> | null = null;
  const guideSpinner = p.spinner();
  guideSpinner.start("Generating catalog guide via LLM...");
  try {
    guide = await generateGuide({
      businessName: businessName as string,
      businessDescription: businessDescription as string,
      industry: industryValue,
      shopifyMetafields,
      storeContext,
      llmProvider: primaryLlm as string,
      llmModel: primaryModel as string,
      apiKey,
    });
    const guideDir = path.join(resolvedDir, ".catalog", "guide");
    fs.mkdirSync(guideDir, { recursive: true });
    // Save JSON (for agents)
    fs.writeFileSync(path.join(guideDir, "catalog-guide.json"), JSON.stringify(guide, null, 2));
    // Save markdown (for humans and CPO skill)
    const guideCtx: GuideContext = {
      businessName: businessName as string,
      businessDescription: businessDescription as string,
      industry: industryValue,
      storeUrl: shopifyStore || undefined,
      shopifyMetafields,
      shopifyProductTypes: storeContext?.productTypes ?? [],
      shopifyTags: storeContext?.tags ?? [],
      shopifyVendors: storeContext?.vendors ?? [],
      metaobjectTypes: (storeContext?.metaobjectOptions ?? []).map((m) => m.name),
    };
    fs.writeFileSync(path.join(guideDir, "catalog-guide.md"), guideToMarkdown(guide, guideCtx));
    guideSpinner.stop("Catalog guide generated — JSON + Markdown saved");
  } catch (err) {
    guideSpinner.stop(
      `Guide generation failed: ${err instanceof Error ? err.message : "unknown error"} — you can regenerate later`
    );
  }

  // Merge guide metafields with Shopify metafields
  if (guide) {
    for (const gm of extractGuideMetafields(guide)) {
      if (!shopifyMetafields.some((sm) => sm.namespace === gm.namespace && sm.key === gm.key)) {
        shopifyMetafields.push(gm);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 3: BUILD CONFIG + GENERATE ALL FILES
  // ═══════════════════════════════════════════════════════════

  const config: ProjectConfig = {
    brand: { projectDir: resolvedDir, name: businessName as string, description: businessDescription as string, industry: industryValue },
    keys,
    llm: { primary: primaryLlm as string, primaryModel: primaryModel as string, fallback: fallbackLlm === "none" ? "" : (fallbackLlm as string), fallbackModel },
    embedding,
    hasShopify,
    services: { convex: enableConvex, trigger: enableTrigger, paperclip: false, syncShopify },
    shopifyMetafields,
    storeContext,
    guide,
  };

  // ═══════════════════════════════════════════════════════════
  // STEP 1: Scaffold project structure + .env
  // ═══════════════════════════════════════════════════════════

  const genSpinner = p.spinner();
  genSpinner.start("Scaffolding project...");
  scaffoldProject(config);
  genSpinner.stop("Project structure created");

  // ═══════════════════════════════════════════════════════════
  // STEP 2: Generate ALL code files
  // ═══════════════════════════════════════════════════════════

  genSpinner.start("Generating Convex schema and functions...");
  generateConvexFiles(config);
  genSpinner.stop(`Convex files generated`);

  genSpinner.start("Generating agent code...");
  generateAgentFiles(config);
  genSpinner.stop("Agent code generated");

  genSpinner.start("Generating runtime (config, services, CLI)...");
  generateRuntimeFiles(config);
  genSpinner.stop("Runtime files generated");

  genSpinner.start("Generating CPO skill package...");
  generateCpoSkill(config);
  genSpinner.stop("CPO skill installed for Claude Code + Codex");

  // Verify generated files exist
  const agentsExist = fs.existsSync(path.join(resolvedDir, "src", "agents", "enrich.ts"));
  const servicesExist = fs.existsSync(path.join(resolvedDir, "src", "services", "llm.ts"));
  if (!agentsExist || !servicesExist) {
    p.log.error("File generation failed — agents or services missing");
    process.exit(1);
  }

  const validationSpinner = p.spinner();
  validationSpinner.start("Validating generated runtime with TypeScript...");
  try {
    execSync("npm run typecheck", { cwd: resolvedDir, stdio: "inherit", timeout: 120_000 });
    validationSpinner.stop("Generated runtime passed local TypeScript validation");
  } catch {
    validationSpinner.stop("Generated runtime failed local TypeScript validation");
    p.log.error("Setup stopped before Convex/Trigger configuration because the generated runtime did not pass local typecheck");
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 3: Deploy Convex (interactive — may need first-time login)
  // ═══════════════════════════════════════════════════════════

  let convexReady = false;
  p.log.info("Deploying Convex schema — follow prompts if this is your first time");
  try {
    execSync("npx convex dev --once", { cwd: resolvedDir, stdio: "inherit", timeout: 120_000 });
    convexReady = true;
    p.log.success("Convex deployed — tables and indexes ready");

    // Sync Convex-generated env vars from .env.local into .env so the scaffold can run immediately
    const envLocalPath = path.join(resolvedDir, ".env.local");
    if (fs.existsSync(envLocalPath)) {
      const envPath = path.join(resolvedDir, ".env");
      const syncedKeys = syncEnvFileVars(envLocalPath, envPath);
      const convexUrl = readEnvVar(envPath, "CONVEX_URL");

      if (syncedKeys.length > 0) {
        p.log.success(`Convex env vars saved to .env: ${syncedKeys.join(", ")}`);
      }

      // Save guide + store context to Convex so Trigger tasks can access them
      if (convexUrl) {
        try {
          if (guide || storeContext) {
            const setupStoreContext = buildSetupStoreContext(storeContext, shopifyMetafields);
            await saveSetupContextToConvex(convexUrl, setupStoreContext, guide);
            await verifySetupContextInConvex(convexUrl, setupStoreContext, Boolean(guide));
            p.log.success("Store context and guide saved to Convex");
          }
        } catch (error) {
          p.log.warning(
            "Could not save guide/context to Convex — " +
              (error instanceof Error ? error.message : "unknown error")
          );
        }
      }
    }
  } catch {
    p.log.warning("Convex deploy skipped — run 'npx convex dev --once' manually");
  }

  if (!(await confirmContinue("Continue to Trigger.dev setup?"))) return cancel();

  // ═══════════════════════════════════════════════════════════
  // STEP 4: Generate Trigger task files + link Trigger.dev
  // ═══════════════════════════════════════════════════════════

  genSpinner.start("Generating Trigger.dev tasks...");
  generateTriggerFiles(config);
  genSpinner.stop("Trigger.dev tasks generated");

  let triggerReady = false;
  const triggerConfigPath = path.join(resolvedDir, "trigger.config.ts");
  const envPath = path.join(resolvedDir, ".env");
  const existingTriggerProjectId = readEnvVar(envPath, "TRIGGER_PROJECT_ID");
  const existingTriggerSecret = readEnvVar(envPath, "TRIGGER_SECRET_KEY");

  p.log.info(
    `${pc.bold("Trigger.dev linking")} — this scaffold already generated ${pc.cyan("trigger.config.ts")} and ${pc.cyan("src/trigger")}\n` +
    `  ${pc.cyan("1.")} Run ${pc.bold("npx trigger.dev@latest login")} if you are not already logged in\n` +
    `  ${pc.cyan("2.")} Copy your project ref from the Trigger.dev dashboard\n` +
    `  ${pc.cyan("3.")} Add the project ref + dev secret key to ${pc.bold(".env")}\n` +
    `  ${pc.dim("No 'trigger init' is needed for this scaffold.")}`
  );

  const linkTrigger = await p.confirm({
    message: "Link your Trigger.dev project now?",
    initialValue: true,
  });
  if (p.isCancel(linkTrigger)) return cancel();

  if (linkTrigger) {
    const triggerProjectId = await p.text({
      message: "Trigger.dev project ref",
      placeholder: "proj_...",
      defaultValue: existingTriggerProjectId || "",
      validate: (v: string) => {
        const value = v.trim();
        if (!value) return "Project ref is required to link Trigger.dev";
        if (value === "YOUR_PROJECT_ID") return "Enter your real Trigger.dev project ref";
      },
    });
    if (p.isCancel(triggerProjectId)) return cancel();

    if (triggerProjectId) {
      writeEnvVar(envPath, "TRIGGER_PROJECT_ID", triggerProjectId.trim());
      p.log.success(`Trigger project ID saved to .env: ${triggerProjectId.trim()}`);
    }

    if (!(await confirmContinue("Continue to Trigger.dev secret key?"))) return cancel();

    p.log.info(
      `${pc.bold("Trigger.dev secret key")} — needed to dispatch tasks\n` +
      `  1. Go to ${pc.cyan("https://cloud.trigger.dev")}\n` +
      `  2. Select your project → API Keys\n` +
      `  3. Copy the Development secret key (starts with tr_dev_...)`
    );

    const triggerSecret = await p.text({
      message: "Trigger.dev secret key",
      placeholder: "tr_dev_...",
      defaultValue: existingTriggerSecret || "",
      validate: (v: string) => { if (!v.trim()) return "Secret key is needed to run tasks via Trigger.dev"; },
    });
    if (p.isCancel(triggerSecret)) return cancel();

    if (triggerSecret) {
      writeEnvVar(envPath, "TRIGGER_SECRET_KEY", triggerSecret.trim());
      p.log.success("Trigger.dev secret key saved to .env");
      triggerReady = true;

      // Push env vars to Trigger.dev so cloud tasks have access
      const envSpinner = p.spinner();
      envSpinner.start("Pushing environment variables to Trigger.dev...");
      try {
        const envVarsToSync: Record<string, string> = {};
        if (keys.openaiApiKey) envVarsToSync["OPENAI_API_KEY"] = keys.openaiApiKey;
        if (keys.geminiApiKey) envVarsToSync["GEMINI_API_KEY"] = keys.geminiApiKey;
        if (keys.anthropicApiKey) envVarsToSync["ANTHROPIC_API_KEY"] = keys.anthropicApiKey;
        if (keys.serperApiKey) envVarsToSync["SERPER_API_KEY"] = keys.serperApiKey;
        if (keys.shopifyStore) envVarsToSync["SHOPIFY_STORE"] = keys.shopifyStore;
        if (keys.shopifyAccessToken) envVarsToSync["SHOPIFY_ACCESS_TOKEN"] = keys.shopifyAccessToken;

        const currentEnv = fs.readFileSync(envPath, "utf-8");
        const convexUrlMatch = currentEnv.match(/CONVEX_URL=(.+)/);
        if (convexUrlMatch?.[1]) envVarsToSync["CONVEX_URL"] = convexUrlMatch[1].trim();

        envVarsToSync["PRIMARY_LLM_PROVIDER"] = config.llm.primary;
        envVarsToSync["PRIMARY_LLM_MODEL"] = config.llm.primaryModel;
        if (config.llm.fallback) envVarsToSync["FALLBACK_LLM_PROVIDER"] = config.llm.fallback;
        if (config.llm.fallbackModel) envVarsToSync["FALLBACK_LLM_MODEL"] = config.llm.fallbackModel;
        envVarsToSync["EMBEDDING_MODEL"] = config.embedding.model;
        envVarsToSync["EMBEDDING_PROVIDER"] = config.embedding.provider;

        let pushed = 0;
        for (const [key, value] of Object.entries(envVarsToSync)) {
          if (!value) continue;
          try {
            execSync(`npx trigger.dev@latest env set ${key} ${value}`, {
              cwd: resolvedDir,
              stdio: "pipe",
              timeout: 15_000,
            });
            pushed++;
          } catch {
            // Some vars may fail — non-critical
          }
        }
        envSpinner.stop(`Pushed ${pushed} environment variables to Trigger.dev`);
      } catch {
        envSpinner.stop("Could not push env vars to Trigger.dev — add them manually in the dashboard after login");
      }
    }
  } else {
    p.log.warning("Trigger.dev not linked yet — tasks were generated, but cloud dispatch will stay disabled until you add TRIGGER_PROJECT_ID and TRIGGER_SECRET_KEY");
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 5: NEXT STEPS
  // ═══════════════════════════════════════════════════════════

  // ─── PROJECT SUMMARY ──────────────────────────────────────

  const summaryLines = [
    `${pc.bold("Business:")}        ${businessName}`,
    `${pc.bold("Industry:")}        ${industryValue}`,
    `${pc.bold("Primary LLM:")}     ${primaryLlm} (${primaryModel})`,
  ];
  if (fallbackLlm !== "none") {
    summaryLines.push(`${pc.bold("Fallback LLM:")}    ${fallbackLlm} (${fallbackModel})`);
  }
  summaryLines.push(`${pc.bold("Embeddings:")}      ${config.embedding.model} (${config.embedding.dimensions} dims)`);
  if (hasShopify) {
    summaryLines.push(`${pc.bold("Shopify:")}         ${shopifyStore}`);
  }
  summaryLines.push(
    `${pc.bold("Convex:")}          ${convexReady ? pc.green("deployed") : enableConvex ? pc.yellow("pending setup") : pc.dim("disabled")}`,
    `${pc.bold("Trigger.dev:")}     ${triggerReady ? pc.green("linked") : enableTrigger ? pc.yellow("pending link") : pc.dim("disabled")}`,
  );

  p.note(summaryLines.join("\n"), "Project Summary");

  // ─── GENERATED FILES ─────────────────────────────────────

  const fileLines = [];
  if (enableConvex) {
    fileLines.push(
      `${pc.cyan("convex/")}`,
      `  schema.ts              ${pc.dim("— 5 canonical tables")}`,
      `  products.ts            ${pc.dim("— sync + review + publish lifecycle")}`,
      `  variants.ts            ${pc.dim("— synced and generated variants")}`,
      `  productEmbeddings.ts   ${pc.dim("— vector search for product matching")}`,
      `  collections.ts         ${pc.dim("— synced and generated collections")}`,
      `  storeContext.ts        ${pc.dim("— guide + store options + sync metadata")}`,
      `  catalogueSummary.ts    ${pc.dim("— collection candidate queries")}`,
    );
  }
  if (enableTrigger) {
    fileLines.push(
      `${pc.cyan("trigger.config.ts")} ${pc.dim("— Trigger.dev project config")}`,
      `${pc.cyan("src/trigger/")}`,
      `  shopify-sync.ts        ${pc.dim("— Shopify catalog sync task")}`,
      `  product-pipeline.ts    ${pc.dim("— durable unified product pipeline")}`,
      `  product-publisher.ts   ${pc.dim("— Shopify publish task for approved products")}`,
      `  collection-builder.ts  ${pc.dim("— collection proposals + nightly schedule")}`,
      `  guide-regenerator.ts   ${pc.dim("— guide refresh tasks")}`,
    );
  }
  fileLines.push(
    `${pc.cyan("src/agents/")}`,
    `  enrich.ts, image.ts, qa.ts, guide.ts`,
    `  collection-builder.ts, collection-evaluator.ts`,
    `${pc.cyan("src/services/")}`,
    `  llm.ts, convex.ts, shopify.ts, embeddings.ts, image-upload.ts, pipeline.ts`,
    `${pc.cyan("src/")}`,
    `  cli.ts                 ${pc.dim("— project CLI (sync, review, run pipeline, collections, publish, status)")}`,
    `  config.ts              ${pc.dim("— env config loader")}`,
    `${pc.cyan(".claude/skills/prodx-cpo/")}`,
    `  SKILL.md               ${pc.dim("— CPO skill for Claude Code")}`,
    `${pc.cyan(".agents/skills/prodx-cpo/")}`,
    `  SKILL.md               ${pc.dim("— CPO skill for Codex")}`,
    `${pc.cyan(".catalog/guide/")}`,
    `  catalog-guide.json     ${pc.dim("— your catalog rules (drives all agents)")}`,
    `${pc.cyan(".env")}                    ${pc.dim("— API keys and config")}`,
  );

  p.note(fileLines.join("\n"), "Generated Files");

  // ─── NEXT STEPS ──────────────────────────────────────────

  const steps: string[] = [];
  let stepNum = 1;

  if (!convexReady) {
    steps.push(`${pc.cyan(`${stepNum++}.`)} Set up Convex:\n   npx convex dev --once`);
  }

  if (!triggerReady) {
    steps.push(
      `${pc.cyan(`${stepNum++}.`)} Link Trigger.dev:\n` +
      `   1. npx trigger.dev@latest login\n` +
      `   2. Add TRIGGER_PROJECT_ID + TRIGGER_SECRET_KEY to .env`
    );
  }

  steps.push(`${pc.cyan(`${stepNum++}.`)} Start Trigger.dev dev server:\n   npx trigger.dev@latest dev`);

  if (syncShopify) {
    steps.push(`${pc.cyan(`${stepNum++}.`)} Sync your Shopify catalog:\n   npx tsx src/cli.ts sync`);
    steps.push(`${pc.cyan(`${stepNum++}.`)} Review catalog for improvements:\n   npx tsx src/cli.ts review`);
  }

  steps.push(`${pc.cyan(`${stepNum++}.`)} Run the enrichment pipeline:\n   npx tsx src/cli.ts run pipeline`);
  steps.push(`${pc.cyan(`${stepNum++}.`)} Use the CPO skill in Claude Code or Codex:\n   Type ${pc.bold("/prodx-cpo")} then ask it to manage your catalog`);

  p.note(steps.join("\n\n"), "Next Steps");
  p.outro(`${pc.green("Done!")} Happy catalog management with ${pc.cyan(businessName as string)}`);
}

// ─── AUTH HELPERS ─────────────────────────────────────────────

function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(`${cmd} --version`, { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function readEnvVar(envPath: string, key: string): string {
  if (!fs.existsSync(envPath)) return "";
  const envContent = fs.readFileSync(envPath, "utf-8");
  const match = envContent.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

function writeEnvVar(envPath: string, key: string, value: string): void {
  const nextValue = value.replace(/\r?\n/g, "").trim();
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(current)
    ? current.replace(pattern, `${key}=${nextValue}`)
    : `${current.trimEnd()}\n${key}=${nextValue}\n`;
  fs.writeFileSync(envPath, next);
}

function syncEnvFileVars(sourceEnvPath: string, targetEnvPath: string): string[] {
  if (!fs.existsSync(sourceEnvPath)) return [];

  const sourceContent = fs.readFileSync(sourceEnvPath, "utf-8");
  const syncedKeys: string[] = [];

  for (const line of sourceContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) continue;

    writeEnvVar(targetEnvPath, key, value);
    syncedKeys.push(key);
  }

  return syncedKeys;
}

function cancel(): void {
  p.cancel("Setup cancelled.");
  process.exit(0);
}

async function confirmContinue(message: string): Promise<boolean> {
  const next = await p.confirm({
    message,
    initialValue: true,
  });
  if (p.isCancel(next)) return false;
  return Boolean(next);
}

/** Collect LLM auth — supports API key or Codex auth for OpenAI */
async function collectLlmAuth(provider: string): Promise<string | null> {
  if (provider === "openai") {
    const authMethod = await p.select({
      message: "OpenAI authentication method",
      options: [
        { value: "api", label: "API key (recommended)", hint: "Get from platform.openai.com/api-keys — works with all models" },
        { value: "codex", label: "Codex auth (limited)", hint: "Uses ChatGPT subscription — may not support all API endpoints" },
      ],
    });
    if (p.isCancel(authMethod)) return null;

    if (authMethod === "codex") {
      let codexKey = loadCodexAuth();
      if (codexKey) {
        p.log.success("Loaded OpenAI key from Codex auth");
        return codexKey;
      }

      // Install Codex CLI if not available (silently in background)
      if (!isCommandAvailable("codex")) {
        const installSpinner = p.spinner();
        installSpinner.start("Installing Codex CLI...");
        try {
          execSync("npm install -g @openai/codex", { stdio: "pipe", timeout: 120_000 });
          installSpinner.stop("Codex CLI installed");
        } catch {
          installSpinner.stop("Could not install Codex CLI");
          p.log.info(`You can install manually: ${pc.cyan("npm install -g @openai/codex")}`);
        }
      }

      // Run codex login — opens browser for OAuth
      if (isCommandAvailable("codex")) {
        p.log.info("Opening browser for Codex login — sign in with your ChatGPT account");
        try {
          execSync("codex login", { stdio: "inherit", timeout: 120_000 });
          codexKey = loadCodexAuth();
          if (codexKey) {
            p.log.success("Codex auth saved — loaded OpenAI key");
            return codexKey;
          }
        } catch {
          // Login failed or timed out
        }
      }
      p.log.warning("Codex login did not complete — falling back to API key");
    }

    const key = await p.text({
      message: "OpenAI API key",
      placeholder: "sk-...",
      validate: (v: string) => { if (!v.trim()) return "API key is required"; },
    });
    if (p.isCancel(key)) return null;
    return key;
  }

  if (provider === "anthropic") {
    const authMethod = await p.select({
      message: "Anthropic authentication method",
      options: [
        { value: "api", label: "API key", hint: "Get from console.anthropic.com → API Keys" },
        { value: "claude-code", label: "Claude Code auth", hint: "Use existing Claude Code login session" },
      ],
    });
    if (p.isCancel(authMethod)) return null;

    if (authMethod === "claude-code") {
      // Check if ANTHROPIC_API_KEY is already set (Claude Code sets this)
      const existingKey = process.env.ANTHROPIC_API_KEY;
      if (existingKey) {
        p.log.success("Loaded Anthropic key from environment (ANTHROPIC_API_KEY)");
        return existingKey;
      }

      // Install Claude Code CLI if not available (silently)
      if (!isCommandAvailable("claude")) {
        const installSpinner = p.spinner();
        installSpinner.start("Installing Claude Code CLI...");
        try {
          execSync("npm install -g @anthropic-ai/claude-code", { stdio: "pipe", timeout: 120_000 });
          installSpinner.stop("Claude Code CLI installed");
        } catch {
          installSpinner.stop("Could not install Claude Code CLI");
          p.log.info(`You can install manually: ${pc.cyan("npm install -g @anthropic-ai/claude-code")}`);
        }
      }

      // Run claude auth login — opens browser for OAuth
      if (isCommandAvailable("claude")) {
        p.log.info("Opening browser for Claude Code login — sign in with your Anthropic account");
        try {
          execSync("claude auth login", { stdio: "inherit", timeout: 120_000 });
          // After login, check if key is now available
          const keyAfterLogin = process.env.ANTHROPIC_API_KEY;
          if (keyAfterLogin) {
            p.log.success("Claude Code auth saved — loaded Anthropic key");
            return keyAfterLogin;
          }
        } catch {
          // Login failed or timed out
        }
      }
      p.log.warning("Claude Code login did not complete — falling back to API key");
    }

    p.log.info(`Get your API key from ${pc.cyan("console.anthropic.com")} → API Keys → Create Key`);
    const key = await p.text({
      message: "Anthropic API key",
      placeholder: "sk-ant-...",
      validate: (v: string) => { if (!v.trim()) return "API key is required"; },
    });
    if (p.isCancel(key)) return null;
    return key;
  }

  if (provider === "gemini") {
    p.log.info(`Get your Gemini API key from ${pc.cyan("aistudio.google.com/apikey")}`);
    const key = await p.text({
      message: "Gemini API key",
      placeholder: "AI...",
      validate: (v: string) => { if (!v.trim()) return "API key is required"; },
    });
    if (p.isCancel(key)) return null;
    return key;
  }

  return null;
}

/** Try loading OpenAI key from Codex CLI auth */
function loadCodexAuth(): string | null {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const authPath = path.join(home, ".codex", "auth.json");
    if (!fs.existsSync(authPath)) return null;
    const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    // API key auth: OPENAI_API_KEY is set directly
    if (data.OPENAI_API_KEY) return data.OPENAI_API_KEY;
    // ChatGPT OAuth: access_token is inside tokens object
    if (data.tokens?.access_token) return data.tokens.access_token;
    // Fallback: check root level
    return data.access_token || data.token || null;
  } catch {
    return null;
  }
}

/** Collect Shopify auth — Dev Dashboard app (Client ID + Secret) or direct token */
async function collectShopifyAuth(): Promise<{ store: string; token: string } | null> {
  const store = await p.text({
    message: "Shopify store domain",
    placeholder: "mystore.myshopify.com",
    validate: (v: string) => { if (!v.trim()) return "Store domain is required"; },
  });
  if (p.isCancel(store)) return null;

  const authMethod = await p.select({
    message: "Shopify authentication method",
    options: [
      {
        value: "client_credentials",
        label: "Dev Dashboard app (recommended)",
        hint: "Client ID + Secret from partners.shopify.com → Apps → your app → Settings",
      },
      {
        value: "access_token",
        label: "Direct access token",
        hint: "If you already have an Admin API access token",
      },
    ],
  });
  if (p.isCancel(authMethod)) return null;

  if (authMethod === "access_token") {
    const token = await p.text({
      message: "Shopify Admin API access token",
      placeholder: "shpat_...",
      validate: (v: string) => { if (!v.trim()) return "Access token is required"; },
    });
    if (p.isCancel(token)) return null;
    return { store, token };
  }

  // Client credentials flow
  p.log.info(
    `${pc.dim("Steps to get Client ID + Secret:")}\n` +
    `  1. Go to ${pc.cyan("partners.shopify.com")} → Apps\n` +
    `  2. Create or select your app\n` +
    `  3. Click ${pc.bold("Settings")} → copy Client ID and Client Secret\n` +
    `  4. Ensure the app is installed on your store with required scopes`
  );

  const clientId = await p.text({
    message: "Client ID",
    validate: (v: string) => { if (!v.trim()) return "Client ID is required"; },
  });
  if (p.isCancel(clientId)) return null;

  const clientSecret = await p.text({
    message: "Client Secret",
    validate: (v: string) => { if (!v.trim()) return "Client Secret is required"; },
  });
  if (p.isCancel(clientSecret)) return null;

  // Exchange for access token
  const tokenSpinner = p.spinner();
  tokenSpinner.start("Exchanging credentials for access token...");
  try {
    const res = await fetch(`https://${store}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "read_products,write_products,read_product_listings,read_inventory,read_publications,write_publications,read_metaobject_definitions,read_metaobjects,write_metaobjects",
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      tokenSpinner.stop(`Auth failed (${res.status}): ${errText}`);
      p.log.warning("You may need to install the app on your store first, or check your scopes.");
      // Fall back to manual token
      const manualToken = await p.text({
        message: "Enter access token manually (or Ctrl+C to cancel)",
        placeholder: "shpat_...",
      });
      if (p.isCancel(manualToken)) return null;
      return { store, token: manualToken };
    }

    const data = (await res.json()) as any;
    tokenSpinner.stop("Access token obtained (valid 24h — will auto-refresh)");
    return { store, token: data.access_token };
  } catch (err) {
    tokenSpinner.stop(`Connection failed: ${err instanceof Error ? err.message : "unknown"}`);
    return null;
  }
}

// ─── SHOPIFY METAFIELDS ──────────────────────────────────────

async function fetchShopifyMetafieldDefinitions(
  store: string,
  accessToken: string
): Promise<MetafieldDefinition[]> {
  const query = `{
    metafieldDefinitions(first: 100, ownerType: PRODUCT) {
      edges { node { namespace key type { name } description validations { name value } } }
    }
  }`;

  const res = await fetch(`https://${store}/admin/api/2025-04/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);
  const data = (await res.json()) as any;
  if (data.errors?.length) throw new Error(data.errors[0].message);

  return (data.data?.metafieldDefinitions?.edges ?? []).map((e: any) => ({
    namespace: e.node.namespace,
    key: e.node.key,
    type: e.node.type?.name ?? "single_line_text_field",
    description: e.node.description ?? "",
    validations: (e.node.validations ?? []).map((validation: any) => ({
      name: validation.name,
      value: validation.value,
    })),
  }));
}

/** Fetch store context: product types, tags, vendors, metaobject options */
async function fetchShopifyStoreContext(
  store: string,
  accessToken: string
): Promise<StoreContext> {
  const typesQuery = `{
    products(first: 250) {
      edges { node { productType vendor tags } }
    }
  }`;

  const referencedMetaobjectsQuery = `{
    products(first: 20) {
      edges {
        node {
          metafields(first: 25) {
            edges {
              node {
                type
                reference {
                  ... on Metaobject {
                    id
                    type
                    displayName
                    fields { key value }
                  }
                }
                references(first: 10) {
                  nodes {
                    ... on Metaobject {
                      id
                      type
                      displayName
                      fields { key value }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

  const [catalogData, referencedMetaobjectsData] = await Promise.all([
    shopifyGraphql(store, accessToken, typesQuery),
    runOptionalSetupShopifyGraphql(store, accessToken, referencedMetaobjectsQuery),
  ]);

  const products = catalogData.data?.products?.edges ?? [];
  const productTypes = [...new Set(products.map((e: any) => e.node.productType).filter(Boolean))] as string[];
  const vendors = [...new Set(products.map((e: any) => e.node.vendor).filter(Boolean))] as string[];
  const allTags = products.flatMap((e: any) => e.node.tags ?? []);
  const tags = [...new Set(allTags)] as string[];

  const metaobjectOptions = buildSetupMetaobjectOptionsFromReferences(referencedMetaobjectsData);

  const metafieldOptions: StoreContext["metafieldOptions"] = [];

  return { productTypes, tags, vendors, metaobjectOptions, metafieldOptions };
}

function buildSetupMetaobjectOptionsFromReferences(data: any): StoreContext["metaobjectOptions"] {
  const groups = new Map<string, StoreContext["metaobjectOptions"][number]>();
  const products = data?.data?.products?.edges ?? [];

  for (const productEdge of products) {
    const metafields = productEdge.node?.metafields?.edges ?? [];
    for (const metafieldEdge of metafields) {
      const node = metafieldEdge.node;
      if (!isSetupMetaobjectReferenceType(node?.type)) continue;
      const references = [
        ...(node?.reference ? [node.reference] : []),
        ...((node?.references?.nodes ?? []).filter(Boolean)),
      ];

      for (const reference of references) {
        if (!reference?.id || !reference?.type) continue;
        const group: StoreContext["metaobjectOptions"][number] = groups.get(reference.type) ?? {
          type: reference.type,
          name: reference.type,
          entries: [],
        };

        if (!group.entries.some((entry) => entry.id === reference.id)) {
          const fields = Object.fromEntries(
            (reference.fields ?? [])
              .map((field: any) => [String(field?.key ?? "").trim(), String(field?.value ?? "").trim()] as const)
              .filter((entry: readonly [string, string]) => entry[0] && entry[1])
          );

          group.entries.push({
            id: reference.id,
            displayName: String(reference.displayName ?? "").trim() || String(reference.type ?? "").trim() || reference.id,
            fields,
          });
        }

        groups.set(reference.type, group);
      }
    }
  }

  return [...groups.values()];
}

function isSetupMetaobjectReferenceType(type: unknown): boolean {
  const normalized = String(type ?? "").trim();
  return normalized === "metaobject_reference" || normalized === "list.metaobject_reference";
}

async function shopifyGraphql(
  store: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<any> {
  const res = await fetch(`https://${store}/admin/api/2025-04/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);
  const data = (await res.json()) as any;
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data;
}

async function runOptionalSetupShopifyGraphql(
  store: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<any | null> {
  try {
    return await shopifyGraphql(store, accessToken, query, variables);
  } catch {
    return null;
  }
}

function buildSetupStoreContext(
  storeContext: StoreContext | null,
  shopifyMetafields: MetafieldDefinition[]
): StoreContext {
  return {
    productTypes: storeContext?.productTypes ?? [],
    tags: storeContext?.tags ?? [],
    vendors: storeContext?.vendors ?? [],
    metaobjectOptions: storeContext?.metaobjectOptions ?? [],
    metafieldOptions: shopifyMetafields.map((metafield) => ({
      namespace: metafield.namespace,
      key: metafield.key,
      type: metafield.type,
      validations: metafield.validations ?? [],
    })),
  };
}

async function saveSetupContextToConvex(
  convexUrl: string,
  storeContext: StoreContext,
  guide: Record<string, unknown> | null
): Promise<void> {
  await callConvexMutation(convexUrl, "storeContext:upsert", {
    context: storeContext,
  });

  if (guide) {
    await callConvexMutation(convexUrl, "storeContext:mergeGuide", {
      guide,
    });
  }
}

async function verifySetupContextInConvex(
  convexUrl: string,
  expectedStoreContext: StoreContext,
  expectGuide: boolean
): Promise<void> {
  const stored = await callConvexQuery<Record<string, unknown> | null>(convexUrl, "storeContext:get", {});
  if (!stored) {
    throw new Error("storeContext:get returned no document after setup write");
  }

  const productTypes = Array.isArray(stored.productTypes) ? stored.productTypes.length : 0;
  const tags = Array.isArray(stored.tags) ? stored.tags.length : 0;
  const vendors = Array.isArray(stored.vendors) ? stored.vendors.length : 0;
  const metaobjectOptions = Array.isArray(stored.metaobjectOptions) ? stored.metaobjectOptions.length : 0;
  const metafieldOptions = Array.isArray(stored.metafieldOptions) ? stored.metafieldOptions.length : 0;

  if ((expectedStoreContext.productTypes?.length ?? 0) > 0 && productTypes === 0) {
    throw new Error("productTypes were not persisted to storeContext");
  }
  if ((expectedStoreContext.tags?.length ?? 0) > 0 && tags === 0) {
    throw new Error("tags were not persisted to storeContext");
  }
  if ((expectedStoreContext.vendors?.length ?? 0) > 0 && vendors === 0) {
    throw new Error("vendors were not persisted to storeContext");
  }
  if ((expectedStoreContext.metaobjectOptions?.length ?? 0) > 0 && metaobjectOptions === 0) {
    throw new Error("metaobjectOptions were not persisted to storeContext");
  }
  if ((expectedStoreContext.metafieldOptions?.length ?? 0) > 0 && metafieldOptions === 0) {
    throw new Error("metafieldOptions were not persisted to storeContext");
  }
  if (expectGuide && (!stored.guide || typeof stored.guide !== "object")) {
    throw new Error("guide was not persisted to storeContext");
  }
}

async function callConvexMutation<T = unknown>(
  convexUrl: string,
  path: string,
  args: Record<string, unknown>
): Promise<T> {
  const response = await fetch(convexUrl + "/api/mutation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });

  if (!response.ok) {
    throw new Error(`Convex mutation ${path} failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { value?: T };
  return data.value as T;
}

async function callConvexQuery<T = unknown>(
  convexUrl: string,
  path: string,
  args: Record<string, unknown>
): Promise<T> {
  const response = await fetch(convexUrl + "/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });

  if (!response.ok) {
    throw new Error(`Convex query ${path} failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { value?: T };
  return data.value as T;
}

// ─── GUIDE GENERATION ────────────────────────────────────────

async function generateGuide(input: {
  businessName: string;
  businessDescription: string;
  industry: string;
  shopifyMetafields: MetafieldDefinition[];
  storeContext: StoreContext | null;
  llmProvider: string;
  llmModel: string;
  apiKey: string;
}): Promise<Record<string, unknown>> {
  // Build context for the guide template
  const guideCtx: GuideContext = {
    businessName: input.businessName,
    businessDescription: input.businessDescription,
    industry: input.industry,
    storeUrl: input.storeContext ? undefined : undefined,
    shopifyMetafields: input.shopifyMetafields,
    shopifyProductTypes: input.storeContext?.productTypes ?? [],
    shopifyTags: input.storeContext?.tags ?? [],
    shopifyVendors: input.storeContext?.vendors ?? [],
    metaobjectTypes: (input.storeContext?.metaobjectOptions ?? []).map((m) => m.name),
  };

  const { system, user } = buildGuidePrompt(guideCtx);

  if (input.llmProvider === "openai") return callOpenAIForGuide(input.llmModel, input.apiKey, system, user);
  if (input.llmProvider === "gemini") return callGeminiForGuide(input.llmModel, input.apiKey, system, user);
  if (input.llmProvider === "anthropic") return callAnthropicForGuide(input.llmModel, input.apiKey, system, user);
  throw new Error(`Unknown LLM provider: ${input.llmProvider}`);
}

async function callOpenAIForGuide(model: string, apiKey: string, system: string, user: string): Promise<Record<string, unknown>> {
  // Try Chat Completions first (works with both API keys and Codex OAuth tokens)
  // Fall back to Responses API only if Chat Completions fails with model error
  try {
    return await callOpenAIChatCompletions(model, apiKey, system, user);
  } catch (err) {
    // If Chat Completions fails, try Responses API (for API key users with gpt-5/o3/o4)
    if (/^(gpt-5|o3|o4)/.test(model)) {
      try {
        return await callOpenAIResponses(model, apiKey, system, user);
      } catch {
        // Both failed, throw the original error
      }
    }
    throw err;
  }
}

async function callOpenAIChatCompletions(model: string, apiKey: string, system: string, user: string): Promise<Record<string, unknown>> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("No output from OpenAI");
  return JSON.parse(text);
}

async function callOpenAIResponses(model: string, apiKey: string, system: string, user: string): Promise<Record<string, unknown>> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, instructions: system, input: user, text: { format: { type: "json_object" } } }),
  });
  if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const text = data.output?.find((o: any) => o.type === "message")?.content?.find((c: any) => c.type === "output_text")?.text;
  if (!text) throw new Error("No output from OpenAI");
  return JSON.parse(text);
}

async function callGeminiForGuide(model: string, apiKey: string, system: string, user: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ parts: [{ text: user }] }], generationConfig: { responseMimeType: "application/json" } }),
  });
  if (!res.ok) throw new Error(`Gemini error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No output from Gemini");
  return JSON.parse(text);
}

async function callAnthropicForGuide(model: string, apiKey: string, system: string, user: string): Promise<Record<string, unknown>> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 8192, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Anthropic error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const text = data.content?.find((c: any) => c.type === "text")?.text;
  if (!text) throw new Error("No output from Anthropic");
  // Find the outermost JSON object by matching balanced braces
  const start = text.indexOf("{");
  if (start === -1) throw new Error("No JSON in Anthropic response");
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error("Malformed JSON in Anthropic response");
  return JSON.parse(text.slice(start, end));
}

function extractGuideMetafields(guide: Record<string, unknown>): MetafieldDefinition[] {
  const schema = (guide as any)?.attributes_metafields_schema;
  if (!schema?.metafields || !Array.isArray(schema.metafields)) return [];
  return schema.metafields
    .filter((m: any) => m.namespace && m.key)
    .map((m: any) => ({ namespace: m.namespace, key: m.key, type: m.type ?? "single_line_text_field", description: m.purpose ?? m.description ?? "", required: m.required ?? false }));
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
