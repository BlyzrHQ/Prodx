import fs from "node:fs";
import path from "node:path";
import { callLlm } from "../services/llm.js";
import { getConfig } from "../config.js";

export interface AnalyzerInput {
  fileUrl?: string;
  fileBase64?: string;
  fileName?: string;
  textInput?: string;
  imageUrl?: string;
  imageBase64?: string;
}

export interface NormalizedProduct {
  title: string;
  brand: string;
  sku: string;
  barcode: string;
  price: string;
  compareAtPrice: string;
  productType: string;
  vendor: string;
  handle: string;
  description: string;
  descriptionHtml: string;
  seoTitle: string;
  seoDescription: string;
  tags: string[];
  option1Name: string;
  option1Value: string;
  option2Name: string;
  option2Value: string;
  option3Name: string;
  option3Value: string;
  images: string[];
  rawData: Record<string, unknown>;
}

type AnalyzerGuideContext = {
  businessName?: string;
  industry?: string;
  storeSummary?: string;
  knownProductTypes: string[];
  knownVariantDimensions: string[];
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const HEADER_ALIASES: Record<string, string> = {
  code: "sku",
  item_code: "sku",
  product_code: "sku",
  barcode: "barcode",
  upc: "barcode",
  ean: "barcode",
  title: "title",
  product_name: "title",
  item_name: "title",
  description: "description",
  short_description: "description",
  brand: "brand",
  brand_name: "brand",
  manufacturer: "brand",
  vendor: "vendor",
  department: "productType",
  category: "productType",
  product_type: "productType",
  website_price: "price",
  retail_price: "price",
  price: "price",
  wholesale_price: "compareAtPrice",
  compare_at_price: "compareAtPrice",
  final_price: "price",
  cost: "compareAtPrice",
  image: "images",
  image_url: "images",
  featured_image: "images",
  photo: "images",
  tags: "tags",
  tag: "tags",
};

const productSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    brand: { type: "string" },
    sku: { type: "string" },
    barcode: { type: "string" },
    price: { type: "string" },
    compareAtPrice: { type: "string" },
    productType: { type: "string" },
    vendor: { type: "string" },
    handle: { type: "string" },
    description: { type: "string" },
    descriptionHtml: { type: "string" },
    seoTitle: { type: "string" },
    seoDescription: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    option1Name: { type: "string" },
    option1Value: { type: "string" },
    option2Name: { type: "string" },
    option2Value: { type: "string" },
    option3Name: { type: "string" },
    option3Value: { type: "string" },
    images: { type: "array", items: { type: "string" } },
    rawData: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  required: [
    "title",
    "brand",
    "sku",
    "barcode",
    "price",
    "compareAtPrice",
    "productType",
    "vendor",
    "handle",
    "description",
    "descriptionHtml",
    "seoTitle",
    "seoDescription",
    "tags",
    "option1Name",
    "option1Value",
    "option2Name",
    "option2Value",
    "option3Name",
    "option3Value",
    "images",
    "rawData",
  ],
} as const;

export async function runAnalyzerAgent(
  input: AnalyzerInput
): Promise<{ products: NormalizedProduct[] }> {
  const guideContext = loadAnalyzerGuideContext();

  if (isImageInput(input)) {
    return analyzeImageInput(input, guideContext);
  }

  if (input.textInput) {
    return analyzeTextInput(input.textInput, guideContext);
  }

  if (input.fileBase64 || input.fileUrl) {
    return analyzeTabularFile(input, guideContext);
  }

  throw new Error("No input provided — supply file, text, or image input.");
}

async function analyzeTextInput(
  text: string,
  guideContext: AnalyzerGuideContext
): Promise<{ products: NormalizedProduct[] }> {
  const response = await callLlm<{ products: NormalizedProduct[] }>({
    systemPrompt: buildAnalyzerSystemPrompt(guideContext, "text"),
    userPrompt:
      "Normalize this product intake text into structured product candidates.\n\n" +
      "Return one or more products only if the input clearly contains multiple distinct products.\n\n" +
      "Raw input:\n" +
      text,
    schema: {
      name: "analyze_products",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          products: { type: "array", items: productSchema },
        },
        required: ["products"],
      },
    },
  });

  return { products: response.products.map((product) => normalizeProduct(product, { originalText: text })) };
}

