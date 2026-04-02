import fs from "node:fs/promises";
import path from "node:path";
import { materializeProposedChanges } from "../lib/change-records.js";
import { createRun, loadRun, writeApplyResult, writeDecision, writeModuleArtifacts } from "../lib/artifacts.js";
import { readJson, readText, writeJson } from "../lib/fs.js";
import {
  buildGeneratedProduct,
  getProductKey,
  persistGeneratedImageArtifacts,
  persistGeneratedProduct,
  writeExcelWorkbook,
  writeRejectedProductsCsv,
  writeReviewQueueCsv,
  writeShopifyImportCsv,
  writeWorkflowProductsLedger
} from "../lib/generated.js";
import { getCatalogPaths } from "../lib/paths.js";
import { resolveProvider } from "../lib/providers.js";
import { initWorkspace, loadRuntimeConfig } from "../lib/runtime.js";
import { getGuidePassingScore } from "../lib/catalog-guide.js";
import { fetchShopifyCatalogSnapshot, applyShopifyPayload } from "../connectors/shopify.js";
import { runExpertGenerate } from "../modules/expert.js";
import { loadRecordsFromSource, loadRecordsFromText } from "../modules/ingest.js";
import { buildCatalogIndex, runMatchDecision } from "../modules/match.js";
import { runEnrich } from "../modules/enrich.js";
import { runImageOptimize } from "../modules/image-optimize.js";
import { runQa } from "../modules/qa.js";
import { runSync } from "../modules/sync.js";
import type {
  ApplyResult,
  GeneratedArtifact,
  GuestSession,
  LooseRecord,
  ProductRecord,
  ReviewDecision,
  ReviewItem,
  SyncBatch,
  WorkflowProduct,
  WorkflowRunSummary,
  WorkflowSession
} from "../types.js";
import {
  buildApprovedProductProjection,
  createCounts,
  getMatchBlockReason,
  getMatchDecision,
  getMatchNeedsReview,
  getReviewAction,
  isApprovedReviewAction,
  isoNow,
  loadGeneratedProductCatalog,
  loadLatestSyncRuns,
  loadReviewableRuns,
  selectRepresentativeProducts,
  summarizeProductDisposition
} from "./catalog-pilot-helpers.js";
import { getCatalogPilotSessionPaths } from "./catalog-pilot-paths.js";
import {
  createWorkflowRecord,
  getOrCreateGuestSession,
  loadGuestSession,
  loadSessionArtifacts,
  loadSyncBatch,
  loadWorkflow,
  loadWorkflowProducts,
  loadWorkflowReviews,
  loadWorkflowRunSummaries,
  saveGuestSession,
  saveSessionArtifacts,
  saveSessionOnboarding,
  saveSyncBatch,
  saveWorkflow,
  saveWorkflowProducts,
  saveWorkflowReviews,
  saveWorkflowRunSummaries
} from "./catalog-pilot-session.js";

export type WorkflowStartInput = {
  source: "text" | "file";
  input_name?: string;
  records: ProductRecord[];
  external_catalog?: LooseRecord[];
};

export type WorkflowView = {
  session: GuestSession;
  workflow: WorkflowSession;
  products: WorkflowProduct[];
  review_items: ReviewItem[];
  artifacts: GeneratedArtifact[];
  sync_batch: SyncBatch | null;
};

const backgroundTasks = new Map<string, Promise<void>>();

async function getGuideOrThrow(root: string) {
  await initWorkspace(root);
  const policy = await readJson(getCatalogPaths(root).policyJson, null);
  if (!policy) throw new Error("No Catalog Guide found for this session. Generate the guide first.");
  return policy;
}

async function executeModule(root: string, moduleName: string, input: LooseRecord, handler: (jobId: string) => Promise<any>) {
  await initWorkspace(root);
  const { jobId, runDir } = await createRun(root, moduleName, input);
  const result = await handler(jobId);
  await writeModuleArtifacts(runDir, result);
  return { job_id: jobId, run_dir: runDir, result };
}

