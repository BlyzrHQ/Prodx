import { NextResponse } from "next/server";
import { requireGuestSession } from "@/lib/api-session";
import { startCatalogPilotSync } from "@/lib/prodx-core";
import { getProjectRoot } from "@/lib/server-root";

export async function POST(_: Request, { params }: { params: Promise<{ workflowId: string }> }) {
  const session = await requireGuestSession();
  const { workflowId } = await params;
  const result = await startCatalogPilotSync(getProjectRoot(), session.id, workflowId);
  return NextResponse.json({ sync_batch: result });
}
