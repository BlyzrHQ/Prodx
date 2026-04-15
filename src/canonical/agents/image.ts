import { getConfig } from "../config.js";
import { uploadImageFromUrl } from "../services/image-upload.js";

interface ImageCandidate {
  url: string;
  altText: string | null;
  source: "uploaded" | "existing" | "web";
}

interface ImageReviewResult {
  accept: boolean;
  reason: string;
  altText: string;
  confidence: number;
}

export async function runImageAgent(input: {
  product: Record<string, unknown>;
  guide?: Record<string, unknown>;
}): Promise<{
  featuredImage: string | null;
  images: Array<{ url: string; altText: string | null; position?: number; sourceUrl?: string; storageId?: string }>;
  findings: string[];
  sourceTier: string | null;
}> {
  const product = input.product;
  const findings: string[] = [];

  const candidates = gatherCandidates(product);
  for (const candidate of candidates) {
    const review = await reviewCandidate(product, candidate);
    if (!review.accept) {
      findings.push(review.reason);
      continue;
    }

    const stored = await uploadCandidate(candidate);
    const image = {
      url: stored.url,
      altText: review.altText || candidate.altText,
      position: 1,
      sourceUrl: stored.sourceUrl,
      storageId: stored.storageId,
    };

    return {
      featuredImage: stored.url,
      images: [image],
      findings,
      sourceTier: candidate.source,
    };
  }

  const webCandidates = await searchFallbackImages(product);
  for (const candidate of webCandidates) {
    const review = await reviewCandidate(product, candidate);
    if (!review.accept) {
      findings.push(review.reason);
      continue;
    }

    const stored = await uploadCandidate(candidate);
    const image = {
      url: stored.url,
      altText: review.altText || candidate.altText,
      position: 1,
      sourceUrl: stored.sourceUrl,
      storageId: stored.storageId,
    };

    return {
      featuredImage: stored.url,
      images: [image],
      findings,
      sourceTier: "web",
    };
  }

  return {
    featuredImage: typeof product.featuredImage === "string" ? product.featuredImage : null,
    images: normalizeExistingImages(product),
    findings: findings.length > 0 ? findings : ["No acceptable product image found."],
    sourceTier: null,
  };
}

function gatherCandidates(product: Record<string, unknown>): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const featuredImage = typeof product.featuredImage === "string" ? product.featuredImage : "";
  if (featuredImage) {
    candidates.push({
      url: featuredImage,
      altText: String(product.title ?? "") || null,
      source: "uploaded",
    });
  }

  const images = normalizeExistingImages(product);
  for (const image of images) {
    if (image.url && !candidates.some((candidate) => candidate.url === image.url)) {
      candidates.push({
        url: image.url,
        altText: image.altText ?? null,
        source: "existing",
      });
    }
  }

  return candidates;
}

function normalizeExistingImages(product: Record<string, unknown>) {
  const images = Array.isArray(product.images) ? product.images : [];
  return images
    .map((image, index) => {
      if (typeof image === "string") {
        return { url: image, altText: String(product.title ?? "") || null, position: index + 1 };
      }
      if (image && typeof image === "object") {
        return {
          url: String((image as any).url ?? ""),
          altText: (image as any).altText ? String((image as any).altText) : null,
          position: (image as any).position ?? index + 1,
          sourceUrl: (image as any).sourceUrl ? String((image as any).sourceUrl) : undefined,
          storageId: (image as any).storageId,
        };
      }
      return null;
    })
    .filter((image): image is NonNullable<typeof image> => Boolean(image?.url));
}

