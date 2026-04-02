import { NextResponse } from "next/server";
import { requireGuestSession } from "@/lib/api-session";
import { configureCatalogPilotSession } from "@/lib/prodx-core";
import { getProjectRoot } from "@/lib/server-root";

export async function POST(request: Request) {
  const session = await requireGuestSession();
  const payload = await request.json();
  const result = await configureCatalogPilotSession(getProjectRoot(), session.id, payload);
  return NextResponse.json(result);
}
