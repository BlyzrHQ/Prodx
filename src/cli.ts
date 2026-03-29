#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as rlInput, stdout as rlOutput } from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs, requireFlag } from "./lib/args.js";
import { initWorkspace, loadRuntimeConfig, saveRuntimeConfig, setRuntimeValue, getRuntimeValue } from "./lib/runtime.js";
import { setCredential, listCredentials, testCredential } from "./lib/credentials.js";
import { getWorkspaceRoot, getCatalogPaths } from "./lib/paths.js";
import { readJson, readText, writeJson } from "./lib/fs.js";
import { createRun, loadRun, writeModuleArtifacts, writeDecision, writeApplyResult } from "./lib/artifacts.js";
import { buildGeneratedProduct, getProductKey, persistGeneratedImageArtifacts, persistGeneratedProduct, writeExcelWorkbook, writeReviewQueueCsv, writeShopifyImportCsv } from "./lib/generated.js";
import { resolveProvider } from "./lib/providers.js";
import { testShopifyConnection, fetchShopifyCatalogSnapshot, applyShopifyPayload } from "./connectors/shopify.js";
import { runExpertGenerate } from "./modules/expert.js";
import { loadRecordsFromSource, runIngest } from "./modules/ingest.js";
import { runMatchDecision, buildCatalogIndex } from "./modules/match.js";
import { runEnrich } from "./modules/enrich.js";
import { runImageOptimize } from "./modules/image-optimize.js";
import { runQa } from "./modules/qa.js";
import { runSync } from "./modules/sync.js";
import { runLearn } from "./modules/learn.js";
import type { ApplyResult, CliStreams, LooseRecord, ModuleResult, OutputWriter, PolicyDocument, ProductRecord, ReviewDecision, RunData, RuntimeConfig, WorkflowRunSummary } from "./types.js";

type Flags = Record<string, string | boolean>;
type OutputMode = "json" | "text";
type ModuleRunner = (args: { root: string; jobId: string; input: ProductRecord; policy?: PolicyDocument; runtimeConfig?: RuntimeConfig }) => Promise<ModuleResult> | ModuleResult;
type ExecutedModule = { job_id: string; run_dir: string; result: ModuleResult };

function getOutputMode(flags: Flags): OutputMode {
  return flags.json ? "json" : "text";
}

async function withSpinner<T>(message: string, mode: OutputMode, work: () => Promise<T>): Promise<T> {
  if (mode === "json" || !process.stdout.isTTY) {
    return work();
  }

  const frames = ["|", "/", "-", "\\"];
  let index = 0;
  process.stdout.write(`${frames[index]} ${message}`);
  const timer = setInterval(() => {
    index = (index + 1) % frames.length;
    process.stdout.write(`\r${frames[index]} ${message}`);
  }, 120);

  try {
    const result = await work();
    clearInterval(timer);
    process.stdout.write(`\r✔ ${message}\n`);
    return result;
  } catch (error) {
    clearInterval(timer);
    process.stdout.write(`\r✖ ${message}\n`);
    throw error;
  }
}

function providerIsReady(resolved: Awaited<ReturnType<typeof resolveProvider>>): boolean {
  if (!resolved?.provider) return false;
  if (!resolved?.credential?.value) return false;
  if (resolved.provider.type === "shopify") return Boolean(resolved.provider.store);
  return true;
}

function isInteractive(flags: Flags): boolean {
  return !flags["no-wizard"] && !flags.json && Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value.length > 140 ? `${value.slice(0, 137)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `${value.length} item(s)`;
  return JSON.stringify(value);
}

function renderModuleResult(executed: ExecutedModule): string {
  const { job_id, run_dir, result } = executed;
  const lines = [
    `Job: ${job_id}`,
    `Module: ${result.module}`,
    `Status: ${result.status}`,
    `Needs review: ${result.needs_review ? "yes" : "no"}`,
    `Run dir: ${run_dir}`,
    ""
  ];

  if ("decision" in result) {
    const decisionResult = result as unknown as LooseRecord;
    lines.push(`Decision: ${String(decisionResult.decision)}`);
    if ("confidence" in result) lines.push(`Confidence: ${String(decisionResult.confidence)}`);
    lines.push("");
  }

  lines.push("Proposed changes:");
  const changes = Object.entries(result.proposed_changes ?? {});
  if (changes.length === 0) lines.push("- none");
  else changes.forEach(([key, value]) => lines.push(`- ${key}: ${formatValue(value)}`));

  if (result.reasoning.length > 0) {
    lines.push("", "Reasoning:");
    result.reasoning.forEach((item) => lines.push(`- ${item}`));
  }

  if (result.warnings.length > 0) {
    lines.push("", "Warnings:");
    result.warnings.forEach((item) => lines.push(`- ${item}`));
  }

  if (result.next_actions.length > 0) {
    lines.push("", "Next:");
    result.next_actions.forEach((item) => lines.push(`- ${item}`));
  }

  return `${lines.join("\n")}\n`;
}

function renderDoctor(payload: { credentials: Array<{ alias: string; source: string; ready: boolean }>; module_checks: Array<{ module: string; ready: boolean; slots: Array<{ slot: string; provider_alias: string; provider_type: string | null; ready: boolean; source: string; store?: string }> }> }): string {
  const lines = ["Credentials:"];
  payload.credentials.forEach((credential) => {
    lines.push(`- ${credential.alias}: ${credential.ready ? `ready via ${credential.source}` : "missing"}`);
  });
  lines.push("", "Module readiness:");
  payload.module_checks.forEach((moduleCheck) => {
    lines.push(`- ${moduleCheck.module}: ${moduleCheck.ready ? "ready" : "not ready"}`);
    moduleCheck.slots.forEach((slot) => {
      const storeSuffix = slot.store ? ` (${slot.store})` : "";
      lines.push(`  ${slot.slot} -> ${slot.provider_alias} [${slot.provider_type ?? "unknown"}]: ${slot.ready ? `ready via ${slot.source}` : "missing"}${storeSuffix}`);
    });
  });
  return `${lines.join("\n")}\n`;
}

function renderDecision(decision: ReviewDecision): string {
  return [`Review recorded for ${decision.job_id}`, `Action: ${decision.action}`, `Notes: ${decision.notes || "none"}`, `Edits: ${Object.keys(decision.edits ?? {}).length} field(s)`].join("\n") + "\n";
}

function renderApplyResult(result: ApplyResult): string {
  const lines = [`Applied job ${result.job_id}`, `Module: ${result.module}`, `Status: ${result.status}`];
  if (result.live_result) lines.push(`Live result: ${formatValue(result.live_result)}`);
  else lines.push(`Applied fields: ${Object.keys(result.applied_changes ?? {}).length}`);
  return `${lines.join("\n")}\n`;
}

function renderReviewQueue(payload: { count: number; items: Array<{ product_key: string; module: string; job_id: string; status: string }> }): string {
  const lines = [`Review queue: ${payload.count} item(s)`];
  payload.items.forEach((item) => {
    lines.push(`- ${item.product_key}: ${item.module} -> ${item.job_id} (${item.status})`);
  });
  return `${lines.join("\n")}\n`;
}

function renderBulkReviewResult(payload: { action: string; count: number; jobs: string[] }): string {
  const lines = [`Bulk review action: ${payload.action}`, `Updated: ${payload.count} run(s)`];
  payload.jobs.forEach((jobId) => lines.push(`- ${jobId}`));
  return `${lines.join("\n")}\n`;
}

function renderBatchSummary(summary: { operation: string; input: string; total: number; processed: number; runs: Array<{ index: number; job_id: string; status: string; needs_review: boolean }> }): string {
  const lines = [`Batch operation: ${summary.operation}`, `Input: ${summary.input}`, `Processed: ${summary.processed}/${summary.total}`, "", "Runs:"];
  summary.runs.forEach((run) => {
    lines.push(`- #${run.index + 1}: ${run.job_id} -> ${run.status}${run.needs_review ? " (needs review)" : ""}`);
  });
  return `${lines.join("\n")}\n`;
}