async function persistGeneratedOutputs(root: string, input: ProductRecord, result: any) {
  const generatedProduct = buildGeneratedProduct(input, result);
  const productPath = await persistGeneratedProduct(root, generatedProduct, result.job_id);
  let imageDirectory: string | undefined;
  let selectedImageUrl: string | undefined;
  let localImagePath: string | undefined;
  if (result.module === "image-optimizer") {
    const imageArtifacts = await persistGeneratedImageArtifacts(root, generatedProduct, result);
    imageDirectory = imageArtifacts.directory;
    const metadata = await readJson<LooseRecord>(path.join(imageArtifacts.directory, "metadata.json"), {});
    if (typeof metadata.selected_image_url === "string") selectedImageUrl = metadata.selected_image_url;
    if (typeof metadata.local_image_path === "string") localImagePath = metadata.local_image_path;
  }
  return { productPath, imageDirectory, selectedImageUrl, localImagePath };
}

async function runWorkflowSequence(root: string, record: ProductRecord, workflowCatalog?: LooseRecord[], workflowCatalogSource?: string): Promise<WorkflowRunSummary> {
  const policy = await getGuideOrThrow(root);
  const runtimeConfig = await loadRuntimeConfig(root);
  const paths = getCatalogPaths(root);
  const learningText = await readText(paths.learningMarkdown, "");
  const sourceRecordId = String(record.id ?? record.product_id ?? record.sku ?? record.handle ?? record.title ?? "record");
  let currentRecord: ProductRecord = { ...record, source_record_id: sourceRecordId };
  const modules: WorkflowRunSummary["modules"] = [];
  let imageDirectory = paths.generatedImagesDir;

  if (workflowCatalog) {
    await writeJson(paths.indexJson, buildCatalogIndex(workflowCatalog));
    const matchRun = await executeModule(root, "catalogue-match", currentRecord, async (jobId) => {
      const result = runMatchDecision({ jobId, input: currentRecord, catalog: workflowCatalog, policy, learningText });
      result.reasoning = [`Catalog source: ${workflowCatalogSource ?? "generated"}`, ...(result.reasoning ?? [])];
      return result;
    });
    const match = matchRun.result as LooseRecord;
    currentRecord = {
      ...currentRecord,
      _catalog_match: {
        decision: match.decision ?? null,
        confidence: match.confidence ?? null,
        needs_review: matchRun.result.needs_review,
        matched_product_id: match.matched_product_id ?? null,
        matched_variant_id: match.matched_variant_id ?? null,
        proposed_action: match.proposed_action ?? null
      }
    };
    modules.push({ module: matchRun.result.module, job_id: matchRun.job_id, status: matchRun.result.status, needs_review: matchRun.result.needs_review });
    if (getMatchDecision(currentRecord as LooseRecord) === "DUPLICATE" || getMatchNeedsReview(currentRecord as LooseRecord)) {
      const productPath = (await persistGeneratedOutputs(root, currentRecord, matchRun.result)).productPath;
      return { index: 0, product_key: getProductKey(currentRecord, sourceRecordId), source_record_id: sourceRecordId, generated_product_path: productPath, generated_image_dir: imageDirectory, modules };
    }
  }

  const enrichRun = await executeModule(root, "product-enricher", currentRecord, async (jobId) => runEnrich({ root, jobId, input: currentRecord, policy }));
  currentRecord = buildGeneratedProduct(currentRecord, enrichRun.result) as ProductRecord;
  modules.push({ module: enrichRun.result.module, job_id: enrichRun.job_id, status: enrichRun.result.status, needs_review: enrichRun.result.needs_review });
  await persistGeneratedOutputs(root, currentRecord, enrichRun.result);

  const imageRun = await executeModule(root, "image-optimizer", currentRecord, async (jobId) => runImageOptimize({ root, jobId, input: currentRecord, policy, runtimeConfig }));
  currentRecord = buildGeneratedProduct(currentRecord, imageRun.result) as ProductRecord;
  modules.push({ module: imageRun.result.module, job_id: imageRun.job_id, status: imageRun.result.status, needs_review: imageRun.result.needs_review });
  const imageOutput = await persistGeneratedOutputs(root, currentRecord, imageRun.result);
  imageDirectory = imageOutput.imageDirectory ?? imageDirectory;

  const qaRun = await executeModule(root, "catalogue-qa", currentRecord, async (jobId) => runQa({ root, jobId, input: currentRecord, policy }));
  currentRecord = buildGeneratedProduct(currentRecord, qaRun.result) as ProductRecord;
  modules.push({ module: qaRun.result.module, job_id: qaRun.job_id, status: qaRun.result.status, needs_review: qaRun.result.needs_review });
  await persistGeneratedOutputs(root, currentRecord, qaRun.result);

  const syncRun = await executeModule(root, "shopify-sync", currentRecord, async (jobId) => runSync({ root, jobId, input: currentRecord }));
  modules.push({ module: syncRun.result.module, job_id: syncRun.job_id, status: syncRun.result.status, needs_review: syncRun.result.needs_review });
  const productPath = (await persistGeneratedOutputs(root, currentRecord, syncRun.result)).productPath;
  return { index: 0, product_key: getProductKey(currentRecord, sourceRecordId), source_record_id: sourceRecordId, generated_product_path: productPath, generated_image_dir: imageDirectory, selected_image_url: imageOutput.selectedImageUrl, local_image_path: imageOutput.localImagePath, modules };
}

