import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "../lib/fs.js";
import { initWorkspace, loadRuntimeConfig, saveRuntimeConfig } from "../lib/runtime.js";
import { setCredential, testCredential } from "../lib/credentials.js";
import type { GeneratedArtifact, GuestSession, SessionSecret, SyncBatch, WorkflowSession } from "../types.js";
import { getCatalogPilotSessionPaths } from "./catalog-pilot-paths.js";
import { addHours, createCounts, createStageState, isoNow } from "./catalog-pilot-helpers.js";

export type SessionOnboardingInput = {
  business_name?: string;
  business_description?: string;
  industry?: string;
  store_url?: string;
  provider_models?: Record<string, string>;
  provider_secrets?: Record<string, string>;
};

export async function ensureCatalogPilotSessionDirs(root: string, sessionId: string): Promise<void> {
  const paths = getCatalogPilotSessionPaths(root, sessionId);
  await fs.mkdir(paths.workspaceRoot, { recursive: true });
  await fs.mkdir(paths.workflowsDir, { recursive: true });
  await fs.mkdir(paths.productsDir, { recursive: true });
  await fs.mkdir(paths.reviewsDir, { recursive: true });
  await fs.mkdir(paths.syncDir, { recursive: true });
}

async function readList<T>(filePath: string): Promise<T[]> {
  return readJson<T[]>(filePath, []);
}

async function writeList(filePath: string, value: unknown[]): Promise<void> {
  await writeJson(filePath, value);
}

export async function createGuestSession(root: string): Promise<GuestSession> {
  const session: GuestSession = {
    id: `guest_${randomUUID().replace(/-/g, "")}`,
    created_at: isoNow(),
    expires_at: addHours(24),
    onboarding_completed: false
  };
  await saveGuestSession(root, session);
  return session;
}

export async function loadGuestSession(root: string, sessionId: string): Promise<GuestSession> {
  const paths = getCatalogPilotSessionPaths(root, sessionId);
  const session = await readJson<GuestSession | null>(paths.sessionJson, null);
  if (!session) throw new Error("Guest session not found.");
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await deleteGuestSession(root, sessionId);
    throw new Error("Guest session expired. Start a new session.");
  }
  return session;
}

export async function getOrCreateGuestSession(root: string, sessionId?: string): Promise<GuestSession> {
  if (!sessionId) return createGuestSession(root);
  try {
    return await loadGuestSession(root, sessionId);
  } catch {
    return createGuestSession(root);
  }
}

export async function saveGuestSession(root: string, session: GuestSession): Promise<void> {
  const paths = getCatalogPilotSessionPaths(root, session.id);
  await ensureCatalogPilotSessionDirs(root, session.id);
  await writeJson(paths.sessionJson, session);
}

export async function deleteGuestSession(root: string, sessionId: string): Promise<void> {
  const paths = getCatalogPilotSessionPaths(root, sessionId);
  await fs.rm(paths.sessionDir, { recursive: true, force: true }).catch(() => undefined);
}

export async function loadSessionSecrets(root: string, sessionId: string): Promise<SessionSecret[]> {
  return readList<SessionSecret>(getCatalogPilotSessionPaths(root, sessionId).secretsJson);
}

export async function saveSessionSecrets(root: string, sessionId: string, secrets: SessionSecret[]): Promise<void> {
  await writeList(getCatalogPilotSessionPaths(root, sessionId).secretsJson, secrets);
}

export async function loadSessionArtifacts(root: string, sessionId: string): Promise<GeneratedArtifact[]> {
  return readList<GeneratedArtifact>(getCatalogPilotSessionPaths(root, sessionId).artifactsJson);
}

export async function saveSessionArtifacts(root: string, sessionId: string, artifacts: GeneratedArtifact[]): Promise<void> {
  await writeList(getCatalogPilotSessionPaths(root, sessionId).artifactsJson, artifacts);
}

export async function loadWorkflow(root: string, sessionId: string, workflowId: string): Promise<WorkflowSession> {
  const workflow = await readJson<WorkflowSession | null>(
    `${getCatalogPilotSessionPaths(root, sessionId).workflowsDir}\\${workflowId}.json`,
    null
  );
  if (!workflow) throw new Error("Workflow session not found.");
  return workflow;
}

export async function saveWorkflow(root: string, sessionId: string, workflow: WorkflowSession): Promise<void> {
  const paths = getCatalogPilotSessionPaths(root, sessionId);
  await writeJson(`${paths.workflowsDir}\\${workflow.id}.json`, workflow);
}

