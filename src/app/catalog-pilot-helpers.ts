import fs from "node:fs/promises";
import path from "node:path";
import { getProductKey } from "../lib/generated.js";
import { loadRun } from "../lib/artifacts.js";
import type { LooseRecord, ReviewDecision, RunData, WorkflowProduct, WorkflowSession } from "../types.js";
import { getCatalogPaths } from "../lib/paths.js";
import { readJson } from "../lib/fs.js";

export function isoNow(): string {
  return new Date().toISOString();
}

export function addHours(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export function createStageState(): WorkflowSession["stage_state"] {
  return {
    guide: "idle",
    match: "idle",
    enrich: "idle",
    image: "idle",
    qa: "idle",
    sync_prep: "idle"
  };
}

export function createCounts(total = 0): WorkflowSession["counts"] {
  return {
    total_entries: total,
    passed_products: 0,
    duplicate_products: 0,
    variant_products: 0,
    rejected_products: 0,
    pending_review_products: 0,
    manually_reviewed_products: 0
  };
}

export function normalizeIdentityValue(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function getExportIdentity(record: LooseRecord | null | undefined): string {
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

export function getMatchDecision(record: LooseRecord | null | undefined): string {
  const match = record?._catalog_match;
  if (!match || typeof match !== "object") return "";
  const decision = (match as LooseRecord).decision;
  return typeof decision === "string" ? decision.toUpperCase() : "";
}

export function getMatchNeedsReview(record: LooseRecord | null | undefined): boolean {
  const match = record?._catalog_match;
  if (!match || typeof match !== "object") return false;
  return Boolean((match as LooseRecord).needs_review);
}

export function getMatchBlockReason(record: LooseRecord | null | undefined): string | null {
  const decision = getMatchDecision(record);
  if (decision === "DUPLICATE") return "catalogue-match marked this product as DUPLICATE";
  if (getMatchNeedsReview(record)) return "catalogue-match still needs review";
  return null;
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

export function selectRepresentativeProducts(products: LooseRecord[]): { selected: LooseRecord[]; shadowedKeys: Set<string> } {
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

export function getReviewAction(run: RunData): string {
  const decision = run.decision as LooseRecord | null;
  return typeof decision?.action === "string" ? decision.action : "";
}

export function isApprovedReviewAction(action: string): boolean {
  return action === "approve" || action === "approve_with_edits";
}

export function buildApprovedProductProjection(product: LooseRecord, run: RunData): LooseRecord {
  const decision = run.decision as ReviewDecision | null;
  if (!decision || !isApprovedReviewAction(decision.action)) return product;
  return {
    ...product,
    ...(decision.edits ?? {})
  };
}

export async function listRunIds(root: string): Promise<string[]> {
  const runsDir = getCatalogPaths(root).runsDir;
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export function deriveProductKeyFromRun(run: RunData): string {
  if (run.input && typeof run.input === "object") {
    return getProductKey(run.input as LooseRecord, run.result?.job_id ?? "product");
  }
  return run.result?.job_id ?? "unknown";
}

export async function loadGeneratedProductCatalog(root: string): Promise<LooseRecord[]> {
  const generatedDir = getCatalogPaths(root).generatedProductsDir;
  const entries = await fs.readdir(generatedDir, { withFileTypes: true }).catch(() => []);
  const productFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => path.join(generatedDir, entry.name));
  return Promise.all(productFiles.map((filePath) => readJson<LooseRecord>(filePath, {})));
}

export async function loadReviewableRuns(root: string): Promise<Array<{ run: RunData; product_key: string }>> {
  const runIds = await listRunIds(root);
  const loaded = await Promise.all(runIds.map(async (jobId) => ({ run: await loadRun(root, jobId), product_key: "" })));
  return loaded
    .map((item) => ({ ...item, product_key: deriveProductKeyFromRun(item.run) }))
    .filter((item) => Boolean(item.run.result?.needs_review) && !isApprovedReviewAction(getReviewAction(item.run)));
}

export async function loadLatestSyncRuns(root: string): Promise<Array<{ run: RunData; product_key: string }>> {
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

export function summarizeProductDisposition(product: LooseRecord, latestSyncRun?: RunData | null): WorkflowProduct["disposition"] {
  const matchDecision = getMatchDecision(product);
  const reviewAction = latestSyncRun ? getReviewAction(latestSyncRun) : "";
  if (reviewAction === "reject") return { status: "rejected", reason: latestSyncRun?.result?.warnings?.[0] ?? "Rejected during review" };
  if (matchDecision === "DUPLICATE") return { status: "duplicate", reason: "Duplicate matched against the catalog ledger" };
  if (latestSyncRun?.result?.needs_review && !isApprovedReviewAction(reviewAction)) {
    return { status: "pending_review", reason: latestSyncRun.result.warnings?.[0] ?? "Review required before export" };
  }
  if (matchDecision === "NEW_VARIANT") return { status: "variant", reason: "Added under an existing family" };
  return { status: "passed" };
}
