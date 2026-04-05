import os from "node:os";
import path from "node:path";
import type { CatalogPaths } from "../types.js";

export function getWorkspaceRoot(cwd = process.cwd()): string {
  return cwd;
}

export function getCatalogPaths(root = process.cwd()): CatalogPaths {
  const base = path.join(root, ".catalog");
  const guideDir = path.join(base, "guide");
  const guideMarkdown = path.join(guideDir, "catalog-guide.md");
  const guideJson = path.join(guideDir, "catalog-guide.json");
  const legacyPolicyDir = path.join(base, "policy");
  const legacyPolicyMarkdown = path.join(legacyPolicyDir, "catalog-policy.md");
  const legacyPolicyJson = path.join(legacyPolicyDir, "catalog-policy.json");
  return {
    base,
    guideDir,
    policyDir: guideDir,
    learningDir: path.join(base, "learning"),
    configDir: path.join(base, "config"),
    indexDir: path.join(base, "index"),
    runsDir: path.join(base, "runs"),
    generatedDir: path.join(base, "generated"),
    generatedProductsDir: path.join(base, "generated", "products"),
    generatedImagesDir: path.join(base, "generated", "images"),
    generatedWorkflowProductsJson: path.join(base, "generated", "workflow-products.json"),
    generatedWorkflowCostsJson: path.join(base, "generated", "workflow-costs.json"),
    generatedReviewCsv: path.join(base, "generated", "review-queue.csv"),
    generatedShopifyCsv: path.join(base, "generated", "shopify-import.csv"),
    generatedRejectedCsv: path.join(base, "generated", "rejected-products.csv"),
    generatedExcelWorkbook: path.join(base, "generated", "catalog-review.xlsx"),
    guideMarkdown,
    guideJson,
    policyMarkdown: guideMarkdown,
    policyJson: guideJson,
    legacyPolicyDir,
    legacyPolicyMarkdown,
    legacyPolicyJson,
    learningMarkdown: path.join(base, "learning", "catalog-learning.md"),
    runtimeJson: path.join(base, "config", "runtime.json"),
    indexJson: path.join(base, "index", "catalog-index.json")
  };
}

export function getUserConfigDir(): string {
  return path.join(os.homedir(), ".catalog-toolkit");
}
