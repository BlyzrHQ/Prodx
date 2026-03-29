import { createBaseResult } from "./shared.js";
import { resolveProvider } from "../lib/providers.js";
import { searchSerperImages } from "../connectors/serper.js";
import { analyzeImageWithOpenAI } from "../connectors/openai.js";
import { createGeminiJsonResponse } from "../connectors/gemini.js";
import type { ImageReviewOutput, LooseRecord, PolicyDocument, ProductRecord, ResolvedProvider, RuntimeConfig } from "../types.js";

function getImageRequirements(policy: PolicyDocument): string {
  const requirements = policy?.image_requirements ?? {};
  const style = requirements.preferred_styles ?? requirements.style ?? [];
  return Array.isArray(style) ? style.join(", ") : String(style);
}

function getPrimaryImage(input: ProductRecord): string | null {
  if (input.featured_image) return input.featured_image;
  if (Array.isArray(input.images) && input.images.length > 0) return input.images[0];
  return null;
}

function buildImageAltText(input: ProductRecord): string {
  const parts = [
    input.brand,
    input.title,
    input.size,
    input.type
  ].filter((value) => typeof value === "string" && value.trim().length > 0);
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text || "Product image";
}

function imageReviewSchema() {
  return {
    name: "catalog_image_review",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["decision", "summary", "issues", "recommended_image_url"],
      properties: {
        decision: { type: "string" },
        summary: { type: "string" },
        issues: { type: "array", items: { type: "string" } },
        recommended_image_url: { type: "string" }
      }
    }
  };
}

async function analyzeWithVision(provider: ResolvedProvider, prompt: string, imageUrl: string): Promise<ImageReviewOutput> {
  const schema = imageReviewSchema();

  if (provider.provider.type === "openai") {
    const response = await analyzeImageWithOpenAI<ImageReviewOutput>({
      apiKey: provider.credential.value,
      model: provider.provider.model ?? "gpt-4.1-mini",
      instructions: "Review this ecommerce product image and return JSON only.",
      prompt,
      imageUrl,
      schema,
      maxOutputTokens: 900
    });
    return response.json;
  }

  if (provider.provider.type === "gemini") {
    const response = await createGeminiJsonResponse<ImageReviewOutput>({
      apiKey: provider.credential.value,
      model: provider.provider.model ?? "gemini-2.5-flash",
      systemInstruction: "Review this ecommerce product image and return JSON only.",
      textPrompt: prompt,
      imageUrl,
      schema
    });
    return response.json;
  }

  throw new Error(`Unsupported vision provider type: ${provider.provider.type}`);
}

function providerReady(resolved: ResolvedProvider | null): resolved is ResolvedProvider {
  return Boolean(resolved?.provider && resolved?.credential?.value);
}

function reviewApprovesImage(review: ImageReviewOutput): boolean {
  const decision = String(review.decision ?? "").toLowerCase();
  return ["approve", "approved", "keep", "use", "accept"].some((token) => decision.includes(token));
}

