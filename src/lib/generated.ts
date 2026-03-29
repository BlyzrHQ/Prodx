import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import { ensureDir, readJson, writeJson, writeText } from "./fs.js";
import { getCatalogPaths } from "./paths.js";
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
  for (const [key, value] of Object.entries(result.proposed_changes ?? {})) {
    if (
      key === "shopify_payload" ||
      key === "image_search" ||
      key === "image_review" ||
      key === "image_task" ||
      key === "live_apply_ready" ||
      key === "target_store" ||
      key === "variant_count" ||
      key === "qa_score" ||
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

  merged._catalog = {
    last_module: result.module,
    last_job_id: result.job_id,
    status: result.status,
    needs_review: result.needs_review,
    updated_at: new Date().toISOString()
  };

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

function defaultOptionNames(policy?: PolicyDocument): [string, string, string] {
  const dimensions = Array.isArray(policy?.variant_structure?.primary_dimensions)
    ? policy.variant_structure.primary_dimensions.map(String)
    : [];
  return [
    dimensions[0] ?? "Default Title",
    dimensions[1] ?? "",
    dimensions[2] ?? ""
  ];
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

function buildShopifyCsvRows(products: LooseRecord[], policy?: PolicyDocument): string[][] {
  const [option1Name, option2Name, option3Name] = defaultOptionNames(policy);
  const rows: string[][] = [];

  for (const product of products) {
    const variants = getVariantRows(product, policy);
    const images = Array.isArray(product.images) ? product.images.filter((item) => typeof item === "string") as string[] : [];
    const featuredImage = typeof product.featured_image === "string" ? product.featured_image : images[0] ?? "";
    const imageAltText = typeof product.image_alt_text === "string" && product.image_alt_text.trim().length > 0
      ? product.image_alt_text
      : [product.brand, product.title, product.size, product.type]
          .filter((item) => typeof item === "string" && item.trim().length > 0)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
    const handle = typeof product.handle === "string" && product.handle ? product.handle : getProductKey(product, "product");

    variants.forEach((variant, index) => {
      rows.push([
        typeof product.title === "string" ? product.title : "",
        handle,
        typeof product.description_html === "string" ? product.description_html : typeof product.description === "string" ? product.description : "",
        typeof product.brand === "string" ? product.brand : typeof product.vendor === "string" ? product.vendor : "",
        "",
        typeof product.product_type === "string" ? product.product_type : "",
        normalizeTags(product.tags),
        toShopifyBoolean(product["published_on_online_store"], "TRUE"),
        typeof product.status === "string" ? product.status : "active",
        typeof variant.sku === "string" ? variant.sku : "",
        typeof variant.barcode === "string" ? variant.barcode : "",
        option1Name,
        typeof variant.option1 === "string" && variant.option1 ? variant.option1 : "Default Title",
        option2Name,
        typeof variant.option2 === "string" ? variant.option2 : "",
        option3Name,
        typeof variant.option3 === "string" ? variant.option3 : "",
        typeof (variant as LooseRecord).price === "string" ? String((variant as LooseRecord).price) : typeof product.price === "string" ? product.price : "",
        typeof (variant as LooseRecord)["compare_at_price"] === "string"
          ? String((variant as LooseRecord)["compare_at_price"])
          : typeof product["compare_at_price"] === "string"
            ? String(product["compare_at_price"])
            : "",
        toShopifyBoolean((variant as LooseRecord)["requires_shipping"], "TRUE"),
        toShopifyBoolean((variant as LooseRecord).taxable, "TRUE"),
        index === 0 ? featuredImage : "",
        imageAltText
      ]);
    });
  }

  return rows;
}

export async function writeShopifyImportCsv(root: string, products: LooseRecord[], policy?: PolicyDocument): Promise<string> {
  const paths = getCatalogPaths(root);
  const header = [
    "Title",
    "Handle",
    "Body (HTML)",
    "Vendor",
    "Category",
    "Type",
    "Tags",
    "Published on online store",
    "Status",
    "SKU",
    "Barcode",
    "Option1 Name",
    "Option1 Value",
    "Option2 Name",
    "Option2 Value",
    "Option3 Name",
    "Option3 Value",
    "Variant Price",
    "Variant Compare At Price",
    "Variant Requires Shipping",
    "Variant Taxable",
    "Image Src",
    "Image Alt Text"
  ];

  const rows = buildShopifyCsvRows(products, policy).map((row) => row.map(csvEscape).join(","));
  await writeText(paths.generatedShopifyCsv, `${header.join(",")}\n${rows.join("\n")}\n`);
  return paths.generatedShopifyCsv;
}

export async function writeExcelWorkbook(
  root: string,
  runs: WorkflowRunSummary[],
  generatedProducts: LooseRecord[],
  shopifyProducts: LooseRecord[],
  policy?: PolicyDocument
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
      Brand: String(product.brand ?? product.vendor ?? ""),
      "Product Type": String(product.product_type ?? ""),
      Tags: normalizeTags(product.tags),
      Description: String(product.description ?? ""),
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

  const shopifyRows = buildShopifyCsvRows(shopifyProducts, policy);
  const shopifyHeader = [
    "Title",
    "Handle",
    "Body (HTML)",
    "Vendor",
    "Category",
    "Type",
    "Tags",
    "Published on online store",
    "Status",
    "SKU",
    "Barcode",
    "Option1 Name",
    "Option1 Value",
    "Option2 Name",
    "Option2 Value",
    "Option3 Name",
    "Option3 Value",
    "Variant Price",
    "Variant Compare At Price",
    "Variant Requires Shipping",
    "Variant Taxable",
    "Image Src",
    "Image Alt Text"
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(moduleRows), "Runs");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(productRows), "Generated Products");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(imageRows), "Images");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(metafieldRows), "Metafields");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([shopifyHeader, ...shopifyRows]), "Shopify Import");
  XLSX.writeFile(workbook, paths.generatedExcelWorkbook);
  return paths.generatedExcelWorkbook;
}