export async function loadWorkflowProducts<T>(root: string, sessionId: string, workflowId: string): Promise<T[]> {
  return readList<T>(`${getCatalogPilotSessionPaths(root, sessionId).productsDir}\\${workflowId}.json`);
}

export async function saveWorkflowProducts(root: string, sessionId: string, workflowId: string, products: unknown[]): Promise<void> {
  await writeList(`${getCatalogPilotSessionPaths(root, sessionId).productsDir}\\${workflowId}.json`, products);
}

export async function loadWorkflowReviews<T>(root: string, sessionId: string, workflowId: string): Promise<T[]> {
  return readList<T>(`${getCatalogPilotSessionPaths(root, sessionId).reviewsDir}\\${workflowId}.json`);
}

export async function saveWorkflowReviews(root: string, sessionId: string, workflowId: string, reviews: unknown[]): Promise<void> {
  await writeList(`${getCatalogPilotSessionPaths(root, sessionId).reviewsDir}\\${workflowId}.json`, reviews);
}

export async function loadSyncBatch(root: string, sessionId: string, workflowId: string): Promise<SyncBatch | null> {
  return readJson<SyncBatch | null>(`${getCatalogPilotSessionPaths(root, sessionId).syncDir}\\${workflowId}.json`, null);
}

export async function saveSyncBatch(root: string, sessionId: string, workflowId: string, batch: SyncBatch): Promise<void> {
  await writeJson(`${getCatalogPilotSessionPaths(root, sessionId).syncDir}\\${workflowId}.json`, batch);
}

export async function loadWorkflowRunSummaries<T>(root: string, sessionId: string): Promise<T[]> {
  return readList<T>(getCatalogPilotSessionPaths(root, sessionId).workflowRunsJson);
}

export async function saveWorkflowRunSummaries(root: string, sessionId: string, runs: unknown[]): Promise<void> {
  await writeList(getCatalogPilotSessionPaths(root, sessionId).workflowRunsJson, runs);
}

export async function saveSessionOnboarding(root: string, sessionId: string, input: SessionOnboardingInput) {
  const session = await loadGuestSession(root, sessionId);
  const paths = getCatalogPilotSessionPaths(root, sessionId);
  await ensureCatalogPilotSessionDirs(root, sessionId);
  await initWorkspace(paths.workspaceRoot);
  const runtime = await loadRuntimeConfig(paths.workspaceRoot);

  for (const [provider, model] of Object.entries(input.provider_models ?? {})) {
    if (provider === "openai" && runtime.providers.openai_default) runtime.providers.openai_default.model = model;
    if (provider === "gemini" && runtime.providers.gemini_flash_default) runtime.providers.gemini_flash_default.model = model;
    if (provider === "anthropic" && runtime.providers.anthropic_default) runtime.providers.anthropic_default.model = model;
  }

  if (input.store_url) runtime.providers.shopify_default.store = input.store_url;
  await saveRuntimeConfig(paths.workspaceRoot, runtime);

  for (const [provider, value] of Object.entries(input.provider_secrets ?? {})) {
    if (!value?.trim()) continue;
    await setCredential(provider, value.trim(), { root: paths.workspaceRoot, encrypt: true });
  }

  const updatedSession: GuestSession = {
    ...session,
    onboarding_completed: true,
    business_name: input.business_name ?? session.business_name,
    business_description: input.business_description ?? session.business_description,
    industry: input.industry ?? session.industry,
    store_url: input.store_url ?? session.store_url,
    provider_models: {
      ...(session.provider_models ?? {}),
      ...(input.provider_models ?? {})
    }
  };
  await saveGuestSession(root, updatedSession);
  const checks = await Promise.all(
    ["openai", "gemini", "anthropic", "serper", "shopify"].map(async (provider) => ({
      provider,
      ...(await testCredential(provider, runtime, paths.workspaceRoot))
    }))
  );
  return { session: updatedSession, checks };
}

export function createWorkflowRecord(sessionId: string, inputSource: "text" | "file", parsedCount: number, inputName?: string): WorkflowSession {
  return {
    id: `workflow_${randomUUID().replace(/-/g, "")}`,
    session_id: sessionId,
    status: "running",
    created_at: isoNow(),
    updated_at: isoNow(),
    input_source: inputSource,
    input_name: inputName,
    parsed_count: parsedCount,
    guide_generated: true,
    stage_state: createStageState(),
    counts: createCounts(parsedCount),
    artifact_ids: []
  };
}