async function refreshWorkspaceExports(root: string, runs: WorkflowRunSummary[]) {
  const policy = await getGuideOrThrow(root);
  const generatedProducts = await loadGeneratedProductCatalog(root);
  const pendingReviewRuns = await loadReviewableRuns(root);
  const pendingReviewRows = pendingReviewRuns.map((item) => ({
    "Product Key": item.product_key,
    "Module": String(item.run.result?.module ?? "unknown"),
    "Job ID": String(item.run.result?.job_id ?? ""),
    "Status": String(item.run.result?.status ?? ""),
    "Generated Product Path": path.join(getCatalogPaths(root).generatedProductsDir, `${item.product_key}.json`),
    "Suggested Command": `catalog review ${item.run.result?.job_id ?? ""}`,
    "Notes": item.run.result?.warnings?.[0] ?? ""
  }));
  const latestSyncRuns = await loadLatestSyncRuns(root);
  const latestSyncByProductKey = new Map(latestSyncRuns.map((item) => [item.product_key, item]));
  const latestSyncByJobId = new Map(latestSyncRuns.filter((item) => item.run.result?.job_id).map((item) => [String(item.run.result?.job_id), item]));
  const { selected: representativeProducts } = selectRepresentativeProducts(generatedProducts);
  const workflowProducts = representativeProducts
    .filter((product) => !getMatchBlockReason(product))
    .map((product) => {
      const lastJobId = typeof (product._catalog as LooseRecord | undefined)?.last_job_id === "string" ? String((product._catalog as LooseRecord).last_job_id) : "";
      const syncRun = (lastJobId ? latestSyncByJobId.get(lastJobId) : undefined) ?? latestSyncByProductKey.get(getProductKey(product, "product"));
      return syncRun ? buildApprovedProductProjection(product, syncRun.run) : product;
    });
  const exportableProducts = workflowProducts.flatMap((product) => {
    const lastJobId = typeof (product._catalog as LooseRecord | undefined)?.last_job_id === "string" ? String((product._catalog as LooseRecord).last_job_id) : "";
    const syncRun = (lastJobId ? latestSyncByJobId.get(lastJobId) : undefined) ?? latestSyncByProductKey.get(getProductKey(product, "product"));
    if (!syncRun?.run.result || syncRun.run.result.module !== "shopify-sync") return [];
    if (syncRun.run.result.needs_review && !isApprovedReviewAction(getReviewAction(syncRun.run))) return [];
    return [product];
  });

  const reviewQueueCsv = await writeReviewQueueCsv(root, runs);
  const workflowProductsJson = await writeWorkflowProductsLedger(root, workflowProducts);
  const shopifyImportCsv = await writeShopifyImportCsv(root, exportableProducts, policy);
  const rejectedProductsCsv = await writeRejectedProductsCsv(root, workflowProducts
    .filter((product) => {
      const syncRun = latestSyncByProductKey.get(getProductKey(product, "product"));
      return getReviewAction(syncRun?.run as any) === "reject";
    })
    .map((product) => ({ ...product, rejection_reason: "Rejected during review", source_record_id: String(product.source_record_id ?? "") })));
  const excelWorkbook = await writeExcelWorkbook(root, runs, generatedProducts, exportableProducts, policy, pendingReviewRows);
  return { reviewQueueCsv, workflowProductsJson, shopifyImportCsv, rejectedProductsCsv, excelWorkbook, workflowProducts, exportableProducts };
}

