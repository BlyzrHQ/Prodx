import { task } from "@trigger.dev/sdk/v3";
import { runImageAgent } from "../agents/image.js";
import { loadGuide } from "../services/pipeline.js";

export const productImageOptimizer = task({
  id: "product-image-optimizer",
  run: async (payload: { product: Record<string, unknown> }) => {
    const guide = await loadGuide();
    return runImageAgent({ product: payload.product, guide });
  },
});
