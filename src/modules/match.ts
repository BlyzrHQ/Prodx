import { createBaseResult } from "./shared.js";
import { jaccardSimilarity, normalizeValue } from "../lib/similarity.js";

function getVariantSignature(product, variantKeys) {
  return variantKeys.map((key) => normalizeValue(product[key])).filter(Boolean).join("|");
}

export function buildCatalogIndex(catalog) {
  return catalog.map((product) => ({
    id: product.id ?? product.product_id ?? product.handle ?? product.sku ?? product.title,
    sku: product.sku ?? "",
    barcode: product.barcode ?? "",
    title: product.title ?? "",
    brand: product.brand ?? product.vendor ?? "",
    handle: product.handle ?? "",
    variant_signature: getVariantSignature(product, ["size", "type", "color", "storage", "option1", "option2"]),
    raw: product
  }));
}

export function runMatchDecision({ jobId, input, catalog, policy, learningText = "" }) {
  const candidates = buildCatalogIndex(catalog);
  const targetSku = normalizeValue(input.sku);
  const targetBarcode = normalizeValue(input.barcode);
  const targetTitle = `${input.brand ?? ""} ${input.title ?? ""}`.trim();

  const exactSku = targetSku ? candidates.find((item) => normalizeValue(item.sku) === targetSku) : null;
  if (exactSku) {
    return {
      ...createBaseResult({
        jobId,
        module: "catalogue-match",
        status: "success",
        needsReview: false,
        reasoning: [`Exact SKU match found for ${input.sku}.`],
        nextActions: ["Treat as duplicate unless overridden by a human review."]
      }),
      decision: "DUPLICATE",
      confidence: 0.99,
      matched_product_id: exactSku.id,
      matched_variant_id: exactSku.id,
      proposed_action: { action: "skip_duplicate", product_id: exactSku.id }
    };
  }

  const exactBarcode = targetBarcode ? candidates.find((item) => normalizeValue(item.barcode) === targetBarcode) : null;
  if (exactBarcode) {
    return {
      ...createBaseResult({
        jobId,
        module: "catalogue-match",
        status: "success",
        needsReview: false,
        reasoning: [`Exact barcode match found for ${input.barcode}.`],
        nextActions: ["Treat as duplicate unless overridden by a human review."]
      }),
      decision: "DUPLICATE",
      confidence: 0.99,
      matched_product_id: exactBarcode.id,
      matched_variant_id: exactBarcode.id,
      proposed_action: { action: "skip_duplicate", product_id: exactBarcode.id }
    };
  }

  const scored = candidates
    .map((candidate) => ({ ...candidate, score: jaccardSimilarity(targetTitle, `${candidate.brand} ${candidate.title}`) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const variantKeys = policy?.variant_structure?.primary_dimensions?.map((item) => item.toLowerCase()) ?? ["size", "type"];
  const targetVariant = getVariantSignature(input, variantKeys);
  const bestVariant = best ? getVariantSignature(best.raw, variantKeys) : "";
  const learningFlag = /generic values like default or regular/i.test(learningText) || /generic values like default or regular/i.test(JSON.stringify(policy));

  if (!best || best.score < 0.35) {
    return {
      ...createBaseResult({
        jobId,
        module: "catalogue-match",
        status: "success",
        needsReview: false,
        reasoning: ["No strong candidate match was found in the current catalog."],
        nextActions: ["Treat as a new product unless downstream review finds otherwise."]
      }),
      decision: "NEW_PRODUCT",
      confidence: 0.9,
      matched_product_id: null,
      matched_variant_id: null,
      proposed_action: { action: "create_product" }
    };
  }

  if (targetVariant && bestVariant && targetVariant === bestVariant) {
    return {
      ...createBaseResult({
        jobId,
        module: "catalogue-match",
        status: "success",
        needsReview: false,
        reasoning: [`Closest product family match: ${best.title}`, "Variant signature matches an existing catalog entry."],
        nextActions: ["Treat as duplicate unless human review overrides it."]
      }),
      decision: "DUPLICATE",
      confidence: 0.95,
      matched_product_id: best.id,
      matched_variant_id: best.id,
      proposed_action: { action: "skip_duplicate", product_id: best.id }
    };
  }

  const genericVariant = ["default", "regular", "standard", "classic"].some((token) => targetVariant.includes(token));
  if (genericVariant && learningFlag) {
    return {
      ...createBaseResult({
        jobId,
        module: "catalogue-match",
        status: "success",
        needsReview: true,
        warnings: ["Generic variant value detected; review before attaching to an existing product."],
        reasoning: [`Closest product family match: ${best.title}`, "The incoming variant uses a generic value that is not safely differentiating."],
        nextActions: ["Review whether this is a duplicate or incomplete product data."]
      }),
      decision: "NEEDS_REVIEW",
      confidence: 0.58,
      matched_product_id: best.id,
      matched_variant_id: null,
      proposed_action: { action: "review_variant_mapping", product_id: best.id }
    };
  }

  if (best.score >= 0.6) {
    return {
      ...createBaseResult({
        jobId,
        module: "catalogue-match",
        status: "success",
        needsReview: false,
        reasoning: [`Closest product family match: ${best.title}`, "Product family is similar, but the variant signature differs."],
        nextActions: ["Treat as a new variant on the matched product."]
      }),
      decision: "NEW_VARIANT",
      confidence: 0.82,
      matched_product_id: best.id,
      matched_variant_id: null,
      proposed_action: { action: "attach_as_variant", product_id: best.id }
    };
  }

  return {
    ...createBaseResult({
      jobId,
      module: "catalogue-match",
      status: "success",
      needsReview: true,
      warnings: ["Similarity score is inconclusive; human review required."],
      reasoning: [`Closest candidate: ${best.title}`, `Similarity score: ${best.score.toFixed(2)}`],
      nextActions: ["Route to review before deciding whether to create or attach."]
    }),
    decision: "NEEDS_REVIEW",
    confidence: 0.45,
    matched_product_id: best.id,
    matched_variant_id: null,
    proposed_action: { action: "manual_review" }
  };
}
