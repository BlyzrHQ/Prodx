import { readText, writeText } from "../lib/fs.js";
import { getCatalogPaths } from "../lib/paths.js";
import { createBaseResult } from "./shared.js";
import type { QaFinding } from "../types.js";

const DEFAULT_HEADER = "# Catalog Learning";

function normalizeLesson(lesson: string): string {
  return lesson.trim().replace(/\s+/g, " ");
}

function extractBulletLessons(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => normalizeLesson(line.slice(2)))
    .filter((line) => line.length > 0 && line !== "No lessons recorded yet.");
}

function buildLearningDocument(existingContent: string, lessons: string[]): string {
  const existingLessons = extractBulletLessons(existingContent);
  const merged = [...existingLessons];
  const seen = new Set(existingLessons.map((item) => item.toLowerCase()));

  for (const lesson of lessons.map(normalizeLesson)) {
    if (!lesson) continue;
    const key = lesson.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(lesson);
  }

  if (merged.length === 0) {
    return `${DEFAULT_HEADER}\n\n- No lessons recorded yet.\n`;
  }

  return `${DEFAULT_HEADER}\n\n${merged.map((lesson) => `- ${lesson}`).join("\n")}\n`;
}

export async function appendLearningLessons(root: string, lessons: string[]): Promise<string[]> {
  const paths = getCatalogPaths(root);
  const current = await readText(paths.learningMarkdown, `${DEFAULT_HEADER}\n\n- No lessons recorded yet.\n`);
  const existing = new Set(extractBulletLessons(current).map((item) => item.toLowerCase()));
  const uniqueNew = lessons.map(normalizeLesson).filter((lesson) => lesson.length > 0 && !existing.has(lesson.toLowerCase()));
  if (uniqueNew.length === 0) return [];
  await writeText(paths.learningMarkdown, buildLearningDocument(current, uniqueNew));
  return uniqueNew;
}

export function deriveLessonsFromQa(findings: QaFinding[]): string[] {
  const lessons = new Set<string>();

  if (findings.some((item) => item.field === "description_html" && /review|placeholder/i.test(`${item.message} ${item.actual}`))) {
    lessons.add("Never place internal review notes, placeholders, or QA text inside customer-facing description or description_html fields.");
  }

  if (findings.some((item) => item.issue_type === "missing" && item.severity === "critical")) {
    lessons.add("If a required field cannot be filled confidently, leave it empty and let QA fail instead of inventing or padding the value.");
  }

  if (findings.some((item) => item.field === "title" && item.issue_type === "format")) {
    lessons.add("Generate titles strictly from the Catalog Guide formula and include required brand tokens only when they are explicit in trusted source data.");
  }

  if (findings.some((item) => item.field === "images" || item.field === "featured_image")) {
    lessons.add("Do not auto-approve a product without a compliant hero image selected from reviewed candidate imagery.");
  }

  if (findings.some((item) => item.field === "metafields" || item.field.includes("."))) {
    lessons.add("Only populate guide-approved metafields when the value matches the Shopify definition type exactly and the source data is trustworthy.");
  }

  if (findings.some((item) => /ingredient|allergen|nutrition|spec|material|dimension|compatib|certif/i.test(`${item.field} ${item.message}`))) {
    lessons.add("High-risk factual fields such as ingredients, allergens, nutrition, materials, dimensions, specs, compatibility, and certifications must stay empty unless verified.");
  }

  return [...lessons];
}

export async function runLearn({ root, jobId, input }) {
  const lesson = input.lesson?.trim() || `Lesson from ${input.module}: ${input.summary}`;
  const appended = await appendLearningLessons(root, [lesson]);

  return createBaseResult({
    jobId,
    module: "feedback-learn",
    status: "success",
    needsReview: false,
    proposedChanges: { appended_lesson: appended[0] ?? null },
    reasoning: [appended.length > 0 ? "Appended a distilled lesson to catalog-learning.md." : "Learning already existed, so no duplicate lesson was added."],
    nextActions: ["Review the learning file to keep only durable, reusable lessons."]
  });
}
