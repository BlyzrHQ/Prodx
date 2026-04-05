import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, readJson, writeJson, writeText, exists } from "./fs.js";
import { getCatalogPaths } from "./paths.js";
import { getGuideAgenticRecommendedMetafields, getGuideMetafields } from "./catalog-guide.js";
import { getProductKey } from "./generated.js";
import type {
  CollectionApplyResult,
  CollectionCandidate,
  CollectionProposal,
  CollectionRegistryEntry,
  CollectionRule,
  CollectionSourceSummary,
  CollectionSummaryEntry,
  LooseRecord,
  PolicyDocument,
  ProductMetafieldValue,
  RuntimeConfig
} from "../types.js";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "collection";
}

function humanizeKey(value: string): string {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function isSupportedCollectionMetafieldType(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("reference")) return false;
  return true;
}

function extractMetafieldValues(metafield: ProductMetafieldValue): string[] {
  const rawValue = typeof metafield.value === "string" ? metafield.value.trim() : "";
  if (!rawValue) return [];

  const normalizedType = String(metafield.type ?? "").trim().toLowerCase();
  if (!isSupportedCollectionMetafieldType(normalizedType)) return [];

  if (normalizedType.startsWith("list.")) {
    try {
      const parsed = JSON.parse(rawValue);
      if (!Array.isArray(parsed)) return [];
      return dedupeStrings(parsed.map((item) => String(item)));
    } catch {
      return dedupeStrings(rawValue.split(",").map((item) => item.trim()));
    }
  }

  if (normalizedType === "boolean") {
    return ["true", "false"].includes(rawValue.toLowerCase()) ? [rawValue.toLowerCase()] : [];
  }

  return [rawValue];
}

function buildSourceId(sourceType: "product_type" | "metafield", sourceKey: string, sourceValue: string): string {
  return slugify(`${sourceType}-${sourceKey}-${normalizeValue(sourceValue)}`);
}

function buildRegistryIdentity(entry: { source_type: "product_type" | "metafield"; source_key: string; source_value: string }): string {
  return `${entry.source_type}|${entry.source_key}|${normalizeValue(entry.source_value)}`;
}

function buildProposalIdentity(entry: { handle: string; source_type: "product_type" | "metafield"; source_key: string; source_value: string }): string {
  return `${buildRegistryIdentity(entry)}|${slugify(entry.handle)}`;
}

function buildRuleForEntry(entry: CollectionSummaryEntry, conditionObjectId?: string): CollectionRule {
  if (entry.source_type === "product_type") {
    return {
      applied_disjunctively: false,
      rules: [{
        column: "TYPE",
        relation: "EQUALS",
        condition: entry.source_value
      }]
    };
  }

  return {
    applied_disjunctively: false,
    rules: [{
      column: "PRODUCT_METAFIELD_DEFINITION",
      relation: "EQUALS",
      condition: entry.source_value,
      ...(conditionObjectId ? { condition_object_id: conditionObjectId } : {})
    }]
  };
}

function getAllowedGuideMetafields(policy: PolicyDocument, runtimeConfig: RuntimeConfig): ProductMetafieldValue[] {
  const allowedSources = Array.isArray(runtimeConfig.collections?.allowed_rule_sources)
    ? runtimeConfig.collections?.allowed_rule_sources ?? []
    : ["product_type", "guide_metafields"];
  if (!allowedSources.includes("guide_metafields")) return [];

  const recommended = getGuideAgenticRecommendedMetafields(policy).map((item) => ({
    namespace: item.namespace,
    key: item.key,
    type: item.type,
    value: ""
  }));

  const seed = recommended.length > 0 ? recommended : getGuideMetafields(policy);
  return seed
    .map((item) => ({
      namespace: String(item.namespace ?? "").trim(),
      key: String(item.key ?? "").trim(),
      type: String(item.type ?? "").trim(),
      value: ""
    }))
    .filter((item) => item.namespace.length > 0 && item.key.length > 0 && isSupportedCollectionMetafieldType(item.type));
}

function getCollectionMinProducts(runtimeConfig: RuntimeConfig, explicitMin?: number): number {
  const value = explicitMin ?? Number(runtimeConfig.collections?.min_products_per_collection ?? 5);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 5;
}

function extractLedgerProducts(raw: unknown): LooseRecord[] {
  if (Array.isArray(raw)) return raw.filter((item): item is LooseRecord => Boolean(item) && typeof item === "object");
  if (raw && typeof raw === "object" && Array.isArray((raw as LooseRecord).products)) {
    return ((raw as LooseRecord).products as unknown[]).filter((item): item is LooseRecord => Boolean(item) && typeof item === "object");
  }
  return [];
}

