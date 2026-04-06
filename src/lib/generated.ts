import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { materializeProposedChanges } from "./change-records.js";
import { ensureDir, readJson, writeJson, writeText } from "./fs.js";
import { getCatalogPaths } from "./paths.js";
import { dedupeTitleLikeText, deriveSeoDescription, deriveSeoTitle, normalizeDescriptionPair } from "./product.js";
import type { LooseRecord, ModuleResult, PolicyDocument, ProductRecord, ProductVariant, WorkflowRunSummary } from "../types.js";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "record";
}

export function getProductKey(record: LooseRecord, fallback = "product"): string {
  const candidates = [
    record.product_id,
    record.id,
    record.sku,
    record.handle,
    record.title
  ].filter((value) => typeof value === "string" && value.trim().length > 0) as string[];

  return slugify(candidates[0] ?? fallback);
}

export function buildGeneratedProduct(input: ProductRecord, result: ModuleResult): LooseRecord {
  const merged: LooseRecord = { ...input };
  const materializedChanges = materializeProposedChanges(result.proposed_changes);
  for (const [key, value] of Object.entries(materializedChanges)) {
    if (
      key === "shopify_payload" ||
      key === "image_search" ||
      key === "image_review" ||
      key === "image_task" ||
      key === "live_apply_ready" ||
      key === "target_store" ||
      key === "variant_count" ||
      key === "missing_fields" ||
      key === "policy_findings" ||
      key === "success_criteria_summary"
    ) {
      continue;
    }
    merged[key] = value;
  }

  if (!merged.handle && typeof merged.title === "string") {
    merged.handle = slugify(merged.title);
  }

  if (result.proposed_changes?.image_review) {
    merged._catalog_image_review = result.proposed_changes.image_review;
  }

  if (result.proposed_changes?.image_search) {
    merged._catalog_image_search = result.proposed_changes.image_search;
  }

  const matchDecision = typeof (merged._catalog_match as LooseRecord | undefined)?.decision === "string"
    ? String((merged._catalog_match as LooseRecord).decision).toUpperCase()
    : "";
  const matchedHandle = typeof (merged._catalog_match as LooseRecord | undefined)?.matched_product_handle === "string"
    ? String((merged._catalog_match as LooseRecord).matched_product_handle).trim()
    : "";
  if (matchDecision === "NEW_VARIANT" && matchedHandle) {
    merged.handle = matchedHandle;
  }

  merged._catalog = {
    last_module: result.module,
    last_job_id: result.job_id,
    status: result.status,
    needs_review: result.needs_review,
    updated_at: new Date().toISOString()
  };

  const stageMetrics = merged._catalog_stage_metrics && typeof merged._catalog_stage_metrics === "object" && !Array.isArray(merged._catalog_stage_metrics)
    ? merged._catalog_stage_metrics as LooseRecord
    : {};
  stageMetrics[result.module] = {
    job_id: result.job_id,
    status: result.status,
    needs_review: result.needs_review,
    provider_usage: result.artifacts?.provider_usage ?? null,
    provider_cost: result.artifacts?.provider_cost ?? null,
    agent_run: result.agent_run ?? null,
    updated_at: new Date().toISOString()
  };
  merged._catalog_stage_metrics = stageMetrics;

  return merged;
}

export async function persistGeneratedProduct(root: string, product: LooseRecord, fallbackKey = "product"): Promise<string> {
  const paths = getCatalogPaths(root);
  const productKey = getProductKey(product, fallbackKey);
  const targetPath = path.join(paths.generatedProductsDir, `${productKey}.json`);
  await writeJson(targetPath, product);
  return targetPath;
}

function inferImageExtension(urlValue: string): string {
  try {
    const parsed = new URL(urlValue);
    const extension = path.extname(parsed.pathname).toLowerCase();
    if (extension && extension.length <= 5) return extension;
  } catch {
    return ".jpg";
  }
  return ".jpg";
}

