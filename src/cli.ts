#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin as rlInput, stdout as rlOutput } from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs, requireFlag } from "./lib/args.js";
import { materializeProposedChanges } from "./lib/change-records.js";
import { initWorkspace, loadRuntimeConfig, saveRuntimeConfig, setRuntimeValue, getRuntimeValue } from "./lib/runtime.js";
import { setCredential, setOAuthCredential, listCredentials, testCredential, loadOpenAICodexAuthSession } from "./lib/credentials.js";
import { getWorkspaceRoot, getCatalogPaths } from "./lib/paths.js";
import { readJson, readText, writeJson } from "./lib/fs.js";
import { createRun, loadRun, writeModuleArtifacts, writeDecision, writeApplyResult } from "./lib/artifacts.js";
import { buildGeneratedProduct, getProductKey, persistGeneratedImageArtifacts, persistGeneratedProduct, writeExcelWorkbook, writePendingReviewQueueCsv, writeReviewQueueCsv, writeShopifyImportCsv, writeWorkflowProductsLedger } from "./lib/generated.js";
import { resolveProvider } from "./lib/providers.js";
import { getGuidePassingScore } from "./lib/catalog-guide.js";
import { INDUSTRY_OPTIONS } from "./lib/policy-template.js";
import { testShopifyConnection, fetchShopifyCatalogSnapshot, applyShopifyPayload, authenticateShopifyViaOAuth } from "./connectors/shopify.js";
import { authenticateGeminiViaOAuth } from "./connectors/gemini.js";
import { runExpertGenerate } from "./modules/expert.js";
import { loadRecordsFromSource, loadRecordsFromText, runIngest } from "./modules/ingest.js";
import { runMatchDecision, buildCatalogIndex } from "./modules/match.js";
import { runEnrich } from "./modules/enrich.js";
import { runImageOptimize } from "./modules/image-optimize.js";
import { runQa } from "./modules/qa.js";
import { runSync } from "./modules/sync.js";
import { runLearn } from "./modules/learn.js";
import type { ApplyResult, CliStreams, LooseRecord, ModuleResult, OutputWriter, PolicyDocument, ProductRecord, ReviewDecision, RunData, RuntimeConfig, ShopifyPayload, WorkflowRunSummary } from "./types.js";

type Flags = Record<string, string | boolean>;
type OutputMode = "json" | "text";
type ModuleRunner = (args: { root: string; jobId: string; input: ProductRecord; policy?: PolicyDocument; runtimeConfig?: RuntimeConfig }) => Promise<ModuleResult> | ModuleResult;
type ExecutedModule = { job_id: string; run_dir: string; result: ModuleResult };

const LLM_PROVIDER_ALIAS_BY_NAME: Record<string, string> = {
  openai: "openai_default",
  gemini: "gemini_flash_default",
  anthropic: "anthropic_default"
};

const LLM_PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-5",
  gemini: "gemini-2.5-flash",
  anthropic: "claude-sonnet-4-20250514"
};

const LLM_PROVIDER_MODEL_CHOICES: Record<string, string[]> = {
  openai: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini", "custom"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash", "custom"],
  anthropic: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3-7-sonnet-latest", "custom"]
};

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

function isShopifyProductGid(value: unknown): value is string {
  return typeof value === "string" && /^gid:\/\/shopify\/Product\/.+$/i.test(value.trim());
}

export function isVariantAttachPayload(payload: LooseRecord | null | undefined): boolean {
  return typeof payload?.attachToProductId === "string" && payload.attachToProductId.trim().length > 0;
}

export async function resolveLiveVariantAttachPayload(root: string, payload: LooseRecord): Promise<LooseRecord> {
  const attachToProductId = typeof payload.attachToProductId === "string" ? payload.attachToProductId.trim() : "";
  if (!attachToProductId || isShopifyProductGid(attachToProductId)) {
    return payload;
  }

  const attachToProductHandle = typeof payload.attachToProductHandle === "string" ? payload.attachToProductHandle.trim() : "";
  const attachToProductTitle = typeof payload.attachToProductTitle === "string" ? payload.attachToProductTitle.trim() : "";
  const generatedProducts = await loadGeneratedProductCatalog(root);
  const parent = generatedProducts.find((product) => {
    const productId = typeof product.id === "string" ? product.id.trim() : "";
    const productHandle = typeof product.handle === "string" ? product.handle.trim() : "";
    const productTitle = typeof product.title === "string" ? product.title.trim() : "";
    return (
      (attachToProductId && productId === attachToProductId) ||
      (attachToProductHandle && productHandle === attachToProductHandle) ||
      (attachToProductTitle && productTitle === attachToProductTitle)
    );
  });

  const liveResult = parent?._catalog_apply && typeof parent._catalog_apply === "object"
    ? (parent._catalog_apply as LooseRecord).live_result as LooseRecord | undefined
    : undefined;
  const resolvedProductId = typeof liveResult?.productId === "string" ? liveResult.productId.trim() : "";
  const resolvedHandle = typeof liveResult?.handle === "string" ? liveResult.handle.trim() : attachToProductHandle;
  if (!resolvedProductId) {
    throw new Error("Variant attach target has not been applied live yet. Publish the parent product first so the child variant can resolve a Shopify product ID.");
  }

  return {
    ...payload,
    attachToProductId: resolvedProductId,
    attachToProductHandle: resolvedHandle || attachToProductHandle
  };
}

