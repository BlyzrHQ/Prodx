import type { ProductRecord } from "../types.js";

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

export function hasReviewPlaceholder(value: string): boolean {
  const normalized = value.toLowerCase();
  return [
    "requires review",
    "requires_review",
    "unknown_requires_review",
    "to be confirmed",
    "to be verified",
    "pending verification"
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
