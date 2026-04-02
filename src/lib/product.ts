import type { LooseRecord, ProductRecord } from "../types.js";

const BRAND_STOP_TOKENS = new Set([
  "with",
  "for",
  "in",
  "on",
  "the",
  "a",
  "an"
]);

export function inferVendorFromTitle(title: string): string {
  const tokens = title
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9-]+$/g, ""))
    .filter(Boolean);

  if (tokens.length === 0) return "";

  const selected: string[] = [];
  for (const token of tokens) {
    if (selected.length > 0 && (/\d/.test(token) || BRAND_STOP_TOKENS.has(token.toLowerCase()))) {
      break;
    }
    if (/^\d/.test(token) && selected.length === 0) break;
    selected.push(token);
    if (selected.length >= 2) break;
  }

  if (selected.length === 0) return tokens[0] ?? "";
  return selected.join(" ");
}

export function inferVendor(product: ProductRecord): string {
  if (typeof product.vendor === "string" && product.vendor.trim()) return product.vendor.trim();
  if (typeof product.brand === "string" && product.brand.trim()) return product.brand.trim();
  if (typeof product.title === "string" && product.title.trim()) return inferVendorFromTitle(product.title.trim());
  return "";
}

const FIELD_ALIASES: Record<string, string[]> = {
  description_html: ["description_html", "body_html"],
  body_html: ["body_html", "description_html"]
};

function isFilledValue(value: unknown): boolean {
  return !(
    value === undefined
    || value === null
    || value === ""
    || (Array.isArray(value) && value.length === 0)
  );
}

export function getProductFieldAliases(fieldName: string): string[] {
  const normalized = fieldName.trim().toLowerCase();
  const aliases = FIELD_ALIASES[normalized] ?? [fieldName];
  return [...new Set(aliases)];
}

export function getProductFieldValue(product: ProductRecord, fieldName: string): unknown {
  for (const alias of getProductFieldAliases(fieldName)) {
    const value = product[alias];
    if (isFilledValue(value)) return value;
  }
  return product[fieldName];
}

export function hasPopulatedProductField(product: ProductRecord, fieldName: string): boolean {
  return isFilledValue(getProductFieldValue(product, fieldName));
}

export function hasReviewPlaceholder(value: string): boolean {
  const normalized = value.toLowerCase();
  return [
    "requires review",
    "requires_review",
    "unknown_requires_review",
    "under review",
    "to be confirmed",
    "to be verified",
    "pending verification",
    "pending confirmation",
    "pending brand confirmation",
    "requires verification",
    "require verification",
    "verification before publishing",
    "confirm on-pack",
    "confirm on pack",
    "brand confirmation",
    "once verified",
    "once confirmed",
    "not verified",
    "not yet verified",
    "not shown",
    "ingredients not shown",
    "see pack",
    "check pack",
    "on delivery",
    "exact label text",
    "label ingredients",
    "exact pack could not be verified",
    "pack not verified"
  ].some((token) => normalized.includes(token));
}

export function dedupeTitleLikeText(...parts: Array<string | null | undefined>): string {
  const normalizedParts = parts
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());

  if (normalizedParts.length === 0) return "";

  const combined: string[] = [];
  for (const part of normalizedParts) {
    if (combined.some((existing) => existing.toLowerCase() === part.toLowerCase())) continue;
    combined.push(part);
  }

  const text = combined.join(" ").replace(/\s+/g, " ").trim();
  return text;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|ul|ol)>/gi, "\n\n")
    .replace(/<li>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wrapParagraph(paragraph: string): string {
  const lines = paragraph.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return "";

  if (lines.every((line) => /^[-*]\s+/.test(line))) {
    const items = lines.map((line) => `<li>${line.replace(/^[-*]\s+/, "").trim()}</li>`).join("");
    return `<ul>${items}</ul>`;
  }

  if (lines.length === 1 && /^[A-Za-z0-9][A-Za-z0-9\s&/,+-]{0,80}$/.test(lines[0]) && !/[.!?]$/.test(lines[0])) {
    return `<h3>${lines[0]}</h3>`;
  }

  return `<p>${lines.join("<br/>")}</p>`;
}

export function textToHtml(text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => wrapParagraph(paragraph))
    .filter(Boolean);

  return paragraphs.join("");
}

export function normalizeDescriptionPair(value: string): { description: string; description_html: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { description: "", description_html: "" };
  }

  const looksHtml = /<[^>]+>/.test(trimmed);
  if (looksHtml) {
    return {
      description: htmlToText(trimmed),
      description_html: trimmed
    };
  }

  return {
    description: trimmed,
    description_html: textToHtml(trimmed)
  };
}

function clipText(value: string, maxLength: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) return trimmed;
  const clipped = trimmed.slice(0, maxLength - 1).trim();
  return `${clipped}…`;
}

export function deriveSeoTitle(product: LooseRecord): string {
  const direct = typeof product.seo_title === "string" ? product.seo_title.trim() : "";
  if (direct) return clipText(direct, 70);

  const title = typeof product.title === "string" ? product.title.trim() : "";
  if (!title) return "";
  return clipText(title, 70);
}

export function deriveSeoDescription(product: LooseRecord): string {
  const direct = typeof product.seo_description === "string" ? product.seo_description.trim() : "";
  if (direct) return clipText(htmlToText(direct), 160);

  const source = typeof product.description_html === "string" && product.description_html.trim()
    ? product.description_html
    : typeof product.description === "string"
      ? product.description
      : "";
  if (!source) return "";
  return clipText(htmlToText(source), 160);
}
