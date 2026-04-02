import { NextResponse } from "next/server";
import { requireGuestSession } from "@/lib/api-session";
import { decideCatalogPilotReview } from "@/lib/prodx-core";
import { getProjectRoot } from "@/lib/server-root";

export async function POST(request: Request, { params }: { params: Promise<{ workflowId: string; reviewId: string }> }) {
  const session = await requireGuestSession();
  const { workflowId, reviewId } = await params;
  const payload = await request.json().catch(() => ({}));
  const result = await decideCatalogPilotReview(getProjectRoot(), session.id, workflowId, reviewId, "approve", {}, String(payload.notes ?? ""));
  return NextResponse.json(result);
}
