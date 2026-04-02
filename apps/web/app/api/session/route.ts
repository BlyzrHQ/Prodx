import { NextResponse } from "next/server";
import { requireGuestSession } from "@/lib/api-session";

export async function GET() {
  const session = await requireGuestSession();
  return NextResponse.json({ session });
}
