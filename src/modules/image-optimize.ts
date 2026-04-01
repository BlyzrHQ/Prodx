import { createBaseResult } from "./shared.js";
import { resolveProvider } from "../lib/providers.js";
import { getGuideImageRequirementSummary } from "../lib/catalog-guide.js";
import { buildImagePromptPayload, buildSystemPrompt, getImagePromptSpec } from "../lib/prompt-specs.js";
import { readText } from "../lib/fs.js";
import { getCatalogPaths } from "../lib/paths.js";
import { searchSerperImages } from "../connectors/serper.js";
import { analyzeImageWithOpenAI } from "../connectors/openai.js";
import { createGeminiJsonResponse } from "../connectors/gemini.js";
import { dedupeTitleLikeText } from "../lib/product.js";
import type { ImageReviewOutput, LooseRecord, PolicyDocument, ProductRecord, ResolvedProvider, RuntimeConfig } from "../types.js";

type ImageCandidateInput = {
  url: string;
  title?: string;
  source?: string;
  domain?: string;
  page_url?: string;
  position?: number;
};

type CandidatePreflightResult = {
  status: "usable" | "inconclusive" | "unusable";
  reason?: string;
  contentType?: string;
};

function getPrimaryImage(input: ProductRecord): string | null {
  if (input.featured_image) return input.featured_image;
  if (Array.isArray(input.images) && input.images.length > 0) return input.images[0];
  return null;
}

function buildImageAltText(input: ProductRecord): string {
  if (typeof input.title === "string" && input.title.trim()) return input.title.trim();
  return dedupeTitleLikeText(input.vendor, input.brand, input.size, input.type);
}

export function buildImageSearchQuery(input: ProductRecord): string {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title) return `"${title}" high quality product image`;

  const fallback = dedupeTitleLikeText(input.vendor, input.brand, input.size, input.type).trim();
  return fallback ? `"${fallback}" high quality product image` : "high quality product image";
}

export function buildImageSearchQueries(input: ProductRecord): string[] {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const fallback = dedupeTitleLikeText(input.vendor, input.brand, input.size, input.type).trim();
  const seed = title || fallback;
  if (!seed) {
    return ["high quality product image", "product packaging front image"];
  }

  return [
    `"${seed}" high quality product image`,
    `"${seed}" product packaging front`
  ];
}

function isLikelySupportedImageUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.endsWith(".svg")) return false;
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg") || pathname.endsWith(".png") || pathname.endsWith(".gif") || pathname.endsWith(".webp")) {
      return true;
    }
    const format = parsed.searchParams.get("format")?.toLowerCase() ?? "";
    return ["jpg", "jpeg", "png", "gif", "webp"].includes(format);
  } catch {
    return false;
  }
}

function isBrandAssetLikeUrl(url: string): boolean {
  return /brand_image|logo|icon|banner|back_|\/brand\/|\/logos?\//i.test(url);
}

function isSupportedImageContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.split(";")[0]?.trim().toLowerCase();
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(normalized);
}

async function fetchCandidateImageMetadata(
  url: string,
  method: "HEAD" | "GET",
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "image/jpeg,image/png,image/gif,image/webp,*/*;q=0.8"
  };
  if (method === "GET") {
    headers.Range = "bytes=0-0";
  }

  return fetchImpl(url, {
    method,
    redirect: "follow",
    headers,
    signal: AbortSignal.timeout(5000)
  });
}