async function rebuildWorkflowView(root: string, sessionId: string, workflowId: string): Promise<WorkflowView> {
  const session = await loadGuestSession(root, sessionId);
  const workflow = await loadWorkflow(root, sessionId, workflowId);
  const sessionPaths = getCatalogPilotSessionPaths(root, sessionId);
  const generatedProducts = await loadGeneratedProductCatalog(sessionPaths.workspaceRoot);
  const latestSyncRuns = await loadLatestSyncRuns(sessionPaths.workspaceRoot);
  const latestByKey = new Map(latestSyncRuns.map((item) => [item.product_key, item.run]));
  const products: WorkflowProduct[] = generatedProducts.map((product) => {
    const productKey = getProductKey(product, "product");
    const syncRun = latestByKey.get(productKey);
    return {
      id: productKey,
      session_id: sessionId,
      workflow_id: workflowId,
      product_key: productKey,
      source_record_id: String(product.source_record_id ?? product.product_id ?? product.id ?? product.title ?? productKey),
      title: String(product.title ?? ""),
      normalized_record: product,
      generated_product_path: path.join(getCatalogPaths(sessionPaths.workspaceRoot).generatedProductsDir, `${productKey}.json`),
      generated_image_dir: path.join(getCatalogPaths(sessionPaths.workspaceRoot).generatedImagesDir, productKey),
      selected_image_url: typeof product.featured_image === "string" ? product.featured_image : undefined,
      modules: syncRun?.result ? [{ module: syncRun.result.module, job_id: syncRun.result.job_id, status: syncRun.result.status, needs_review: syncRun.result.needs_review }] : [],
      disposition: summarizeProductDisposition(product, syncRun ?? null)
    };
  });

  const reviewableRuns = await loadReviewableRuns(sessionPaths.workspaceRoot);
  const existingReviewItems = await loadWorkflowReviews<ReviewItem>(root, sessionId, workflowId);
  const existingById = new Map(existingReviewItems.map((item) => [item.id, item]));
  const reviewItems: ReviewItem[] = reviewableRuns.map((item) => {
    const product = generatedProducts.find((candidate) => getProductKey(candidate, "product") === item.product_key) ?? {};
    const existing = existingById.get(item.run.result?.job_id ?? "");
    return {
      id: item.run.result?.job_id ?? item.product_key,
      session_id: sessionId,
      workflow_id: workflowId,
      product_id: item.product_key,
      product_key: item.product_key,
      title: String((product as LooseRecord).title ?? item.product_key),
      blocking_module: String(item.run.result?.module ?? "unknown"),
      issue_type: "review_required",
      reason: item.run.result?.warnings?.[0] ?? item.run.result?.reasoning?.[0] ?? "Manual review required",
      preview_image_url: typeof (product as LooseRecord).featured_image === "string" ? String((product as LooseRecord).featured_image) : undefined,
      current_fields: product as LooseRecord,
      action_state: existing?.action_state ?? "pending",
      edit_payload: existing?.edit_payload,
      created_at: existing?.created_at ?? isoNow(),
      updated_at: isoNow()
    };
  });
  await saveWorkflowReviews(root, sessionId, workflowId, reviewItems);

  workflow.counts = {
    total_entries: products.length,
    passed_products: products.filter((product) => product.disposition.status === "passed").length,
    duplicate_products: products.filter((product) => product.disposition.status === "duplicate").length,
    variant_products: products.filter((product) => product.disposition.status === "variant").length,
    rejected_products: products.filter((product) => product.disposition.status === "rejected").length,
    pending_review_products: reviewItems.filter((item) => item.action_state === "pending").length,
    manually_reviewed_products: reviewItems.filter((item) => item.action_state !== "pending").length
  };
  workflow.status = reviewItems.some((item) => item.action_state === "pending") ? "needs_review" : workflow.status === "failed" ? "failed" : "ready";
  workflow.updated_at = isoNow();
  await saveWorkflow(root, sessionId, workflow);

  const artifacts = (await loadSessionArtifacts(root, sessionId)).filter((artifact) => artifact.workflow_id === workflowId || artifact.type === "guide_markdown");
  const syncBatch = await loadSyncBatch(root, sessionId, workflowId);
  return { session, workflow, products, review_items: reviewItems, artifacts, sync_batch: syncBatch };
}

