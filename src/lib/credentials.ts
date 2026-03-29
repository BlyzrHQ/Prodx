import path from "node:path";
import { readJson, writeJson } from "./fs.js";
import { getUserConfigDir } from "./paths.js";
import type { CredentialStatus, CredentialValue, RuntimeConfig } from "../types.js";

const ENV_ALIASES = {
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  serper: ["SERPER_API_KEY"],
  shopify: ["SHOPIFY_ADMIN_TOKEN", "SHOPIFY_ACCESS_TOKEN"]
};

function getCredentialFile() {
  return path.join(getUserConfigDir(), "credentials.json");
}

export async function setCredential(alias: string, value: string) {
  const filePath = getCredentialFile();
  const store = (await readJson<Record<string, { value: string; updated_at: string }>>(filePath, {})) ?? {};
  store[alias] = { value, updated_at: new Date().toISOString() };
  await writeJson(filePath, store);
  return store[alias];
}

export async function listCredentials(): Promise<CredentialStatus[]> {
  const filePath = getCredentialFile();
  const store = (await readJson<Record<string, { value: string; updated_at: string }>>(filePath, {})) ?? {};
  const aliases = new Set([...Object.keys(store), ...Object.keys(ENV_ALIASES)]);
  return [...aliases].sort().map((alias) => {
    const envMatch = (ENV_ALIASES[alias] ?? []).find((key) => process.env[key]);
    const fileMatch = Boolean(store[alias]?.value);
    return { alias, source: envMatch ? "env" : fileMatch ? "file" : "missing", ready: Boolean(envMatch || fileMatch) };
  });
}

export async function getCredential(alias: string): Promise<CredentialValue | null> {
  const envMatch = (ENV_ALIASES[alias] ?? []).find((key) => process.env[key]);
  if (envMatch) return { alias, value: process.env[envMatch], source: "env" };
  const filePath = getCredentialFile();
  const store = (await readJson<Record<string, { value: string; updated_at: string }>>(filePath, {})) ?? {};
  if (store[alias]?.value) return { alias, value: store[alias].value, source: "file" };
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