export async function evaluateImageCandidateUrl(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<CandidatePreflightResult> {
  if (!isLikelySupportedImageUrl(url)) {
    return { status: "unusable", reason: "unsupported_url" };
  }

  let sawInconclusive = false;

  for (const method of ["HEAD", "GET"] as const) {
    try {
      const response = await fetchCandidateImageMetadata(url, method, fetchImpl);
      const contentType = response.headers.get("content-type");

      if (response.ok) {
        if (isSupportedImageContentType(contentType)) {
          return {
            status: "usable",
            contentType: contentType ?? undefined
          };
        }

        if (contentType && !contentType.toLowerCase().startsWith("image/")) {
          return {
            status: "unusable",
            reason: `unsupported_content_type:${contentType}`
          };
        }

        sawInconclusive = true;
        continue;
      }

      if ([404, 410].includes(response.status)) {
        return {
          status: "unusable",
          reason: `http_${response.status}`
        };
      }

      if ([401, 403, 405, 429].includes(response.status) || response.status >= 500) {
        sawInconclusive = true;
        continue;
      }

      return {
        status: "unusable",
        reason: `http_${response.status}`
      };
    } catch {
      sawInconclusive = true;
    }
  }

  return {
    status: sawInconclusive ? "inconclusive" : "unusable",
    reason: sawInconclusive ? "preflight_inconclusive" : "preflight_failed"
  };
}

async function preflightImageCandidates(
  candidates: ImageCandidateInput[],
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<{
  usable: ImageCandidateInput[];
  inconclusive: ImageCandidateInput[];
  unusable: Array<ImageCandidateInput & { reason: string }>;
}> {
  const usable: ImageCandidateInput[] = [];
  const inconclusive: ImageCandidateInput[] = [];
  const unusable: Array<ImageCandidateInput & { reason: string }> = [];

  for (const candidate of candidates) {
    const result = await evaluateImageCandidateUrl(candidate.url, fetchImpl);
    if (result.status === "usable") {
      usable.push(candidate);
      continue;
    }

    if (result.status === "inconclusive") {
      inconclusive.push(candidate);
      continue;
    }

    unusable.push({
      ...candidate,
      reason: result.reason ?? "preflight_failed"
    });
  }

  return { usable, inconclusive, unusable };
}

function normalizeCandidateText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSearchTokens(value: string): string[] {
  return normalizeCandidateText(value)
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 1);
}

function getProductSearchSignals(product: ProductRecord): {
  brandTokens: string[];
  titleTokens: string[];
  sizeTokens: string[];
} {
  const brandText = [product.brand, product.vendor].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" ");
  const titleText = typeof product.title === "string" ? product.title : "";
  const titleTokens = extractSearchTokens(titleText);
  const brandTokens = extractSearchTokens(brandText);
  const sizeTokens = titleTokens.filter((token) => /\d/.test(token) || /^(ml|l|g|kg|oz|lb|tb|gb)$/.test(token));
  return { brandTokens, titleTokens, sizeTokens };
}

export function scoreImageCandidate(product: ProductRecord, candidate: ImageCandidateInput): number {
  const signals = getProductSearchSignals(product);
  const haystack = normalizeCandidateText([
    candidate.title ?? "",
    candidate.source ?? "",
    candidate.domain ?? "",
    candidate.page_url ?? "",
    candidate.url
  ].join(" "));

  let score = 0;
  let sharedTitleTokens = 0;
  for (const token of signals.titleTokens) {
    if (haystack.includes(token)) {
      sharedTitleTokens += 1;
      score += signals.sizeTokens.includes(token) ? 4 : signals.brandTokens.includes(token) ? 3 : 1;
    }
  }

  if (sharedTitleTokens > 0) {
    score += Math.min(sharedTitleTokens, 6);
  }

  if (signals.brandTokens.some((token) => haystack.includes(token))) {
    score += 3;
  }

  if (signals.sizeTokens.length > 0 && signals.sizeTokens.some((token) => haystack.includes(token))) {
    score += 4;
  }

  if (/high quality|product|pack|front|pdp|main/i.test(candidate.title ?? "")) {
    score += 1;
  }

  if (/tiktok|instagram|facebook|pinterest|youtube|clubt/i.test(haystack)) {
    score -= 6;
  }

  if (/brand_image|logo|icon|banner|back_/.test(haystack)) {
    score -= 5;
  }

  if (/drinkable|mixed berry|passion fruit|strawberry|vanilla|0 fat|full fat|full cream|3 1|4x|4 pcs|360g|150g/.test(haystack)) {
    score -= 4;
  }

  if (/product\/|\/p\//.test(candidate.page_url ?? "")) {
    score += 1;
  }

  if (typeof candidate.position === "number") {
    score += Math.max(0, 4 - Math.min(candidate.position - 1, 4));
  }

  return score;
}

export function rankImageCandidates(product: ProductRecord, candidates: ImageCandidateInput[]): ImageCandidateInput[] {
  return [...candidates].sort((left, right) => {
    const scoreDelta = scoreImageCandidate(product, right) - scoreImageCandidate(product, left);
    if (scoreDelta !== 0) return scoreDelta;
    return (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER);
  });
}