async function registerArtifacts(root: string, sessionId: string, workflowId: string, exportState: Awaited<ReturnType<typeof refreshWorkspaceExports>>) {
  const sessionPaths = getCatalogPilotSessionPaths(root, sessionId);
  const artifacts = await loadSessionArtifacts(root, sessionId);
  const next = artifacts.filter((artifact) => artifact.workflow_id !== workflowId);
  const summaryPath = path.join(sessionPaths.workspaceRoot, ".catalog", "generated", "workflow-summary.json");
  const view = await rebuildWorkflowView(root, sessionId, workflowId);
  await writeJson(summaryPath, { workflow_id: workflowId, counts: view.workflow.counts, generated_at: isoNow() });
  next.push(
    { id: `guide_${workflowId}`, session_id: sessionId, workflow_id: workflowId, type: "guide_markdown", storage_key: getCatalogPaths(sessionPaths.workspaceRoot).policyMarkdown, file_name: "catalog-guide.md", content_type: "text/markdown", created_at: isoNow() },
    { id: `shopify_${workflowId}`, session_id: sessionId, workflow_id: workflowId, type: "shopify_import", storage_key: exportState.shopifyImportCsv, file_name: "shopify-import.csv", content_type: "text/csv", created_at: isoNow() },
    { id: `rejected_${workflowId}`, session_id: sessionId, workflow_id: workflowId, type: "rejected_products", storage_key: exportState.rejectedProductsCsv, file_name: "rejected-products.csv", content_type: "text/csv", created_at: isoNow() },
    { id: `summary_${workflowId}`, session_id: sessionId, workflow_id: workflowId, type: "workflow_summary", storage_key: summaryPath, file_name: "workflow-summary.json", content_type: "application/json", created_at: isoNow() }
  );
  await saveSessionArtifacts(root, sessionId, next);
}

async function processWorkflow(root: string, sessionId: string, workflowId: string, input: WorkflowStartInput) {
  const sessionPaths = getCatalogPilotSessionPaths(root, sessionId);
  const workflow = await loadWorkflow(root, sessionId, workflowId);
  workflow.stage_state.guide = "complete";
  workflow.stage_state.match = "running";
  await saveWorkflow(root, sessionId, workflow);
  const generatedCatalog = await loadGeneratedProductCatalog(sessionPaths.workspaceRoot);
  const generatedProducts: LooseRecord[] = [...generatedCatalog];
  const runs: WorkflowRunSummary[] = [];
  let externalCatalog = input.external_catalog ?? [];
  let workflowCatalog = [...generatedCatalog, ...externalCatalog];
  let workflowCatalogSource = externalCatalog.length > 0 ? "generated+external" : "generated";

  for (const record of input.records) {
    const summary = await runWorkflowSequence(sessionPaths.workspaceRoot, record, workflowCatalog, workflowCatalogSource);
    runs.push({ ...summary, index: runs.length });
    await saveWorkflowRunSummaries(root, sessionId, runs);
    generatedProducts.push(await readJson<LooseRecord>(summary.generated_product_path, {}));
    const exportState = await refreshWorkspaceExports(sessionPaths.workspaceRoot, runs);
    await registerArtifacts(root, sessionId, workflowId, exportState);
    workflowCatalog = [...exportState.workflowProducts, ...externalCatalog];
    workflowCatalogSource = externalCatalog.length > 0 ? "generated-ledger+external" : "generated-ledger";
  }

  await rebuildWorkflowView(root, sessionId, workflowId);
}

