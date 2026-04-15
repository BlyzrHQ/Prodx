import { convexAction, convexMutation, convexQuery } from "./convex.js";

export async function uploadImageFromUrl(url: string): Promise<{
  url: string;
  storageId?: string;
  sourceUrl: string;
}> {
  const result = await convexAction<{ url: string; storageId?: string; sourceUrl: string }>("images:ingestRemote", {
    url,
  });
  return result;
}

export async function getConvexImageUrl(storageId: string): Promise<string | null> {
  return convexQuery<string | null>("images:getUrl", { storageId });
}

export async function generateConvexUploadUrl(): Promise<string> {
  return convexMutation<string>("images:generateUploadUrl", {});
}
