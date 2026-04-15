import { task } from "@trigger.dev/sdk/v3";
import { runQaAgent } from "../agents/qa.js";
import { loadGuide } from "../services/pipeline.js";

export const productQa = task({
  id: "product-qa",
  run: async (payload: { product: Record<string, unknown> }) => {
    const guide = await loadGuide();
    return runQaAgent({ product: payload.product, guide });
  },
});
