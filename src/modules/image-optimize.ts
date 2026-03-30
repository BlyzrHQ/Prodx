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

function getPrimaryImage(input: ProductRecord): string | null {
  if (input.featured_image) return input.featured_image;
  if (Array.isArray(input.images) && input.images.length > 0) return input.images[0];
  return null;
}

function buildImageAltText(input: ProductRecord): string {
  if (typeof input.title === "string" && input.title.trim()) return input.title.trim();
  return dedupeTitleLikeText(input.vendor, input.brand, input.size, input.type);
}

function buildImageSearchQuery(input: ProductRecord): string {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title) return `"${title}" image`;

  const fallback = dedupeTitleLikeText(input.vendor, input.brand, input.size, input.type).trim();
  return fallback ? `"${fallback}" image` : "product image";
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
      maxOutputTokens: 2200,
      reasoningEffort: "low"
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
  candidateImages: Array<{ url: string; title?: string }>
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

function providerReady(resolved: ResolvedProvider | null): resolved is ResolvedProvider {
  return Boolean(resolved?.provider && resolved?.credential?.value);
}

function selectBestHero(review: ImageReviewOutput, allowedUrls: string[]): string {
  const heroUrl = review.selected?.hero?.url;
  if (typeof heroUrl === "string" && allowedUrls.includes(heroUrl) && Number(review.selected.hero?.confidence ?? 0) >= 0.7) {
    return heroUrl;
  }

  const ranked = (review.scored_candidates ?? [])
    .filter((candidate) => allowedUrls.includes(candidate.url) && candidate.approved && candidate.confidence >= 0.7)
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

  const candidateImages = hasImage
    ? [getPrimaryImage(input)].filter((value): value is string => typeof value === "string").map((url) => ({ url }))
    : [];
  let missingInputImages = false;

  if (!hasImage) {
    missingInputImages = true;
    reasoning.push("The module will try image search when a provider is configured.");

    if (providerReady(searchProvider) && searchProvider.provider.type === "serper") {
      try {
        const query = buildImageSearchQuery(input);
        const candidates = await searchSerperImages({
          apiKey: searchProvider.credential.value,
          query,
          num: 8
        });
        proposedChanges.image_search = {
          provider: searchProvider.providerAlias,
          query,
          candidates
        };
        reasoning.push(`Found ${candidates.length} image candidates via ${searchProvider.providerAlias}.`);
        candidateImages.push(...candidates.map((candidate) => ({ url: candidate.image_url, title: candidate.title })));
      } catch (error) {
        warnings.push(`Image search failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      proposedChanges.image_task = { action: "search_and_review", provider: configuredSearch };
      warnings.push("No ready search provider found. Configure Serper or another search provider alias.");
    }
  }

  if (candidateImages.length === 0) {
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
    const review = await analyzeCandidatesIndividually(
      visionProvider,
      policy,
      input,
      learningText,
      candidateImages
    );
    proposedChanges.image_review = review;

    const allowedUrls = candidateImages.map((candidate) => candidate.url);
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
