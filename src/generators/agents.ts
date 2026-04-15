import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../types.js";

const AGENT_FILES = [
  "analyzer.ts",
  "matcher.ts",
  "enrich.ts",
  "image.ts",
  "qa.ts",
  "guide.ts",
  "collection-builder.ts",
  "collection-evaluator.ts",
] as const;

export function generateAgentFiles(config: ProjectConfig): void {
  const dir = path.resolve(config.brand.projectDir, "src", "agents");
  fs.mkdirSync(dir, { recursive: true });

  for (const fileName of AGENT_FILES) {
    fs.writeFileSync(path.join(dir, fileName), loadCanonicalAgentSource(fileName));
  }
}

function loadCanonicalAgentSource(fileName: string): string {
  const canonicalPath = path.resolve("src", "canonical", "agents", fileName);
  if (!fs.existsSync(canonicalPath)) {
    throw new Error(
      `Missing canonical agent source: src/canonical/agents/${fileName}. ` +
        `The scaffold expects src/canonical to be the source of truth for generated agent files.`
    );
  }

  return fs.readFileSync(canonicalPath, "utf-8");
}
