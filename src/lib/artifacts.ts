import path from "node:path";
import { ensureDir, readJson, readText, writeJson, writeText } from "./fs.js";
import { getCatalogPaths } from "./paths.js";
import { createJobId } from "./ids.js";

export async function createRun(root, moduleName, input, explicitJobId = null) {
  const catalogPaths = getCatalogPaths(root);
  const jobId = explicitJobId ?? createJobId(moduleName.replace(/\s+/g, "-"));
  const runDir = path.join(catalogPaths.runsDir, jobId);
  await ensureDir(runDir);
  await writeJson(path.join(runDir, "input.json"), input);
  return { jobId, runDir };
}

export function buildReviewMarkdown(result) {
  const changes = Object.entries(result.proposed_changes ?? {});
  const warnings = result.warnings ?? [];
  const reasoning = result.reasoning ?? [];
  return `# Review Packet

- Job ID: ${result.job_id}
- Module: ${result.module}
- Status: ${result.status}
- Needs Review: ${result.needs_review ? "Yes" : "No"}

## Proposed Changes
${changes.length > 0 ? changes.map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`).join("\n") : "- No proposed changes"}

## Reasoning
${reasoning.length > 0 ? reasoning.map((item) => `- ${item}`).join("\n") : "- No reasoning provided"}

## Warnings
${warnings.length > 0 ? warnings.map((item) => `- ${item}`).join("\n") : "- None"}
`;
}

export async function writeModuleArtifacts(runDir, result) {
  const reviewJson = {
    job_id: result.job_id,
    module: result.module,
    status: result.status,
    needs_review: result.needs_review,
    proposed_changes: result.proposed_changes,
    warnings: result.warnings,
    errors: result.errors,
    reasoning: result.reasoning ?? [],
    next_actions: result.next_actions ?? []
  };
  await writeJson(path.join(runDir, "result.json"), result);
  await writeJson(path.join(runDir, "changes.json"), result.proposed_changes ?? {});
  await writeJson(path.join(runDir, "review.json"), reviewJson);
  await writeText(path.join(runDir, "review.md"), buildReviewMarkdown(result));
}

export async function loadRun(root, jobOrPath) {
  const catalogPaths = getCatalogPaths(root);
  const runDir = jobOrPath.includes(path.sep) ? jobOrPath : path.join(catalogPaths.runsDir, jobOrPath);
  return {
    runDir,
    input: await readJson(path.join(runDir, "input.json"), null),
    result: await readJson(path.join(runDir, "result.json"), null),
    review: await readJson(path.join(runDir, "review.json"), null),
    decision: await readJson(path.join(runDir, "decision.json"), null),
    reviewMarkdown: await readText(path.join(runDir, "review.md"), "")
  };
}

export async function writeDecision(runDir, decision) {
  await writeJson(path.join(runDir, "decision.json"), decision);
}

export async function writeApplyResult(runDir, applyResult) {
  await writeJson(path.join(runDir, "apply.json"), applyResult);
}
