import { NextResponse } from "next/server";
import { requireGuestSession } from "@/lib/api-session";
import { generateCatalogPilotGuide } from "@/lib/prodx-core";
import { getProjectRoot } from "@/lib/server-root";

export async function POST() {
  const session = await requireGuestSession();
  const result = await generateCatalogPilotGuide(getProjectRoot(), session.id);
  return NextResponse.json(result);
}
