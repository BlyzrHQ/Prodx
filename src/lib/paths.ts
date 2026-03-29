import os from "node:os";
import path from "node:path";
import type { CatalogPaths } from "../types.js";

export function getWorkspaceRoot(cwd = process.cwd()): string {
  return cwd;
}

export function getCatalogPaths(root = process.cwd()): CatalogPaths {
  const base = path.join(root, ".catalog");
  return {
    base,
    policyDir: path.join(base, "policy"),
    learningDir: path.join(base, "learning"),
    configDir: path.join(base, "config"),
    indexDir: path.join(base, "index"),
    runsDir: path.join(base, "runs"),
    generatedDir: path.join(base, "generated"),
    generatedProductsDir: path.join(base, "generated", "products"),
    generatedImagesDir: path.join(base, "generated", "images"),
    generatedReviewCsv: path.join(base, "generated", "review-queue.csv"),
    generatedShopifyCsv: path.join(base, "generated", "shopify-import.csv"),
    generatedExcelWorkbook: path.join(base, "generated", "catalog-review.xlsx"),
    policyMarkdown: path.join(base, "policy", "catalog-policy.md"),
    policyJson: path.join(base, "policy", "catalog-policy.json"),
    learningMarkdown: path.join(base, "learning", "catalog-learning.md"),
    runtimeJson: path.join(base, "config", "runtime.json"),
    indexJson: path.join(base, "index", "catalog-index.json")
  };
}

export function getUserConfigDir(): string {
  return path.join(os.homedir(), ".catalog-toolkit");
}
