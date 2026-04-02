import { createBaseResult } from "./shared.js";
import { compactValue, jaccardSimilarity, normalizeValue } from "../lib/similarity.js";
import { inferVendorFromTitle } from "../lib/product.js";

const COLOR_VALUES = [
  "black",
  "white",
  "blue",
  "red",
  "green",
  "pink",
  "purple",
  "yellow",
  "gray",
  "grey",
  "silver",
  "gold",
  "beige",
  "brown",
  "orange",
  "navy"
];

const TITLE_SYNONYMS = new Map([
  ["tee", "t shirt"],
  ["tees", "t shirt"],
  ["tshirt", "t shirt"],
  ["tshirts", "t shirt"],
  ["jogger", "joggers"],
  ["sneaker", "sneakers"],
  ["earbud", "earbuds"],
  ["headphone", "headphones"]
]);

const VARIANT_FIELD_ALIASES = {
  size: ["size", "pack_size", "packsize", "size_uom"],
  color: ["color"],
  storage: ["storage"],
  type: ["type", "flavor", "fat_percent", "fat_strength", "strength"],
  flavor: ["flavor", "type"],
  pack_size: ["pack_size", "packsize", "size", "size_uom"],
  "fat_strength": ["fat_strength", "fat_percent", "type"],
  "fat_%_/_strength": ["fat_strength", "fat_percent", "type"],
  "fat_%": ["fat_percent", "type"]
};