async function analyzeTabularFile(
  input: AnalyzerInput,
  guideContext: AnalyzerGuideContext
): Promise<{ products: NormalizedProduct[] }> {
  const content = await readFileLikeInput(input);
  const rows = parseDelimitedRows(content);
  if (rows.length === 0) {
    return { products: [] };
  }

  const response = await callLlm<{ products: NormalizedProduct[] }>({
    systemPrompt: buildAnalyzerSystemPrompt(guideContext, "tabular"),
    userPrompt:
      "Normalize these spreadsheet rows into structured product candidates.\n\n" +
      "Each row is one product candidate unless the row clearly represents multiple sellable products.\n\nRows:\n" +
      JSON.stringify(rows, null, 2),
    schema: {
      name: "analyze_products",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          products: { type: "array", items: productSchema },
        },
        required: ["products"],
      },
    },
  });

  return {
    products: response.products.map((product, index) => normalizeProduct(product, rows[index] ?? {})),
  };
}

async function analyzeImageInput(
  input: AnalyzerInput,
  guideContext: AnalyzerGuideContext
): Promise<{ products: NormalizedProduct[] }> {
  const { openaiApiKey } = getConfig();
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY required for image analysis");
  }

  const imagePayload = await buildImagePayload(input);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + openaiApiKey,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: buildImageAnalyzerSystemPrompt(guideContext),
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Analyze this product image and return structured product candidates. " +
                "Do not leave title blank if the visible packaging clearly shows brand/logo, product family/name, variant words, or net weight. " +
                "If the packaging clearly shows a brand, use it. If it shows a product family and variant words like roast/flavor/form, combine them into a shopper-friendly product title. " +
                "Use empty strings for unknown fields.",
            },
            imagePayload,
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "analyze_products",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              products: { type: "array", items: productSchema },
            },
            required: ["products"],
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error("OpenAI Vision error: " + response.status + " " + (await response.text()));
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("No output from OpenAI Vision");
  }

  const parsed = JSON.parse(content) as { products: NormalizedProduct[] };
  const products = parsed.products
    .map((product) =>
      normalizeProduct(product, {
        sourceImage: input.fileName ?? input.fileUrl ?? input.imageUrl ?? "image",
        sourceType: "image",
      })
    )
    .map(applyImageTitleFallback)
    .filter((product) => product.title.trim().length > 0);

  if (products.length === 0) {
    throw new Error("Image analyzer could not extract a usable product title");
  }

  return { products };
}

function buildAnalyzerSystemPrompt(
  guideContext: AnalyzerGuideContext,
  mode: "text" | "tabular"
): string {
  return `You are a PRODUCT ANALYZER for a catalog management system.

## ROLE
Your job is to take raw intake input and convert it into normalized product candidates for downstream matching, enrichment, QA, and publishing.

## INPUT MODES
- text: loose product notes, copied product lines, or short descriptions
- tabular: CSV/spreadsheet rows with inconsistent column names and abbreviations

Current mode: ${mode}

## BUSINESS CONTEXT
Business: ${guideContext.businessName || "Unknown business"}
Industry: ${guideContext.industry || "Unknown industry"}
Store summary: ${guideContext.storeSummary || "Not provided"}
Known product types: ${guideContext.knownProductTypes.join(", ") || "None provided"}
Known variant dimensions: ${guideContext.knownVariantDimensions.join(", ") || "Size, flavor, pack, form"}

## TASK
Return normalized structured product candidates. Your output must be suitable for:
- duplicate detection
- variant detection
- enrichment
- publishing workflows

## FIELD NORMALIZATION RULES
- Use the strongest title/product name field available.
- Clean abbreviations into shopper-friendly English when obvious.
- Extract size, weight, count, roast, flavor, or form into option fields when present.
- Price priority: website_price, retail_price, price, wholesale_price, cost, final_price, then any obvious price field.
- If a field is unknown, return an empty string.
- Always return all keys.
- If a known product type clearly matches, use it.
- Do not do full merchandising or long-form enrichment yet.
- Keep rawData as the original row or original input facts.

## OUTPUT RULES
- Return structured JSON only.
- Each candidate should represent one sellable product or one row-level product candidate.
- Do not invent ingredients, certifications, brand claims, or other unseen facts.
- Tags should be short useful classification hints only when obvious.
- Images should only contain source image URLs if the input explicitly includes them.`;
}

