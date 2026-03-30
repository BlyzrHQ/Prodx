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
  const qaStatus = typeof input.qa_status === "string" ? input.qa_status.toUpperCase() : "";
  const qaPassed = qaStatus === "PASS";
  const blockingWarnings = [
    ...(qaStatus && !qaPassed ? ["QA did not pass. Fix QA findings before syncing."] : []),
    ...(variantCount > 1 ? ["Live apply currently supports zero or one variant only. Multi-variant payloads must be reviewed manually."] : [])
  ];
  const nonBlockingWarnings = [
    ...(liveReady ? [] : ["Shopify provider is not fully configured for live apply."]),
    ...(imageCount === 0 ? ["No product image is currently attached to the Shopify payload."] : [])
  ];
  const needsReview = blockingWarnings.length > 0;

  return createBaseResult({
    jobId,
    module: "shopify-sync",
    status: "success",
    needsReview,
    proposedChanges: {
      shopify_payload: payload,
      live_apply_ready: liveReady,
      target_store: shopifyProvider?.provider?.store ?? "",
      variant_count: variantCount,
      image_count: imageCount
    },
    warnings: [...blockingWarnings, ...nonBlockingWarnings],
    reasoning: ["Built a Shopify-ready payload from the current product input, including any selected image URLs."],
    artifacts: {
      provider_used: shopifyProvider?.providerAlias ?? null
    },
    nextActions: needsReview
      ? ["Resolve blocking QA or sync issues before applying this payload."]
      : ["Ready for `catalog apply` or `catalog apply --live`."]
  });
}
