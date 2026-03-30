import path from "node:path";
import { readJson, writeJson } from "./fs.js";
import { getUserConfigDir } from "./paths.js";
import type { CredentialStatus, CredentialValue, OAuthCredentialSession, RuntimeConfig } from "../types.js";

const ENV_ALIASES = {
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  serper: ["SERPER_API_KEY"],
  shopify: ["SHOPIFY_ADMIN_TOKEN", "SHOPIFY_ACCESS_TOKEN"]
};

type StoredCredentialRecord = {
  value: string;
  updated_at: string;
  source?: "file" | "oauth";
  metadata?: Record<string, unknown>;
};

function getCredentialFile() {
  return path.join(getUserConfigDir(), "credentials.json");
}

export async function setCredential(alias: string, value: string) {
  const filePath = getCredentialFile();
  const store = (await readJson<Record<string, StoredCredentialRecord>>(filePath, {})) ?? {};
  store[alias] = { value, updated_at: new Date().toISOString(), source: "file" };
  await writeJson(filePath, store);
  return store[alias];
}

export async function setOAuthCredential(alias: string, session: OAuthCredentialSession) {
  const filePath = getCredentialFile();
  const store = (await readJson<Record<string, StoredCredentialRecord>>(filePath, {})) ?? {};
  store[alias] = {
    value: session.access_token,
    updated_at: new Date().toISOString(),
    source: "oauth",
    metadata: session as unknown as Record<string, unknown>
  };
  await writeJson(filePath, store);
  return store[alias];
}

async function loadStoredCredentials(): Promise<Record<string, StoredCredentialRecord>> {
  return (await readJson<Record<string, StoredCredentialRecord>>(getCredentialFile(), {})) ?? {};
}

export async function listCredentials(): Promise<CredentialStatus[]> {
  const store = await loadStoredCredentials();
  const aliases = new Set([...Object.keys(store), ...Object.keys(ENV_ALIASES)]);
  return [...aliases].sort().map((alias) => {
    const envMatch = (ENV_ALIASES[alias] ?? []).find((key) => process.env[key]);
    const fileMatch = Boolean(store[alias]?.value);
    const fileSource = store[alias]?.source ?? "file";
    return { alias, source: envMatch ? "env" : fileMatch ? fileSource : "missing", ready: Boolean(envMatch || fileMatch) };
  });
}

export async function getCredential(alias: string): Promise<CredentialValue | null> {
  const envMatch = (ENV_ALIASES[alias] ?? []).find((key) => process.env[key]);
  if (envMatch) return { alias, value: process.env[envMatch], source: "env" };
  const store = await loadStoredCredentials();
  if (store[alias]?.value) {
    return {
      alias,
      value: store[alias].value,
      source: store[alias].source ?? "file",
      metadata: store[alias].metadata
    };
  }
  return null;
}

export async function testCredential(alias: string, runtimeConfig: RuntimeConfig | null = null) {
  const credential = await getCredential(alias);
  if (!credential) return { ok: false, alias, message: `No credential configured for '${alias}'.` };
  if (alias === "shopify") {
    const store = runtimeConfig?.providers?.shopify_default?.store ?? "";
    if (!store) {
      return { ok: false, alias, message: "Shopify credential exists, but no store is configured in runtime.json." };
    }
  }
  return { ok: true, alias, credential, message: `Credential '${alias}' is configured via ${credential.source}.` };
}