export async function loadCollectionLedgerProducts(root: string): Promise<LooseRecord[]> {
  const paths = getCatalogPaths(root);
  const ledger = await readJson<LooseRecord | LooseRecord[]>(paths.generatedWorkflowProductsJson, { products: [] });
  const fromLedger = extractLedgerProducts(ledger);
  if (fromLedger.length > 0) return fromLedger;

  if (!(await exists(paths.generatedProductsDir))) return [];
  const files = await fs.readdir(paths.generatedProductsDir);
  const products: LooseRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const product = await readJson<LooseRecord>(path.join(paths.generatedProductsDir, file), {});
    if (Object.keys(product).length > 0) products.push(product);
  }
  return products;
}

export async function buildCollectionSourceSummary(args: {
  root: string;
  policy: PolicyDocument;
  runtimeConfig: RuntimeConfig;
  minProducts?: number;
}): Promise<CollectionSourceSummary> {
  const products = await loadCollectionLedgerProducts(args.root);
  const minProducts = getCollectionMinProducts(args.runtimeConfig, args.minProducts);
  const allowedSources = Array.isArray(args.runtimeConfig.collections?.allowed_rule_sources)
    ? args.runtimeConfig.collections?.allowed_rule_sources ?? []
    : ["product_type", "guide_metafields"];
  const sourceMap = new Map<string, CollectionSummaryEntry>();
  const skippedMap = new Map<string, CollectionSummaryEntry & { skipped_reason: string }>();
  const allowedMetafields = getAllowedGuideMetafields(args.policy, args.runtimeConfig);
  const allowedMetafieldKeys = new Set(allowedMetafields.map((item) => `${item.namespace}.${item.key}`));

  const pushEntry = (entry: Omit<CollectionSummaryEntry, "product_count" | "product_ids" | "product_keys">, product: LooseRecord) => {
    const productId: string = typeof product.id === "string" ? product.id : getProductKey(product, "product");
    const productKey: string = getProductKey(product, "product");
    const entryId = String(entry.id);
    const existing = sourceMap.get(entryId);
    if (existing) {
      existing.product_count += 1;
      if (!existing.product_ids.includes(productId)) existing.product_ids.push(productId);
      if (!existing.product_keys.includes(productKey)) existing.product_keys.push(productKey);
      return;
    }
    sourceMap.set(entryId, {
      ...entry,
      id: entryId,
      product_count: 1,
      product_ids: [productId],
      product_keys: [productKey]
    } as CollectionSummaryEntry);
  };

  for (const product of products) {
    const productType = typeof product.product_type === "string" ? product.product_type.trim() : "";
    if (allowedSources.includes("product_type") && productType) {
      const normalizedValue = normalizeValue(productType);
      pushEntry({
        id: buildSourceId("product_type", "product_type", normalizedValue),
        source_type: "product_type",
        source_key: "product_type",
        source_label: "Product type",
        source_value: productType,
        normalized_value: normalizedValue
      }, product);
    }

    const metafields = Array.isArray(product.metafields)
      ? product.metafields.filter((item): item is ProductMetafieldValue => Boolean(item) && typeof item === "object")
      : [];
    for (const metafield of metafields) {
      const sourceKey = `${String(metafield.namespace ?? "").trim()}.${String(metafield.key ?? "").trim()}`;
      if (!allowedMetafieldKeys.has(sourceKey)) continue;
      const values = extractMetafieldValues(metafield);
      if (values.length === 0) {
        const id = buildSourceId("metafield", sourceKey, "");
        if (!skippedMap.has(id)) {
          skippedMap.set(id, {
            id,
            source_type: "metafield",
            source_key: sourceKey,
            source_label: `${humanizeKey(String(metafield.namespace ?? ""))} / ${humanizeKey(String(metafield.key ?? ""))}`,
            namespace: String(metafield.namespace ?? "").trim(),
            key: String(metafield.key ?? "").trim(),
            metafield_type: String(metafield.type ?? "").trim(),
            source_value: "",
            normalized_value: "",
            product_count: 0,
            product_ids: [],
            product_keys: [],
            skipped_reason: "unsupported_or_empty_value"
          });
        }
        continue;
      }

      for (const value of values) {
        const normalizedValue = normalizeValue(value);
        pushEntry({
          id: buildSourceId("metafield", sourceKey, normalizedValue),
          source_type: "metafield",
          source_key: sourceKey,
          source_label: `${humanizeKey(String(metafield.namespace ?? ""))} / ${humanizeKey(String(metafield.key ?? ""))}`,
          namespace: String(metafield.namespace ?? "").trim(),
          key: String(metafield.key ?? "").trim(),
          metafield_type: String(metafield.type ?? "").trim(),
          source_value: value,
          normalized_value: normalizedValue
        }, product);
      }
    }
  }

  const candidates: CollectionSummaryEntry[] = [];
  const skipped: Array<CollectionSummaryEntry & { skipped_reason: string }> = [...skippedMap.values()];

  for (const entry of [...sourceMap.values()].sort((left, right) => right.product_count - left.product_count || left.source_label.localeCompare(right.source_label))) {
    if (entry.product_count < minProducts) {
      skipped.push({
        ...entry,
        skipped_reason: `below_minimum_${minProducts}`
      });
      continue;
    }
    candidates.push(entry);
  }

  return {
    generated_at: new Date().toISOString(),
    total_products_analyzed: products.length,
    min_products_per_collection: minProducts,
    allowed_rule_sources: allowedSources,
    candidates,
    skipped
  };
}