function buildImageAnalyzerSystemPrompt(guideContext: AnalyzerGuideContext): string {
  return `You are a PRODUCT ANALYZER for a catalog management system.

## ROLE
You are analyzing product packaging, labels, or shelf photos and converting what is visibly present into normalized product candidates.

## BUSINESS CONTEXT
Business: ${guideContext.businessName || "Unknown business"}
Industry: ${guideContext.industry || "Unknown industry"}
Store summary: ${guideContext.storeSummary || "Not provided"}
Known product types: ${guideContext.knownProductTypes.join(", ") || "None provided"}
Known variant dimensions: ${guideContext.knownVariantDimensions.join(", ") || "Size, flavor, pack, form"}

## IMAGE ANALYSIS RULES
- Extract only what is visible on the product, package, or label.
- Prioritize visible brand/logo, product family/name, flavor/form words, roast/type words, and net weight/size.
- If the package clearly shows a brand, use it.
- If the product has no visible brand, leave brand empty.
- Product title should be shopper-friendly and product-level, but image-specific variant words like roast, flavor, or form may be included when they are clearly on-pack and necessary to identify the product.
- Do not invent price, certifications, ingredients, or nutrition facts from memory.
- Use empty strings for unknown fields.

## OUTPUT RULES
- Return strict JSON only.
- Always return every key.
- Do not leave title blank if the visible packaging clearly provides enough information to name the product.`;
}

function normalizeProduct(
  raw: Partial<NormalizedProduct>,
  fallbackRawData: Record<string, unknown>
): NormalizedProduct {
  const title = cleanText(String(raw.title ?? ""));
  const brand = cleanText(String(raw.brand ?? raw.vendor ?? ""));
  const vendor = cleanText(String(raw.vendor ?? raw.brand ?? ""));
  const productType = cleanText(String(raw.productType ?? ""));
  const handle = cleanText(String(raw.handle ?? slugify(title)));
  const rawDataCandidate =
    raw.rawData && typeof raw.rawData === "object" && !Array.isArray(raw.rawData)
      ? (raw.rawData as Record<string, unknown>)
      : null;
  const rawData =
    rawDataCandidate && Object.keys(rawDataCandidate).length > 0 ? rawDataCandidate : fallbackRawData;

  return {
    title,
    brand,
    sku: cleanText(String(raw.sku ?? "")),
    barcode: cleanText(String(raw.barcode ?? "")),
    price: cleanText(String(raw.price ?? "")),
    compareAtPrice: cleanText(String(raw.compareAtPrice ?? "")),
    productType,
    vendor,
    handle,
    description: cleanText(String(raw.description ?? "")),
    descriptionHtml: cleanText(String(raw.descriptionHtml ?? "")),
    seoTitle: cleanText(String(raw.seoTitle ?? "")),
    seoDescription: cleanText(String(raw.seoDescription ?? "")),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).map(cleanText).filter(Boolean) : [],
    option1Name: cleanText(String(raw.option1Name ?? "")),
    option1Value: cleanText(String(raw.option1Value ?? "")),
    option2Name: cleanText(String(raw.option2Name ?? "")),
    option2Value: cleanText(String(raw.option2Value ?? "")),
    option3Name: cleanText(String(raw.option3Name ?? "")),
    option3Value: cleanText(String(raw.option3Value ?? "")),
    images: Array.isArray(raw.images) ? raw.images.map(String).map(cleanText).filter(Boolean) : [],
    rawData,
  };
}

function applyImageTitleFallback(product: NormalizedProduct): NormalizedProduct {
  if (product.title.trim().length > 0) {
    return product;
  }

  const parts = [
    product.brand,
    product.productType,
    product.option2Value,
    product.option1Value,
  ]
    .map((value) => cleanText(value))
    .filter(Boolean);

  return {
    ...product,
    title: parts.join(" ").trim(),
    handle: slugify(parts.join(" ").trim()),
  };
}

