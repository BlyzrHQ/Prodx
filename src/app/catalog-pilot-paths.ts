import path from "node:path";

export interface CatalogPilotSessionPaths {
  base: string;
  sessionsDir: string;
  sessionDir: string;
  workspaceRoot: string;
  sessionJson: string;
  secretsJson: string;
  workflowsDir: string;
  productsDir: string;
  reviewsDir: string;
  artifactsJson: string;
  syncDir: string;
  workflowRunsJson: string;
}

export function getCatalogPilotSessionPaths(root: string, sessionId: string): CatalogPilotSessionPaths {
  const base = path.join(root, ".catalog-web");
  const sessionsDir = path.join(base, "sessions");
  const sessionDir = path.join(sessionsDir, sessionId);
  return {
    base,
    sessionsDir,
    sessionDir,
    workspaceRoot: path.join(sessionDir, "workspace"),
    sessionJson: path.join(sessionDir, "session.json"),
    secretsJson: path.join(sessionDir, "secrets.json"),
    workflowsDir: path.join(sessionDir, "workflows"),
    productsDir: path.join(sessionDir, "products"),
    reviewsDir: path.join(sessionDir, "reviews"),
    artifactsJson: path.join(sessionDir, "artifacts.json"),
    syncDir: path.join(sessionDir, "sync"),
    workflowRunsJson: path.join(sessionDir, "workflow-runs.json")
  };
}
