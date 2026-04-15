import { task } from "@trigger.dev/sdk/v3";
import { publishApprovedProducts, runProductPublishStage } from "../services/pipeline.js";

export const productPublisher = task({
  id: "product-publisher",
  run: async (payload?: {
    productId?: string;
    product?: Record<string, unknown>;
    qaScore?: number;
    reviewNotes?: Array<Record<string, unknown>>;
  }) => {
    if (payload?.productId) {
      return runProductPublishStage(
        String(payload.productId),
        payload.product,
        payload.qaScore,
        payload.reviewNotes
      );
    }
    return publishApprovedProducts();
  },
});