export async function loadCollectionRegistry(root: string): Promise<CollectionRegistryEntry[]> {
  const paths = getCatalogPaths(root);
  const payload = await readJson<{ entries?: CollectionRegistryEntry[] } | CollectionRegistryEntry[]>(paths.generatedCollectionsRegistryJson, { entries: [] });
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload.entries) ? payload.entries : [];
}

export async function saveCollectionRegistry(root: string, entries: CollectionRegistryEntry[]): Promise<{ jsonPath: string; csvPath: string }> {
  const paths = getCatalogPaths(root);
  await ensureDir(paths.generatedCollectionsDir);
  const sorted = [...entries].sort((left, right) => left.title.localeCompare(right.title));
  await writeJson(paths.generatedCollectionsRegistryJson, {
    generated_at: new Date().toISOString(),
    count: sorted.length,
    entries: sorted
  });

  const header = [
    "id",
    "title",
    "handle",
    "source_type",
    "source_key",
    "source_label",
    "source_value",
    "product_count",
    "status",
    "shopify_id",
    "duplicate_of",
    "created_at",
    "updated_at"
  ];
  const rows = sorted.map((entry) => ([
    entry.id,
    entry.title,
    entry.handle,
    entry.source_type,
    entry.source_key,
    entry.source_label,
    entry.source_value,
    entry.product_count,
    entry.status,
    entry.shopify_id ?? "",
    entry.duplicate_of ?? "",
    entry.created_at,
    entry.updated_at
  ].map(csvEscape).join(",")));
  await writeText(paths.generatedCollectionsRegistryCsv, `${header.join(",")}\n${rows.join("\n")}\n`);
  return { jsonPath: paths.generatedCollectionsRegistryJson, csvPath: paths.generatedCollectionsRegistryCsv };
}

export async function saveCollectionSummary(root: string, summary: CollectionSourceSummary): Promise<string> {
  const paths = getCatalogPaths(root);
  await writeJson(paths.generatedCollectionsSummaryJson, summary);
  return paths.generatedCollectionsSummaryJson;
}

export async function loadCollectionSummary(root: string): Promise<CollectionSourceSummary | null> {
  const paths = getCatalogPaths(root);
  return readJson<CollectionSourceSummary | null>(paths.generatedCollectionsSummaryJson, null);
}

export async function saveCollectionProposals(root: string, proposals: CollectionProposal[]): Promise<string> {
  const paths = getCatalogPaths(root);
  await writeJson(paths.generatedCollectionsProposalsJson, {
    generated_at: new Date().toISOString(),
    count: proposals.length,
    proposals
  });
  return paths.generatedCollectionsProposalsJson;
}

export async function loadCollectionProposals(root: string): Promise<CollectionProposal[]> {
  const paths = getCatalogPaths(root);
  const payload = await readJson<{ proposals?: CollectionProposal[] } | CollectionProposal[]>(paths.generatedCollectionsProposalsJson, { proposals: [] });
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload.proposals) ? payload.proposals : [];
}

export async function saveCollectionApplyResults(root: string, results: CollectionApplyResult[]): Promise<string> {
  const paths = getCatalogPaths(root);
  await writeJson(paths.generatedCollectionsApplyJson, {
    generated_at: new Date().toISOString(),
    count: results.length,
    results
  });
  return paths.generatedCollectionsApplyJson;
}

