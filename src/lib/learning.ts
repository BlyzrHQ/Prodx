import path from "node:path";
import { ensureDir, readJson, writeJson } from "./fs.js";
import { getCatalogPaths } from "./paths.js";
import type { LearningRecord, WorkflowMemory } from "../types.js";

function normalizeLesson(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function getLearningRecordsPath(root: string): string {
  return path.join(getCatalogPaths(root).learningDir, "learning-records.json");
}

function getMemoryDirectory(root: string): string {
  return path.join(getCatalogPaths(root).learningDir, "workflow-memory");
}

export function getWorkflowMemoryPath(root: string, productKey: string): string {
  return path.join(getMemoryDirectory(root), `${productKey}.json`);
}

export async function loadLearningRecords(root: string): Promise<LearningRecord[]> {
  return readJson<LearningRecord[]>(getLearningRecordsPath(root), []);
}

export async function appendLearningRecords(root: string, records: LearningRecord[]): Promise<LearningRecord[]> {
  if (records.length === 0) return [];
  const current = await loadLearningRecords(root);
  const seen = new Set(current.map((item) => `${item.source}:${normalizeLesson(item.lesson).toLowerCase()}`));
  const appended: LearningRecord[] = [];
  for (const record of records) {
    const normalized = normalizeLesson(record.lesson);
    if (!normalized) continue;
    const key = `${record.source}:${normalized.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    appended.push({ ...record, lesson: normalized });
  }
  if (appended.length === 0) return [];
  await writeJson(getLearningRecordsPath(root), [...current, ...appended]);
  return appended;
}

export async function loadWorkflowMemory(root: string, productKey: string, sourceRecordId: string): Promise<WorkflowMemory> {
  const memoryPath = getWorkflowMemoryPath(root, productKey);
  const fallback: WorkflowMemory = {
    product_key: productKey,
    source_record_id: sourceRecordId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    enrich_retries: 0,
    image_retries: 0,
    total_iterations: 0,
    attempts: [],
    supervisor_decisions: [],
    learning_records: []
  };
  return readJson<WorkflowMemory>(memoryPath, fallback);
}

export async function saveWorkflowMemory(root: string, memory: WorkflowMemory): Promise<string> {
  const memoryPath = getWorkflowMemoryPath(root, memory.product_key);
  await ensureDir(path.dirname(memoryPath));
  await writeJson(memoryPath, { ...memory, updated_at: new Date().toISOString() });
  return memoryPath;
}

export function summarizeLearningRecords(records: LearningRecord[], limit = 8): string[] {
  return records
    .slice(-limit)
    .map((item) => normalizeLesson(item.lesson))
    .filter((item) => item.length > 0);
}
