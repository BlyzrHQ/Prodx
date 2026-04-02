import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireGuestSession } from "@/lib/api-session";
import { getCatalogPilotSessionPaths, parseCatalogPilotInput, startCatalogPilotWorkflow } from "@/lib/prodx-core";
import { getProjectRoot } from "@/lib/server-root";

async function writeUploadFile(targetPath: string, file: File) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, Buffer.from(await file.arrayBuffer()));
}

export async function POST(request: Request) {
  const session = await requireGuestSession();
  const formData = await request.formData();
  const source = String(formData.get("source") ?? "text") as "text" | "file";
  const text = String(formData.get("text") ?? "");
  const upload = formData.get("file");
  const externalCatalog = formData.get("externalCatalog");
  const sessionPaths = getCatalogPilotSessionPaths(getProjectRoot(), session.id);
  const uploadsDir = path.join(sessionPaths.sessionDir, "uploads");
  let filePath = "";
  let externalCatalogPath = "";

  if (upload instanceof File) {
    filePath = path.join(uploadsDir, upload.name);
    await writeUploadFile(filePath, upload);
  }
  if (externalCatalog instanceof File && externalCatalog.size > 0) {
    externalCatalogPath = path.join(uploadsDir, `catalog-${externalCatalog.name}`);
    await writeUploadFile(externalCatalogPath, externalCatalog);
  }

  const input = await parseCatalogPilotInput(source, {
    text,
    filePath,
    fileName: upload instanceof File ? upload.name : undefined,
    externalCatalogPath: externalCatalogPath || undefined
  });

  const workflow = await startCatalogPilotWorkflow(getProjectRoot(), session.id, input);
  return NextResponse.json({ workflow });
}
