import { createBaseResult } from "./shared.js";
import { buildShopifyPayload } from "../connectors/shopify.js";
import { resolveProvider } from "../lib/providers.js";
import type { ProductRecord } from "../types.js";

export async function runSync({ root, jobId, input }: { root: string; jobId: string; input: ProductRecord }) {
  const shopifyProvider = await resolveProvider(root, "shopify-sync", "shopify_provider");
  const liveReady = Boolean(shopifyProvider?.provider?.store && shopifyProvider?.credential?.value);
  const payload = buildShopifyPayload(input);
  const variantCount = Array.isArray(payload.variants) ? payload.variants.length : 0;
  const imageCount = Array.isArray(payload.images) ? payload.images.length : 0;

  return createBaseResult({
    jobId,
    module: "shopify-sync",
    status: "success",
    needsReview: true,
    proposedChanges: {
      shopify_payload: payload,
      live_apply_ready: liveReady,
      target_store: shopifyProvider?.provider?.store ?? "",
      variant_count: variantCount,
      image_count: imageCount
    },
    warnings: [
      ...(liveReady ? [] : ["Shopify provider is not fully configured for live apply."]),
      ...(variantCount > 1 ? ["Live apply currently supports zero or one variant only. Multi-variant payloads must be reviewed manually."] : []),
      ...(imageCount === 0 ? ["No product image is currently attached to the Shopify payload."] : [])
    ],
    reasoning: ["Built a Shopify-ready payload from the current product input, including any selected image URLs."],
    artifacts: {
      provider_used: shopifyProvider?.providerAlias ?? null
    },
    nextActions: ["Review the payload and approve before `catalog apply`."]
  });
}