function renderWorkflowSummary(summary: { input: string; total: number; processed: number; runs: WorkflowRunSummary[]; review_queue_csv?: string; shopify_import_csv?: string; excel_workbook?: string }): string {
  const lines = [
    "Workflow complete",
    `Input: ${summary.input}`,
    `Processed: ${summary.processed}/${summary.total}`,
    "",
    "Products:"
  ];

  summary.runs.forEach((run) => {
    lines.push(`- ${run.product_key} (${run.source_record_id})`);
    lines.push(`  Product output: ${run.generated_product_path}`);
    lines.push(`  Image output: ${run.generated_image_dir}`);
    run.modules.forEach((module) => {
      lines.push(`  ${module.module} -> ${module.job_id} (${module.status}${module.needs_review ? ", needs review" : ""})`);
    });
  });

  if (summary.review_queue_csv) lines.push("", `Review queue CSV: ${summary.review_queue_csv}`);
  if (summary.shopify_import_csv) lines.push(`Shopify import CSV: ${summary.shopify_import_csv}`);
  if (summary.excel_workbook) lines.push(`Excel workbook: ${summary.excel_workbook}`);
  return `${lines.join("\n")}\n`;
}

function renderConfigSet(pathExpression: string, value: unknown): string {
  return `Updated config: ${pathExpression} = ${formatValue(value)}\n`;
}

function renderConfigGet(pathExpression: string, value: unknown): string {
  return `${pathExpression}: ${formatValue(value)}\n`;
}

function renderCredentialList(credentials: Array<{ alias: string; source: string; ready: boolean }>): string {
  const lines = ["Credentials:"];
  credentials.forEach((credential) => {
    lines.push(`- ${credential.alias}: ${credential.ready ? `ready via ${credential.source}` : "missing"}`);
  });
  return `${lines.join("\n")}\n`;
}

function renderAuthTest(result: LooseRecord): string {
  const lines = [`Provider: ${String(result.alias ?? "unknown")}`, `Status: ${result.ok ? "ready" : "not ready"}`];
  if (result.message) lines.push(`Message: ${String(result.message)}`);
  if (result.shop) lines.push(`Shop: ${formatValue(result.shop)}`);
  return `${lines.join("\n")}\n`;
}

function writeOutput(stdout: OutputWriter, mode: OutputMode, payload: unknown, text: string): void {
  stdout.write(mode === "json" ? `${JSON.stringify(payload, null, 2)}\n` : text);
}

async function loadInputFile(filePath: string): Promise<LooseRecord> {
  return JSON.parse(await readText(filePath, "")) as LooseRecord;
}

async function getPolicyOrThrow(root: string): Promise<PolicyDocument> {
  const policy = await readJson<PolicyDocument | null>(getCatalogPaths(root).policyJson, null);
  if (!policy) throw new Error("No policy found. Run `catalog expert generate` first.");
  return policy;
}

async function askText(rl: readline.Interface, prompt: string, defaultValue = ""): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askYesNo(rl: readline.Interface, prompt: string, defaultValue = true): Promise<boolean> {
  const suffix = defaultValue ? " [Y/n]" : " [y/N]";
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return ["y", "yes"].includes(answer);
}

async function maybePromptCredential(rl: readline.Interface, alias: string, prompt: string): Promise<boolean> {
  const configureNow = await askYesNo(rl, `Configure ${alias} now?`, false);
  if (!configureNow) return false;
  const value = await askText(rl, prompt, "");
  if (value) await setCredential(alias, value);
  return Boolean(value);
}

function isLiveTextMode(mode: OutputMode): boolean {
  return mode === "text" && Boolean(process.stdout.isTTY);
}

function writeWorkflowProgress(stdout: OutputWriter, line: string, mode: OutputMode): void {
  if (!isLiveTextMode(mode)) return;
  stdout.write(`${line}\n`);
}

