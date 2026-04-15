import { task } from "@trigger.dev/sdk/v3";
import { runMatcherAgent } from "../agents/matcher.js";
import { loadGuide } from "../services/pipeline.js";

export const matchProductCandidate = task({
  id: "match-product-candidate",
  run: async (payload: { product: Record<string, unknown> }) => {
    const guide = await loadGuide();
    return runMatcherAgent({ product: payload.product as any, guide });
  },
});