async function reviewCandidate(
  product: Record<string, unknown>,
  candidate: ImageCandidate
): Promise<ImageReviewResult> {
  const { openaiApiKey } = getConfig();
  if (!openaiApiKey) {
    return {
      accept: true,
      reason: "No OpenAI key configured for visual review.",
      altText: buildAltText(product),
      confidence: 0.5,
    };
  }

  const prompt = buildImageReviewPrompt(product);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + openaiApiKey,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: prompt },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Review this candidate product image. Return valid JSON with accept, reason, altText, and confidence.",
            },
            {
              type: "image_url",
              image_url: { url: candidate.url },
            },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "image_review",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              accept: { type: "boolean" },
              reason: { type: "string" },
              altText: { type: "string" },
              confidence: { type: "number" },
            },
            required: ["accept", "reason", "altText", "confidence"],
          },
        },
      },
    }),
  });

  if (!response.ok) {
    return {
      accept: false,
      reason: "Image review failed: " + response.status,
      altText: buildAltText(product),
      confidence: 0,
    };
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    return {
      accept: false,
      reason: "Image review returned no content.",
      altText: buildAltText(product),
      confidence: 0,
    };
  }

  const parsed = JSON.parse(content) as ImageReviewResult;
  return {
    accept: Boolean(parsed.accept),
    reason: parsed.reason,
    altText: parsed.altText || buildAltText(product),
    confidence: normalizeConfidence(parsed.confidence),
  };
}

function buildImageReviewPrompt(product: Record<string, unknown>): string {
  const title = String(product.title ?? "");
  const vendor = String(product.vendor ?? "");
  const productType = String(product.productType ?? "");
  const handle = String(product.handle ?? "");
  const description = String(product.description ?? "");
  const optionValues = [
    product.option1,
    product.option2,
    product.option3,
    product.option1Value,
    product.option2Value,
    product.option3Value,
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  const isCommodity = isCommodityProduct(title, vendor, productType);

  return `You are an exact-match product image reviewer.

Product:
- title: ${title}
- vendor: ${vendor}
- product type: ${productType}
- handle: ${handle}
- short description: ${description.slice(0, 240)}
- option values: ${optionValues.join(", ") || "none"}

Rules:
- Accept only if the image clearly matches the product identity.
- Reject recipe, lifestyle, or unrelated product imagery.
- Reject random branded packaging when the product has no real brand.
- For no-brand commodity products like quinoa, rice, beans, fruits, or vegetables, prefer the item itself or generic product imagery instead of a random branded bag.
- For no-brand commodity products, prefer the ingredient or produce itself over branded packaging.
- If the candidate is a package image for an unbranded commodity, reject it unless the product itself is clearly sold as packaged and branded in the input.
- Prefer front-of-pack or clearly representative product imagery.
- Keep alt text factual and clean.`;
}

async function searchFallbackImages(product: Record<string, unknown>): Promise<ImageCandidate[]> {
  const { serperApiKey } = getConfig();
  if (!serperApiKey) {
    return [];
  }

  const query = buildImageSearchQuery(product);
  const response = await fetch("https://google.serper.dev/images", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": serperApiKey,
    },
    body: JSON.stringify({ q: query, num: 5 }),
  });

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as { images?: Array<{ imageUrl?: string; title?: string }> };
  return (data.images ?? [])
    .map((image) => ({
      url: image.imageUrl ?? "",
      altText: image.title ?? null,
      source: "web" as const,
    }))
    .filter((candidate) => candidate.url);
}

function buildImageSearchQuery(product: Record<string, unknown>): string {
  const title = String(product.title ?? "").trim();
  const vendor = String(product.vendor ?? "").trim();
  const productType = String(product.productType ?? "").trim();

  if (isCommodityProduct(title, vendor, productType)) {
    return `${title || productType} ingredient pile loose product high quality`;
  }

  return [vendor, title, "product packshot"]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function isCommodityProduct(title: string, vendor: string, productType: string): boolean {
  const normalizedVendor = vendor.trim().toLowerCase();
  if (normalizedVendor.length > 0 && !["generic", "unknown", "unbranded"].includes(normalizedVendor)) {
    return false;
  }

  const haystack = `${title} ${productType}`.toLowerCase();
  return [
    "quinoa",
    "rice",
    "beans",
    "lentils",
    "tomato",
    "potato",
    "onion",
    "apple",
    "banana",
    "cucumber",
    "lettuce",
    "spinach",
    "broccoli",
  ].some((term) => haystack.includes(term));
}

async function uploadCandidate(candidate: ImageCandidate) {
  return uploadImageFromUrl(candidate.url);
}

function buildAltText(product: Record<string, unknown>): string {
  return [product.vendor, product.title].map((value) => String(value ?? "").trim()).filter(Boolean).join(" ");
}

function normalizeConfidence(value: number): number {
  if (value <= 1) {
    return value * 100;
  }
  return value;
}
