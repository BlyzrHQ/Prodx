import { task } from "@trigger.dev/sdk/v3";
import { runEnrichAgent } from "../agents/enrich.js";
import { convexQuery } from "../services/convex.js";
import { loadGuide } from "../services/pipeline.js";

export const productEnricher = task({
  id: "product-enricher",
  run: async (payload: { product: Record<string, unknown>; fieldsToImprove?: string[] }) => {
    const [guide, storeContext] = await Promise.all([
      loadGuide(),
      convexQuery<Record<string, unknown> | null>("storeContext:get", {}),
    ]);

    return runEnrichAgent({
      product: payload.product,
      guide,
      storeContext,
      fieldsToImprove: payload.fieldsToImprove ?? [],
    });
  },
});
