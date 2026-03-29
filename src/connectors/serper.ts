import type { SerperImageCandidate } from "../types.js";

const SERPER_IMAGES_URL = "https://google.serper.dev/images";
const SERPER_SEARCH_URL = "https://google.serper.dev/search";

export async function searchSerperImages({
  apiKey,
  query,
  num = 5,
  gl = "us",
  hl = "en"
}: {
  apiKey: string;
  query: string;
  num?: number;
  gl?: string;
  hl?: string;
}): Promise<SerperImageCandidate[]> {
  const response = await fetch(SERPER_IMAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey
    },
    body: JSON.stringify({
      q: query,
      num,
      gl,
      hl
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Serper request failed: ${response.status} ${JSON.stringify(data)}`);
  }

  return (data.images ?? []).map((item: any) => ({
    title: item.title,
    image_url: item.imageUrl,
    source: item.source,
    domain: item.domain,
    page_url: item.link,
    position: item.position
  }));
}

export async function searchSerperWeb({
  apiKey,
  query,
  num = 5,
  gl = "us",
  hl = "en"
}: {
  apiKey: string;
  query: string;
  num?: number;
  gl?: string;
  hl?: string;
}): Promise<Array<{ title: string; link: string; snippet: string }>> {
  const response = await fetch(SERPER_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey
    },
    body: JSON.stringify({
      q: query,
      num,
      gl,
      hl
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Serper request failed: ${response.status} ${JSON.stringify(data)}`);
  }

  return (data.organic ?? []).map((item: any) => ({
    title: item.title,
    link: item.link,
    snippet: item.snippet
  }));
}