function dedupeImageCandidates(candidates: ImageCandidateInput[]): ImageCandidateInput[] {
  const seen = new Set<string>();
  const deduped: ImageCandidateInput[] = [];

  for (const candidate of candidates) {
    const key = candidate.url.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

function imageReviewSchema() {
  return {
    name: "catalog_image_review",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["status", "confidence", "selected", "scored_candidates", "rejected", "findings", "skipped_reasons"],
      properties: {
        status: { type: "string", enum: ["PASS", "FAIL"] },
        confidence: { type: "number" },
        selected: {
          type: "object",
          additionalProperties: false,
          required: ["hero", "secondary"],
          properties: {
            hero: {
              anyOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["url", "confidence"],
                  properties: {
                    url: { type: "string" },
                    confidence: { type: "number" }
                  }
                },
                { type: "null" }
              ]
            },
            secondary: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["url", "type", "confidence"],
                properties: {
                  url: { type: "string" },
                  type: { type: "string" },
                  confidence: { type: "number" }
                }
              }
            }
          }
        },
        scored_candidates: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["url", "type", "approved", "score", "confidence", "issues"],
            properties: {
              url: { type: "string" },
              type: { type: "string" },
              approved: { type: "boolean" },
              score: { type: "number" },
              confidence: { type: "number" },
              issues: { type: "array", items: { type: "string" } }
            }
          }
        },
        rejected: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["url", "reason", "details"],
            properties: {
              url: { type: "string" },
              reason: { type: "string" },
              details: { type: "string" }
            }
          }
        },
        findings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "message"],
            properties: {
              type: { type: "string" },
              message: { type: "string" }
            }
          }
        },
        skipped_reasons: { type: "array", items: { type: "string" } }
      }
    }
  };
}

async function analyzeCandidateWithVision(provider: ResolvedProvider, prompt: string, imageUrls: string[]): Promise<ImageReviewOutput> {
  const schema = imageReviewSchema();
  const instructions = buildSystemPrompt(getImagePromptSpec());

  if (provider.provider.type === "openai") {
    const response = await analyzeImageWithOpenAI<ImageReviewOutput>({
      apiKey: provider.credential.value,
      model: provider.provider.model ?? "gpt-4.1-mini",
      instructions,
      prompt,
      imageUrls,
      schema,
      maxOutputTokens: 2200
    });
    return response.json;
  }

  if (provider.provider.type === "gemini") {
    const response = await createGeminiJsonResponse<ImageReviewOutput>({
      apiKey: provider.credential.source === "oauth" ? undefined : provider.credential.value,
      accessToken: provider.credential.source === "oauth" ? provider.credential.value : undefined,
      googleProjectId: provider.credential.source === "oauth" ? String(provider.credential.metadata?.project_id ?? "") : undefined,
      model: provider.provider.model ?? "gemini-2.5-flash",
      systemInstruction: instructions,
      textPrompt: prompt,
      imageUrls,
      schema
    });
    return response.json;
  }

  throw new Error(`Unsupported vision provider type: ${provider.provider.type}`);
}