async function tryDownloadImage(urlValue: string, outputPath: string): Promise<void> {
  const response = await fetch(urlValue);
  if (!response.ok) {
    throw new Error(`Image download failed: ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, bytes);
}

export async function persistGeneratedImageArtifacts(
  root: string,
  product: LooseRecord,
  result: ModuleResult
): Promise<{ directory: string; metadataPath: string }> {
  const paths = getCatalogPaths(root);
  const productKey = getProductKey(product, result.job_id);
  const directory = path.join(paths.generatedImagesDir, productKey);
  await ensureDir(directory);

  const featuredImage = typeof result.proposed_changes?.featured_image === "string"
    ? result.proposed_changes.featured_image
    : typeof product.featured_image === "string"
      ? product.featured_image
      : Array.isArray(product.images) && typeof product.images[0] === "string"
        ? product.images[0]
        : undefined;

  const metadata: LooseRecord = {
    product_key: productKey,
    job_id: result.job_id,
    module: result.module,
    generated_at: new Date().toISOString(),
    selected_image_url: featuredImage ?? null,
    image_review: result.proposed_changes?.image_review ?? null,
    image_search: result.proposed_changes?.image_search ?? null,
    warnings: result.warnings ?? []
  };

  if (featuredImage && /^https?:\/\//i.test(featuredImage)) {
    const extension = inferImageExtension(featuredImage);
    const localImagePath = path.join(directory, `selected${extension}`);
    try {
      await tryDownloadImage(featuredImage, localImagePath);
      metadata.local_image_path = localImagePath;
    } catch (error) {
      metadata.download_error = error instanceof Error ? error.message : String(error);
    }
  }

  const metadataPath = path.join(directory, "metadata.json");
  await writeJson(metadataPath, metadata);
  return { directory, metadataPath };
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

const SHOPIFY_IMPORT_HEADER = [
  "Title",
  "URL handle",
  "Description",
  "Vendor",
  "Product category",
  "Type",
  "Tags",
  "Published on online store",
  "Status",
  "SKU",
  "Barcode",
  "Option1 name",
  "Option1 value",
  "Option1 LinkedTo",
  "Option2 name",
  "Option2 value",
  "Option2 LinkedTo",
  "Option3 name",
  "Option3 value",
  "Option3 LinkedTo",
  "Price",
  "Compare-at price",
  "Cost per item",
  "Charge tax",
  "Inventory tracker",
  "Inventory quantity",
  "Continue selling when out of stock",
  "Weight value (grams)",
  "Weight unit for display",
  "Requires shipping",
  "Fulfillment service",
  "Product image URL",
  "Image position",
  "Image alt text",
  "Variant image URL",
  "Gift card",
  "SEO title",
  "SEO description",
  "Google Shopping / Google Product Category"
] as const;

export async function writeReviewQueueCsv(root: string, runs: WorkflowRunSummary[]): Promise<string> {
  const paths = getCatalogPaths(root);
  const header = [
    "product_key",
    "source_record_id",
    "generated_product_path",
    "generated_image_dir",
    "selected_image_url",
    "local_image_path",
    "match_job_id",
    "enrich_job_id",
    "image_job_id",
    "qa_job_id",
    "qa_status",
    "sync_job_id",
    "sync_status",
    "needs_review"
  ];

  const rows = runs.map((run) => {
    const moduleMap = Object.fromEntries(run.modules.map((module) => [module.module, module]));
    const needsReview = run.modules.some((module) => module.needs_review);
    return [
      run.product_key,
      run.source_record_id,
      run.generated_product_path,
      run.generated_image_dir,
      run.selected_image_url ?? "",
      run.local_image_path ?? "",
      moduleMap["catalogue-match"]?.job_id ?? "",
      moduleMap["product-enricher"]?.job_id ?? "",
      moduleMap["image-optimizer"]?.job_id ?? "",
      moduleMap["catalogue-qa"]?.job_id ?? "",
      moduleMap["catalogue-qa"]?.status ?? "",
      moduleMap["shopify-sync"]?.job_id ?? "",
      moduleMap["shopify-sync"]?.status ?? "",
      needsReview ? "yes" : "no"
    ].map(csvEscape).join(",");
  });

  await writeText(paths.generatedReviewCsv, `${header.join(",")}\n${rows.join("\n")}\n`);
  return paths.generatedReviewCsv;
}

export async function writePendingReviewQueueCsv(
  root: string,
  rows: Array<Record<string, string>>
): Promise<string> {
  const paths = getCatalogPaths(root);
  const header = [
    "Product Key",
    "Module",
    "Job ID",
    "Status",
    "Generated Product Path",
    "Suggested Command",
    "Notes"
  ];

  const csvRows = rows.map((row) => header.map((column) => csvEscape(row[column] ?? "")).join(","));
  await writeText(paths.generatedReviewCsv, `${header.join(",")}\n${csvRows.join("\n")}\n`);
  return paths.generatedReviewCsv;
}

export async function writeWorkflowProductsLedger(root: string, products: LooseRecord[]): Promise<string> {
  const paths = getCatalogPaths(root);
  await writeJson(paths.generatedWorkflowProductsJson, {
    generated_at: new Date().toISOString(),
    count: products.length,
    products
  });
  return paths.generatedWorkflowProductsJson;
}

export async function writeWorkflowCostReport(root: string, runs: WorkflowRunSummary[]): Promise<string> {
  const paths = getCatalogPaths(root);
  const stages = runs.flatMap((run) =>
    (run.cost_summary?.stages ?? []).map((stage) => ({
      product_key: run.product_key,
      source_record_id: run.source_record_id,
      ...stage
    }))
  );
  await writeJson(paths.generatedWorkflowCostsJson, {
    generated_at: new Date().toISOString(),
    workflow_count: runs.length,
    total_tokens: runs.reduce((sum, run) => sum + Number(run.cost_summary?.total_tokens ?? 0), 0),
    estimated_total_cost_usd: Number(
      runs.reduce((sum, run) => sum + Number(run.cost_summary?.estimated_total_cost_usd ?? 0), 0).toFixed(6)
    ),
    runs: runs.map((run) => ({
      product_key: run.product_key,
      source_record_id: run.source_record_id,
      cost_summary: run.cost_summary ?? null
    })),
    stages
  });
  return paths.generatedWorkflowCostsJson;
}

function toShopifyBoolean(value: unknown, fallback = "TRUE"): string {
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return "TRUE";
    if (value.toLowerCase() === "false") return "FALSE";
  }
  return fallback;
}

function normalizeTags(tags: unknown): string {
  if (!Array.isArray(tags)) return "";
  return tags.filter((item) => typeof item === "string" && item.trim().length > 0).join(", ");
}

function getVendor(product: LooseRecord): string {
  if (typeof product.vendor === "string" && product.vendor.trim()) return product.vendor.trim();
  if (typeof product.brand === "string" && product.brand.trim()) return product.brand.trim();
  return "";
}

function normalizeMetafields(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((item): item is LooseRecord => Boolean(item) && typeof item === "object")
    .map((item) => {
      const namespace = typeof item.namespace === "string" ? item.namespace : "";
      const key = typeof item.key === "string" ? item.key : "";
      const metafieldValue = typeof item.value === "string" ? item.value : "";
      return namespace && key ? `${namespace}.${key}=${metafieldValue}` : "";
    })
    .filter(Boolean)
    .join("; ");
}

type ShopifyCsvMetafieldColumn = {
  header: string;
  namespace: string;
  key: string;
};

function toTitleCase(input: string): string {
  return input
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function collectShopifyCsvMetafieldColumns(products: LooseRecord[], policy?: PolicyDocument): ShopifyCsvMetafieldColumn[] {
  const seen = new Set<string>();
  const columns: ShopifyCsvMetafieldColumn[] = [];

  const appendColumn = (namespace: unknown, key: unknown) => {
    if (typeof namespace !== "string" || typeof key !== "string") return;
    const normalizedNamespace = namespace.trim();
    const normalizedKey = key.trim();
    if (!normalizedNamespace || !normalizedKey) return;
    const identifier = `${normalizedNamespace}.${normalizedKey}`;
    if (seen.has(identifier)) return;
    seen.add(identifier);
    columns.push({
      header: `${toTitleCase(normalizedKey)} (product.metafields.${normalizedNamespace}.${normalizedKey})`,
      namespace: normalizedNamespace,
      key: normalizedKey
    });
  };

  for (const metafield of policy?.attributes_metafields_schema?.metafields ?? []) {
    appendColumn(metafield.namespace, metafield.key);
  }

  for (const product of products) {
    const metafields = Array.isArray(product.metafields) ? product.metafields : [];
    for (const metafield of metafields) {
      if (!metafield || typeof metafield !== "object") continue;
      appendColumn((metafield as LooseRecord).namespace, (metafield as LooseRecord).key);
    }
  }

  return columns;
}

function buildProductMetafieldMap(product: LooseRecord): Map<string, string> {
  const values = new Map<string, string>();
  const metafields = Array.isArray(product.metafields) ? product.metafields : [];
  for (const metafield of metafields) {
    if (!metafield || typeof metafield !== "object") continue;
    const record = metafield as LooseRecord;
    if (typeof record.namespace !== "string" || typeof record.key !== "string") continue;
    values.set(`${record.namespace}.${record.key}`, typeof record.value === "string" ? record.value : String(record.value ?? ""));
  }
  return values;
}

function getVariantRows(product: LooseRecord, policy?: PolicyDocument): ProductVariant[] {
  if (Array.isArray(product.variants) && product.variants.length > 0) {
    return product.variants as ProductVariant[];
  }

  return [
    {
      title: "Default Title",
      sku: typeof product.sku === "string" ? product.sku : "",
      barcode: typeof product.barcode === "string" ? product.barcode : "",
      option1: "Default Title",
      option2: "",
      option3: ""
    }
  ];
}

function getCatalogMatch(product: LooseRecord): LooseRecord | null {
  const match = product._catalog_match;
  return match && typeof match === "object" ? match as LooseRecord : null;
}

function getAttachedVariantOptionValues(product: LooseRecord): Array<{ name: string; value: string }> {
  if (!isAttachedVariant(product)) return [];
  const match = getCatalogMatch(product);
  const action = match?.proposed_action && typeof match.proposed_action === "object"
    ? match.proposed_action as LooseRecord
    : null;
  return Array.isArray(action?.option_values)
    ? action.option_values
        .filter((item): item is LooseRecord => Boolean(item) && typeof item === "object")
        .map((item) => ({
          name: String(item.name ?? "").trim(),
          value: String(item.value ?? "").trim()
        }))
        .filter((item) => item.name.length > 0 && item.value.length > 0)
    : [];
}

function isAttachedVariant(product: LooseRecord): boolean {
  const match = getCatalogMatch(product);
  const decision = String(match?.decision ?? "").toUpperCase();
  const action = match?.proposed_action && typeof match.proposed_action === "object"
    ? match.proposed_action as LooseRecord
    : null;
  return decision === "NEW_VARIANT" && String(action?.action ?? "") === "attach_as_variant";
}

function getAttachedVariantRows(product: LooseRecord, optionNames: string[] = []): ProductVariant[] {
  if (!isAttachedVariant(product)) return [];
  const existing = getVariantRows(product);
  if (existing.length > 0 && existing.some((variant) => [variant.option1, variant.option2, variant.option3].some((value) => typeof value === "string" && value.trim() && value.trim().toLowerCase() !== "default title"))) {
    return existing;
  }

  const optionValues = getAttachedVariantOptionValues(product);
  const resolvedOptionNames = optionNames.length > 0
    ? optionNames
    : optionValues.map((item) => item.name);
  const valueByName = new Map(optionValues.map((item) => [item.name.toLowerCase(), item.value]));
  const values = resolvedOptionNames
    .map((name) => valueByName.get(name.toLowerCase()) ?? "")
    .filter(Boolean);

  return [{
    title: values.join(" / ") || "Variant",
    sku: typeof product.sku === "string" ? product.sku : "",
    barcode: typeof product.barcode === "string" ? product.barcode : "",
    option1: values[0] ?? "Default Title",
    option2: values[1] ?? "",
    option3: values[2] ?? "",
    price: typeof product.price === "string" ? product.price : "",
    compare_at_price: typeof product.compare_at_price === "string" ? product.compare_at_price : ""
  }];
}

function getLooseString(record: LooseRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferOptionValueFromTitle(title: string, candidates: string[]): string {
  const sorted = [...new Set(candidates.map((item) => item.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  for (const candidate of sorted) {
    const pattern = new RegExp(`(^|[\\s\\-\\/(])${escapeRegex(candidate)}(?=([\\s\\-\\)/,]|$))`, "i");
    if (pattern.test(title)) return candidate;
  }
  return "";
}

function normalizeFamilyTitle(title: string, optionValues: string[]): string {
  let normalized = title;
  const sorted = [...new Set(optionValues.map((item) => item.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);

  for (const value of sorted) {
    const escaped = escapeRegex(value);
    normalized = normalized
      .replace(new RegExp(`\\s*\\(${escaped}\\)`, "ig"), " ")
      .replace(new RegExp(`(^|[\\s\\-/,])${escaped}(?=([\\s\\-/,]|$))`, "ig"), "$1");
  }

  return normalized
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,/])/g, "$1")
    .replace(/[-/,]\s*$/g, "")
    .trim() || title;
}

function getOptionValueFromProduct(
  product: LooseRecord,
  optionName: string,
  familyCandidates: string[] = []
): string {
  const normalized = optionName.toLowerCase().replace(/\s+/g, "");
  const dimensionMap: Record<string, string> = {
    size: getLooseString(product, "size"),
    type: getLooseString(product, "type"),
    color: getLooseString(product, "color"),
    storage: getLooseString(product, "storage"),
    packsize: getLooseString(product, "pack_size", "packsize", "size"),
    "pack size": getLooseString(product, "pack_size", "packsize", "size"),
    flavor: getLooseString(product, "flavor", "type")
  };

  const explicit = dimensionMap[normalized] ?? getLooseString(product, normalized, optionName);
  if (explicit) return explicit;

  const title = getLooseString(product, "title");
  if (!title || familyCandidates.length === 0) return "";
  return inferOptionValueFromTitle(title, familyCandidates);
}

function buildImplicitVariantRows(
  product: LooseRecord,
  optionNames: string[],
  familyOptionValues: Map<string, string[]> = new Map()
): ProductVariant[] {
  const values = optionNames
    .map((dimension) => getOptionValueFromProduct(product, dimension, familyOptionValues.get(dimension.toLowerCase()) ?? []))
    .filter((value) => typeof value === "string" && value.trim().length > 0);

  if (values.length === 0) return getVariantRows(product);

  return [{
    title: values.join(" / "),
    sku: typeof product.sku === "string" ? product.sku : "",
    barcode: typeof product.barcode === "string" ? product.barcode : "",
    option1: values[0] ?? "Default Title",
    option2: values[1] ?? "",
    option3: values[2] ?? "",
    price: typeof product.price === "string" ? product.price : "",
    compare_at_price: typeof product.compare_at_price === "string" ? product.compare_at_price : ""
  }];
}

function resolveVariantBaseProduct(product: LooseRecord, productById: Map<string, LooseRecord>): LooseRecord {
  if (!isAttachedVariant(product)) return product;
  const match = getCatalogMatch(product);
  const action = match?.proposed_action && typeof match.proposed_action === "object"
    ? match.proposed_action as LooseRecord
    : null;
  const matchedProductId = String(match?.matched_product_id ?? action?.product_id ?? "").trim();
  const parent = matchedProductId ? productById.get(matchedProductId) : null;
  if (parent) return parent;

  return {
    ...product,
    title: String(action?.product_title ?? product.title ?? ""),
    handle: String(action?.product_handle ?? product.handle ?? ""),
    vendor: typeof product.vendor === "string" && product.vendor.trim() ? product.vendor : product.brand ?? "",
    brand: typeof product.brand === "string" && product.brand.trim() ? product.brand : product.vendor ?? ""
  };
}

function getProductFamilyKey(product: LooseRecord): string {
  const match = getCatalogMatch(product);
  if (match) {
    const action = match.proposed_action && typeof match.proposed_action === "object"
      ? match.proposed_action as LooseRecord
      : null;
    const matchedProductId = String(match.matched_product_id ?? action?.product_id ?? "").trim();
    if (matchedProductId) return `id:${matchedProductId}`;
    const matchedHandle = String(match.matched_product_handle ?? action?.product_handle ?? "").trim();
    if (matchedHandle) return `handle:${matchedHandle}`;
    const matchedTitle = String(match.matched_product_title ?? action?.product_title ?? "").trim();
    if (matchedTitle) return `title:${normalizeDescriptionPair(matchedTitle).description}`;
  }
  if (typeof product.id === "string" && product.id.trim()) return `id:${product.id}`;
  if (typeof product.handle === "string" && product.handle.trim()) return `handle:${product.handle}`;
  if (typeof product.title === "string" && product.title.trim()) return `title:${product.title}`;
  return `generated:${getProductKey(product, "product")}`;
}

function hasMeaningfulVariantOptions(variants: ProductVariant[]): boolean {
  return variants.some((variant) => {
    const values = [variant.option1, variant.option2, variant.option3]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    return values.some((value) => value.toLowerCase() !== "default title");
  });
}

function collectFamilyAttachedOptionNames(products: LooseRecord[]): Map<string, string[]> {
  const namesByFamily = new Map<string, string[]>();
  for (const product of products) {
    if (!isAttachedVariant(product)) continue;
    const familyKey = getProductFamilyKey(product);
    const names = getAttachedVariantOptionValues(product)
      .map((item) => item.name)
      .filter(Boolean);
    if (names.length === 0) continue;

    const existing = namesByFamily.get(familyKey) ?? [];
    for (const name of names) {
      if (!existing.some((item) => item.toLowerCase() === name.toLowerCase())) {
        existing.push(name);
      }
    }
    namesByFamily.set(familyKey, existing);
  }
  return namesByFamily;
}

function collectFamilyOptionValues(
  products: LooseRecord[],
  namesByFamily: Map<string, string[]>
): Map<string, Map<string, string[]>> {
  const valuesByFamily = new Map<string, Map<string, string[]>>();

  const upsert = (familyKey: string, optionName: string, optionValue: string) => {
    const trimmedName = optionName.trim();
    const trimmedValue = optionValue.trim();
    if (!trimmedName || !trimmedValue || trimmedValue.toLowerCase() === "default title") return;

    const familyMap = valuesByFamily.get(familyKey) ?? new Map<string, string[]>();
    const existing = familyMap.get(trimmedName.toLowerCase()) ?? [];
    if (!existing.some((item) => item.toLowerCase() === trimmedValue.toLowerCase())) {
      existing.push(trimmedValue);
    }
    familyMap.set(trimmedName.toLowerCase(), existing);
    valuesByFamily.set(familyKey, familyMap);
  };

  for (const product of products) {
    const familyKey = getProductFamilyKey(product);
    const configuredNames = namesByFamily.get(familyKey) ?? [];
    for (const option of getAttachedVariantOptionValues(product)) {
      upsert(familyKey, option.name, option.value);
    }
    for (const optionName of configuredNames) {
      const explicit = getOptionValueFromProduct(product, optionName);
      if (explicit) upsert(familyKey, optionName, explicit);
    }
  }

  return valuesByFamily;
}

function buildShopifyCsvRows(products: LooseRecord[], metafieldColumns: ShopifyCsvMetafieldColumn[], policy?: PolicyDocument): string[][] {
  const rows: string[][] = [];
  const productById = new Map<string, LooseRecord>();
  const familiesWithAttachedVariants = new Set<string>();
  const familyOptionNames = collectFamilyAttachedOptionNames(products);
  const familyOptionValues = collectFamilyOptionValues(products, familyOptionNames);
  for (const product of products) {
    const candidates = [product.id, product.product_id, product.handle, getProductKey(product, "product")];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        productById.set(candidate, product);
      }
    }
    if (isAttachedVariant(product)) {
      familiesWithAttachedVariants.add(getProductFamilyKey(product));
    }
  }

  for (const product of products) {
    const baseProduct = resolveVariantBaseProduct(product, productById);
    const configuredDimensions = Array.isArray(policy?.variant_structure?.primary_dimensions)
      ? policy.variant_structure.primary_dimensions.map(String)
      : [];
    const familyUsesAttachedVariants = familiesWithAttachedVariants.has(getProductFamilyKey(product));
    const resolvedOptionNames = familyOptionNames.get(getProductFamilyKey(product)) ?? configuredDimensions;
    const resolvedOptionValues = familyOptionValues.get(getProductFamilyKey(product)) ?? new Map<string, string[]>();
    const variants = isAttachedVariant(product)
      ? getAttachedVariantRows(product, resolvedOptionNames)
      : familyUsesAttachedVariants
        ? buildImplicitVariantRows(product, resolvedOptionNames, resolvedOptionValues)
        : getVariantRows(product, policy);
    const useRealOptionNames = hasMeaningfulVariantOptions(variants);
    const option1Name = useRealOptionNames ? (resolvedOptionNames[0] ?? "Option1") : "Title";
    const option2Name = useRealOptionNames ? (resolvedOptionNames[1] ?? "") : "";
    const option3Name = useRealOptionNames ? (resolvedOptionNames[2] ?? "") : "";
    const images = Array.isArray(baseProduct.images) ? baseProduct.images.filter((item) => typeof item === "string") as string[] : [];
    const featuredImage = typeof baseProduct.featured_image === "string" ? baseProduct.featured_image : images[0] ?? "";
    const normalizedDescription = normalizeDescriptionPair(
      typeof baseProduct.description_html === "string" && baseProduct.description_html.trim().length > 0
        ? baseProduct.description_html
        : typeof baseProduct.description === "string"
          ? baseProduct.description
          : ""
    );
    const vendor = getVendor(baseProduct);
    const normalizedTitle = normalizeFamilyTitle(
      typeof baseProduct.title === "string" ? baseProduct.title : "",
      [
        ...(resolvedOptionValues.get(option1Name.toLowerCase()) ?? []),
        ...(resolvedOptionValues.get(option2Name.toLowerCase()) ?? []),
        ...(resolvedOptionValues.get(option3Name.toLowerCase()) ?? [])
      ]
    );
    const imageAltText = typeof baseProduct.image_alt_text === "string" && baseProduct.image_alt_text.trim().length > 0
      ? baseProduct.image_alt_text
      : (normalizedTitle.trim().length > 0
          ? normalizedTitle.trim()
          : dedupeTitleLikeText(vendor, typeof product.size === "string" ? product.size : "", typeof product.type === "string" ? product.type : ""));
    const handle = typeof baseProduct.handle === "string" && baseProduct.handle ? baseProduct.handle : getProductKey(baseProduct, "product");
    const metafieldMap = buildProductMetafieldMap(product);
    const seoTitle = deriveSeoTitle({ ...baseProduct, title: normalizedTitle || baseProduct.title });
    const seoDescription = deriveSeoDescription(baseProduct);
    const productCategory = getLooseString(baseProduct, "product_category", "category");
    const googleProductCategory = getLooseString(baseProduct, "google_product_category");

    variants.forEach((variant, index) => {
      rows.push([
        normalizedTitle || (typeof baseProduct.title === "string" ? baseProduct.title : ""),
        handle,
        normalizedDescription.description_html,
        vendor,
        productCategory,
        typeof baseProduct.product_type === "string" ? baseProduct.product_type : "",
        normalizeTags(baseProduct.tags),
        toShopifyBoolean(baseProduct["published_on_online_store"], "TRUE"),
        typeof baseProduct.status === "string" ? baseProduct.status : "active",
        typeof variant.sku === "string" ? variant.sku : "",
        typeof variant.barcode === "string" ? variant.barcode : "",
        option1Name,
        typeof variant.option1 === "string" && variant.option1 ? variant.option1 : "Default Title",
        "",
        option2Name,
        useRealOptionNames && typeof variant.option2 === "string" ? variant.option2 : "",
        "",
        option3Name,
        useRealOptionNames && typeof variant.option3 === "string" ? variant.option3 : "",
        "",
        typeof (variant as LooseRecord).price === "string" ? String((variant as LooseRecord).price) : typeof product.price === "string" ? product.price : "",
        typeof (variant as LooseRecord)["compare_at_price"] === "string"
          ? String((variant as LooseRecord)["compare_at_price"])
          : typeof product["compare_at_price"] === "string"
            ? String(product["compare_at_price"])
            : "",
        getLooseString(variant as LooseRecord, "cost_per_item") || getLooseString(product, "cost_per_item"),
        toShopifyBoolean((variant as LooseRecord).taxable ?? product["taxable"], "TRUE"),
        getLooseString(product, "inventory_tracker"),
        getLooseString(variant as LooseRecord, "inventory_quantity") || getLooseString(product, "inventory_quantity"),
        toShopifyBoolean((variant as LooseRecord)["continue_selling_when_out_of_stock"] ?? product["continue_selling_when_out_of_stock"], "FALSE"),
        getLooseString(variant as LooseRecord, "weight_value_grams") || getLooseString(product, "weight_value_grams", "grams"),
        getLooseString(variant as LooseRecord, "weight_unit") || getLooseString(product, "weight_unit"),
        toShopifyBoolean((variant as LooseRecord)["requires_shipping"] ?? product["requires_shipping"], "TRUE"),
        getLooseString(product, "fulfillment_service"),
        index === 0 ? featuredImage : "",
        index === 0 && featuredImage ? "1" : "",
        imageAltText,
        getLooseString(variant as LooseRecord, "image", "variant_image", "variant_image_url"),
        toShopifyBoolean(product["gift_card"], "FALSE"),
        seoTitle,
        seoDescription,
        googleProductCategory,
        ...metafieldColumns.map((column) => metafieldMap.get(`${column.namespace}.${column.key}`) ?? "")
      ]);
    });
  }

  return rows;
}

export async function writeShopifyImportCsv(root: string, products: LooseRecord[], policy?: PolicyDocument): Promise<string> {
  const paths = getCatalogPaths(root);
  const metafieldColumns = collectShopifyCsvMetafieldColumns(products, policy);
  const header = [...SHOPIFY_IMPORT_HEADER, ...metafieldColumns.map((column) => column.header)];

  const rows = buildShopifyCsvRows(products, metafieldColumns, policy).map((row) => row.map(csvEscape).join(","));
  await writeText(paths.generatedShopifyCsv, `${header.join(",")}\n${rows.join("\n")}\n`);
  return paths.generatedShopifyCsv;
}

export async function writeRejectedProductsCsv(
  root: string,
  products: Array<LooseRecord & { rejection_reason?: string; source_record_id?: string }>
): Promise<string> {
  const paths = getCatalogPaths(root);
  const header = [
    "Product Key",
    "Source Record ID",
    "Title",
    "Handle",
    "Vendor",
    "Product Type",
    "Reason",
    "Description"
  ];

  const rows = products.map((product) => ([
    getProductKey(product, "product"),
    String(product.source_record_id ?? ""),
    String(product.title ?? ""),
    String(product.handle ?? ""),
    getVendor(product),
    String(product.product_type ?? ""),
    String(product.rejection_reason ?? ""),
    normalizeDescriptionPair(String(product.description_html ?? product.description ?? "")).description
  ].map(csvEscape).join(",")));

  await writeText(paths.generatedRejectedCsv, `${header.join(",")}\n${rows.join("\n")}\n`);
  return paths.generatedRejectedCsv;
}

export async function writeExcelWorkbook(
  root: string,
  runs: WorkflowRunSummary[],
  generatedProducts: LooseRecord[],
  shopifyProducts: LooseRecord[],
  policy?: PolicyDocument,
  pendingReviewRows: Array<Record<string, string>> = []
): Promise<string> {
  const paths = getCatalogPaths(root);
  const moduleRows: Array<Record<string, string>> = [];
  for (const run of runs) {
    for (const module of run.modules) {
      moduleRows.push({
        "Product Key": run.product_key,
        "Source Record ID": run.source_record_id,
        "Generated Product Path": run.generated_product_path,
        "Generated Image Dir": run.generated_image_dir,
        "Selected Image URL": run.selected_image_url ?? "",
        "Local Image Path": run.local_image_path ?? "",
        Module: module.module,
        "Job ID": module.job_id,
        Status: module.status,
        "Needs Review": module.needs_review ? "yes" : "no"
      });
    }
  }

  const productRows: Array<Record<string, string>> = [];
  for (const product of generatedProducts) {
    const images = Array.isArray(product.images) ? product.images.filter((item): item is string => typeof item === "string") : [];
    productRows.push({
      "Product Key": getProductKey(product, "product"),
      Title: String(product.title ?? ""),
      Handle: String(product.handle ?? ""),
      Brand: getVendor(product),
      "Product Type": String(product.product_type ?? ""),
      Tags: normalizeTags(product.tags),
      Description: normalizeDescriptionPair(
        String(product.description_html ?? product.description ?? "")
      ).description_html,
      "Featured Image": String(product.featured_image ?? ""),
      "Additional Images": images.join(", "),
      Metafields: normalizeMetafields(product.metafields),
      "Last Module": String((product._catalog as LooseRecord | undefined)?.last_module ?? ""),
      "Needs Review": String((product._catalog as LooseRecord | undefined)?.needs_review ? "yes" : "no"),
      "Product JSON Path": path.join(paths.generatedProductsDir, `${getProductKey(product, "product")}.json`)
    });
  }

  const imageRows: Array<Record<string, string>> = [];
  for (const run of runs) {
    const metadataPath = path.join(run.generated_image_dir, "metadata.json");
    const metadata = await readJson<LooseRecord>(metadataPath, {});
    imageRows.push({
      "Product Key": run.product_key,
      "Source Record ID": run.source_record_id,
      "Generated Image Dir": run.generated_image_dir,
      "Selected Image URL": String(metadata.selected_image_url ?? run.selected_image_url ?? ""),
      "Local Image Path": String(metadata.local_image_path ?? run.local_image_path ?? ""),
      "Download Error": String(metadata.download_error ?? ""),
      Warnings: Array.isArray(metadata.warnings) ? metadata.warnings.map(String).join("; ") : "",
      "Metadata Path": metadataPath
    });
  }

  const metafieldRows: Array<Record<string, string>> = [];
  for (const product of generatedProducts) {
    const productKey = getProductKey(product, "product");
    const title = String(product.title ?? "");
    const handle = String(product.handle ?? "");
    const metafields = Array.isArray(product.metafields) ? product.metafields : [];

    if (metafields.length === 0) {
      metafieldRows.push({
        "Product Key": productKey,
        Title: title,
        Handle: handle,
        Namespace: "",
        Key: "",
        Type: "",
        Value: "",
        Required: "",
        "Source Field": "",
        Description: ""
      });
      continue;
    }

    for (const item of metafields) {
      if (!item || typeof item !== "object") continue;
      const record = item as LooseRecord;
      metafieldRows.push({
        "Product Key": productKey,
        Title: title,
        Handle: handle,
        Namespace: String(record.namespace ?? ""),
        Key: String(record.key ?? ""),
        Type: String(record.type ?? ""),
        Value: String(record.value ?? ""),
        Required: String(record.required ?? ""),
        "Source Field": String(record.source_field ?? ""),
        Description: String(record.description ?? "")
      });
    }
  }

  const shopifyMetafieldColumns = collectShopifyCsvMetafieldColumns(shopifyProducts, policy);
  const shopifyRows = buildShopifyCsvRows(shopifyProducts, shopifyMetafieldColumns, policy);
  const shopifyHeader = [...SHOPIFY_IMPORT_HEADER, ...shopifyMetafieldColumns.map((column) => column.header)];

  const workbook = new ExcelJS.Workbook();
  appendJsonWorksheet(workbook, "Runs", moduleRows);
  appendJsonWorksheet(workbook, "Generated Products", productRows);
  appendJsonWorksheet(workbook, "Images", imageRows);
  appendJsonWorksheet(workbook, "Metafields", metafieldRows);
  appendJsonWorksheet(workbook, "Pending Review", pendingReviewRows);
  appendRowsWorksheet(workbook, "Shopify Import", [shopifyHeader, ...shopifyRows]);
  await workbook.xlsx.writeFile(paths.generatedExcelWorkbook);
  return paths.generatedExcelWorkbook;
}

function appendJsonWorksheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  rows: Array<Record<string, string>>
): void {
  const worksheet = workbook.addWorksheet(sheetName);
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  worksheet.columns = headers.map((header) => ({ header, key: header }));
  for (const row of rows) {
    worksheet.addRow(row);
  }
}

function appendRowsWorksheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  rows: Array<readonly string[] | string[]>
): void {
  const worksheet = workbook.addWorksheet(sheetName);
  for (const row of rows) {
    worksheet.addRow([...row]);
  }
}