function isInteractive(flags: Flags): boolean {
  return !flags["no-wizard"] && !flags.json && Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function supportsColor(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function colorize(text: string, code: string): string {
  return supportsColor() ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function bold(text: string): string {
  return colorize(text, "1");
}

function dim(text: string): string {
  return colorize(text, "2");
}

function green(text: string): string {
  return colorize(text, "32");
}

function yellow(text: string): string {
  return colorize(text, "33");
}

function red(text: string): string {
  return colorize(text, "31");
}

function cyan(text: string): string {
  return colorize(text, "36");
}

function section(title: string): string {
  return `${bold(title)}\n${dim("=".repeat(title.length))}`;
}

function formatStatus(status: string, needsReview = false): string {
  const normalized = status.toUpperCase();
  if (needsReview || normalized === "NEEDS_REVIEW") return yellow(status);
  if (normalized === "SUCCESS" || normalized === "PASSED") return green(status);
  if (normalized === "FAIL" || normalized === "FAILED") return red(status);
  return bold(status);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value.length > 140 ? `${value.slice(0, 137)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `${value.length} item(s)`;
  return JSON.stringify(value);
}

function getSuggestedCommandsForModule(executed: ExecutedModule): string[] {
  const { job_id, result } = executed;
  if (result.needs_review) {
    return [
      `catalog review ${job_id}`,
      "catalog review queue"
    ];
  }

  switch (result.module) {
    case "catalogue-expert":
      return [
        "catalog guide show",
        "catalog workflow run --input <file> [--catalog <file>]"
      ];
    case "catalogue-match":
      return ["catalog enrich --input <file>"];
    case "product-enricher":
      return ["catalog image --input <file>", "catalog qa --input <file>"];
    case "image-optimizer":
      return ["catalog qa --input <file>"];
    case "catalogue-qa":
      return ["catalog sync --input <file>", "catalog workflow run --input <file> [--catalog <file>]"];
    case "shopify-sync":
      return ["catalog apply " + job_id, "catalog publish", "catalog apply " + job_id + " --live"];
    case "feedback-learn":
      return ["catalog guide show"];
    default:
      return [];
  }
}

function renderModuleResult(executed: ExecutedModule): string {
  const { job_id, run_dir, result } = executed;
  const lines = [
    section("Run Summary"),
    `Job: ${bold(job_id)}`,
    `Module: ${cyan(result.module)}`,
    `Status: ${formatStatus(result.status, result.needs_review)}`,
    `Needs review: ${result.needs_review ? yellow("yes") : green("no")}`,
    `Run dir: ${run_dir}`,
    ""
  ];

  if ("decision" in result) {
    const decisionResult = result as unknown as LooseRecord;
    lines.push(`Decision: ${bold(String(decisionResult.decision))}`);
    if ("confidence" in result) lines.push(`Confidence: ${String(decisionResult.confidence)}`);
    lines.push("");
  }

  lines.push(section("Proposed Changes"));
  const changes = Object.entries(result.proposed_changes ?? {});
  if (changes.length === 0) lines.push("- none");
  else changes.forEach(([key, value]) => lines.push(`- ${key}: ${formatValue(value)}`));

  if (result.reasoning.length > 0) {
    lines.push("", section("Reasoning"));
    result.reasoning.forEach((item) => lines.push(`- ${item}`));
  }

  if (result.warnings.length > 0) {
    lines.push("", section("Warnings"));
    result.warnings.forEach((item) => lines.push(`- ${item}`));
  }

  const suggestedCommands = getSuggestedCommandsForModule(executed);
  if (suggestedCommands.length > 0) {
    lines.push("", section("Try Next"));
    suggestedCommands.forEach((item) => lines.push(`- ${item}`));
  }

  if (result.next_actions.length > 0) {
    lines.push("", section("Workflow Guidance"));
    result.next_actions.forEach((item) => lines.push(`- ${item}`));
  }

  return `${lines.join("\n")}\n`;
}

function renderDoctor(payload: { credentials: Array<{ alias: string; source: string; ready: boolean }>; module_checks: Array<{ module: string; ready: boolean; slots: Array<{ slot: string; provider_alias: string; provider_type: string | null; ready: boolean; source: string; store?: string }> }> }): string {
  const lines = [section("Credentials")];
  payload.credentials.forEach((credential) => {
    lines.push(`- ${credential.alias}: ${credential.ready ? green(`ready via ${credential.source}`) : red("missing")}`);
  });
  lines.push("", section("Module Readiness"));
  payload.module_checks.forEach((moduleCheck) => {
    lines.push(`- ${moduleCheck.module}: ${moduleCheck.ready ? green("ready") : yellow("not ready")}`);
    moduleCheck.slots.forEach((slot) => {
      const storeSuffix = slot.store ? ` (${slot.store})` : "";
      lines.push(`  ${slot.slot} -> ${slot.provider_alias} [${slot.provider_type ?? "unknown"}]: ${slot.ready ? green(`ready via ${slot.source}`) : red("missing")}${storeSuffix}`);
    });
  });
  lines.push("", section("Try Next"));
  lines.push("- catalog guide generate --industry <industry> --business-name \"Store\" --business-description \"...\"");
  lines.push("- catalog workflow run --input <file> [--catalog <file>]");
  lines.push("- catalog auth test --provider shopify");
  return `${lines.join("\n")}\n`;
}

function renderDecision(decision: ReviewDecision): string {
  return [
    section("Review Saved"),
    `Run: ${bold(decision.job_id)}`,
    `Action: ${bold(decision.action)}`,
    `Notes: ${decision.notes || "none"}`,
    `Edits: ${Object.keys(decision.edits ?? {}).length} field(s)`,
    "",
    section("Try Next"),
    `- catalog apply ${decision.job_id}`,
    `- catalog review queue`
  ].join("\n") + "\n";
}

function renderApplyResult(result: ApplyResult): string {
  const lines = [section("Apply Result"), `Run: ${bold(result.job_id)}`, `Module: ${cyan(result.module)}`, `Status: ${formatStatus(result.status)}`];
  if (result.live_result) lines.push(`Live result: ${formatValue(result.live_result)}`);
  else lines.push(`Applied fields: ${Object.keys(result.applied_changes ?? {}).length}`);
  lines.push("", section("Try Next"));
  lines.push("- catalog publish");
  lines.push("- catalog review queue");
  return `${lines.join("\n")}\n`;
}

function renderReviewQueue(payload: { count: number; items: Array<{ product_key: string; module: string; job_id: string; status: string }> }): string {
  const lines = [section("Review Queue"), `${payload.count} item(s)`];
  payload.items.forEach((item) => {
    lines.push(`- ${item.product_key}: ${item.module} -> ${item.job_id} (${formatStatus(item.status, item.status === "needs_review")})`);
  });
  if (payload.count > 0) {
    lines.push("", section("Try Next"));
    lines.push("- catalog review <job-id>");
    lines.push("- catalog review bulk --action approve --all");
  }
  return `${lines.join("\n")}\n`;
}

function renderBulkReviewResult(payload: { action: string; count: number; jobs: string[] }): string {
  const lines = [section("Bulk Review"), `Action: ${bold(payload.action)}`, `Updated: ${payload.count} run(s)`];
  payload.jobs.forEach((jobId) => lines.push(`- ${jobId}`));
  lines.push("", section("Try Next"));
  lines.push("- catalog publish");
  return `${lines.join("\n")}\n`;
}

function renderBatchSummary(summary: { operation: string; input: string; total: number; processed: number; runs: Array<{ index: number; job_id: string; status: string; needs_review: boolean }> }): string {
  const lines = [section("Batch Summary"), `Operation: ${cyan(summary.operation)}`, `Input: ${summary.input}`, `Processed: ${summary.processed}/${summary.total}`, "", section("Runs")];
  summary.runs.forEach((run) => {
    lines.push(`- #${run.index + 1}: ${run.job_id} -> ${formatStatus(run.status, run.needs_review)}${run.needs_review ? " (needs review)" : ""}`);
  });
  lines.push("", section("Try Next"));
  lines.push("- catalog review queue");
  return `${lines.join("\n")}\n`;
}

function renderWorkflowSummary(summary: { input: string; total: number; processed: number; runs: WorkflowRunSummary[]; review_queue_csv?: string; shopify_import_csv?: string; excel_workbook?: string }): string {
  const reviewCount = summary.runs.flatMap((run) => run.modules).filter((module) => module.needs_review).length;
  const lines = [
    section("Workflow Complete"),
    `Input: ${summary.input}`,
    `Processed: ${summary.processed}/${summary.total}`,
    `Review items: ${reviewCount}`,
    "",
    section("Products")
  ];

  summary.runs.forEach((run) => {
    lines.push(`- ${run.product_key} (${run.source_record_id})`);
    lines.push(`  Product output: ${run.generated_product_path}`);
    lines.push(`  Image output: ${run.generated_image_dir}`);
    run.modules.forEach((module) => {
      lines.push(`  ${module.module} -> ${module.job_id} (${formatStatus(module.status, module.needs_review)}${module.needs_review ? ", needs review" : ""})`);
    });
  });

  if (summary.review_queue_csv || summary.shopify_import_csv || summary.excel_workbook) {
    lines.push("", section("Generated Files"));
    if (summary.review_queue_csv) lines.push(`Review queue CSV: ${summary.review_queue_csv}`);
    if (summary.shopify_import_csv) lines.push(`Shopify import CSV: ${summary.shopify_import_csv}`);
    if (summary.excel_workbook) lines.push(`Excel workbook: ${summary.excel_workbook}`);
  }

  lines.push("", section("Try Next"));
  if (reviewCount > 0) {
    lines.push("- catalog review queue");
    lines.push("- catalog review <job-id>");
  } else {
    lines.push("- catalog publish");
    lines.push("- catalog publish --live");
  }
  return `${lines.join("\n")}\n`;
}

function renderPublishSummary(payload: { live: boolean; published: number; skipped: Array<{ job_id: string; reason: string }>; jobs: string[] }): string {
  const lines = [
    section(payload.live ? "Live Publish Complete" : "Local Publish Complete"),
    `Published: ${payload.published}`
  ];
  if (payload.jobs.length > 0) {
    lines.push("", section("Published Jobs"));
    payload.jobs.forEach((jobId) => lines.push(`- ${jobId}`));
  }
  if (payload.skipped.length > 0) {
    lines.push("", section("Skipped"));
    payload.skipped.forEach((item) => lines.push(`- ${item.job_id}: ${item.reason}`));
  }
  lines.push("", section("Try Next"));
  lines.push("- catalog review queue");
  lines.push("- catalog publish --live");
  return `${lines.join("\n")}\n`;
}

function renderConfigSet(pathExpression: string, value: unknown): string {
  return `${section("Config Updated")}\n${pathExpression} = ${formatValue(value)}\n`;
}

function renderConfigGet(pathExpression: string, value: unknown): string {
  return `${section("Config Value")}\n${pathExpression}: ${formatValue(value)}\n`;
}

function renderCredentialList(credentials: Array<{ alias: string; source: string; ready: boolean }>): string {
  const lines = [section("Credentials")];
  credentials.forEach((credential) => {
    lines.push(`- ${credential.alias}: ${credential.ready ? green(`ready via ${credential.source}`) : red("missing")}`);
  });
  return `${lines.join("\n")}\n`;
}

function renderAuthTest(result: LooseRecord): string {
  const lines = [section("Auth Test"), `Provider: ${String(result.alias ?? "unknown")}`, `Status: ${result.ok ? green("ready") : red("not ready")}`];
  if (result.message) lines.push(`Message: ${String(result.message)}`);
  if (result.shop) lines.push(`Shop: ${formatValue(result.shop)}`);
  lines.push("", section("Try Next"));
  lines.push("- catalog doctor");
  return `${lines.join("\n")}\n`;
}

function writeOutput(stdout: OutputWriter, mode: OutputMode, payload: unknown, text: string): void {
  stdout.write(mode === "json" ? `${JSON.stringify(payload, null, 2)}\n` : text);
}

async function loadInputFile(filePath: string): Promise<LooseRecord> {
  return JSON.parse(await readText(filePath, "")) as LooseRecord;
}

async function loadRecordsFromFlags(root: string, flags: Flags, message = "Use --input <file> or --text \"...\"."): Promise<{ records: LooseRecord[]; sourceLabel: string }> {
  const textValue = typeof flags.text === "string" ? String(flags.text) : "";
  if (textValue.trim()) {
    return {
      records: loadRecordsFromText(textValue),
      sourceLabel: "--text"
    };
  }

  const inputPath = requireFlag(flags, "input", message);
  return {
    records: await loadRecordsFromSource(path.resolve(root, inputPath)),
    sourceLabel: inputPath
  };
}

async function loadSingleRecordFromFlags(root: string, flags: Flags, message = "Use --input <file> or --text \"...\"."): Promise<{ record: ProductRecord; sourceLabel: string }> {
  const { records, sourceLabel } = await loadRecordsFromFlags(root, flags, message);
  if (records.length === 0) {
    throw new Error("No product records were found in the provided input.");
  }
  if (records.length > 1) {
    throw new Error("This command accepts a single product. Use `catalog batch ...` or `catalog workflow run ...` for multiple records.");
  }
  return { record: records[0] as ProductRecord, sourceLabel };
}

async function getPolicyOrThrow(root: string): Promise<PolicyDocument> {
  await initWorkspace(root);
  const policy = await readJson<PolicyDocument | null>(getCatalogPaths(root).policyJson, null);
  if (!policy) throw new Error("No Catalog Guide found. Run `catalog guide generate` or `catalog expert generate` first.");
  return policy;
}

async function askText(rl: readline.Interface, prompt: string, defaultValue = ""): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askChoice(rl: readline.Interface, prompt: string, options: string[], defaultValue: string): Promise<string> {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return askArrowChoice(prompt, options, defaultValue);
  }
  const lines = [prompt];
  options.forEach((option, index) => {
    const isDefault = option === defaultValue ? " (default)" : "";
    lines.push(`  ${index + 1}. ${option}${isDefault}`);
  });
  const answer = (await rl.question(`${lines.join("\n")}\nChoose an option: `)).trim();
  if (!answer) return defaultValue;
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return options[index - 1];
  }
  return options.includes(answer) ? answer : defaultValue;
}

