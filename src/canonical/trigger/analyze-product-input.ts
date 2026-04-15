import { task } from "@trigger.dev/sdk/v3";
import { runAnalyzerAgent } from "../agents/analyzer.js";

export const analyzeProductInput = task({
  id: "analyze-product-input",
  run: async (payload: {
    fileUrl?: string;
    fileBase64?: string;
    fileName?: string;
    textInput?: string;
    imageUrl?: string;
    imageBase64?: string;
  }) => {
    return runAnalyzerAgent(payload);
  },
});