function loadAnalyzerGuideContext(): AnalyzerGuideContext {
  const guidePath = path.resolve(".catalog/guide/catalog-guide.json");
  if (!fs.existsSync(guidePath)) {
    return {
      businessName: undefined,
      industry: undefined,
      storeSummary: undefined,
      knownProductTypes: [],
      knownVariantDimensions: [],
    };
  }

  try {
    const guide = JSON.parse(fs.readFileSync(guidePath, "utf-8")) as any;
    return {
      businessName: guide?.at_a_glance?.name ?? undefined,
      industry:
        guide?.at_a_glance?.industry ??
        guide?.industry_business_context?.industry ??
        undefined,
      storeSummary:
        guide?.at_a_glance?.store_summary ??
        guide?.industry_business_context?.summary ??
        undefined,
      knownProductTypes: extractKnownProductTypes(guide),
      knownVariantDimensions: Array.isArray(guide?.variant_architecture?.allowed_dimensions)
        ? guide.variant_architecture.allowed_dimensions
            .map((value: unknown) => String(value).trim())
            .filter(Boolean)
        : [],
    };
  } catch {
    return {
      businessName: undefined,
      industry: undefined,
      storeSummary: undefined,
      knownProductTypes: [],
      knownVariantDimensions: [],
    };
  }
}

function extractKnownProductTypes(guide: any): string[] {
  const values = new Set<string>();
  for (const source of [guide?.taxonomy?.hierarchy, guide?.taxonomy?.product_type_rules]) {
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      if (typeof item === "string") {
        values.add(item.trim());
      } else if (item && typeof item === "object") {
        if (typeof item.name === "string") values.add(item.name.trim());
        if (typeof item.productType === "string") values.add(item.productType.trim());
      }
    }
  }
  return [...values].filter(Boolean).slice(0, 100);
}

function parseDelimitedRows(content: string): Array<Record<string, unknown>> {
  const clean = content.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return [];
  }

  const delimiters = [",", ";", "\t"];
  const delimiter = delimiters.reduce((best, candidate) => {
    return lines[0].split(candidate).length > lines[0].split(best).length ? candidate : best;
  }, ",");

  const headers = lines[0]
    .split(delimiter)
    .map((header) => header.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_"))
    .map((header) => HEADER_ALIASES[header] ?? header);

  return lines.slice(1).map((line) => {
    const values = splitDelimitedLine(line, delimiter);
    const row: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      const value = values[index] ?? "";
      if (header === "images" || header === "tags") {
        row[header] = String(value)
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
      } else {
        row[header] = value;
      }
    });
    return row;
  });
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === delimiter && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  values.push(current.trim());
  return values.map((value) => value.replace(/^["']|["']$/g, ""));
}

function isImageInput(input: AnalyzerInput): boolean {
  if (input.imageUrl || input.imageBase64) {
    return true;
  }

  const filePath = input.fileUrl ?? input.fileName ?? "";
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function buildImagePayload(input: AnalyzerInput) {
  if (input.imageBase64) {
    return {
      type: "image_url",
      image_url: { url: "data:image/png;base64," + input.imageBase64 },
    };
  }

  if (input.imageUrl) {
    return { type: "image_url", image_url: { url: input.imageUrl } };
  }

  if (input.fileBase64) {
    const mimeType = guessMimeType(input.fileName ?? "image.png");
    return {
      type: "image_url",
      image_url: { url: "data:" + mimeType + ";base64," + input.fileBase64 },
    };
  }

  if (input.fileUrl && fs.existsSync(input.fileUrl)) {
    const buffer = fs.readFileSync(input.fileUrl);
    const mimeType = guessMimeType(input.fileUrl);
    return {
      type: "image_url",
      image_url: { url: "data:" + mimeType + ";base64," + buffer.toString("base64") },
    };
  }

  if (input.fileUrl) {
    return { type: "image_url", image_url: { url: input.fileUrl } };
  }

  throw new Error("No image input found");
}

async function readFileLikeInput(input: AnalyzerInput): Promise<string> {
  if (input.fileBase64) {
    return Buffer.from(input.fileBase64, "base64").toString("utf-8");
  }

  if (!input.fileUrl) {
    throw new Error("No file content provided");
  }

  if (fs.existsSync(input.fileUrl)) {
    return fs.readFileSync(input.fileUrl, "utf-8");
  }

  const response = await fetch(input.fileUrl);
  if (!response.ok) {
    throw new Error("Failed to fetch file: " + response.status);
  }
  return response.text();
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function guessMimeType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/png";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