async function listRunIds(root: string): Promise<string[]> {
  const runsDir = getCatalogPaths(root).runsDir;
  const entries = await fs.readdir(runsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function deriveProductKeyFromRun(run: RunData): string {
  if (run.input && typeof run.input === "object") {
    return getProductKey(run.input as LooseRecord, run.result?.job_id ?? "product");
  }
  return run.result?.job_id ?? "unknown";
}

async function loadReviewableRuns(root: string, flags: Flags): Promise<Array<{ run: RunData; product_key: string }>> {
  const runIds = await listRunIds(root);
  const loaded = await Promise.all(runIds.map(async (jobId) => ({ run: await loadRun(root, jobId), product_key: "" })));

  return loaded
    .map((item) => ({ ...item, product_key: deriveProductKeyFromRun(item.run) }))
    .filter((item) => {
      if (!item.run.result) return false;
      if (flags.module && item.run.result.module !== String(flags.module)) return false;
      if (flags.product && item.product_key !== String(flags.product)) return false;
      if (!flags.all && !item.run.result.needs_review) return false;
      return true;
    });
}

async function executeModule(root: string, moduleName: string, runInput: LooseRecord, handler: (jobId: string, runInput: LooseRecord, runDir: string) => Promise<ModuleResult> | ModuleResult): Promise<ExecutedModule> {
  await initWorkspace(root);
  const { jobId, runDir } = await createRun(root, moduleName, runInput);
  const result = await handler(jobId, runInput, runDir);
  await writeModuleArtifacts(runDir, result);
  return { job_id: jobId, run_dir: runDir, result };
}

async function persistGeneratedOutputs(
  root: string,
  input: ProductRecord,
  result: ModuleResult
): Promise<{ productPath: string; imageDirectory?: string; selectedImageUrl?: string; localImagePath?: string }> {
  const generatedProduct = buildGeneratedProduct(input, result);
  const productPath = await persistGeneratedProduct(root, generatedProduct, result.job_id);
  let imageDirectory: string | undefined;
  let selectedImageUrl: string | undefined;
  let localImagePath: string | undefined;

  if (result.module === "image-optimizer") {
    const imageArtifacts = await persistGeneratedImageArtifacts(root, generatedProduct, result);
    imageDirectory = imageArtifacts.directory;
    const metadata = await readJson<LooseRecord>(imageArtifacts.metadataPath, {});
    if (typeof metadata.selected_image_url === "string") selectedImageUrl = metadata.selected_image_url;
    if (typeof metadata.local_image_path === "string") localImagePath = metadata.local_image_path;
  }

  return { productPath, imageDirectory, selectedImageUrl, localImagePath };
}

async function runWorkflowSequence(root: string, record: ProductRecord, flags: Flags, stdout?: OutputWriter, mode: OutputMode = "text", sequenceIndex?: number, total?: number): Promise<WorkflowRunSummary> {
  const policy = await getPolicyOrThrow(root);
  const runtimeConfig = await loadRuntimeConfig(root);
  const paths = getCatalogPaths(root);
  const learningText = await readText(paths.learningMarkdown, "");
  const sourceRecordId = String(record.id ?? record.product_id ?? record.sku ?? record.handle ?? record.title ?? "record");
  let currentRecord: ProductRecord = { ...record };
  const modules: WorkflowRunSummary["modules"] = [];
  let imageDirectory = paths.generatedImagesDir;
  const productLabel = getProductKey(currentRecord, sourceRecordId);

  if (stdout && sequenceIndex !== undefined && total !== undefined) {
    writeWorkflowProgress(stdout, `[${sequenceIndex + 1}/${total}] ${productLabel}`, mode);
  }

  async function executeWorkflowModule(moduleName: string, handler: (jobId: string) => Promise<ModuleResult> | ModuleResult): Promise<ExecutedModule> {
    writeWorkflowProgress(stdout ?? { write() {} }, `  -> ${moduleName} ...`, mode);
    const executed = await executeModule(root, moduleName, currentRecord, async (jobId) => handler(jobId));
    writeWorkflowProgress(stdout ?? { write() {} }, `  -> ${moduleName} ... ${executed.result.status}${executed.result.needs_review ? " (needs review)" : ""}`, mode);
    if (executed.result.warnings.length > 0) {
      writeWorkflowProgress(stdout ?? { write() {} }, `     warning: ${executed.result.warnings[0]}`, mode);
    }
    return executed;
  }

  let catalogData: LooseRecord[] | undefined;
  let catalogSource = "";
  if (flags.catalog) {
    const fileCatalog = await loadInputFile(path.resolve(root, String(flags.catalog)));
    catalogData = Array.isArray(fileCatalog) ? (fileCatalog as LooseRecord[]) : [fileCatalog];
    catalogSource = "file";
  } else {
    const catalogProvider = await resolveProvider(root, "catalogue-match", "catalog_provider");
    if (providerIsReady(catalogProvider)) {
      catalogSource = `shopify:${catalogProvider.provider.store}`;
      catalogData = await fetchShopifyCatalogSnapshot({
        store: catalogProvider.provider.store,
        apiVersion: catalogProvider.provider.api_version ?? "2025-04",
        accessToken: catalogProvider.credential.value,
        first: Number(flags.first ?? 50)
      }) as LooseRecord[];
    }
  }

  if (catalogData) {
    await writeJson(paths.indexJson, buildCatalogIndex(catalogData));
    const executed = await executeWorkflowModule("catalogue-match", async (jobId) => {
      const result = runMatchDecision({
        jobId,
        input: currentRecord,
        catalog: catalogData!,
        policy,
        learningText
      });
      result.reasoning = [`Catalog source: ${catalogSource}`, ...(result.reasoning ?? [])];
      result.artifacts = { ...(result.artifacts ?? {}), catalog_source: catalogSource };
      return result;
    });
    modules.push({ module: executed.result.module, job_id: executed.job_id, status: executed.result.status, needs_review: executed.result.needs_review });
  }

  const enrichRun = await executeWorkflowModule("product-enricher", async (jobId) => runEnrich({ root, jobId, input: currentRecord, policy }));
  currentRecord = buildGeneratedProduct(currentRecord, enrichRun.result) as ProductRecord;
  modules.push({ module: enrichRun.result.module, job_id: enrichRun.job_id, status: enrichRun.result.status, needs_review: enrichRun.result.needs_review });
  await persistGeneratedOutputs(root, currentRecord, enrichRun.result);

  const imageRun = await executeWorkflowModule("image-optimizer", async (jobId) => runImageOptimize({ root, jobId, input: currentRecord, policy, runtimeConfig }));
  currentRecord = buildGeneratedProduct(currentRecord, imageRun.result) as ProductRecord;
  modules.push({ module: imageRun.result.module, job_id: imageRun.job_id, status: imageRun.result.status, needs_review: imageRun.result.needs_review });
  const imageOutput = await persistGeneratedOutputs(root, currentRecord, imageRun.result);
  imageDirectory = imageOutput.imageDirectory ?? imageDirectory;

  const qaRun = await executeWorkflowModule("catalogue-qa", async (jobId) => runQa({ root, jobId, input: currentRecord, policy }));
  modules.push({ module: qaRun.result.module, job_id: qaRun.job_id, status: qaRun.result.status, needs_review: qaRun.result.needs_review });
  await persistGeneratedOutputs(root, currentRecord, qaRun.result);

  const syncRun = await executeWorkflowModule("shopify-sync", async (jobId) => runSync({ root, jobId, input: currentRecord }));
  modules.push({ module: syncRun.result.module, job_id: syncRun.job_id, status: syncRun.result.status, needs_review: syncRun.result.needs_review });
  const productPath = (await persistGeneratedOutputs(root, currentRecord, syncRun.result)).productPath;

  return {
    index: 0,
    product_key: getProductKey(currentRecord, sourceRecordId),
    source_record_id: sourceRecordId,
    generated_product_path: productPath,
    generated_image_dir: imageDirectory,
    selected_image_url: imageOutput.selectedImageUrl,
    local_image_path: imageOutput.localImagePath,
    modules
  };
}

async function runInitWizard(root: string, stdout: OutputWriter): Promise<void> {
  const rl = readline.createInterface({ input: rlInput, output: rlOutput });
  try {
    const shouldRun = await askYesNo(rl, "Run guided setup now?", true);
    if (!shouldRun) return;

    const businessName = await askText(rl, "Business name", "Demo Store");
    const businessDescription = await askText(rl, "Short business description", "A Shopify business selling curated products");
    const industry = await askText(rl, "Industry", "grocery");
    const targetMarket = await askText(rl, "Target market", "General ecommerce shoppers");
    const operatingMode = await askText(rl, "Operating mode (local_files, shopify, both)", "both");
    let policyJobId = "";

    const configureProviders = await askYesNo(rl, "Configure providers now?", true);
    const configured: string[] = [];
    let storeUrl = "";
    if (configureProviders) {
      const runtime = await loadRuntimeConfig(root);
      const openaiReady = await maybePromptCredential(rl, "openai", "OpenAI API key");
      if (openaiReady) configured.push("openai");
      const geminiReady = await maybePromptCredential(rl, "gemini", "Gemini API key");
      if (geminiReady) configured.push("gemini");
      const serperReady = await maybePromptCredential(rl, "serper", "Serper API key");
      if (serperReady) configured.push("serper");

      const shopifyNow = await askYesNo(rl, "Configure Shopify now?", false);
      let shopifyTokenReady = false;
      if (shopifyNow) {
        const store = await askText(rl, "Shopify store domain", "");
        const token = await askText(rl, "Shopify admin token", "");
        storeUrl = store;
        if (store) {
          runtime.providers.shopify_default.store = store;
          configured.push(`shopify-store:${store}`);
        }
        if (token) {
          await setCredential("shopify", token);
          configured.push("shopify");
          shopifyTokenReady = true;
        }
      }

      if (openaiReady && geminiReady) {
        const primary = await askText(rl, "Primary enrichment provider", "openai");
        runtime.modules["product-enricher"].llm_provider = primary === "gemini" ? "gemini_flash_default" : "openai_default";
        runtime.modules["product-enricher"].fallback_llm_provider = primary === "gemini" ? "openai_default" : "gemini_flash_default";
      } else if (geminiReady) {
        runtime.modules["product-enricher"].llm_provider = "gemini_flash_default";
        runtime.modules["product-enricher"].fallback_llm_provider = "";
      } else if (openaiReady) {
        runtime.modules["product-enricher"].llm_provider = "openai_default";
        runtime.modules["product-enricher"].fallback_llm_provider = "";
      }

      if (!openaiReady && !geminiReady) runtime.modules["product-enricher"].llm_provider = "";
      if (!serperReady) runtime.modules["image-optimizer"].search_provider = "";
      if (!openaiReady) runtime.modules["image-optimizer"].vision_provider = geminiReady ? "gemini_flash_default" : "";
      if (!(runtime.providers.shopify_default.store && shopifyTokenReady)) {
        runtime.modules["catalogue-match"].catalog_provider = "";
        runtime.modules["shopify-sync"].shopify_provider = "";
      }

      await saveRuntimeConfig(root, runtime);
    }

    const generatePolicy = await askYesNo(rl, "Generate a catalog policy now?", true);
    if (generatePolicy) {
      const executed = await executeModule(root, "catalogue-expert", { source: "init-wizard" }, async (jobId) => runExpertGenerate({
        root,
        jobId,
        input: {
          industry,
          businessName,
          businessDescription,
          targetMarket,
          operatingMode,
          storeUrl,
          notes: "Generated from init wizard"
        }
      }));
      policyJobId = executed.job_id;
    }

    const lines = ["Guided setup complete."];
    if (policyJobId) lines.push(`Policy generated in run: ${policyJobId}`);
    if (configured.length > 0) lines.push(`Configured: ${configured.join(", ")}`);
    lines.push("Next: run `catalog doctor` to confirm readiness.");
    stdout.write(`${lines.join("\n")}\n`);
  } finally {
    rl.close();
  }
}

export async function runCli(
  argv: string[],
  { cwd = process.cwd(), stdout = process.stdout as unknown as OutputWriter, stderr = process.stderr as unknown as OutputWriter }: CliStreams = {}
): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const root = getWorkspaceRoot(cwd);
  const command = positional[0];
  const subcommand = positional[1];

  try {
    switch (command) {
      case "init":
        return await handleInit(root, flags, stdout);
      case "auth":
        return await handleAuth(root, subcommand, positional.slice(2), flags, stdout);
      case "config":
        return await handleConfig(root, subcommand, positional.slice(2), flags, stdout);
      case "doctor":
        return await handleDoctor(root, flags, stdout);
      case "expert":
        return await handleExpert(root, subcommand, flags, stdout);
      case "ingest":
        return await handleIngest(root, flags, stdout);
      case "match":
        return await handleMatch(root, flags, stdout);
      case "enrich":
        return await handlePolicyModule(root, "product-enricher", flags, stdout, runEnrich);
      case "image":
        return await handleImage(root, flags, stdout);
      case "qa":
        return await handlePolicyModule(root, "catalogue-qa", flags, stdout, async ({ root, jobId, input, policy }) => runQa({ root, jobId, input, policy: policy! }));
      case "sync":
        return await handleInputModule(root, "shopify-sync", flags, stdout, runSync);
      case "batch":
        return await handleBatch(root, subcommand, flags, stdout);
      case "workflow":
        return await handleWorkflow(root, subcommand, flags, stdout);
      case "review":
        return await handleReview(root, positional[1], flags, stdout);
      case "apply":
        return await handleApply(root, positional[1], flags, stdout);
      case "learn":
        return await handleLearn(root, flags, stdout);
      case "help":
      case undefined:
        printHelp(stdout);
        return 0;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function handleInit(root: string, flags: Flags, stdout: OutputWriter): Promise<number> {
  const mode = getOutputMode(flags);
  const paths = await withSpinner("Initializing workspace", mode, () => initWorkspace(root));
  writeOutput(stdout, getOutputMode(flags), { base: paths.base }, `Initialized workspace at ${paths.base}\n`);
  if (isInteractive(flags)) {
    await withSpinner("Running setup wizard", mode, () => runInitWizard(root, stdout));
  }
  return 0;
}

async function handleAuth(root: string, subcommand: string | undefined, extraPositional: string[], flags: Flags, stdout: OutputWriter): Promise<number> {
  await initWorkspace(root);
  const mode = getOutputMode(flags);

  if (subcommand === "set") {
    const alias = flags.provider ?? extraPositional[0];
    if (!alias) throw new Error("Use `catalog auth set --provider <name> [--value <secret>]`.");
    let value = flags.value;
    if (!value) {
      const rl = readline.createInterface({ input: rlInput, output: rlOutput });
      value = await rl.question(`Enter credential for ${alias}: `);
      rl.close();
    }
    await setCredential(String(alias), String(value));
    writeOutput(stdout, mode, { alias, stored: true }, `Stored credential for ${alias}\n`);
    return 0;
  }

  if (subcommand === "list") {
    const credentials = await listCredentials();
    writeOutput(stdout, mode, credentials, renderCredentialList(credentials));
    return 0;
  }

  if (subcommand === "test") {
    const alias = flags.provider ?? extraPositional[0];
    if (!alias) throw new Error("Use `catalog auth test --provider <name>`.");
    const runtime = await loadRuntimeConfig(root);
    const result = await testCredential(String(alias), runtime);
    let payload: LooseRecord = { ...result };
    if (result.ok && alias === "shopify") {
      try {
        const provider = runtime.providers?.shopify_default;
        const shop = await testShopifyConnection({
          store: provider.store,
          apiVersion: provider.api_version ?? "2025-04",
          accessToken: result.credential.value
        });
        payload = { ...result, shop };
      } catch (error) {
        payload = { ...result, ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
    writeOutput(stdout, mode, payload, renderAuthTest(payload));
    return payload.ok ? 0 : 1;
  }

  throw new Error("Supported auth commands: set, list, test");
}

async function handleConfig(root: string, subcommand: string | undefined, extraPositional: string[], flags: Flags, stdout: OutputWriter): Promise<number> {
  await initWorkspace(root);
  const mode = getOutputMode(flags);
  if (subcommand === "set") {
    const pathExpression = extraPositional[0];
    const value = extraPositional[1];
    if (!pathExpression || value === undefined) throw new Error("Use `catalog config set <path> <value>`.");
    const config = await setRuntimeValue(root, pathExpression, value);
    const current = pathExpression.split(".").reduce<unknown>((acc, key) => (acc as LooseRecord)?.[key], config as unknown);
    writeOutput(stdout, mode, config, renderConfigSet(pathExpression, current));
    return 0;
  }

  if (subcommand === "get") {
    const pathExpression = extraPositional[0];
    if (!pathExpression) throw new Error("Use `catalog config get <path>`.");
    const value = await getRuntimeValue(root, pathExpression);
    writeOutput(stdout, mode, { path: pathExpression, value }, renderConfigGet(pathExpression, value));
    return 0;
  }

  throw new Error("Supported config commands: set, get");
}

async function handleDoctor(root: string, flags: Flags, stdout: OutputWriter): Promise<number> {
  const mode = getOutputMode(flags);
  const payload = await withSpinner("Checking provider readiness", mode, async () => {
    const runtime: RuntimeConfig = await loadRuntimeConfig(root);
    const credentials = await listCredentials();
    const moduleChecks: Array<{ module: string; ready: boolean; slots: Array<{ slot: string; provider_alias: string; provider_type: string | null; ready: boolean; source: string; store?: string }> }> = [];

    for (const [moduleName, config] of Object.entries(runtime.modules)) {
      const slotChecks = [];
      for (const [slotName, providerAlias] of Object.entries(config)) {
        const resolved = await resolveProvider(root, moduleName, slotName);
        slotChecks.push({
          slot: slotName,
          provider_alias: providerAlias,
          provider_type: resolved?.provider?.type ?? null,
          ready: providerIsReady(resolved),
          source: resolved?.credential?.source ?? "missing",
          store: resolved?.provider?.type === "shopify" ? resolved.provider.store : undefined
        });
      }
      moduleChecks.push({
        module: moduleName,
        ready: slotChecks.every((slot) => slot.ready),
        slots: slotChecks
      });
    }

    return { credentials, module_checks: moduleChecks };
  });
  writeOutput(stdout, mode, payload, renderDoctor(payload));
  return 0;
}

async function handleExpert(root: string, subcommand: string | undefined, flags: Flags, stdout: OutputWriter): Promise<number> {
  if (subcommand !== "generate") throw new Error("Use `catalog expert generate`.");
  const mode = getOutputMode(flags);
  const executed = await withSpinner("Generating catalog policy", mode, () => executeModule(root, "catalogue-expert", {}, async (jobId) => runExpertGenerate({
    root,
    jobId,
    input: {
      industry: String(flags.industry ?? "grocery"),
      businessName: String(flags["business-name"] ?? "Demo Store"),
      businessDescription: String(flags["business-description"] ?? ""),
      targetMarket: String(flags["target-market"] ?? "General ecommerce shoppers"),
      operatingMode: String(flags["operating-mode"] ?? "both"),
      storeUrl: String(flags["store-url"] ?? ""),
      notes: String(flags.notes ?? ""),
      research: flags.research === "true" || flags.research === true
    }
  })));
  writeOutput(stdout, mode, executed, renderModuleResult(executed));
  return 0;
}

async function handleIngest(root: string, flags: Flags, stdout: OutputWriter): Promise<number> {
  const inputPath = requireFlag(flags, "input", "Use --input with a JSON or CSV file.");
  const executed = await executeModule(root, "catalogue-ingest", { source_path: inputPath }, async (jobId, runInput) => runIngest({
    jobId,
    input: { source_path: String(runInput.source_path) }
  }));
  writeOutput(stdout, getOutputMode(flags), executed, renderModuleResult(executed));
  return 0;
}

async function handleInputModule(root: string, moduleName: string, flags: Flags, stdout: OutputWriter, moduleRunner: ModuleRunner): Promise<number> {
  const inputPath = requireFlag(flags, "input", "Use --input with a JSON file.");
  const inputData = await loadInputFile(path.resolve(root, inputPath)) as ProductRecord;
  const mode = getOutputMode(flags);
  const executed = await withSpinner(`Running ${moduleName}`, mode, () => executeModule(root, moduleName, inputData, async (jobId) => moduleRunner({ root, jobId, input: inputData })));
  await persistGeneratedOutputs(root, inputData, executed.result);
  writeOutput(stdout, mode, executed, renderModuleResult(executed));
  return 0;
}

async function handlePolicyModule(root: string, moduleName: string, flags: Flags, stdout: OutputWriter, moduleRunner: ModuleRunner): Promise<number> {
  const inputPath = requireFlag(flags, "input", "Use --input with a JSON file.");
  const inputData = await loadInputFile(path.resolve(root, inputPath)) as ProductRecord;
  const policy = await getPolicyOrThrow(root);
  const mode = getOutputMode(flags);
  const executed = await withSpinner(`Running ${moduleName}`, mode, () => executeModule(root, moduleName, inputData, async (jobId) => moduleRunner({ root, jobId, input: inputData, policy })));
  await persistGeneratedOutputs(root, inputData, executed.result);
  writeOutput(stdout, mode, executed, renderModuleResult(executed));
  return 0;
}

async function handleMatch(root: string, flags: Flags, stdout: OutputWriter): Promise<number> {
  await initWorkspace(root);
  const inputData = await loadInputFile(path.resolve(root, requireFlag(flags, "input", "Use --input with a JSON file.")));
  const paths = getCatalogPaths(root);
  const policy = await getPolicyOrThrow(root);
  const learningText = await readText(paths.learningMarkdown, "");

  let catalogData: LooseRecord[];
  let catalogSource = "file";
  if (flags.catalog) {
    const fileCatalog = await loadInputFile(path.resolve(root, String(flags.catalog)));
    catalogData = Array.isArray(fileCatalog) ? fileCatalog as LooseRecord[] : [fileCatalog];
  } else {
    const catalogProvider = await resolveProvider(root, "catalogue-match", "catalog_provider");
    if (!providerIsReady(catalogProvider)) {
      throw new Error("Use --catalog with a JSON file or configure a ready Shopify provider for catalogue-match.");
    }
    catalogSource = `shopify:${catalogProvider.provider.store}`;
    catalogData = await fetchShopifyCatalogSnapshot({
      store: catalogProvider.provider.store,
      apiVersion: catalogProvider.provider.api_version ?? "2025-04",
      accessToken: catalogProvider.credential.value,
      first: Number(flags.first ?? 50)
    }) as LooseRecord[];
  }

  await writeJson(paths.indexJson, buildCatalogIndex(catalogData));
  const mode = getOutputMode(flags);
  const executed = await withSpinner("Running catalogue-match", mode, () => executeModule(root, "catalogue-match", inputData, async (jobId) => {
    const result = runMatchDecision({
      jobId,
      input: inputData,
      catalog: catalogData,
      policy,
      learningText
    });
    result.reasoning = [`Catalog source: ${catalogSource}`, ...(result.reasoning ?? [])];
    result.artifacts = { ...(result.artifacts ?? {}), catalog_source: catalogSource };
    return result;
  }));

  await persistGeneratedOutputs(root, inputData, executed.result);
  writeOutput(stdout, mode, executed, renderModuleResult(executed));
  return 0;
}

async function handleImage(root: string, flags: Flags, stdout: OutputWriter): Promise<number> {
  const inputPath = requireFlag(flags, "input", "Use --input with a JSON file.");
  const inputData = await loadInputFile(path.resolve(root, inputPath)) as ProductRecord;
  const runtimeConfig = await loadRuntimeConfig(root);
  const policy = await getPolicyOrThrow(root);
  const mode = getOutputMode(flags);
  const executed = await withSpinner("Running image-optimizer", mode, () => executeModule(root, "image-optimizer", inputData, async (jobId) => runImageOptimize({
    root,
    jobId,
    input: inputData,
    policy,
    runtimeConfig
  })));
  await persistGeneratedOutputs(root, inputData, executed.result);
  writeOutput(stdout, mode, executed, renderModuleResult(executed));
  return 0;
}

async function handleBatch(root: string, operation: string | undefined, flags: Flags, stdout: OutputWriter): Promise<number> {
  if (!operation) throw new Error("Use `catalog batch <enrich|qa|match|image|sync> --input <file>`.");
  const inputPath = requireFlag(flags, "input", "Use --input with a JSON or CSV file.");
  const records = await loadRecordsFromSource(path.resolve(root, inputPath));
  const limit = flags.limit ? Number(flags.limit) : records.length;
  const selected = records.slice(0, limit) as ProductRecord[];
  const mode = getOutputMode(flags);
  const summary = {
    operation,
    input: inputPath,
    total: records.length,
    processed: 0,
    runs: [] as Array<{ index: number; job_id: string; status: string; needs_review: boolean }>
  };

  let policy: PolicyDocument | undefined;
  let runtimeConfig: RuntimeConfig | undefined;
  let catalogData: LooseRecord[] | undefined;
  let catalogSource = "";

  if (["enrich", "qa", "image", "match"].includes(operation)) {
    policy = await getPolicyOrThrow(root);
  }
  if (operation === "image") {
    runtimeConfig = await loadRuntimeConfig(root);
  }
  if (operation === "match") {
    if (!flags.catalog) throw new Error("Batch match currently requires --catalog <file>.");
    const fileCatalog = await loadInputFile(path.resolve(root, String(flags.catalog)));
    catalogData = Array.isArray(fileCatalog) ? fileCatalog as LooseRecord[] : [fileCatalog];
    catalogSource = "file";
  }

  const payload = await withSpinner(`Running batch ${operation}`, mode, async () => {
    for (const [index, record] of selected.entries()) {
      let executed: ExecutedModule;
      if (operation === "enrich") {
        executed = await executeModule(root, "product-enricher", record, async (jobId) => runEnrich({ root, jobId, input: record, policy: policy! }));
      } else if (operation === "qa") {
        executed = await executeModule(root, "catalogue-qa", record, async (jobId) => runQa({ root, jobId, input: record, policy: policy! }));
      } else if (operation === "image") {
        executed = await executeModule(root, "image-optimizer", record, async (jobId) => runImageOptimize({ root, jobId, input: record, policy: policy!, runtimeConfig: runtimeConfig! }));
      } else if (operation === "sync") {
        executed = await executeModule(root, "shopify-sync", record, async (jobId) => runSync({ root, jobId, input: record }));
      } else if (operation === "match") {
        const paths = getCatalogPaths(root);
        const learningText = await readText(paths.learningMarkdown, "");
        executed = await executeModule(root, "catalogue-match", record, async (jobId) => {
          const result = runMatchDecision({
            jobId,
            input: record,
            catalog: catalogData!,
            policy: policy!,
            learningText
          });
          result.reasoning = [`Catalog source: ${catalogSource}`, ...(result.reasoning ?? [])];
          result.artifacts = { ...(result.artifacts ?? {}), catalog_source: catalogSource, batch_index: index };
          return result;
        });
      } else {
        throw new Error(`Unsupported batch operation: ${operation}`);
      }

      await persistGeneratedOutputs(root, record, executed.result);
      summary.processed += 1;
      summary.runs.push({
        index,
        job_id: executed.job_id,
        status: executed.result.status,
        needs_review: executed.result.needs_review
      });
    }

    return summary;
  });

  writeOutput(stdout, mode, payload, renderBatchSummary(payload));
  return 0;
}

async function handleWorkflow(root: string, subcommand: string | undefined, flags: Flags, stdout: OutputWriter): Promise<number> {
  if (subcommand !== "run") throw new Error("Use `catalog workflow run --input <file>`.");
  const inputPath = requireFlag(flags, "input", "Use --input with a JSON or CSV file.");
  const records = await loadRecordsFromSource(path.resolve(root, inputPath));
  const limit = flags.limit ? Number(flags.limit) : records.length;
  const selected = records.slice(0, limit) as ProductRecord[];
  const mode = getOutputMode(flags);
  const policy = await getPolicyOrThrow(root);
  const runWork = async () => {
    const items: WorkflowRunSummary[] = [];
    for (const [index, record] of selected.entries()) {
      const summary = await runWorkflowSequence(root, record, flags, stdout, mode, index, selected.length);
      items.push({ ...summary, index });
    }
    return items;
  };
  const runs = isLiveTextMode(mode)
    ? await runWork()
    : await withSpinner("Running full workflow", mode, runWork);

  const generatedProducts = await Promise.all(runs.map((run) => readJson<LooseRecord>(run.generated_product_path, {})));
  const reviewQueueCsv = await writeReviewQueueCsv(root, runs);
  const shopifyImportCsv = await writeShopifyImportCsv(root, generatedProducts, policy);
  const excelWorkbook = await writeExcelWorkbook(root, runs, generatedProducts, generatedProducts, policy);
  const payload = {
    input: inputPath,
    total: records.length,
    processed: runs.length,
    runs,
    review_queue_csv: reviewQueueCsv,
    shopify_import_csv: shopifyImportCsv,
    excel_workbook: excelWorkbook
  };
  if (mode === "text") {
    const reviewItems = runs.flatMap((run) =>
      run.modules
        .filter((module) => module.needs_review)
        .map((module) => ({
          product_key: run.product_key,
          module: module.module,
          job_id: module.job_id,
          status: module.status
        }))
    );
    if (reviewItems.length > 0) {
      stdout.write(`\n${renderReviewQueue({ count: reviewItems.length, items: reviewItems })}`);
    }
  }
  writeOutput(stdout, mode, payload, renderWorkflowSummary(payload));
  return 0;
}

async function handleReview(root: string, jobOrPath: string | undefined, flags: Flags, stdout: OutputWriter): Promise<number> {
  if (!jobOrPath) throw new Error("Use `catalog review <job-id>`.");
  const mode = getOutputMode(flags);

  if (jobOrPath === "queue") {
    const items = await withSpinner("Loading review queue", mode, () => loadReviewableRuns(root, flags));
    const payload = {
      count: items.length,
      items: items.map((item) => ({
        product_key: item.product_key,
        module: item.run.result?.module ?? "unknown",
        job_id: item.run.result?.job_id ?? "unknown",
        status: item.run.result?.status ?? "unknown"
      }))
    };
    writeOutput(stdout, mode, payload, renderReviewQueue(payload));
    return 0;
  }

  if (jobOrPath === "bulk") {
    const action = flags.action;
    if (!action) throw new Error("Use `catalog review bulk --action approve|approve_with_edits|reject|defer`.");
    const items = await withSpinner("Loading review queue", mode, () => loadReviewableRuns(root, flags));
    const payload = await withSpinner("Applying bulk review decisions", mode, async () => {
      const jobs: string[] = [];
      for (const item of items) {
        const decision: ReviewDecision = {
          job_id: item.run.result?.job_id ?? "",
          action: String(action),
          notes: typeof flags.notes === "string" ? flags.notes : "",
          edits: {},
          decided_at: new Date().toISOString()
        };
        await writeDecision(item.run.runDir, decision);
        jobs.push(decision.job_id);
      }
      return { action: String(action), count: jobs.length, jobs };
    });
    writeOutput(stdout, mode, payload, renderBulkReviewResult(payload));
    return 0;
  }

  const run = await withSpinner("Loading review packet", mode, () => loadRun(root, jobOrPath));
  if (!flags.action) {
    stdout.write(`${run.reviewMarkdown}\n`);
    return 0;
  }
  const decision: ReviewDecision = {
    job_id: run.result?.job_id ?? jobOrPath,
    action: String(flags.action),
    notes: typeof flags.notes === "string" ? flags.notes : "",
    edits: flags.edits ? await loadInputFile(path.resolve(root, String(flags.edits))) : {},
    decided_at: new Date().toISOString()
  };
  await withSpinner("Saving review decision", mode, () => writeDecision(run.runDir, decision));
  writeOutput(stdout, mode, decision, renderDecision(decision));
  return 0;
}

async function handleApply(root: string, jobOrPath: string | undefined, flags: Flags, stdout: OutputWriter): Promise<number> {
  if (!jobOrPath) throw new Error("Use `catalog apply <job-id>`.");
  const mode = getOutputMode(flags);
  const run: RunData = await withSpinner("Loading approved run", mode, () => loadRun(root, jobOrPath));
  if (!run.result) throw new Error("Run result not found.");
  const decision = run.decision as ReviewDecision | null;
  if (!decision || !["approve", "approve_with_edits"].includes(decision.action)) {
    throw new Error("Run must be approved before apply.");
  }

  const appliedChanges = { ...run.result.proposed_changes, ...decision.edits };
  const applyResult: ApplyResult = {
    job_id: run.result.job_id,
    module: run.result.module,
    applied_at: new Date().toISOString(),
    status: "applied_local",
    applied_changes: appliedChanges
  };

  if (flags.live) {
    if (run.result.module !== "shopify-sync") {
      throw new Error("Live apply is only supported for shopify-sync runs.");
    }

    const shopifyProvider = await resolveProvider(root, "shopify-sync", "shopify_provider");
    if (!shopifyProvider?.provider?.store || !shopifyProvider.credential?.value) {
      throw new Error("Shopify provider is not ready. Configure the store domain and Shopify credential before using --live.");
    }

    const shopifyPayload = appliedChanges.shopify_payload as LooseRecord | undefined;
    if (!shopifyPayload) {
      throw new Error("No shopify_payload found in the approved changes.");
    }

    const liveResult = await applyShopifyPayload({
      store: shopifyProvider.provider.store,
      apiVersion: shopifyProvider.provider.api_version ?? "2025-04",
      accessToken: shopifyProvider.credential.value,
      payload: shopifyPayload
    });

    applyResult.status = "applied_live";
    applyResult.live_result = {
      ...liveResult,
      provider_alias: shopifyProvider.providerAlias,
      target_store: shopifyProvider.provider.store
    };
  }

  await withSpinner(flags.live ? "Applying changes to Shopify" : "Applying changes locally", mode, () => writeApplyResult(run.runDir, applyResult));
  if (run.input && typeof run.input === "object") {
    const generatedProduct = {
      ...(run.input as LooseRecord),
      ...(appliedChanges ?? {}),
      _catalog_apply: {
        job_id: run.result.job_id,
        module: run.result.module,
        status: applyResult.status,
        applied_at: applyResult.applied_at
      }
    };
    await persistGeneratedProduct(root, generatedProduct, run.result.job_id);
  }
  writeOutput(stdout, mode, applyResult, renderApplyResult(applyResult));
  return 0;
}

async function handleLearn(root: string, flags: Flags, stdout: OutputWriter): Promise<number> {
  await initWorkspace(root);
  let payload: LooseRecord;
  if (flags.run) {
    const run = await loadRun(root, String(flags.run));
    const review = run.review as LooseRecord | null;
    const reviewWarnings = Array.isArray(review?.warnings) ? review.warnings.map(String) : [];
    const reasoning = Array.isArray(run.result?.reasoning) ? run.result.reasoning.map(String) : [];
    const decision = run.decision as ReviewDecision | null;
    payload = {
      module: run.result?.module ?? "unknown",
      summary: reviewWarnings.join("; ") || reasoning[0] || "Review outcome recorded.",
      lesson: flags.lesson ?? `Review outcome for ${run.result?.module ?? "module"}: ${decision?.action ?? "no action"}`
    };
  } else {
    payload = {
      module: flags.module ?? "manual",
      summary: flags.summary ?? "Manual lesson entry",
      lesson: requireFlag(flags, "lesson", "Use --lesson or provide --run.")
    };
  }
  const executed = await executeModule(root, "feedback-learn", payload, async (jobId) => runLearn({ root, jobId, input: payload }));
  writeOutput(stdout, getOutputMode(flags), executed, renderModuleResult(executed));
  return 0;
}

function printHelp(stdout: OutputWriter): void {
  stdout.write(`catalog commands:
  init [--no-wizard] [--json]
  auth set --provider <name> --value <secret> [--json]
  auth list [--json]
  auth test --provider <name> [--json]
  config set <path> <value> [--json]
  config get <path> [--json]
  doctor [--json]
  expert generate --industry grocery --business-name "Store" --business-description "..." [--operating-mode both] [--research true] [--json]
  ingest --input <file> [--json]
  match --input <file> [--catalog <file>] [--first 50] [--json]
  enrich --input <file> [--json]
  image --input <file> [--json]
  qa --input <file> [--json]
  sync --input <file> [--json]
  batch <enrich|qa|match|image|sync> --input <file> [--catalog <file>] [--limit N] [--json]
  workflow run --input <file> [--catalog <file>] [--limit N] [--json]
  review <job-id> [--action approve|approve_with_edits|reject|defer] [--json]
  review queue [--module <name>] [--product <product-key>] [--all] [--json]
  review bulk --action approve|approve_with_edits|reject|defer [--module <name>] [--product <product-key>] [--all] [--json]
  apply <job-id> [--live] [--json]
  learn --run <job-id> [--lesson "..."] [--json]
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await runCli(process.argv.slice(2)));
}
