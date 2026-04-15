import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../types.js";

const CONVEX_FILES = [
  "schema.ts",
  "images.ts",
  "products.ts",
  "variants.ts",
  "productEmbeddings.ts",
  "collections.ts",
  "storeContext.ts",
  "catalogueSummary.ts",
] as const;

export function generateConvexFiles(config: ProjectConfig): void {
  const dir = path.resolve(config.brand.projectDir, "convex");
  fs.mkdirSync(dir, { recursive: true });

  for (const fileName of CONVEX_FILES) {
    fs.writeFileSync(path.join(dir, fileName), loadCanonicalConvexSource(fileName));
  }
}

function loadCanonicalConvexSource(fileName: string): string {
  const canonicalPath = path.resolve("src", "canonical", "convex", fileName);
  if (!fs.existsSync(canonicalPath)) {
    throw new Error(
      `Missing canonical Convex source: src/canonical/convex/${fileName}. ` +
        `The scaffold expects src/canonical to be the source of truth for generated Convex files.`
    );
  }

  return fs.readFileSync(canonicalPath, "utf-8");
}
