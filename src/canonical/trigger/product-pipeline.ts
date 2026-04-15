import { task, tasks } from "@trigger.dev/sdk/v3";
import {
  handleMatchedCandidate,
  processProductPipelineWithRunners,
} from "../services/pipeline.js";

export const productPipeline = task({
  id: "product-pipeline",
  run: async (payload: { productId?: string; input?: Record<string, unknown> }) => {
    if (payload.productId) {
      return processProductPipelineWithRunners(
        String(payload.productId),
        createTriggerPipelineStageRunners()
      );
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
      const result = await handleMatchedCandidate(
        (product.rawData as Record<string, unknown> | undefined) ?? {},
        match,
        { runPipelineInline: false, publishVariantInline: false }
      );

      if (result.outcome === "added") {
        added++;
        if (result.productId) {
          await processProductPipelineWithRunners(
            String(result.productId),
            createTriggerPipelineStageRunners()
          );
        }
      }
      if (result.outcome === "skipped") skipped++;
      if (result.outcome === "variant") {
        variants++;
        if (result.productId) {
          const publishRun = await tasks.triggerAndWait("product-publisher", {
            productId: String(result.productId),
          });
          unwrapTaskResult(publishRun);
        }
      }
      if (result.outcome === "uncertain") uncertain++;
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

function createTriggerPipelineStageRunners() {
  return {
    enrich: async (payload: {
      product: Record<string, unknown>;
      fieldsToImprove: string[];
      qaFeedback: string[];
    }) => {
      const run = await tasks.triggerAndWait("product-enricher", payload);
      return unwrapTaskResult(run);
    },
    image: async (payload: { product: Record<string, unknown> }) => {
      const run = await tasks.triggerAndWait("product-image-optimizer", payload);
      return unwrapTaskResult(run);
    },
    qa: async (payload: { product: Record<string, unknown> }) => {
      const run = await tasks.triggerAndWait("product-qa", payload);
      return unwrapTaskResult(run);
    },
    publish: async (payload: {
      productId: string;
      product: Record<string, unknown>;
      qaScore?: number;
      reviewNotes?: Array<Record<string, unknown>>;
    }) => {
      const run = await tasks.triggerAndWait("product-publisher", payload);
      return unwrapTaskResult<{ action: string; qaScore?: number }>(run);
    },
  };
}