async function askArrowChoice(prompt: string, options: string[], defaultValue: string): Promise<string> {
  const startIndex = Math.max(0, options.indexOf(defaultValue));
  let selectedIndex = startIndex >= 0 ? startIndex : 0;
  const input = process.stdin;
  const output = process.stdout;
  const linesInBlock = options.length + 4;
  const linesUpToTop = Math.max(0, linesInBlock - 1);
  let renderedOnce = false;

  emitKeypressEvents(input);
  const wasRaw = Boolean((input as typeof input & { isRaw?: boolean }).isRaw);
  if (typeof input.setRawMode === "function" && !wasRaw) {
    input.setRawMode(true);
  }

  const render = () => {
    if (!renderedOnce) {
      output.write("\n");
      renderedOnce = true;
    } else {
      output.write(`\x1b[${linesUpToTop}F`);
    }

    const lines = [
      `? ${prompt}`,
      "",
      ...options.map((option, index) => {
        const marker = index === selectedIndex ? ">" : " ";
        const label = option === defaultValue ? `${option} (default)` : option;
        return ` ${marker} ${label}`;
      }),
      "",
      "Use Up/Down and Enter to choose."
    ];

    for (let index = 0; index < lines.length; index += 1) {
      output.write("\x1b[2K\r");
      output.write(lines[index]);
      if (index < lines.length - 1) output.write("\n");
    }
  };

  const clearBlock = () => {
    if (!renderedOnce) return;
    output.write(`\x1b[${linesUpToTop}F`);
    for (let index = 0; index < linesInBlock; index += 1) {
      output.write("\x1b[2K\r");
      if (index < linesInBlock - 1) output.write("\n");
    }
    output.write(`\x1b[${linesUpToTop}F`);
  };

  render();

  return await new Promise<string>((resolve, reject) => {
    const onKeypress = (_: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Interactive setup cancelled."));
        return;
      }

      if (key.name === "up") {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        render();
        return;
      }

      if (key.name === "down") {
        selectedIndex = (selectedIndex + 1) % options.length;
        render();
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        const selected = options[selectedIndex];
        cleanup();
        clearBlock();
        output.write(`? ${prompt}: ${selected}\n`);
        resolve(selected);
      }
    };

    const cleanup = () => {
      input.off("keypress", onKeypress);
      if (typeof input.setRawMode === "function" && !wasRaw) {
        input.setRawMode(false);
      }
    };

    input.on("keypress", onKeypress);
  });
}

async function askYesNo(rl: readline.Interface, prompt: string, defaultValue = true): Promise<boolean> {
  const suffix = defaultValue ? " [Y/n]" : " [y/N]";
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return ["y", "yes"].includes(answer);
}

function getLlmProviderAlias(providerName: string): string {
  return LLM_PROVIDER_ALIAS_BY_NAME[providerName] ?? `${providerName}_default`;
}

function getDefaultModelForProvider(providerName: string): string {
  return LLM_PROVIDER_DEFAULT_MODELS[providerName] ?? "";
}

async function askProviderModel(rl: readline.Interface, providerName: string, currentModel = ""): Promise<string> {
  const defaultModel = currentModel || getDefaultModelForProvider(providerName);
  const options = [...new Set([...(LLM_PROVIDER_MODEL_CHOICES[providerName] ?? []), defaultModel, "custom"].filter(Boolean))];
  const selected = await askChoice(rl, `Model for ${providerName}`, options, options.includes(defaultModel) ? defaultModel : options[0]);
  if (selected === "custom") {
    return askText(rl, `Custom model for ${providerName}`, defaultModel);
  }
  return selected;
}

function applyProviderModelToRuntime(runtime: RuntimeConfig, providerName: string, model: string): void {
  const alias = getLlmProviderAlias(providerName);
  if (!runtime.providers[alias]) return;
  runtime.providers[alias].model = model;
}

async function maybePromptCredential(rl: readline.Interface, alias: string, prompt: string): Promise<boolean> {
  const configureNow = await askYesNo(rl, `Configure ${alias} now?`, false);
  if (!configureNow) return false;
  const value = await askText(rl, prompt, "");
  if (value) await setCredential(alias, value);
  return Boolean(value);
}