export function buildCollectionCandidate(entry: CollectionSummaryEntry, runtimeConfig: RuntimeConfig, minProducts?: number): CollectionCandidate {
  return {
    ...entry,
    min_products_per_collection: getCollectionMinProducts(runtimeConfig, minProducts)
  };
}

export function findCollectionRegistryDuplicate(
  candidate: { source_type: "product_type" | "metafield"; source_key: string; source_value: string; handle?: string },
  registry: CollectionRegistryEntry[]
): CollectionRegistryEntry | null {
  const candidateIdentity = buildRegistryIdentity(candidate);
  const candidateHandle = candidate.handle ? slugify(candidate.handle) : "";
  for (const entry of registry) {
    if (buildRegistryIdentity(entry) === candidateIdentity) return entry;
    if (candidateHandle && slugify(entry.handle) === candidateHandle) return entry;
  }
  return null;
}

export function dedupeCollectionCandidates(entries: CollectionSummaryEntry[]): CollectionSummaryEntry[] {
  const seen = new Set<string>();
  const deduped: CollectionSummaryEntry[] = [];
  for (const entry of entries) {
    const identity = buildRegistryIdentity(entry);
    if (seen.has(identity)) continue;
    seen.add(identity);
    deduped.push(entry);
  }
  return deduped;
}

export function buildRegistryEntryFromProposal(
  proposal: CollectionProposal,
  status: CollectionRegistryEntry["status"],
  overrides: Partial<CollectionRegistryEntry> = {}
): CollectionRegistryEntry {
  const now = new Date().toISOString();
  return {
    id: proposal.id,
    title: proposal.title,
    handle: proposal.handle,
    source_type: proposal.source_type,
    source_key: proposal.source_key,
    source_label: proposal.source_label,
    ...(proposal.namespace ? { namespace: proposal.namespace } : {}),
    ...(proposal.key ? { key: proposal.key } : {}),
    source_value: proposal.source_value,
    normalized_value: proposal.normalized_value,
    product_count: proposal.product_count,
    status,
    rule: proposal.rule,
    rationale: proposal.rationale,
    created_at: proposal.created_at,
    updated_at: now,
    ...overrides
  };
}

export function mergeCollectionRegistryEntries(
  existing: CollectionRegistryEntry[],
  incoming: CollectionRegistryEntry[]
): CollectionRegistryEntry[] {
  const merged = new Map<string, CollectionRegistryEntry>();
  for (const entry of existing) {
    merged.set(buildProposalIdentity({
      handle: entry.handle,
      source_type: entry.source_type,
      source_key: entry.source_key,
      source_value: entry.source_value
    }), entry);
  }
  for (const entry of incoming) {
    const key = buildProposalIdentity({
      handle: entry.handle,
      source_type: entry.source_type,
      source_key: entry.source_key,
      source_value: entry.source_value
    });
    const current = merged.get(key);
    merged.set(key, current ? { ...current, ...entry, updated_at: entry.updated_at ?? current.updated_at } : entry);
  }
  return [...merged.values()];
}

export function createSkippedDuplicateProposal(
  candidate: CollectionCandidate,
  duplicateOf: CollectionRegistryEntry
): CollectionProposal {
  const now = new Date().toISOString();
  return {
    id: `${candidate.id}-duplicate`,
    candidate_id: candidate.id,
    title: duplicateOf.title,
    handle: duplicateOf.handle,
    description_html: "",
    rationale: "Skipped because an equivalent collection already exists in the local registry.",
    source_type: candidate.source_type,
    source_key: candidate.source_key,
    source_label: candidate.source_label,
    ...(candidate.namespace ? { namespace: candidate.namespace } : {}),
    ...(candidate.key ? { key: candidate.key } : {}),
    source_value: candidate.source_value,
    normalized_value: candidate.normalized_value,
    product_count: candidate.product_count,
    product_ids: candidate.product_ids,
    product_keys: candidate.product_keys,
    rule: buildRuleForEntry(candidate),
    evaluator_decision: "APPROVE",
    evaluation: {
      decision: "APPROVE",
      summary: "Skipped duplicate proposal because the collection already exists locally.",
      reasons: [`Matched registry entry ${duplicateOf.id}`],
      retry_instructions: []
    },
    status: "skipped_duplicate",
    duplicate_of: duplicateOf.id,
    attempts: { builder: [], evaluator: [] },
    created_at: now,
    updated_at: now
  };
}

export function buildCollectionRuleForCandidate(candidate: CollectionCandidate, conditionObjectId?: string): CollectionRule {
  return buildRuleForEntry(candidate, conditionObjectId);
}