async function pickCandidateImage({
  candidates,
  imageRequirements,
  visionProvider,
  warnings,
  reasoning
}: {
  candidates: Array<{ image_url: string; title?: string }>;
  imageRequirements: string;
  visionProvider: ResolvedProvider | null;
  warnings: string[];
  reasoning: string[];
}): Promise<{ featuredImage?: string; review?: ImageReviewOutput }> {
  if (!candidates[0]) {
    return {};
  }

  if (!providerReady(visionProvider)) {
    warnings.push("No ready vision provider found. Using the top search candidate without image review.");
    reasoning.push("Selected the top search candidate because no vision provider was configured.");
    return { featuredImage: candidates[0].image_url };
  }

  let lastReview: ImageReviewOutput | undefined;

  for (const [index, candidate] of candidates.entries()) {
    const review = await analyzeWithVision(
      visionProvider,
      `Check whether this product image fits the store requirements: ${imageRequirements || "clear product-focused ecommerce imagery"}.
Return recommended_image_url as the approved URL or an empty string if this candidate should not be used.`,
      candidate.image_url
    );
    lastReview = review;
    warnings.push(...(review.issues ?? []));
    reasoning.push(review.summary ?? `Reviewed candidate ${index + 1} with ${visionProvider.providerAlias}.`);

    if (review.recommended_image_url) {
      return { featuredImage: review.recommended_image_url, review };
    }
    if (reviewApprovesImage(review)) {
      return { featuredImage: candidate.image_url, review };
    }
  }

  warnings.push("No image candidate passed automated review. Using the top search candidate for manual review.");
  reasoning.push("All reviewed candidates were rejected or inconclusive, so the top candidate was retained for human review.");
  return { featuredImage: candidates[0].image_url, review: lastReview };
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
  const hasImage = Boolean(getPrimaryImage(input));
  const searchProvider = await resolveProvider(root, "image-optimizer", "search_provider");
  const visionProvider = await resolveProvider(root, "image-optimizer", "vision_provider");
  const configuredSearch = runtimeConfig.modules?.["image-optimizer"]?.search_provider ?? null;
  const configuredVision = runtimeConfig.modules?.["image-optimizer"]?.vision_provider ?? null;
  const proposedChanges: LooseRecord = {};
  const warnings: string[] = [];
  const reasoning: string[] = [];
  const imageRequirements = getImageRequirements(policy);

  if (!hasImage) {
    warnings.push("No images available on the input payload.");
    reasoning.push("The module will try image search when a provider is configured.");

    if (providerReady(searchProvider) && searchProvider.provider.type === "serper") {
      try {
        const query = `${input.brand ?? ""} ${input.title ?? ""}`.trim();
        const candidates = await searchSerperImages({
          apiKey: searchProvider.credential.value,
          query,
          num: 5
        });
        proposedChanges.image_search = {
          provider: searchProvider.providerAlias,
          query,
          candidates
        };
        reasoning.push(`Found ${candidates.length} image candidates via ${searchProvider.providerAlias}.`);

        if (candidates[0]) {
          try {
            const selection = await pickCandidateImage({
              candidates,
              imageRequirements,
              visionProvider,
              warnings,
              reasoning
            });
          if (selection.review) {
            proposedChanges.image_review = selection.review;
          }
          if (selection.featuredImage) {
            proposedChanges.featured_image = selection.featuredImage;
            proposedChanges.image_alt_text = buildImageAltText(input);
          }
        } catch (error) {
          proposedChanges.featured_image = candidates[0].image_url;
          proposedChanges.image_alt_text = buildImageAltText(input);
          warnings.push(`Image review failed: ${error instanceof Error ? error.message : String(error)}`);
          warnings.push("Using the top search candidate for manual review because automated image review failed.");
          reasoning.push("Selected the top search candidate after automated image review failed.");
          }
        }
      } catch (error) {
        warnings.push(`Image search failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      proposedChanges.image_task = { action: "search_and_review", provider: configuredSearch };
      warnings.push("No ready search provider found. Configure Serper or another search provider alias.");
    }
  } else {
    const imageUrl = getPrimaryImage(input);
    reasoning.push("Existing images should be reviewed against the policy image requirements.");

    if (providerReady(visionProvider)) {
      try {
        const review = await analyzeWithVision(
          visionProvider,
          `Review this ecommerce image against the policy requirements: ${imageRequirements || "clear pack shot or merchandising image"}.
Return issues and whether it should be kept, replaced, or reviewed.`,
          imageUrl
        );
        proposedChanges.image_review = review;
        if (review.recommended_image_url) {
          proposedChanges.featured_image = review.recommended_image_url;
          proposedChanges.image_alt_text = buildImageAltText(input);
        }
        warnings.push(...(review.issues ?? []));
        reasoning.push(review.summary ?? `Reviewed current image with ${visionProvider.providerAlias}.`);
      } catch (error) {
        warnings.push(`Vision review failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      proposedChanges.image_task = { action: "quality_review", provider: configuredVision };
      warnings.push("No ready vision provider found. Configure OpenAI vision or another supported provider.");
    }
  }

  return createBaseResult({
    jobId,
    module: "image-optimizer",
    status: "success",
    needsReview: true,
    proposedChanges,
    warnings: [...new Set(warnings)],
    reasoning,
    nextActions: ["Review image candidates or review notes before applying image updates."]
  });
}