async function configureLlmCredential(rl: readline.Interface, providerName: string, stdout: OutputWriter): Promise<boolean> {
  if (providerName === "openai") {
    const connectionMode = await askChoice(rl, "Connection mode for openai", ["api", "auth"], "api");
    if (connectionMode === "auth") {
      const session = await loadOpenAICodexAuthSession();
      if (!session) {
        stdout.write("No reusable OpenAI API key was found in local Codex auth. Use API key mode or sign in through Codex CLI so an API key is created first.\n");
        return false;
      }
      await setOAuthCredential("openai", session);
      stdout.write(`Imported OpenAI auth from local Codex session${session.auth_mode ? ` (${session.auth_mode})` : ""}.\n`);
      return true;
    }
  }

  if (providerName === "gemini") {
    const connectionMode = await askChoice(rl, "Connection mode for gemini", ["api", "auth"], "api");
    if (connectionMode === "auth") {
      const clientId = await askText(rl, "Google OAuth client ID", "");
      const clientSecret = await askText(rl, "Google OAuth client secret", "");
      const projectId = await askText(rl, "Google Cloud project ID", "");
      if (clientId && clientSecret && projectId) {
        stdout.write("Starting Google OAuth in your browser...\n");
        const session = await authenticateGeminiViaOAuth({
          clientId,
          clientSecret,
          projectId
        });
        await setOAuthCredential("gemini", session);
        return true;
      }
      return false;
    }
  }

  if (providerName === "anthropic") {
    stdout.write("Anthropic currently uses API key authentication in this toolkit.\n");
  }

  const value = await askText(rl, `${providerName[0].toUpperCase()}${providerName.slice(1)} API key`, "");
  if (value) {
    await setCredential(providerName, value);
    return true;
  }
  return false;
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

function normalizeIdentityValue(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getExportIdentity(record: LooseRecord | null | undefined): string {
  if (!record || typeof record !== "object") return "";
  const match = record._catalog_match;
  if (match && typeof match === "object") {
    const decision = String((match as LooseRecord).decision ?? "").toUpperCase();
    const action = (match as LooseRecord).proposed_action;
    if (decision === "NEW_VARIANT" && action && typeof action === "object") {
      const actionRecord = action as LooseRecord;
      const productId = String(actionRecord.product_id ?? (match as LooseRecord).matched_product_id ?? "").trim();
      const optionValues = Array.isArray(actionRecord.option_values)
        ? actionRecord.option_values
            .filter((item): item is LooseRecord => Boolean(item) && typeof item === "object")
            .map((item) => `${String(item.name ?? "").trim().toLowerCase()}:${normalizeIdentityValue(String(item.value ?? ""))}`)
            .filter(Boolean)
            .join("|")
        : "";
      if (productId && optionValues) return `variant:${productId}:${optionValues}`;
    }
  }
  const handle = typeof record.handle === "string" ? normalizeIdentityValue(record.handle) : "";
  if (handle) return `handle:${handle}`;
  const vendor = typeof record.vendor === "string" ? record.vendor : typeof record.brand === "string" ? record.brand : "";
  const title = typeof record.title === "string" ? record.title : "";
  const combined = normalizeIdentityValue(`${vendor} ${title}`);
  return combined ? `title:${combined}` : "";
}

function getMatchDecision(record: LooseRecord | null | undefined): string {
  const match = record?._catalog_match;
  if (!match || typeof match !== "object") return "";
  const decision = (match as LooseRecord).decision;
  return typeof decision === "string" ? decision.toUpperCase() : "";
}

function getMatchNeedsReview(record: LooseRecord | null | undefined): boolean {
  const match = record?._catalog_match;
  if (!match || typeof match !== "object") return false;
  return Boolean((match as LooseRecord).needs_review);
}

function getMatchBlockReason(record: LooseRecord | null | undefined): string | null {
  const decision = getMatchDecision(record);
  if (decision === "DUPLICATE") return "catalogue-match marked this product as DUPLICATE";
  if (getMatchNeedsReview(record)) return "catalogue-match still needs review";
  return null;
}

export function shouldSkipAfterMatch(record: ProductRecord): boolean {
  const decision = getMatchDecision(record as LooseRecord);
  if (decision === "DUPLICATE") return true;
  return getMatchNeedsReview(record as LooseRecord);
}

function getRepresentativeRank(record: LooseRecord | null | undefined): number {
  const decision = getMatchDecision(record);
  if (decision === "NEW_PRODUCT") return 0;
  if (decision === "NEW_VARIANT") return 1;
  if (!decision) return 2;
  if (decision === "NEEDS_REVIEW") return 3;
  if (decision === "DUPLICATE") return 4;
  return 5;
}

function getRepresentativeConfidence(record: LooseRecord | null | undefined): number {
  const match = record?._catalog_match;
  if (!match || typeof match !== "object") return 0;
  return Number((match as LooseRecord).confidence ?? 0);
}

function getRepresentativeQaScore(record: LooseRecord | null | undefined): number {
  return Number(record?.qa_score ?? 0);
}

function getReviewAction(run: RunData): string {
  const decision = run.decision as LooseRecord | null;
  return typeof decision?.action === "string" ? decision.action : "";
}

function isApprovedReviewAction(action: string): boolean {
  return action === "approve" || action === "approve_with_edits";
}

function selectRepresentativeProducts(products: LooseRecord[]): { selected: LooseRecord[]; shadowedKeys: Set<string> } {
  const selectedByIdentity = new Map<string, LooseRecord>();
  const shadowedKeys = new Set<string>();

  for (const product of products) {
    const identity = getExportIdentity(product);
    if (!identity) {
      selectedByIdentity.set(`unique:${getProductKey(product, "product")}`, product);
      continue;
    }

    const existing = selectedByIdentity.get(identity);
    if (!existing) {
      selectedByIdentity.set(identity, product);
      continue;
    }

    const currentRank = getRepresentativeRank(product);
    const existingRank = getRepresentativeRank(existing);
    const currentConfidence = getRepresentativeConfidence(product);
    const existingConfidence = getRepresentativeConfidence(existing);
    const currentQa = getRepresentativeQaScore(product);
    const existingQa = getRepresentativeQaScore(existing);

    const shouldReplace =
      currentRank < existingRank
      || (currentRank === existingRank && currentQa > existingQa)
      || (currentRank === existingRank && currentQa === existingQa && currentConfidence > existingConfidence);

    if (shouldReplace) {
      shadowedKeys.add(getProductKey(existing, "product"));
      selectedByIdentity.set(identity, product);
    } else {
      shadowedKeys.add(getProductKey(product, "product"));
    }
  }

  return { selected: [...selectedByIdentity.values()], shadowedKeys };
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
      if (!flags.all && isApprovedReviewAction(getReviewAction(item.run))) return false;
      if (!flags.all && !item.run.result.needs_review) return false;
      return true;
    });
}

async function loadGeneratedProductCatalog(root: string): Promise<LooseRecord[]> {
  const generatedDir = getCatalogPaths(root).generatedProductsDir;
  const entries = await fs.readdir(generatedDir, { withFileTypes: true }).catch(() => []);
  const productFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => path.join(generatedDir, entry.name));
  return Promise.all(productFiles.map((filePath) => readJson<LooseRecord>(filePath, {})));
}

async function loadPublishableSyncRuns(root: string): Promise<Array<{ run: RunData; product_key: string }>> {
  const policy = await getPolicyOrThrow(root);
  const passingScore = getGuidePassingScore(policy);
  const runIds = await listRunIds(root);
  const loaded = await Promise.all(runIds.map(async (jobId) => ({ run: await loadRun(root, jobId), product_key: "" })));
  const latestByProduct = new Map<string, { run: RunData; product_key: string }>();

  for (const item of loaded) {
    if (!item.run.result || item.run.result.module !== "shopify-sync") continue;
    const productKey = deriveProductKeyFromRun(item.run);
    latestByProduct.set(productKey, { ...item, product_key: productKey });
  }

  return [...latestByProduct.values()].filter((item) => {
    const result = item.run.result;
    const input = item.run.input as LooseRecord | null;
    const apply = item.run.apply as LooseRecord | null;
    if (!result || result.module !== "shopify-sync") return false;
    if (apply?.status === "applied_live") return false;
    if (result.needs_review) return false;
    if (!input || typeof input !== "object") return false;
    const qaStatus = typeof input.qa_status === "string" ? input.qa_status.toUpperCase() : "";
    const qaScore = Number(input.qa_score ?? 0);
    return qaStatus === "PASS" && qaScore >= passingScore;
  });
}

async function loadLatestSyncRuns(root: string): Promise<Array<{ run: RunData; product_key: string }>> {
  const runIds = await listRunIds(root);
  const loaded = await Promise.all(runIds.map(async (jobId) => ({ run: await loadRun(root, jobId), product_key: "" })));
  const latestByProduct = new Map<string, { run: RunData; product_key: string }>();

  for (const item of loaded) {
    if (!item.run.result || item.run.result.module !== "shopify-sync") continue;
    const productKey = deriveProductKeyFromRun(item.run);
    latestByProduct.set(productKey, { ...item, product_key: productKey });
  }

  return [...latestByProduct.values()];
}

function buildPendingReviewRows(root: string, items: Array<{ run: RunData; product_key: string }>): Array<Record<string, string>> {
  return items.map((item) => {
    const result = item.run.result;
    const generatedProductPath = path.join(getCatalogPaths(root).generatedProductsDir, `${item.product_key}.json`);
    return {
      "Product Key": item.product_key,
      "Module": String(result?.module ?? "unknown"),
      "Job ID": String(result?.job_id ?? ""),
      "Status": String(result?.status ?? ""),
      "Generated Product Path": generatedProductPath,
      "Suggested Command": result?.job_id ? `catalog review ${result.job_id}` : "",
      "Notes": result?.needs_review ? "Pending approval" : ""
    };
  });
}

function buildWorkflowSummariesFromSyncRuns(
  root: string,
  items: Array<{ run: RunData; product_key: string }>
): WorkflowRunSummary[] {
  return items.map((item, index) => {
    const input = item.run.input as LooseRecord | null;
    const productKey = item.product_key;
    const generatedImageDir = path.join(getCatalogPaths(root).generatedImagesDir, productKey);
    const generatedProductPath = path.join(getCatalogPaths(root).generatedProductsDir, `${productKey}.json`);
    const featuredImage = typeof input?.featured_image === "string" ? input.featured_image : undefined;
    const localImagePath = path.join(generatedImageDir, "selected.jpg");
    return {
      index,
      product_key: productKey,
      source_record_id: typeof input?.id === "string" ? input.id : productKey,
      generated_product_path: generatedProductPath,
      generated_image_dir: generatedImageDir,
      selected_image_url: featuredImage,
      local_image_path: featuredImage ? localImagePath : undefined,
      modules: item.run.result ? [{
        module: item.run.result.module,
        job_id: item.run.result.job_id,
        status: item.run.result.status,
        needs_review: item.run.result.needs_review
      }] : []
    };
  });
}

function buildApprovedProductProjection(product: LooseRecord, run: RunData): LooseRecord {
  const decision = run.decision as ReviewDecision | null;
  if (!decision || !isApprovedReviewAction(decision.action)) return product;
  return {
    ...product,
    ...(decision.edits ?? {})
  };
}

