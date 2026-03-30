import { readText } from "../lib/fs.js";
import { createBaseResult } from "./shared.js";
import type { LooseRecord } from "../types.js";

const FIELD_ALIASES: Record<string, string[]> = {
  id: ["id", "product_id", "record_id", "item_id"],
  title: ["title", "product_name", "product_title", "name", "item_name"],
  description: ["description", "body", "details", "product_description"],
  description_html: ["description_html", "body_html", "html_description", "product_description_html"],
  brand: ["brand", "brand_name", "manufacturer", "maker"],
  vendor: ["vendor", "supplier", "vendor_name", "seller"],
  handle: ["handle", "slug", "url_handle"],
  product_type: ["product_type", "type", "category", "product_category", "item_type"],
  sku: ["sku", "item_sku", "product_sku"],
  barcode: ["barcode", "ean", "gtin", "upc"],
  price: ["price", "sale_price", "selling_price", "current_price", "retail_price"],
  compare_at_price: ["compare_at_price", "original_price", "list_price", "msrp", "regular_price"],
  size: ["size", "pack_size", "net_weight", "weight", "volume"],
  color: ["color", "colour"],
  featured_image: ["featured_image", "image", "image_url", "main_image", "main_image_url", "primary_image"],
  image_alt_text: ["image_alt_text", "alt_text", "image_alt"],
  ingredients_text: ["ingredients_text", "ingredients", "ingredient_list"],
  allergen_note: ["allergen_note", "allergens", "allergen_info"],
  storage_instructions: ["storage_instructions", "storage", "storage_note"],
  option1: ["option1", "variant_1", "option_1"],
  option2: ["option2", "variant_2", "option_2"],
  option3: ["option3", "variant_3", "option_3"],
  tags: ["tags", "tag_list", "labels"],
  images: ["images", "image_urls", "gallery", "gallery_images"]
};

function normalizeKey(key: string): string {
  return key.toLowerCase().trim().replace(/[\s\-./]+/g, "_").replace(/[()]/g, "");
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function parseListLikeValue(value: string): string[] {
  if (!value.trim()) return [];
  return value
    .split(/[|;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRow(record: LooseRecord): LooseRecord {
  const normalized: LooseRecord = { ...record };
  const indexedValues = new Map<string, unknown>();

  for (const [key, value] of Object.entries(record)) {
    indexedValues.set(normalizeKey(key), value);
  }

  for (const [canonicalField, aliases] of Object.entries(FIELD_ALIASES)) {
    if (normalized[canonicalField] !== undefined && normalized[canonicalField] !== null && normalized[canonicalField] !== "") continue;
    const alias = aliases.find((candidate) => indexedValues.has(normalizeKey(candidate)));
    if (!alias) continue;
    normalized[canonicalField] = indexedValues.get(normalizeKey(alias));
  }

  if (typeof normalized.tags === "string") normalized.tags = parseListLikeValue(normalized.tags);
  if (typeof normalized.images === "string") normalized.images = parseListLikeValue(normalized.images);
  if (typeof normalized.featured_image === "string") normalized.featured_image = normalized.featured_image.trim();
  if (typeof normalized.title === "string") normalized.title = normalized.title.trim();
  if (typeof normalized.brand === "string") normalized.brand = normalized.brand.trim();
  if (typeof normalized.vendor === "string") normalized.vendor = normalized.vendor.trim();
  if (typeof normalized.price === "number") normalized.price = String(normalized.price);
  if (typeof normalized.compare_at_price === "number") normalized.compare_at_price = String(normalized.compare_at_price);

  return normalized;
}

function parseCsv(text: string): LooseRecord[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: LooseRecord = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return normalizeRow(row);
  });
}

function unwrapJsonRecords(input: unknown): LooseRecord[] {
  if (Array.isArray(input)) return input as LooseRecord[];
  if (!input || typeof input !== "object") return [input as LooseRecord];

  const record = input as LooseRecord;
  for (const key of ["products", "items", "records", "data"]) {
    if (Array.isArray(record[key])) return record[key] as LooseRecord[];
  }

  return [record];
}

export async function loadRecordsFromSource(sourcePath: string): Promise<LooseRecord[]> {
  const raw = await readText(sourcePath, "");
  const extension = sourcePath.toLowerCase().split(".").pop();
  let normalized: unknown;
  if (extension === "json") normalized = JSON.parse(raw);
  else if (extension === "csv") normalized = parseCsv(raw);
  else throw new Error(`Unsupported ingest format: ${extension}`);

  return unwrapJsonRecords(normalized).map((record) => normalizeRow(record));
}

export async function runIngest({ jobId, input }: { jobId: string; input: { source_path: string } }) {
  const sourcePath = input.source_path;
  const records = await loadRecordsFromSource(sourcePath);

  return createBaseResult({
    jobId,
    module: "catalogue-ingest",
    status: "success",
    needsReview: false,
    proposedChanges: { records_ingested: records.length },
    reasoning: [`Normalized ${records.length} record(s) from ${sourcePath}.`],
    nextActions: ["Use one of the normalized records as input for `catalog match` or `catalog enrich`."],
    artifacts: { normalized_records: records }
  });
}
