import { task, tasks } from "@trigger.dev/sdk/v3";
import {
  handleMatchedCandidate,
  processProductPipeline,
} from "../services/pipeline.js";

export const productPipeline = task({
  id: "product-pipeline",
  run: async (payload: { productId?: string; input?: Record<string, unknown> }) => {
    if (payload.productId) {
      return processProductPipeline(String(payload.productId));
    }

    if (!payload.input) {
      return { action: "noop" };
    }

    const analyzerRun = await tasks.triggerAndWait("analyze-product-input", {
      fileUrl: payload.input.fileUrl,
      fileBase64: payload.input.fileBase64,
      fileName: payload.input.fileName,
      textInput: payload.input.textInput,
      imageUrl: payload.input.imageUrl,
      imageBase64: payload.input.imageBase64,
    });

    const analysis = unwrapTaskResult<{ products: Array<Record<string, unknown>> }>(analyzerRun);
    let added = 0;
    let skipped = 0;
    let variants = 0;
    let uncertain = 0;

    for (const product of analysis.products ?? []) {
      const matchRun = await tasks.triggerAndWait("match-product-candidate", { product });
      const match = unwrapTaskResult<any>(matchRun);
      const outcome = await handleMatchedCandidate(
        (product.rawData as Record<string, unknown> | undefined) ?? {},
        match
      );

      if (outcome === "added") added++;
      if (outcome === "skipped") skipped++;
      if (outcome === "variant") variants++;
      if (outcome === "uncertain") uncertain++;
    }

    return { added, skipped, variants, uncertain };
  },
});

function unwrapTaskResult<T>(result: { ok: boolean; output?: T; error?: unknown }): T {
  if (!result.ok) {
    throw new Error(
      "Trigger subtask failed: " +
        (result.error instanceof Error ? result.error.message : String(result.error))
    );
  }
  return result.output as T;
}
