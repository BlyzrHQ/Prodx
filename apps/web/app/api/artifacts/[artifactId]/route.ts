import { NextResponse } from "next/server";
import { requireGuestSession } from "@/lib/api-session";
import { readCatalogPilotArtifact } from "@/lib/prodx-core";
import { getProjectRoot } from "@/lib/server-root";

export async function GET(_: Request, { params }: { params: Promise<{ artifactId: string }> }) {
  const session = await requireGuestSession();
  const { artifactId } = await params;
  const { artifact, body } = await readCatalogPilotArtifact(getProjectRoot(), session.id, artifactId);
  return new NextResponse(body, {
    headers: {
      "content-type": artifact.content_type,
      "content-disposition": `attachment; filename="${artifact.file_name}"`
    }
  });
}