async function refreshWorkspaceExportsFromState(root: string, policy: PolicyDocument): Promise<{ reviewQueueCsv: string; shopifyImportCsv: string; excelWorkbook: string; workflowProductsJson: string; workflowProducts: LooseRecord[]; exportableProducts: LooseRecord[] }> {
  const generatedProducts = await loadGeneratedProductCatalog(root);
  const pendingReviewRuns = await loadReviewableRuns(root, {});
  const latestSyncRuns = await loadLatestSyncRuns(root);
  const latestSyncByProductKey = new Map(latestSyncRuns.map((item) => [item.product_key, item]));
  const latestSyncByJobId = new Map(
    latestSyncRuns
      .filter((item) => item.run.result?.job_id)
      .map((item) => [String(item.run.result?.job_id), item])
  );
  const { selected: representativeProducts } = selectRepresentativeProducts(generatedProducts);
  const workflowProducts = representativeProducts
    .filter((product) => !getMatchBlockReason(product))
    .map((product) => {
      const lastJobId = typeof (product._catalog as LooseRecord | undefined)?.last_job_id === "string"
        ? String((product._catalog as LooseRecord).last_job_id)
        : "";
      const syncRun = (lastJobId ? latestSyncByJobId.get(lastJobId) : undefined)
        ?? latestSyncByProductKey.get(getProductKey(product, "product"));
      return syncRun ? buildApprovedProductProjection(product, syncRun.run) : product;
    });

  const exportableProducts = workflowProducts
    .flatMap((product) => {
      const lastJobId = typeof (product._catalog as LooseRecord | undefined)?.last_job_id === "string"
        ? String((product._catalog as LooseRecord).last_job_id)
        : "";
      const syncRun = (lastJobId ? latestSyncByJobId.get(lastJobId) : undefined)
        ?? latestSyncByProductKey.get(getProductKey(product, "product"));
      if (!syncRun?.run.result || syncRun.run.result.module !== "shopify-sync") return [];
      if (syncRun.run.result.needs_review && !isApprovedReviewAction(getReviewAction(syncRun.run))) return [];
      return [product];
    });

  const pendingReviewRows = buildPendingReviewRows(root, pendingReviewRuns);
  const reviewQueueCsv = await writePendingReviewQueueCsv(root, pendingReviewRows);
  const workflowProductsJson = await writeWorkflowProductsLedger(root, workflowProducts);
  const shopifyImportCsv = await writeShopifyImportCsv(root, exportableProducts, policy);
  const excelWorkbook = await writeExcelWorkbook(
    root,
    buildWorkflowSummariesFromSyncRuns(root, latestSyncRuns),
    generatedProducts,
    exportableProducts,
    policy,
    pendingReviewRows
  );
  return { reviewQueueCsv, shopifyImportCsv, excelWorkbook, workflowProductsJson, workflowProducts, exportableProducts };
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

async function runWorkflowSequence(
  root: string,
  record: ProductRecord,
  flags: Flags,
  stdout?: OutputWriter,
  mode: OutputMode = "text",
  sequenceIndex?: number,
  total?: number,
  workflowCatalog?: LooseRecord[],
  workflowCatalogSource?: string
): Promise<WorkflowRunSummary> {
  const policy = await getPolicyOrThrow(root);
  const runtimeConfig = await loadRuntimeConfig(root);
  const paths = getCatalogPaths(root);
  const learningText = await readText(paths.learningMarkdown, "");
  const sourceRecordId = String(record.id ?? record.product_id ?? record.sku ?? record.handle ?? record.title ?? "record");
  let currentRecord: ProductRecord = {
    ...record,
    _catalog_match_basis: {
      title: record.title ?? "",
      brand: record.brand ?? record.vendor ?? "",
      vendor: record.vendor ?? record.brand ?? "",
      handle: record.handle ?? "",
      sku: record.sku ?? "",
      barcode: record.barcode ?? "",
      size: record.size ?? record.option1 ?? "",
      type: record.type ?? record.option2 ?? "",
      option1: record.option1 ?? "",
      option2: record.option2 ?? "",
      option3: record.option3 ?? ""
    }
  };
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

  let catalogData: LooseRecord[] | undefined = workflowCatalog;
  let catalogSource = workflowCatalogSource ?? "";
  if (!catalogData) {
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
    const matchResult = executed.result as unknown as LooseRecord;
    currentRecord = {
      ...currentRecord,
      _catalog_match: {
        decision: matchResult.decision ?? null,
        confidence: matchResult.confidence ?? null,
        needs_review: executed.result.needs_review,
        matched_product_id: matchResult.matched_product_id ?? null,
        matched_variant_id: matchResult.matched_variant_id ?? null,
        proposed_action: matchResult.proposed_action ?? null,
        matched_product_handle: typeof (matchResult.proposed_action as LooseRecord | undefined)?.product_handle === "string"
          ? (matchResult.proposed_action as LooseRecord).product_handle
          : null,
        matched_product_title: typeof (matchResult.proposed_action as LooseRecord | undefined)?.product_title === "string"
          ? (matchResult.proposed_action as LooseRecord).product_title
          : null
      }
    };
    modules.push({ module: executed.result.module, job_id: executed.job_id, status: executed.result.status, needs_review: executed.result.needs_review });

    if (shouldSkipAfterMatch(currentRecord)) {
      const productPath = (await persistGeneratedOutputs(root, currentRecord, executed.result)).productPath;
      return {
        index: 0,
        product_key: getProductKey(currentRecord, sourceRecordId),
        source_record_id: sourceRecordId,
        generated_product_path: productPath,
        generated_image_dir: imageDirectory,
        modules
      };
    }
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
  currentRecord = buildGeneratedProduct(currentRecord, qaRun.result) as ProductRecord;
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

async function refreshWorkflowGeneratedOutputs(
  root: string,
  runs: WorkflowRunSummary[],
  generatedProducts: LooseRecord[],
  policy?: PolicyDocument
): Promise<{ reviewQueueCsv: string; shopifyImportCsv: string; excelWorkbook: string; workflowProductsJson: string; workflowProducts: LooseRecord[]; exportableProducts: LooseRecord[] }> {
  const pendingReviewRuns = await loadReviewableRuns(root, {});
  const pendingReviewRows = buildPendingReviewRows(root, pendingReviewRuns);
  const latestSyncRuns = await loadLatestSyncRuns(root);
  const latestSyncByProductKey = new Map(latestSyncRuns.map((item) => [item.product_key, item]));
  const latestSyncByJobId = new Map(
    latestSyncRuns
      .filter((item) => item.run.result?.job_id)
      .map((item) => [String(item.run.result?.job_id), item])
  );
  const { selected: representativeProducts } = selectRepresentativeProducts(generatedProducts);
  const workflowProducts = representativeProducts
    .filter((product) => !getMatchBlockReason(product))
    .map((product) => {
      const lastJobId = typeof (product._catalog as LooseRecord | undefined)?.last_job_id === "string"
        ? String((product._catalog as LooseRecord).last_job_id)
        : "";
      const syncRun = (lastJobId ? latestSyncByJobId.get(lastJobId) : undefined)
        ?? latestSyncByProductKey.get(getProductKey(product, "product"));
      return syncRun ? buildApprovedProductProjection(product, syncRun.run) : product;
    });
  const exportableProducts = workflowProducts
    .flatMap((product) => {
      const lastJobId = typeof (product._catalog as LooseRecord | undefined)?.last_job_id === "string"
        ? String((product._catalog as LooseRecord).last_job_id)
        : "";
      const syncRun = (lastJobId ? latestSyncByJobId.get(lastJobId) : undefined)
        ?? latestSyncByProductKey.get(getProductKey(product, "product"));
      if (!syncRun?.run.result || syncRun.run.result.module !== "shopify-sync") return [];
      if (syncRun.run.result.needs_review && !isApprovedReviewAction(getReviewAction(syncRun.run))) return [];
      return [product];
    });
  const reviewQueueCsv = await writeReviewQueueCsv(root, runs);
  const workflowProductsJson = await writeWorkflowProductsLedger(root, workflowProducts);
  const shopifyImportCsv = await writeShopifyImportCsv(root, exportableProducts, policy);
  const excelWorkbook = await writeExcelWorkbook(root, runs, generatedProducts, exportableProducts, policy, pendingReviewRows);
  return { reviewQueueCsv, shopifyImportCsv, excelWorkbook, workflowProductsJson, workflowProducts, exportableProducts };
}

async function runInitWizard(root: string, stdout: OutputWriter): Promise<void> {
  const rl = readline.createInterface({ input: rlInput, output: rlOutput });
  try {
    const shouldRun = await askYesNo(rl, "Run guided setup now?", true);
    if (!shouldRun) return;

    const businessName = await askText(rl, "Business name", "Demo Store");
    const businessDescription = await askText(rl, "Short business description", "A Shopify business selling curated products");
    const selectedIndustry = await askChoice(rl, "Industry", [...INDUSTRY_OPTIONS], "food_and_beverage");
    const industry = selectedIndustry === "other"
      ? await askText(rl, "Custom industry", "generic")
      : selectedIndustry;
    const operatingMode = await askChoice(rl, "Operating mode", ["local_files", "shopify", "both"], "both");
    let guideJobId = "";

    const configureProviders = await askYesNo(rl, "Configure providers now?", true);
    const configured: string[] = [];
    let storeUrl = "";
    if (configureProviders) {
      const runtime = await loadRuntimeConfig(root);
      const primaryLlm = await askChoice(rl, "Primary LLM provider", ["openai", "gemini", "anthropic", "none"], "openai");
      const fallbackLlm = await askChoice(
        rl,
        "Fallback LLM provider",
        ["none", "openai", "gemini", "anthropic"].filter((option) => option === "none" || option !== primaryLlm),
        "gemini"
      );
      const selectedProviders = [...new Set([primaryLlm, fallbackLlm].filter((value) => value !== "none"))];
      const readiness: Record<string, boolean> = { openai: false, gemini: false, anthropic: false };

      for (const providerName of selectedProviders) {
        readiness[providerName] = await configureLlmCredential(rl, providerName, stdout);
        const configuredModel = await askProviderModel(
          rl,
          providerName,
          runtime.providers[getLlmProviderAlias(providerName)]?.model ?? getDefaultModelForProvider(providerName)
        );
        applyProviderModelToRuntime(runtime, providerName, configuredModel);
        configured.push(`${providerName}-model:${configuredModel}`);
        if (readiness[providerName]) configured.push(providerName);
      }

      stdout.write("Serper is currently required for image search.\n");
      const serperReady = await maybePromptCredential(rl, "serper", "Serper API key");
      if (serperReady) configured.push("serper");

      const shopifyNow = await askYesNo(rl, "Configure Shopify now?", false);
      let shopifyReady = false;
      if (shopifyNow) {
        const shopifyMode = await askChoice(rl, "Shopify connection mode", ["api", "oauth"], "api");
        const store = await askText(rl, "Shopify store domain", "");
        storeUrl = store;
        if (store) {
          runtime.providers.shopify_default.store = store;
          configured.push(`shopify-store:${store}`);
        }
        if (shopifyMode === "api") {
          const token = await askText(rl, "Shopify admin token", "");
          if (token) {
            await setCredential("shopify", token);
            configured.push("shopify-api");
            shopifyReady = true;
          }
        } else if (store) {
          const clientId = await askText(rl, "Shopify app client ID", "");
          const clientSecret = await askText(rl, "Shopify app client secret", "");
          if (clientId && clientSecret) {
            stdout.write("Starting Shopify OAuth in your browser...\n");
            const session = await authenticateShopifyViaOAuth({
              store,
              clientId,
              clientSecret,
              scopes: ["write_products", "read_products", "read_metafields", "write_metafields"]
            });
            await setOAuthCredential("shopify", session);
            runtime.providers.shopify_default.client_id = clientId;
            runtime.providers.shopify_default.scopes = session.scopes ?? session.scope?.split(",").map((item) => item.trim()).filter(Boolean) ?? runtime.providers.shopify_default.scopes;
            configured.push("shopify-oauth");
            shopifyReady = true;
          }
        }
      }

      const readyProviderAlias = (providerName: string): string => readiness[providerName] ? getLlmProviderAlias(providerName) : "";
      runtime.modules["catalogue-expert"].llm_provider = readyProviderAlias(primaryLlm) || readyProviderAlias(fallbackLlm);
      runtime.modules["catalogue-qa"].llm_provider = readyProviderAlias(primaryLlm) || readyProviderAlias(fallbackLlm);
      runtime.modules["catalogue-match"].reasoning_provider = readyProviderAlias(primaryLlm) || readyProviderAlias(fallbackLlm);
      runtime.modules["product-enricher"].llm_provider = readyProviderAlias(primaryLlm) || readyProviderAlias(fallbackLlm);
      runtime.modules["product-enricher"].fallback_llm_provider = readyProviderAlias(primaryLlm) && readyProviderAlias(fallbackLlm)
        ? readyProviderAlias(fallbackLlm)
        : "";
      if (!serperReady) runtime.modules["image-optimizer"].search_provider = "";
      runtime.modules["image-optimizer"].vision_provider = readiness.openai
        ? "openai_vision_default"
        : readiness.gemini
          ? "gemini_flash_default"
          : "";
      if (!(runtime.providers.shopify_default.store && shopifyReady)) {
        runtime.modules["catalogue-match"].catalog_provider = "";
        runtime.modules["shopify-sync"].shopify_provider = "";
      } else {
        runtime.modules["catalogue-match"].catalog_provider = "shopify_default";
        runtime.modules["shopify-sync"].shopify_provider = "shopify_default";
      }

      await saveRuntimeConfig(root, runtime);
    }

    const generateGuide = await askYesNo(rl, "Generate a Catalog Guide now?", true);
    if (generateGuide) {
      const executed = await executeModule(root, "catalogue-expert", { source: "init-wizard" }, async (jobId) => runExpertGenerate({
        root,
        jobId,
        input: {
          industry,
          businessName,
          businessDescription,
          operatingMode,
          storeUrl,
          notes: "Generated from init wizard"
        }
      }));
      guideJobId = executed.job_id;
    }

    const lines = ["Guided setup complete."];
    if (guideJobId) lines.push(`Catalog Guide generated in run: ${guideJobId}`);
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
      case "guide":
        return await handleGuide(root, subcommand, flags, stdout);
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
      case "publish":
        return await handlePublish(root, flags, stdout);
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
    if (mode === "text") {
      stdout.write("Starting setup wizard...\n");
    }
    await runInitWizard(root, stdout);
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
    const runtime = await loadRuntimeConfig(root);
    const requestedModel = typeof flags.model === "string" ? String(flags.model).trim() : "";
    if (requestedModel && LLM_PROVIDER_ALIAS_BY_NAME[String(alias)]) {
      applyProviderModelToRuntime(runtime, String(alias), requestedModel);
      await saveRuntimeConfig(root, runtime);
    }
    writeOutput(
      stdout,
      mode,
      { alias, stored: true, ...(requestedModel ? { model: requestedModel } : {}) },
      `Stored credential for ${alias}${requestedModel ? ` using model ${requestedModel}` : ""}\n`
    );
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

  if (subcommand === "login") {
    const alias = String(flags.provider ?? extraPositional[0] ?? "");
    const runtime = await loadRuntimeConfig(root);
    const requestedModel = typeof flags.model === "string" ? String(flags.model).trim() : "";

    if (alias === "shopify") {
      const store = String(flags.store ?? runtime.providers.shopify_default.store ?? "");
      const clientId = String(flags["client-id"] ?? runtime.providers.shopify_default.client_id ?? "");
      const clientSecret = String(flags["client-secret"] ?? "");
      if (!store || !clientId || !clientSecret) {
        throw new Error("Use `catalog auth login --provider shopify --store <shop> --client-id <id> --client-secret <secret>`.");
      }
      const session = await withSpinner("Authenticating Shopify", mode, () => authenticateShopifyViaOAuth({
        store,
        clientId,
        clientSecret,
        scopes: ["write_products", "read_products", "read_metafields", "write_metafields"]
      }));
      runtime.providers.shopify_default.store = session.store;
      runtime.providers.shopify_default.client_id = clientId;
      runtime.providers.shopify_default.scopes = session.scopes ?? session.scope?.split(",").map((item) => item.trim()).filter(Boolean) ?? runtime.providers.shopify_default.scopes;
      await saveRuntimeConfig(root, runtime);
      await setOAuthCredential("shopify", session);
      writeOutput(stdout, mode, { alias, ok: true, source: "oauth", store: session.store }, `Stored Shopify OAuth session for ${session.store}\n`);
      return 0;
    }

    if (alias === "openai") {
      const session = await loadOpenAICodexAuthSession();
      if (!session) {
        throw new Error("No reusable OpenAI API key was found in local Codex auth. Use `catalog auth set --provider openai --value <api-key>` or sign in through Codex CLI first so a local API key is available.");
      }
      await setOAuthCredential("openai", session);
      if (requestedModel) {
        applyProviderModelToRuntime(runtime, "openai", requestedModel);
        await saveRuntimeConfig(root, runtime);
      }
      writeOutput(
        stdout,
        mode,
        { alias, ok: true, source: "oauth", auth_mode: session.auth_mode ?? "codex", ...(requestedModel ? { model: requestedModel } : {}) },
        `Imported OpenAI auth from local Codex session${requestedModel ? ` using model ${requestedModel}` : ""}\n`
      );
      return 0;
    }

    if (alias === "gemini") {
      const clientId = String(flags["client-id"] ?? "");
      const clientSecret = String(flags["client-secret"] ?? "");
      const projectId = String(flags["project-id"] ?? "");
      if (!clientId || !clientSecret || !projectId) {
        throw new Error("Use `catalog auth login --provider gemini --client-id <id> --client-secret <secret> --project-id <project>`.");
      }
      const session = await withSpinner("Authenticating Gemini", mode, () => authenticateGeminiViaOAuth({
        clientId,
        clientSecret,
        projectId
      }));
      await setOAuthCredential("gemini", session);
      if (requestedModel) {
        applyProviderModelToRuntime(runtime, "gemini", requestedModel);
        await saveRuntimeConfig(root, runtime);
      }
      writeOutput(
        stdout,
        mode,
        { alias, ok: true, source: "oauth", project_id: projectId, ...(requestedModel ? { model: requestedModel } : {}) },
        `Stored Gemini OAuth session for project ${projectId}${requestedModel ? ` using model ${requestedModel}` : ""}\n`
      );
      return 0;
    }

    if (alias === "anthropic") {
      throw new Error("Anthropic interactive auth is not supported yet. Use `catalog auth set --provider anthropic --value <api-key> [--model <model>]`.");
    }

    throw new Error("Supported auth login providers: openai, shopify, gemini");
  }

  throw new Error("Supported auth commands: set, list, test, login");
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
  const executed = await withSpinner("Generating Catalog Guide", mode, () => executeModule(root, "catalogue-expert", {}, async (jobId) => runExpertGenerate({
    root,
    jobId,
    input: {
      industry: String(flags.industry ?? "food_and_beverage"),
      businessName: String(flags["business-name"] ?? "Demo Store"),
      businessDescription: String(flags["business-description"] ?? ""),
      targetMarket: String(flags["target-market"] ?? ""),
      operatingMode: String(flags["operating-mode"] ?? "both"),
      storeUrl: String(flags["store-url"] ?? ""),
      notes: String(flags.notes ?? ""),
      research: flags.research === "true" || flags.research === true
    }
  })));
  writeOutput(stdout, mode, executed, renderModuleResult(executed));
  return 0;
}

async function handleGuide(root: string, subcommand: string | undefined, flags: Flags, stdout: OutputWriter): Promise<number> {
  if (subcommand === "generate") {
    return handleExpert(root, "generate", flags, stdout);
  }

  if (subcommand === "show") {
    await initWorkspace(root);
    const mode = getOutputMode(flags);
    const paths = getCatalogPaths(root);
    const policy = await getPolicyOrThrow(root);
    const markdown = await readText(paths.policyMarkdown, "");
    const payload = {
      title: "Catalog Guide",
      business_name: policy.meta?.business_name ?? "",
      industry: policy.meta?.industry ?? "",
      operating_mode: policy.meta?.operating_mode ?? "",
      markdown
    };
    writeOutput(stdout, mode, payload, markdown || "Catalog Guide is empty.\n");
    return 0;
  }

  throw new Error("Use `catalog guide generate` or `catalog guide show`.");
}

async function handleIngest(root: string, flags: Flags, stdout: OutputWriter): Promise<number> {
  const inputPath = typeof flags.input === "string" ? String(flags.input) : typeof flags.text === "string" ? "--text" : requireFlag(flags, "input", "Use --input with a JSON, CSV, or TXT file, or use --text.");
  const executed = await executeModule(root, "catalogue-ingest", { source_path: inputPath }, async (jobId, runInput) => runIngest({
    jobId,
    input: typeof flags.text === "string"
      ? { source_path: "--text", source_text: String(flags.text) }
      : { source_path: String(runInput.source_path) }
  }));
  writeOutput(stdout, getOutputMode(flags), executed, renderModuleResult(executed));
  return 0;
}

async function handleInputModule(root: string, moduleName: string, flags: Flags, stdout: OutputWriter, moduleRunner: ModuleRunner): Promise<number> {
  const { record: inputData } = await loadSingleRecordFromFlags(root, flags, "Use --input with a JSON, CSV, or TXT file, or use --text.");
  const mode = getOutputMode(flags);
  const executed = await withSpinner(`Running ${moduleName}`, mode, () => executeModule(root, moduleName, inputData, async (jobId) => moduleRunner({ root, jobId, input: inputData })));
  await persistGeneratedOutputs(root, inputData, executed.result);
  writeOutput(stdout, mode, executed, renderModuleResult(executed));
  return 0;
}

async function handlePolicyModule(root: string, moduleName: string, flags: Flags, stdout: OutputWriter, moduleRunner: ModuleRunner): Promise<number> {
  const { record: inputData } = await loadSingleRecordFromFlags(root, flags, "Use --input with a JSON, CSV, or TXT file, or use --text.");
  const policy = await getPolicyOrThrow(root);
  const mode = getOutputMode(flags);
  const executed = await withSpinner(`Running ${moduleName}`, mode, () => executeModule(root, moduleName, inputData, async (jobId) => moduleRunner({ root, jobId, input: inputData, policy })));
  await persistGeneratedOutputs(root, inputData, executed.result);
  writeOutput(stdout, mode, executed, renderModuleResult(executed));
  return 0;
}

async function handleMatch(root: string, flags: Flags, stdout: OutputWriter): Promise<number> {
  await initWorkspace(root);
  const { record: inputData } = await loadSingleRecordFromFlags(root, flags, "Use --input with a JSON, CSV, or TXT file, or use --text.");
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
  const { record: inputData } = await loadSingleRecordFromFlags(root, flags, "Use --input with a JSON, CSV, or TXT file, or use --text.");
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
  const { records, sourceLabel } = await loadRecordsFromFlags(root, flags, "Use --input with a JSON, CSV, or TXT file, or use --text.");
  const limit = flags.limit ? Number(flags.limit) : records.length;
  const selected = records.slice(0, limit) as ProductRecord[];
  const mode = getOutputMode(flags);
  const summary = {
    operation,
    input: sourceLabel,
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
  const { records, sourceLabel } = await loadRecordsFromFlags(root, flags, "Use --input with a JSON, CSV, or TXT file, or use --text.");
  const limit = flags.limit ? Number(flags.limit) : records.length;
  const selected = records.slice(0, limit) as ProductRecord[];
  const mode = getOutputMode(flags);
  const policy = await getPolicyOrThrow(root);
  const generatedCatalog = await loadGeneratedProductCatalog(root);
  let workflowCatalog: LooseRecord[] | undefined;
  let workflowCatalogSource = "";
  let externalCatalog: LooseRecord[] = [];
  if (flags.catalog) {
    const fileCatalog = await loadInputFile(path.resolve(root, String(flags.catalog)));
    externalCatalog = Array.isArray(fileCatalog) ? [...(fileCatalog as LooseRecord[])] : [fileCatalog];
    workflowCatalog = [...generatedCatalog, ...externalCatalog];
    workflowCatalogSource = generatedCatalog.length > 0 ? "generated+file" : "file";
  } else {
    const catalogProvider = await resolveProvider(root, "catalogue-match", "catalog_provider");
    if (providerIsReady(catalogProvider)) {
      externalCatalog = await fetchShopifyCatalogSnapshot({
        store: catalogProvider.provider.store,
        apiVersion: catalogProvider.provider.api_version ?? "2025-04",
        accessToken: catalogProvider.credential.value,
        first: Number(flags.first ?? 50)
      }) as LooseRecord[];
      workflowCatalog = [...generatedCatalog, ...externalCatalog];
      workflowCatalogSource = generatedCatalog.length > 0 ? `generated+shopify:${catalogProvider.provider.store}` : `shopify:${catalogProvider.provider.store}`;
    } else if (generatedCatalog.length > 0) {
      workflowCatalog = [...generatedCatalog];
      workflowCatalogSource = "generated";
    }
  }
  const generatedProducts: LooseRecord[] = [...generatedCatalog];
  let refreshedOutputs = await refreshWorkflowGeneratedOutputs(root, [], generatedProducts, policy);
  const runWork = async () => {
    const items: WorkflowRunSummary[] = [];
    for (const [index, record] of selected.entries()) {
      const summary = await runWorkflowSequence(
        root,
        record,
        flags,
        stdout,
        mode,
        index,
        selected.length,
        workflowCatalog,
        workflowCatalogSource
      );
      items.push({ ...summary, index });
      const generatedProduct = await readJson<LooseRecord>(summary.generated_product_path, {});
      generatedProducts.push(generatedProduct);
      refreshedOutputs = await refreshWorkflowGeneratedOutputs(root, items, generatedProducts, policy);
      workflowCatalog = [...refreshedOutputs.workflowProducts, ...externalCatalog];
      workflowCatalogSource = externalCatalog.length > 0 ? "generated-ledger+external" : "generated-ledger";
    }
    return items;
  };
  const runs = isLiveTextMode(mode)
    ? await runWork()
    : await withSpinner("Running full workflow", mode, runWork);
  const payload = {
    input: sourceLabel,
    total: records.length,
    processed: runs.length,
    runs,
    review_queue_csv: refreshedOutputs.reviewQueueCsv,
    shopify_import_csv: refreshedOutputs.shopifyImportCsv,
    excel_workbook: refreshedOutputs.excelWorkbook
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
    await refreshWorkspaceExportsFromState(root, await getPolicyOrThrow(root));
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
  await refreshWorkspaceExportsFromState(root, await getPolicyOrThrow(root));
  writeOutput(stdout, mode, decision, renderDecision(decision));
  return 0;
}

async function handleApply(root: string, jobOrPath: string | undefined, flags: Flags, stdout: OutputWriter): Promise<number> {
  if (!jobOrPath) throw new Error("Use `catalog apply <job-id>`.");
  const mode = getOutputMode(flags);
  const run: RunData = await withSpinner("Loading approved run", mode, () => loadRun(root, jobOrPath));
  if (!run.result) throw new Error("Run result not found.");
  const decision = run.decision as ReviewDecision | null;
  const requiresApproval = run.result.needs_review;
  if (requiresApproval && (!decision || !["approve", "approve_with_edits"].includes(decision.action))) {
    throw new Error("Run must be approved before apply.");
  }
  if (!requiresApproval && decision && !["approve", "approve_with_edits"].includes(decision.action)) {
    throw new Error("Run has a review decision that blocks apply.");
  }

  const appliedChanges = materializeProposedChanges({
    ...run.result.proposed_changes,
    ...(decision?.edits ?? {})
  });
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

    const rawShopifyPayload = appliedChanges.shopify_payload as LooseRecord | undefined;
    const shopifyPayload = rawShopifyPayload && isVariantAttachPayload(rawShopifyPayload)
      ? await resolveLiveVariantAttachPayload(root, rawShopifyPayload)
      : rawShopifyPayload;
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
        applied_at: applyResult.applied_at,
        ...(applyResult.live_result ? { live_result: applyResult.live_result } : {})
      }
    };
    await persistGeneratedProduct(root, generatedProduct, run.result.job_id);
  }
  await refreshWorkspaceExportsFromState(root, await getPolicyOrThrow(root));
  writeOutput(stdout, mode, applyResult, renderApplyResult(applyResult));
  return 0;
}

async function handlePublish(root: string, flags: Flags, stdout: OutputWriter): Promise<number> {
  const mode = getOutputMode(flags);
  const policy = await getPolicyOrThrow(root);
  const passingScore = getGuidePassingScore(policy);
  const latestRuns = await withSpinner("Loading latest sync runs", mode, () => loadLatestSyncRuns(root));
  const skipped: Array<{ job_id: string; reason: string }> = [];
  const representativeByIdentity = new Map<string, { run: RunData; product_key: string }>();
  const shadowedJobIds = new Set<string>();

  for (const item of latestRuns) {
    const input = item.run.input as LooseRecord | null;
    const identity = getExportIdentity(input);
    if (!identity) {
      representativeByIdentity.set(`unique:${item.run.result?.job_id ?? item.product_key}`, item);
      continue;
    }
    const existing = representativeByIdentity.get(identity);
    if (!existing) {
      representativeByIdentity.set(identity, item);
      continue;
    }

    const currentRank = getRepresentativeRank(input);
    const existingRank = getRepresentativeRank(existing.run.input as LooseRecord | null);
    const currentQa = getRepresentativeQaScore(input);
    const existingQa = getRepresentativeQaScore(existing.run.input as LooseRecord | null);
    const currentConfidence = getRepresentativeConfidence(input);
    const existingConfidence = getRepresentativeConfidence(existing.run.input as LooseRecord | null);
    const shouldReplace =
      currentRank < existingRank
      || (currentRank === existingRank && currentQa > existingQa)
      || (currentRank === existingRank && currentQa === existingQa && currentConfidence > existingConfidence);

    if (shouldReplace) {
      if (existing.run.result?.job_id) shadowedJobIds.add(existing.run.result.job_id);
      representativeByIdentity.set(identity, item);
    } else if (item.run.result?.job_id) {
      shadowedJobIds.add(item.run.result.job_id);
    }
  }

  const publishable = [...representativeByIdentity.values()].filter((item) => {
    const result = item.run.result;
    const input = item.run.input as LooseRecord | null;
    const apply = item.run.apply as LooseRecord | null;
    if (!result || result.module !== "shopify-sync") return false;
    if (shadowedJobIds.has(result.job_id)) {
      skipped.push({ job_id: result.job_id, reason: "shadowed by a better representative of the same product identity" });
      return false;
    }
    if (apply?.status === "applied_live") {
      skipped.push({ job_id: result.job_id, reason: "already applied live" });
      return false;
    }
    if (!input || typeof input !== "object") {
      skipped.push({ job_id: result.job_id, reason: "missing sync input context" });
      return false;
    }
    const matchBlockReason = getMatchBlockReason(input);
    if (matchBlockReason) {
      skipped.push({ job_id: result.job_id, reason: matchBlockReason });
      return false;
    }
    const qaStatus = typeof input.qa_status === "string" ? input.qa_status.toUpperCase() : "";
    const qaScore = Number(input.qa_score ?? 0);
    if (qaStatus !== "PASS") {
      skipped.push({ job_id: result.job_id, reason: "qa_status is not PASS" });
      return false;
    }
    if (qaScore < passingScore) {
      skipped.push({ job_id: result.job_id, reason: `qa_score ${qaScore} is below passing score ${passingScore}` });
      return false;
    }
    if (result.needs_review) {
      skipped.push({ job_id: result.job_id, reason: "sync run still needs review" });
      return false;
    }
    return true;
  });

  const orderedPublishable = [...publishable].sort((left, right) => {
    const leftIsVariantAttach = isVariantAttachPayload((left.run.result?.proposed_changes?.shopify_payload as LooseRecord | undefined) ?? null);
    const rightIsVariantAttach = isVariantAttachPayload((right.run.result?.proposed_changes?.shopify_payload as LooseRecord | undefined) ?? null);
    return Number(leftIsVariantAttach) - Number(rightIsVariantAttach);
  });

  const jobs: string[] = [];
  for (const item of orderedPublishable) {
    const code = await handleApply(
      root,
      item.run.result?.job_id,
      { live: Boolean(flags.live), json: true },
      { write() {} }
    );
    if (code === 0 && item.run.result?.job_id) jobs.push(item.run.result.job_id);
  }

  const payload = {
    live: Boolean(flags.live),
    published: jobs.length,
    skipped,
    jobs
  };
  writeOutput(stdout, mode, payload, renderPublishSummary(payload));
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
  stdout.write(`${section("Catalog CLI Help")}

${section("Fast Start")}
1. catalog init
2. catalog doctor
3. catalog guide generate --industry apparel --business-name "Demo Store" --business-description "Everyday essentials"
4. catalog workflow run --input .\\examples\\apparel\\products-match.json --catalog .\\examples\\apparel\\catalog-match.json
   or: catalog workflow run --text "Uniqlo Club T-Shirt - 29.00"
5. catalog publish

${section("Core Commands")}
init [--no-wizard] [--json]
doctor [--json]
guide generate --industry <industry> --business-name "Store" --business-description "..." [--operating-mode both] [--research true] [--json]
guide show [--json]
workflow run --input <file> [--catalog <file>] [--limit N] [--json]
workflow run --text "<product lines>" [--catalog <file>] [--limit N] [--json]
publish [--live] [--json]

${section("Single-Step Commands")}
ingest --input <file> [--json]
ingest --text "<product lines>" [--json]
match --input <file> [--catalog <file>] [--first 50] [--json]
match --text "<single product>" [--catalog <file>] [--first 50] [--json]
enrich --input <file> [--json]
enrich --text "<single product>" [--json]
image --input <file> [--json]
image --text "<single product>" [--json]
qa --input <file> [--json]
qa --text "<single product>" [--json]
sync --input <file> [--json]
sync --text "<single product>" [--json]
batch <enrich|qa|match|image|sync> --input <file> [--catalog <file>] [--limit N] [--json]
batch <enrich|qa|match|image|sync> --text "<product lines>" [--catalog <file>] [--limit N] [--json]

${section("Review And Apply")}
review <job-id> [--action approve|approve_with_edits|reject|defer] [--json]
review queue [--module <name>] [--product <product-key>] [--all] [--json]
review bulk --action approve|approve_with_edits|reject|defer [--module <name>] [--product <product-key>] [--all] [--json]
apply <job-id> [--live] [--json]
learn --run <job-id> [--lesson "..."] [--json]

${section("Credentials And Config")}
auth set --provider <name> --value <secret> [--model <model>] [--json]
auth login --provider openai [--model <model>] [--json]
auth login --provider shopify --store <shop> --client-id <id> --client-secret <secret> [--json]
auth login --provider gemini --client-id <id> --client-secret <secret> --project-id <project> [--model <model>] [--json]
auth list [--json]
auth test --provider <name> [--json]
config set <path> <value> [--json]
config get <path> [--json]

${section("Examples")}
catalog guide generate --industry food_and_beverage --business-name "Blyzr" --business-description "Online grocery store for halal and cultural groceries"
catalog workflow run --input .\\examples\\grocery\\products-match.json --catalog .\\examples\\grocery\\catalog-match.json
catalog workflow run --input .\\examples\\alt-structure\\products-grocery.csv --catalog .\\examples\\grocery\\catalog-match.json
catalog workflow run --text "Almarai Fresh Milk Low Fat 1L - 8.50\nBaladna Greek Yogurt Plain 500g - 12.50" --catalog .\\examples\\grocery\\catalog-match.json
catalog auth set --provider anthropic --value <api-key> --model claude-sonnet-4-20250514
catalog auth login --provider openai --model gpt-5
catalog review queue
catalog publish --live
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await runCli(process.argv.slice(2)));
}