export async function createOrLoadGuestSession(root: string, sessionId?: string) {
  return getOrCreateGuestSession(root, sessionId);
}

export async function configureCatalogPilotSession(root: string, sessionId: string, input: Parameters<typeof saveSessionOnboarding>[2]) {
  return saveSessionOnboarding(root, sessionId, input);
}

export async function generateCatalogPilotGuide(root: string, sessionId: string) {
  const session = await loadGuestSession(root, sessionId);
  const sessionPaths = getCatalogPilotSessionPaths(root, sessionId);
  await initWorkspace(sessionPaths.workspaceRoot);
  const { jobId, runDir } = await createRun(sessionPaths.workspaceRoot, "catalogue-expert", { source: "catalog-pilot" });
  const result = await runExpertGenerate({
    root: sessionPaths.workspaceRoot,
    jobId,
    input: {
      industry: session.industry ?? "generic",
      businessName: session.business_name ?? "Catalog Pilot Store",
      businessDescription: session.business_description ?? "",
      operatingMode: "both",
      storeUrl: session.store_url ?? "",
      notes: "Generated from Catalog Pilot web app"
    }
  });
  await writeModuleArtifacts(runDir, result);
  const artifacts = await loadSessionArtifacts(root, sessionId);
  artifacts.push({ id: "guide_initial", session_id: sessionId, workflow_id: "guide", type: "guide_markdown", storage_key: getCatalogPaths(sessionPaths.workspaceRoot).policyMarkdown, file_name: "catalog-guide.md", content_type: "text/markdown", created_at: isoNow() });
  await saveSessionArtifacts(root, sessionId, artifacts);
  return { job_id: jobId, path: getCatalogPaths(sessionPaths.workspaceRoot).policyMarkdown };
}

export async function parseCatalogPilotInput(source: "text" | "file", payload: { text?: string; filePath?: string; fileName?: string; externalCatalogPath?: string }): Promise<WorkflowStartInput> {
  if (source === "text") {
    const text = payload.text?.trim() ?? "";
    if (!text) throw new Error("Paste at least one product before starting the workflow.");
    return { source, input_name: "Pasted products", records: loadRecordsFromText(text) as ProductRecord[] };
  }
  if (!payload.filePath) throw new Error("Missing uploaded file path.");
  return {
    source,
    input_name: payload.fileName ?? path.basename(payload.filePath),
    records: (await loadRecordsFromSource(payload.filePath)) as ProductRecord[],
    external_catalog: payload.externalCatalogPath ? await readJson<LooseRecord[]>(payload.externalCatalogPath, []) : []
  };
}

export async function startCatalogPilotWorkflow(root: string, sessionId: string, input: WorkflowStartInput) {
  const sessionPaths = getCatalogPilotSessionPaths(root, sessionId);
  await initWorkspace(sessionPaths.workspaceRoot);
  const workflow = createWorkflowRecord(sessionId, input.source, input.records.length, input.input_name);
  await saveWorkflow(root, sessionId, workflow);
  const task = processWorkflow(root, sessionId, workflow.id, input)
    .catch(async () => {
      const current = await loadWorkflow(root, sessionId, workflow.id);
      current.status = "failed";
      current.updated_at = isoNow();
      await saveWorkflow(root, sessionId, current);
    })
    .finally(() => backgroundTasks.delete(`${sessionId}:${workflow.id}`));
  backgroundTasks.set(`${sessionId}:${workflow.id}`, task);
  return workflow;
}

export async function getCatalogPilotWorkflow(root: string, sessionId: string, workflowId: string) {
  return rebuildWorkflowView(root, sessionId, workflowId);
}