function normalizeRetailTitle(value) {
  return normalizeValue(value)
    .replace(/\b(\d+(?:[\.,]\d+)?)\s*grams?\b/g, "$1g")
    .replace(/\b(\d+(?:[\.,]\d+)?)\s*kilograms?\b/g, "$1kg")
    .replace(/\b(\d+(?:[\.,]\d+)?)\s*millilit(?:er|re)s?\b/g, "$1ml")
    .replace(/\b(\d+(?:[\.,]\d+)?)\s*lit(?:er|re)s?\b/g, "$1l")
    .split(" ")
    .filter(Boolean)
    .map((token) => TITLE_SYNONYMS.get(token) ?? token)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqStrings(values) {
  const seen = new Set();
  return values.filter((value) => {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function getVariantSignature(product, variantKeys) {
  return variantKeys.map((key) => normalizeValue(product[key])).filter(Boolean).join("|");
}

function toTitleCase(value) {
  return String(value ?? "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function findOptionValueFromTitle(title, key) {
  const text = String(title ?? "");
  const normalized = normalizeValue(text);
  if (!normalized) return "";

  if (key === "color") {
    const matchedColor = COLOR_VALUES.find((color) => new RegExp(`(?:^|\\s)${color}(?:$|\\s)`, "i").test(normalized));
    return matchedColor ? toTitleCase(matchedColor) : "";
  }

  if (key === "size" || key === "pack_size") {
    const match = text.match(/\b\d+(?:[\.,]\d+)?\s?(?:kg|g|mg|lb|oz|l|ml|cl|cm|mm|m|tb|gb)\b/i);
    return match ? match[0].replace(/\s+/g, "") : "";
  }

  if (key === "storage") {
    const match = text.match(/\b\d+(?:[\.,]\d+)?\s?(?:tb|gb)\b/i);
    return match ? match[0].replace(/\s+/g, "") : "";
  }

  if (key === "type") {
    const knownTypes = ["low fat", "lowfat", "full fat", "full cream", "nonfat", "plain", "vanilla", "strawberry", "chocolate"];
    const matchedType = knownTypes.find((candidate) => normalized.includes(candidate));
    return matchedType ? toTitleCase(matchedType) : "";
  }

  if (key === "flavor") {
    const knownFlavors = ["plain", "vanilla", "strawberry", "chocolate", "mixed berry"];
    const matchedFlavor = knownFlavors.find((candidate) => normalized.includes(candidate));
    return matchedFlavor ? toTitleCase(matchedFlavor) : "";
  }

  if (key === "fat_strength" || key === "fat_percent") {
    const percentMatch = text.match(/\b\d+%/i);
    if (percentMatch) return percentMatch[0].replace(/\s+/g, "");
    const knownStrengths = ["low fat", "lowfat", "full fat", "full cream", "nonfat"];
    const matchedStrength = knownStrengths.find((candidate) => normalized.includes(candidate));
    return matchedStrength ? toTitleCase(matchedStrength) : "";
  }

  return "";
}

function getVariantOptionValues(product, variantEntries) {
  const explicit = variantEntries
    .map(({ fieldKey, optionName }) => {
      const aliasKeys = VARIANT_FIELD_ALIASES[fieldKey] ?? [fieldKey];
      const raw = aliasKeys
        .map((key) => product?.[key])
        .find((value) => typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null && String(value).trim().length > 0);
      const value = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
      if (!value || value.toLowerCase() === "default title") return null;
      return {
        name: optionName,
        value
      };
    })
    .filter(Boolean);

  if (explicit.length > 0) return uniqStrings(explicit.map((item) => JSON.stringify(item))).map((value) => JSON.parse(value));

  const inferred = variantEntries
    .map(({ fieldKey, optionName }) => {
      const aliasKeys = VARIANT_FIELD_ALIASES[fieldKey] ?? [fieldKey];
      const value = aliasKeys
        .map((key) => findOptionValueFromTitle(product?.title, key))
        .find(Boolean);
      if (!value) return null;
      return {
        name: optionName,
        value
      };
    })
    .filter(Boolean);

  return uniqStrings(inferred.map((item) => JSON.stringify(item))).map((value) => JSON.parse(value));
}

function buildComparableTitle(brand, title) {
  const normalizedBrand = normalizeRetailTitle(brand);
  const normalizedTitle = normalizeRetailTitle(title);
  if (!normalizedBrand) return String(title ?? "").trim();
  if (!normalizedTitle) return String(brand ?? "").trim();
  if (normalizedTitle === normalizedBrand || normalizedTitle.startsWith(`${normalizedBrand} `)) {
    return String(title ?? "").trim();
  }
  return `${String(brand ?? "").trim()} ${String(title ?? "").trim()}`.trim();
}

function resolveBrand(product) {
  const explicit = typeof product?.brand === "string" && product.brand.trim()
    ? product.brand.trim()
    : typeof product?.vendor === "string" && product.vendor.trim()
      ? product.vendor.trim()
      : "";
  if (explicit) return explicit;
  if (typeof product?.title === "string" && product.title.trim()) {
    return inferVendorFromTitle(product.title.trim());
  }
  return "";
}

function getFamilyTokenSet(title) {
  const tokens = normalizeRetailTitle(title)
    .split(" ")
    .filter(Boolean)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !["black", "white", "blue", "red", "green", "pink", "silver", "gold", "gray", "grey"].includes(token))
    .filter((token) => !["usb", "c", "wall", "charger", "wireless", "headphones", "milk", "yogurt"].includes(token));
  return new Set(tokens);
}

function familyOverlapScore(leftTitle, rightTitle) {
  const left = getFamilyTokenSet(leftTitle);
  const right = getFamilyTokenSet(rightTitle);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return shared / Math.max(left.size, right.size);
}

export function buildCatalogIndex(catalog) {
  return catalog.map((product) => {
    const basis = product?._catalog_match_basis && typeof product._catalog_match_basis === "object"
      ? product._catalog_match_basis
      : null;
    const source = basis && typeof basis === "object" ? basis : product;
    return {
      id: product.id ?? product.product_id ?? product.handle ?? product.sku ?? product.title,
      sku: source.sku ?? product.sku ?? "",
      barcode: source.barcode ?? product.barcode ?? "",
      title: source.title ?? product.title ?? "",
      brand: resolveBrand(source) || resolveBrand(product),
      handle: source.handle ?? product.handle ?? "",
      variant_signature: getVariantSignature(source, ["size", "type", "color", "storage", "option1", "option2"]),
      raw: product
    };
  });
}

export function runMatchDecision({ jobId, input, catalog, policy, learningText = "" }) {
  const candidates = buildCatalogIndex(catalog);
  const targetSku = normalizeValue(input.sku);
  const targetBarcode = normalizeValue(input.barcode);
  const resolvedTargetBrand = resolveBrand(input);
  const targetTitle = buildComparableTitle(resolvedTargetBrand, input.title);
  const canonicalTargetTitle = compactValue(normalizeRetailTitle(targetTitle));
  const variantEntries = (
    policy?.variant_structure?.primary_dimensions
    ?? policy?.variant_architecture?.allowed_dimensions
    ?? ["size", "type", "color", "storage"]
  ).map((item) => {
    const optionName = String(item).trim();
    return {
      optionName: optionName || toTitleCase(String(item).replace(/_/g, " ")),
      fieldKey: String(item).toLowerCase().replace(/\s+/g, "_")
    };
  });
  const variantKeys = variantEntries.map((entry) => entry.fieldKey);
  const targetVariant = getVariantSignature(input, variantKeys);
  const targetOptionValues = getVariantOptionValues(input, variantEntries);

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

  const exactCanonicalTitle = canonicalTargetTitle
    ? candidates.find((candidate) => compactValue(normalizeRetailTitle(buildComparableTitle(candidate.brand, candidate.title))) === canonicalTargetTitle)
    : null;
  if (exactCanonicalTitle) {
    const exactTitleVariant = getVariantSignature(exactCanonicalTitle.raw, variantKeys);
    const canTreatAsDuplicate = !targetVariant || !exactTitleVariant || targetVariant === exactTitleVariant;
    if (canTreatAsDuplicate) {
    return {
      ...createBaseResult({
        jobId,
        module: "catalogue-match",
        status: "success",
        needsReview: false,
        reasoning: [`Canonical product title match found for ${input.title ?? targetTitle}.`],
        nextActions: ["Treat as duplicate unless overridden by a human review."]
      }),
      decision: "DUPLICATE",
      confidence: 0.97,
      matched_product_id: exactCanonicalTitle.id,
      matched_variant_id: exactCanonicalTitle.id,
      proposed_action: { action: "skip_duplicate", product_id: exactCanonicalTitle.id }
    };
    }
  }

  const scored = candidates
    .map((candidate) => {
      const candidateTitle = buildComparableTitle(candidate.brand, candidate.title);
      const similarity = jaccardSimilarity(targetTitle, candidateTitle);
      const familyScore = familyOverlapScore(targetTitle, candidateTitle);
      const brandMismatch = Boolean(
        resolvedTargetBrand
        && candidate.brand
        && normalizeValue(resolvedTargetBrand) !== normalizeValue(candidate.brand)
      );
      const adjustedScore = brandMismatch
        ? Math.max(0, similarity - 0.2)
        : similarity;
      return {
        ...candidate,
        score: adjustedScore,
        raw_score: similarity,
        family_score: familyScore,
        brand_mismatch: brandMismatch
      };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const bestVariant = best ? getVariantSignature(best.raw, variantKeys) : "";
  const bestCanonicalTitle = best ? compactValue(normalizeRetailTitle(buildComparableTitle(best.brand, best.title))) : "";
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

  if (best.brand_mismatch && best.family_score < 0.5) {
    return {
      ...createBaseResult({
        jobId,
        module: "catalogue-match",
        status: "success",
        needsReview: false,
        reasoning: [
          `Closest candidate: ${best.title}`,
          "Candidate shares only generic category terms and does not match the same brand or product family strongly enough."
        ],
        nextActions: ["Treat as a new product unless stronger identity signals appear later."]
      }),
      decision: "NEW_PRODUCT",
      confidence: 0.82,
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

  if (!targetVariant && targetOptionValues.length === 0 && canonicalTargetTitle && bestCanonicalTitle && canonicalTargetTitle === bestCanonicalTitle) {
    return {
      ...createBaseResult({
        jobId,
        module: "catalogue-match",
        status: "success",
        needsReview: false,
        reasoning: [`Closest product family match: ${best.title}`, "Titles normalize to the same product identity and no meaningful variant option could be extracted."],
        nextActions: ["Treat as duplicate unless a human review finds a hidden variant difference."]
      }),
      decision: "DUPLICATE",
      confidence: 0.93,
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
    const variantOptionValues = targetOptionValues;
    if (variantOptionValues.length === 0) {
      return {
        ...createBaseResult({
          jobId,
          module: "catalogue-match",
          status: "success",
          needsReview: true,
          warnings: ["Product family matched but no real shopper-facing variant value could be extracted safely."],
          reasoning: [`Closest product family match: ${best.title}`, "Variant attachment was blocked because no actual option value was identified from the input."],
          nextActions: ["Review whether this is a duplicate or enrich the input with a real variant value before attaching."]
        }),
        decision: "NEEDS_REVIEW",
        confidence: 0.55,
        matched_product_id: best.id,
        matched_variant_id: null,
        proposed_action: { action: "manual_review" }
      };
    }
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
      proposed_action: {
        action: "attach_as_variant",
        product_id: best.id,
        product_handle: best.handle ?? "",
        product_title: best.title ?? "",
        option_values: variantOptionValues
      }
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
