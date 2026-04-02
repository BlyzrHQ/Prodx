import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "./session-cookie";
import { getProjectRoot } from "./server-root";
import { createOrLoadGuestSession } from "@/lib/prodx-core";

export async function requireGuestSession() {
  const cookieStore = await cookies();
  const existing = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const session = await createOrLoadGuestSession(getProjectRoot(), existing);
  if (session.id !== existing) {
    cookieStore.set(SESSION_COOKIE_NAME, session.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(session.expires_at)
    });
  }
  return session;
}
