import { readText } from "../lib/fs.js";
import { createBaseResult } from "./shared.js";
import type { LooseRecord } from "../types.js";

function parseCsv(text: string): LooseRecord[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map((item) => item.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",").map((item) => item.trim());
    const row: LooseRecord = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });
}

export async function loadRecordsFromSource(sourcePath: string): Promise<LooseRecord[]> {
  const raw = await readText(sourcePath, "");
  const extension = sourcePath.toLowerCase().split(".").pop();
  let normalized: unknown;
  if (extension === "json") normalized = JSON.parse(raw);
  else if (extension === "csv") normalized = parseCsv(raw);
  else throw new Error(`Unsupported ingest format: ${extension}`);

  return Array.isArray(normalized) ? normalized as LooseRecord[] : [normalized as LooseRecord];
}

export async function runIngest({ jobId, input }: { jobId: string; input: { source_path: string } }) {
  const sourcePath = input.source_path;
  const records = await loadRecordsFromSource(sourcePath);

  return createBaseResult({
    jobId,
    module: "catalogue-ingest",
    status: "success",
    needsReview: false,
    proposedChanges: { records_ingested: records.length },
    reasoning: [`Normalized ${records.length} record(s) from ${sourcePath}.`],
    nextActions: ["Use one of the normalized records as input for `catalog match` or `catalog enrich`."],
    artifacts: { normalized_records: records }
  });
}