export async function decideCatalogPilotReview(root: string, sessionId: string, workflowId: string, reviewItemId: string, action: "approve" | "reject" | "approve_with_edits", edits: LooseRecord = {}, notes = "") {
  const sessionPaths = getCatalogPilotSessionPaths(root, sessionId);
  const reviewItems = await loadWorkflowReviews<ReviewItem>(root, sessionId, workflowId);
  const reviewItem = reviewItems.find((item) => item.id === reviewItemId);
  if (!reviewItem) throw new Error("Review item not found.");
  const run = await loadRun(sessionPaths.workspaceRoot, reviewItemId);
  await writeDecision(run.runDir, { job_id: reviewItemId, action, notes, edits, decided_at: isoNow() } satisfies ReviewDecision);
  reviewItem.action_state = action === "reject" ? "rejected" : "approved";
  reviewItem.edit_payload = edits;
  reviewItem.updated_at = isoNow();
  await saveWorkflowReviews(root, sessionId, workflowId, reviewItems);
  const runs = await loadWorkflowRunSummaries<WorkflowRunSummary>(root, sessionId);
  const exportState = await refreshWorkspaceExports(sessionPaths.workspaceRoot, runs);
  await registerArtifacts(root, sessionId, workflowId, exportState);
  return rebuildWorkflowView(root, sessionId, workflowId);
}

export async function startCatalogPilotSync(root: string, sessionId: string, workflowId: string) {
  const sessionPaths = getCatalogPilotSessionPaths(root, sessionId);
  const view = await rebuildWorkflowView(root, sessionId, workflowId);
  const approved = view.products.filter((product) => product.disposition.status === "passed" || product.disposition.status === "variant");
  const batch: SyncBatch = { id: `sync_${Date.now()}`, session_id: sessionId, workflow_id: workflowId, status: "running", approved_product_ids: approved.map((item) => item.id), results: [], created_at: isoNow(), updated_at: isoNow() };
  await saveSyncBatch(root, sessionId, workflowId, batch);
  const latestSyncRuns = await loadLatestSyncRuns(sessionPaths.workspaceRoot);
  const latestByKey = new Map(latestSyncRuns.map((item) => [item.product_key, item.run]));
  const shopifyProvider = await resolveProvider(sessionPaths.workspaceRoot, "shopify-sync", "shopify_provider");
  if (!shopifyProvider?.provider?.store || !shopifyProvider.credential?.value) {
    batch.status = "failed";
    batch.results.push({ product_id: "all", product_key: "all", status: "failed", message: "Shopify provider is not configured for live sync in this session." });
    await saveSyncBatch(root, sessionId, workflowId, batch);
    return batch;
  }

  for (const product of approved) {
    const run = latestByKey.get(product.product_key);
    if (!run?.result) continue;
    try {
      const decision = run.decision as ReviewDecision | null;
      const appliedChanges = materializeProposedChanges({ ...run.result.proposed_changes, ...(decision?.edits ?? {}) });
      const liveResult = await applyShopifyPayload({
        store: shopifyProvider.provider.store,
        apiVersion: shopifyProvider.provider.api_version ?? "2025-04",
        accessToken: shopifyProvider.credential.value,
        payload: appliedChanges.shopify_payload as LooseRecord
      });
      await writeApplyResult(run.runDir, { job_id: run.result.job_id, module: run.result.module, applied_at: isoNow(), status: "applied_live", applied_changes: appliedChanges, live_result: liveResult } satisfies ApplyResult);
      batch.results.push({ product_id: product.id, product_key: product.product_key, status: "success", message: "Synced successfully." });
    } catch (error) {
      batch.results.push({ product_id: product.id, product_key: product.product_key, status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
  batch.status = batch.results.some((item) => item.status === "failed") ? "failed" : "complete";
  batch.updated_at = isoNow();
  await saveSyncBatch(root, sessionId, workflowId, batch);
  return batch;
}

export async function readCatalogPilotArtifact(root: string, sessionId: string, artifactId: string) {
  const artifact = (await loadSessionArtifacts(root, sessionId)).find((item) => item.id === artifactId);
  if (!artifact) throw new Error("Artifact not found.");
  return { artifact, body: await fs.readFile(artifact.storage_key) };
}
