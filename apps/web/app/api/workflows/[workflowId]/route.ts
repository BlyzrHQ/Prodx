import { NextResponse } from "next/server";
import { requireGuestSession } from "@/lib/api-session";
import { getCatalogPilotWorkflow } from "@/lib/prodx-core";
import { getProjectRoot } from "@/lib/server-root";

export async function GET(_: Request, { params }: { params: Promise<{ workflowId: string }> }) {
  const session = await requireGuestSession();
  const { workflowId } = await params;
  const result = await getCatalogPilotWorkflow(getProjectRoot(), session.id, workflowId);
  return NextResponse.json(result);
}
