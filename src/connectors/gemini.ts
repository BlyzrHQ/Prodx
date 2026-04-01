import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import type { ConnectorJsonResponse } from "../types.js";

export async function createGeminiJsonResponse<T>({
  apiKey,
  accessToken,
  googleProjectId,
  model,
  systemInstruction,
  textPrompt,
  schema,
  imageUrl = null,
  imageUrls,
  googleSearch = false
}: {
  apiKey?: string;
  accessToken?: string;
  googleProjectId?: string;
  model: string;
  systemInstruction?: string;
  textPrompt: string;
  schema: unknown;
  imageUrl?: string | null;
  imageUrls?: string[];
  googleSearch?: boolean;
}): Promise<ConnectorJsonResponse<T>> {
  if (!apiKey && !accessToken) {
    throw new Error("Gemini requests require either an API key or an OAuth access token.");
  }
  if (accessToken && !googleProjectId) {
    throw new Error("Gemini OAuth requests require a Google Cloud project ID.");
  }

  const rawSchema = typeof schema === "object" && schema !== null && "schema" in (schema as Record<string, unknown>)
    ? (schema as Record<string, unknown>).schema
    : schema;
  const normalizedSchema = sanitizeGeminiSchema(rawSchema);
  const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
  if (apiKey) {
    url.searchParams.set("key", apiKey);
  }
  const parts = [];

  if (textPrompt) {
    parts.push({ text: textPrompt });
  }
  const resolvedImageUrls = Array.isArray(imageUrls) && imageUrls.length > 0
    ? imageUrls
    : imageUrl
      ? [imageUrl]
      : [];
  for (const resolvedImageUrl of resolvedImageUrls) {
    parts.push({
      file_data: {
        mime_type: "image/jpeg",
        file_uri: resolvedImageUrl
      }
    });
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(accessToken && googleProjectId ? { "x-goog-user-project": googleProjectId } : {})
    },
    body: JSON.stringify({
      system_instruction: systemInstruction
        ? {
            parts: [{ text: systemInstruction }]
          }
        : undefined,
      contents: [
        {
          parts
        }
      ],
      ...(googleSearch ? {
        tools: [
          {
            google_search: {}
          }
        ]
      } : {}),
      generationConfig: {
        ...(!googleSearch ? {
          responseMimeType: "application/json",
          responseJsonSchema: normalizedSchema
        } : {})
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status} ${JSON.stringify(data)}`);
  }

  const text = extractGeminiText(data);
  if (googleSearch) {
    return {
      raw: data,
      text,
      json: JSON.parse(text) as T
    };
  }
  return {
    raw: data,
    text,
    json: JSON.parse(text) as T
  };
}

export function extractGeminiGroundingSources(raw: unknown): Array<{ title?: string; url?: string; snippet?: string }> {
  const response = raw as {
    candidates?: Array<{
      groundingMetadata?: {
        groundingChunks?: Array<{
          web?: {
            uri?: string;
            title?: string;
          };
        }>;
        groundingSupports?: Array<{
          segment?: { text?: string };
        }>;
      };
    }>;
  };

  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const supports = response.candidates?.[0]?.groundingMetadata?.groundingSupports ?? [];
  const supportText = supports
    .map((item) => item.segment?.text)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .slice(0, 5)
    .join(" | ");

  const seen = new Set<string>();
  return chunks
    .map((chunk) => ({
      title: chunk.web?.title,
      url: chunk.web?.uri,
      snippet: supportText || undefined
    }))
    .filter((item) => {
      const key = `${item.url ?? ""}|${item.title ?? ""}`;
      if (!item.url && !item.title) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function openBrowser(url: string): void {
  const platform = process.platform;
  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

export async function authenticateGeminiViaOAuth({
  clientId,
  clientSecret,
  projectId,
  scopes = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/generative-language.retriever"
  ],
  openBrowserWindow = true
}: {
  clientId: string;
  clientSecret: string;
  projectId: string;
  scopes?: string[];
  openBrowserWindow?: boolean;
}): Promise<{
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expires_in?: number;
  project_id: string;
  method: "oauth";
  obtained_at: string;
}> {
  const state = crypto.randomBytes(16).toString("hex");

  const callbackServer = await new Promise<{ redirectUri: string; codePromise: Promise<string> }>((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname !== "/oauth/callback") {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      try {
        const code = requestUrl.searchParams.get("code") ?? "";
        const callbackState = requestUrl.searchParams.get("state") ?? "";
        if (!code) throw new Error("Missing Google authorization code.");
        if (callbackState !== state) throw new Error("State verification failed for Google OAuth.");

        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end("<html><body><h1>Google authentication complete</h1><p>You can close this window and return to the CLI.</p></body></html>");
        server.close();
        codeResolver(code);
      } catch (error) {
        response.statusCode = 400;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<html><body><h1>Google authentication failed</h1><p>${error instanceof Error ? error.message : String(error)}</p></body></html>`);
        server.close();
        codeRejecter(error);
      }
    });

    let codeResolver!: (code: string) => void;
    let codeRejecter!: (error: unknown) => void;
    const codePromise = new Promise<string>((resolveCode, rejectCode) => {
      codeResolver = resolveCode;
      codeRejecter = rejectCode;
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to start local Google OAuth callback server."));
        return;
      }
      resolve({ redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`, codePromise });
    });

    const timer = setTimeout(() => {
      server.close();
      codeRejecter(new Error("Timed out waiting for Google OAuth callback."));
    }, 300000);
    codePromise.finally(() => clearTimeout(timer)).catch(() => {});
  });

  const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", callbackServer.redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", scopes.join(" "));
  authorizeUrl.searchParams.set("access_type", "offline");
  authorizeUrl.searchParams.set("prompt", "consent");
  authorizeUrl.searchParams.set("state", state);

  if (openBrowserWindow) {
    openBrowser(authorizeUrl.toString());
  }

  const code = await callbackServer.codePromise;
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackServer.redirectUri
    })
  });
  const payload = await tokenResponse.json() as Record<string, unknown>;
  if (!tokenResponse.ok || typeof payload.access_token !== "string") {
    throw new Error(`Google OAuth token exchange failed: ${tokenResponse.status} ${JSON.stringify(payload)}`);
  }

  return {
    access_token: payload.access_token,
    refresh_token: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
    token_type: typeof payload.token_type === "string" ? payload.token_type : undefined,
    expires_in: typeof payload.expires_in === "number" ? payload.expires_in : undefined,
    project_id: projectId,
    method: "oauth",
    obtained_at: new Date().toISOString()
  };
}

function sanitizeGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeGeminiSchema(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(record)) {
    if (key === "additionalProperties") continue;
    output[key] = sanitizeGeminiSchema(entry);
  }

  return output;
}

function extractGeminiText(response: any): string {
  const text = response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!text) {
    throw new Error("Gemini response did not contain text output.");
  }
  return text;
}
