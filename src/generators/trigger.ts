import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../types.js";

export function generateTriggerFiles(config: ProjectConfig): void {
  const projectDir = path.resolve(config.brand.projectDir);
  const triggerDir = path.join(projectDir, "src", "trigger");
  const canonicalTriggerDir = path.resolve("src", "canonical", "trigger");

  fs.mkdirSync(triggerDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "trigger.config.ts"), loadCanonicalSource("src/canonical/trigger.config.ts"));

  const canonicalFiles = fs
    .readdirSync(canonicalTriggerDir)
    .filter((file) => file.endsWith(".ts"));

  for (const fileName of canonicalFiles) {
    fs.writeFileSync(
      path.join(triggerDir, fileName),
      loadCanonicalSource(path.join("src", "canonical", "trigger", fileName))
    );
  }
}

function loadCanonicalSource(relativePath: string): string {
  const absolutePath = path.resolve(relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(
      `Missing canonical Trigger source: ${relativePath}. ` +
        `The scaffold expects src/canonical to be the source of truth for generated Trigger files.`
    );
  }

  return fs.readFileSync(absolutePath, "utf-8");
}