async function analyzeCandidatesIndividually(
  provider: ResolvedProvider,
  policy: PolicyDocument,
  product: ProductRecord,
  learningText: string,
  candidateImages: ImageCandidateInput[]
): Promise<ImageReviewOutput> {
  const scoredCandidates: ImageReviewOutput["scored_candidates"] = [];
  const rejected: ImageReviewOutput["rejected"] = [];
  const findings = new Map<string, { type: string; message: string }>();
  const skippedReasons = new Set<string>();

  for (const candidate of candidateImages) {
    try {
      const prompt = buildImagePromptPayload({
        product,
        guide: policy,
        storeContext: {
          business_name: policy.meta?.business_name ?? "Store",
          industry: policy.meta?.industry ?? "general",
          image_requirements: getGuideImageRequirementSummary(policy)
        },
        candidateImages: [candidate],
        learningText
      });

      const review = await analyzeCandidateWithVision(provider, prompt, [candidate.url]);
      const scored = review.scored_candidates?.[0];

      if (scored) {
        scoredCandidates.push(scored);
        if (!scored.approved) {
          rejected.push({
            url: scored.url,
            reason: scored.issues[0] ?? "candidate_rejected",
            details: scored.issues.join("; ")
          });
        }
      } else {
        rejected.push({
          url: candidate.url,
          reason: "candidate_not_scored",
          details: "Vision review returned no scored candidate payload for this image."
        });
      }

      for (const finding of review.findings ?? []) {
        findings.set(`${finding.type}|${finding.message}`, finding);
      }
      for (const reason of review.skipped_reasons ?? []) {
        skippedReasons.add(reason);
      }
    } catch (error) {
      rejected.push({
        url: candidate.url,
        reason: "vision_request_failed",
        details: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const approvedCandidates = scoredCandidates
    .filter((candidate) => candidate.approved && candidate.confidence >= 0.7)
    .sort((left, right) => {
      const heroBias = Number(right.type === "hero") - Number(left.type === "hero");
      return heroBias || right.score - left.score || right.confidence - left.confidence;
    });

  const hero = approvedCandidates[0]
    ? {
        url: approvedCandidates[0].url,
        confidence: approvedCandidates[0].confidence
      }
    : null;

  const secondary = approvedCandidates
    .slice(hero ? 1 : 0)
    .slice(0, 3)
    .map((candidate) => ({
      url: candidate.url,
      type: candidate.type,
      confidence: candidate.confidence
    }));

  if (!hero && findings.size === 0) {
    findings.set(
      "image_selection_failed|No candidate image passed visual review strongly enough to be selected.",
      {
        type: "image_selection_failed",
        message: "No candidate image passed visual review strongly enough to be selected."
      }
    );
  }

  return {
    status: hero ? "PASS" : "FAIL",
    confidence: hero?.confidence ?? Math.max(0, ...approvedCandidates.map((candidate) => candidate.confidence)),
    selected: {
      hero,
      secondary
    },
    scored_candidates: scoredCandidates,
    rejected,
    findings: [...findings.values()],
    skipped_reasons: [...skippedReasons]
  };
}

function mergeImageReviews(reviews: ImageReviewOutput[]): ImageReviewOutput {
  const findings = new Map<string, { type: string; message: string }>();
  const skippedReasons = new Set<string>();
  const scoredCandidates: ImageReviewOutput["scored_candidates"] = [];
  const rejected: ImageReviewOutput["rejected"] = [];

  for (const review of reviews) {
    for (const candidate of review.scored_candidates ?? []) {
      scoredCandidates.push(candidate);
    }
    for (const item of review.rejected ?? []) {
      rejected.push(item);
    }
    for (const finding of review.findings ?? []) {
      findings.set(`${finding.type}|${finding.message}`, finding);
    }
    for (const reason of review.skipped_reasons ?? []) {
      skippedReasons.add(reason);
    }
  }

  const approvedCandidates = scoredCandidates
    .filter((candidate) => candidate.approved && candidate.confidence >= 0.7)
    .sort((left, right) => {
      const heroBias = Number(right.type === "hero") - Number(left.type === "hero");
      return heroBias || right.score - left.score || right.confidence - left.confidence;
    });

  const hero = approvedCandidates[0]
    ? {
        url: approvedCandidates[0].url,
        confidence: approvedCandidates[0].confidence
      }
    : null;

  const secondary = approvedCandidates
    .slice(hero ? 1 : 0)
    .slice(0, 3)
    .map((candidate) => ({
      url: candidate.url,
      type: candidate.type,
      confidence: candidate.confidence
    }));

  if (!hero && findings.size === 0) {
    findings.set(
      "image_selection_failed|No candidate image passed visual review strongly enough to be selected.",
      {
        type: "image_selection_failed",
        message: "No candidate image passed visual review strongly enough to be selected."
      }
    );
  }

  return {
    status: hero ? "PASS" : "FAIL",
    confidence: hero?.confidence ?? Math.max(0, ...approvedCandidates.map((candidate) => candidate.confidence)),
    selected: {
      hero,
      secondary
    },
    scored_candidates: scoredCandidates,
    rejected,
    findings: [...findings.values()],
    skipped_reasons: [...skippedReasons]
  };
}

async function analyzeCandidatesInBatches(
  provider: ResolvedProvider,
  policy: PolicyDocument,
  product: ProductRecord,
  learningText: string,
  candidateImages: ImageCandidateInput[],
  batchSize = 3
): Promise<{ review: ImageReviewOutput; processedBatches: number; totalBatches: number }> {
  const reviews: ImageReviewOutput[] = [];
  const totalBatches = Math.max(1, Math.ceil(candidateImages.length / batchSize));

  for (let index = 0; index < candidateImages.length; index += batchSize) {
    const batch = candidateImages.slice(index, index + batchSize);
    const review = await analyzeCandidatesIndividually(provider, policy, product, learningText, batch);
    reviews.push(review);

    const approvedHero = review.selected?.hero;
    if (review.status === "PASS" && approvedHero && approvedHero.confidence >= 0.7) {
      return {
        review: mergeImageReviews(reviews),
        processedBatches: reviews.length,
        totalBatches
      };
    }
  }

  return {
    review: mergeImageReviews(reviews),
    processedBatches: reviews.length,
    totalBatches
  };
}

function providerReady(resolved: ResolvedProvider | null): resolved is ResolvedProvider {
  return Boolean(resolved?.provider && resolved?.credential?.value);
}

function selectBestHero(review: ImageReviewOutput, allowedUrls: string[]): string {
  const heroUrl = review.selected?.hero?.url;
  if (
    typeof heroUrl === "string" &&
    allowedUrls.includes(heroUrl) &&
    !isBrandAssetLikeUrl(heroUrl) &&
    Number(review.selected.hero?.confidence ?? 0) >= 0.7
  ) {
    return heroUrl;
  }

  const ranked = (review.scored_candidates ?? [])
    .filter(
      (candidate) =>
        allowedUrls.includes(candidate.url) &&
        candidate.approved &&
        candidate.confidence >= 0.7 &&
        !isBrandAssetLikeUrl(candidate.url)
    )
    .sort((left, right) => right.score - left.score || right.confidence - left.confidence);

  return ranked[0]?.url ?? "";
}

export async function runImageOptimize({
  root,
  jobId,
  input,
  policy,
  runtimeConfig
}: {
  root: string;
  jobId: string;
  input: ProductRecord;
  policy: PolicyDocument;
  runtimeConfig: RuntimeConfig;
}) {
  const learningText = await readText(getCatalogPaths(root).learningMarkdown, "");
  const hasImage = Boolean(getPrimaryImage(input));
  const searchProvider = await resolveProvider(root, "image-optimizer", "search_provider");
  const visionProvider = await resolveProvider(root, "image-optimizer", "vision_provider");
  const configuredSearch = runtimeConfig.modules?.["image-optimizer"]?.search_provider ?? null;
  const configuredVision = runtimeConfig.modules?.["image-optimizer"]?.vision_provider ?? null;
  const proposedChanges: LooseRecord = {};
  const warnings: string[] = [];
  const reasoning: string[] = [];

  const rawCandidateImages: ImageCandidateInput[] = hasImage
    ? [getPrimaryImage(input)].filter((value): value is string => typeof value === "string").map((url) => ({ url }))
    : [];
  const candidateImages = rawCandidateImages;
  let missingInputImages = false;

  if (!hasImage) {
    missingInputImages = true;
    reasoning.push("The module will try image search when a provider is configured.");

    if (providerReady(searchProvider) && searchProvider.provider.type === "serper") {
      try {
        const queries = buildImageSearchQueries(input);
        const collectedCandidates: ImageCandidateInput[] = [];
        const imageSearchAttempts: Array<{ query: string; count: number }> = [];
        for (const query of queries) {
          const candidates = await searchSerperImages({
            apiKey: searchProvider.credential.value,
            query,
            num: 8
          });
          imageSearchAttempts.push({ query, count: candidates.length });
          collectedCandidates.push(
            ...candidates.map((candidate) => ({
              url: candidate.image_url,
              title: candidate.title,
              source: candidate.source,
              domain: candidate.domain,
              page_url: candidate.page_url,
              position: candidate.position
            }))
          );
        }
        const dedupedCandidates = dedupeImageCandidates(collectedCandidates);
        proposedChanges.image_search = {
          provider: searchProvider.providerAlias,
          query: queries[0] ?? buildImageSearchQuery(input),
          queries,
          attempts: imageSearchAttempts,
          candidates: dedupedCandidates.map((candidate) => ({
            title: candidate.title,
            image_url: candidate.url,
            source: candidate.source,
            domain: candidate.domain,
            page_url: candidate.page_url,
            position: candidate.position
          }))
        };
        reasoning.push(`Found ${dedupedCandidates.length} unique image candidates via ${searchProvider.providerAlias} across ${queries.length} search query variants.`);
        candidateImages.push(...dedupedCandidates);
      } catch (error) {
        warnings.push(`Image search failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      proposedChanges.image_task = { action: "search_and_review", provider: configuredSearch };
      warnings.push("No ready search provider found. Configure Serper or another search provider alias.");
    }
  }

  const candidatesWithSupportedUrls = candidateImages.filter((candidate) => isLikelySupportedImageUrl(candidate.url));
  if (candidatesWithSupportedUrls.length !== candidateImages.length) {
    warnings.push(`Skipped ${candidateImages.length - candidatesWithSupportedUrls.length} candidate URL(s) that were not clearly valid supported image URLs.`);
  }

  const preflightedCandidates = await preflightImageCandidates(candidatesWithSupportedUrls);
  const filteredCandidates = [
    ...rankImageCandidates(input, preflightedCandidates.usable),
    ...rankImageCandidates(input, preflightedCandidates.inconclusive)
  ];

  if (preflightedCandidates.unusable.length > 0) {
    warnings.push(
      `Skipped ${preflightedCandidates.unusable.length} candidate URL(s) after image preflight: ${preflightedCandidates.unusable
        .slice(0, 3)
        .map((candidate) => candidate.reason)
        .join(", ")}`
    );
  }
  if (preflightedCandidates.usable.length > 0) {
    reasoning.push(`Preflight confirmed ${preflightedCandidates.usable.length} candidate image URL(s) as directly fetchable images.`);
  }
  if (preflightedCandidates.inconclusive.length > 0) {
    reasoning.push(`Kept ${preflightedCandidates.inconclusive.length} candidate image URL(s) for review after inconclusive preflight checks.`);
  }

  if (filteredCandidates.length === 0) {
    if (missingInputImages) {
      warnings.push("No images were provided in the input payload, and image search returned no usable candidates.");
    }
    return createBaseResult({
      jobId,
      module: "image-optimizer",
      status: "success",
      needsReview: true,
      proposedChanges,
      warnings: [...new Set(warnings)],
      reasoning,
      nextActions: ["Review image configuration before applying image updates."]
    });
  }

  if (!providerReady(visionProvider)) {
    proposedChanges.image_task = { action: "quality_review", provider: configuredVision };
    warnings.push("No ready vision provider found. Configure OpenAI vision or another supported provider.");
    return createBaseResult({
      jobId,
      module: "image-optimizer",
      status: "success",
      needsReview: true,
      proposedChanges,
      warnings: [...new Set(warnings)],
      reasoning,
      nextActions: ["Review image configuration before applying image updates."]
    });
  }

  let needsReview = true;
  let nextActions = ["Review image findings before applying image updates."];

  try {
    const batchResult = await analyzeCandidatesInBatches(
      visionProvider,
      policy,
      input,
      learningText,
      filteredCandidates,
      3
    );
    const review = batchResult.review;
    proposedChanges.image_review = review;

    const allowedUrls = filteredCandidates.map((candidate) => candidate.url);
    const selectedHero = selectBestHero(review, allowedUrls);
    if (selectedHero) {
      proposedChanges.featured_image = selectedHero;
      const altText = buildImageAltText(input);
      if (altText) proposedChanges.image_alt_text = altText;
      const secondaryUrls = Array.isArray(review.selected?.secondary)
        ? review.selected.secondary
            .filter((item) => allowedUrls.includes(item.url))
            .map((item) => item.url)
        : [];
      proposedChanges.images = [selectedHero, ...secondaryUrls.filter((url) => url !== selectedHero)];
    }

    const candidateSummaries = Array.isArray(review.scored_candidates)
      ? review.scored_candidates
      : [];
    reasoning.push(`Reviewed ${candidateSummaries.length} candidate image(s) across ${batchResult.processedBatches}/${batchResult.totalBatches} batch(es).`);
    candidateSummaries.forEach((candidate, index) => {
      reasoning.push(`Candidate ${index + 1}: ${candidate.url} -> score ${candidate.score}, confidence ${candidate.confidence.toFixed(2)}, type ${candidate.type}${candidate.approved ? ", approved" : ", rejected"}`);
    });

    if (Array.isArray(review.rejected)) {
      warnings.push(...review.rejected.map((item) => `${item.url}: ${item.reason}`));
    }
    if (Array.isArray(review.findings)) {
      warnings.push(...review.findings.map((item) => `${item.type}: ${item.message}`));
    }
    if (Array.isArray(review.skipped_reasons) && review.skipped_reasons.length > 0) {
      warnings.push(`Skipped: ${review.skipped_reasons.join(", ")}`);
    }
    reasoning.push(`Image review status: ${review.status} with confidence ${review.confidence.toFixed(2)}.`);
    const imagePassed = review.status === "PASS" && Boolean(selectedHero) && review.confidence >= 0.7;
    needsReview = !imagePassed;
    nextActions = imagePassed
      ? ["Proceed to QA validation."]
      : ["Review image findings before applying image updates."];
  } catch (error) {
    warnings.push(`Vision review failed: ${error instanceof Error ? error.message : String(error)}`);
    reasoning.push("No image was selected automatically because visual validation did not complete successfully.");
  }

  return createBaseResult({
    jobId,
    module: "image-optimizer",
    status: "success",
    needsReview,
    proposedChanges,
    warnings: [...new Set(warnings)],
    reasoning,
    nextActions
  });
}
