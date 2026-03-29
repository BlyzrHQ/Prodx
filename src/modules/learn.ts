import { readText, writeText } from "../lib/fs.js";
import { getCatalogPaths } from "../lib/paths.js";
import { createBaseResult } from "./shared.js";

export async function runLearn({ root, jobId, input }) {
  const paths = getCatalogPaths(root);
  const current = await readText(paths.learningMarkdown, "# Catalog Learning\n\n");
  const lesson = input.lesson?.trim() || `Lesson from ${input.module}: ${input.summary}`;
  await writeText(paths.learningMarkdown, `${current.trimEnd()}\n- ${lesson}\n`);

  return createBaseResult({
    jobId,
    module: "feedback-learn",
    status: "success",
    needsReview: false,
    proposedChanges: { appended_lesson: lesson },
    reasoning: ["Appended a distilled lesson to catalog-learning.md."],
    nextActions: ["Review the learning file to keep only durable, reusable lessons."]
  });
}
