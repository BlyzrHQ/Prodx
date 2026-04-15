import { task } from "@trigger.dev/sdk/v3";
import { publishApprovedProducts, runProductPublishStage } from "../services/pipeline.js";

export const productPublisher = task({
  id: "product-publisher",
  run: async (payload?: { productId?: string }) => {
    if (payload?.productId) {
      return runProductPublishStage(String(payload.productId));
    }
    return publishApprovedProducts();
  },
});
