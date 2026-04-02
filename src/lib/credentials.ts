import crypto from "node:crypto";
import path from "node:path";
import { readJson, writeJson } from "./fs.js";
import { getCatalogPaths, getUserConfigDir } from "./paths.js";
import type { CredentialStatus, CredentialValue, LooseRecord, OAuthCredentialSession, RuntimeConfig } from "../types.js";

const ENV_ALIASES = {
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  serper: ["SERPER_API_KEY"],
  shopify: ["SHOPIFY_ADMIN_TOKEN", "SHOPIFY_ACCESS_TOKEN"]
};

type StoredCredentialRecord = {
  value?: string;
  encrypted_value?: string;
  iv?: string;
  tag?: string;
  updated_at: string;
  source?: "file" | "oauth";
  metadata?: Record<string, unknown>;
};

function getCredentialFile() {
  return path.join(getUserConfigDir(), "credentials.json");
}

function getScopedCredentialFile(root?: string) {
  if (!root) return getCredentialFile();
  return path.join(getCatalogPaths(root).configDir, "credentials.json");
}

function getEncryptionKey(): Buffer {
  const source = process.env.CATALOG_PILOT_SESSION_SECRET || "catalog-pilot-dev-secret";
  return crypto.createHash("sha256").update(source).digest();
}

function encryptCredentialValue(value: string): { encrypted_value: string; iv: string; tag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted_value: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64")
  };
}

function decryptCredentialValue(record: StoredCredentialRecord): string | null {
  if (!record.encrypted_value || !record.iv || !record.tag) return null;
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      getEncryptionKey(),
      Buffer.from(record.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(record.encrypted_value, "base64")),
      decipher.final()
    ]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

export async function setCredential(alias: string, value: string, options: { root?: string; encrypt?: boolean } = {}) {
  const filePath = getScopedCredentialFile(options.root);
  const store = (await readJson<Record<string, StoredCredentialRecord>>(filePath, {})) ?? {};
  store[alias] = options.encrypt
    ? { ...encryptCredentialValue(value), updated_at: new Date().toISOString(), source: "file" }
    : { value, updated_at: new Date().toISOString(), source: "file" };
  await writeJson(filePath, store);
  return store[alias];
}

export async function setOAuthCredential(alias: string, session: OAuthCredentialSession, options: { root?: string } = {}) {
  const filePath = getScopedCredentialFile(options.root);
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

export async function loadOpenAICodexAuthSession(): Promise<(OAuthCredentialSession & { auth_mode?: string }) | null> {
  const authPath = path.join(path.dirname(getUserConfigDir()), ".codex", "auth.json");
  const payload = await readJson<LooseRecord | null>(authPath, null);
  if (!payload || typeof payload !== "object") return null;

  const apiKey = typeof payload.OPENAI_API_KEY === "string" ? payload.OPENAI_API_KEY.trim() : "";
  if (!apiKey) return null;

  return {
    access_token: apiKey,
    method: "oauth",
    obtained_at: typeof payload.last_refresh === "string" ? payload.last_refresh : new Date().toISOString(),
    auth_mode: typeof payload.auth_mode === "string" ? payload.auth_mode : undefined
  };
}

async function loadStoredCredentials(): Promise<Record<string, StoredCredentialRecord>> {
  return (await readJson<Record<string, StoredCredentialRecord>>(getCredentialFile(), {})) ?? {};
}

async function loadScopedStoredCredentials(root?: string): Promise<Record<string, StoredCredentialRecord>> {
  return (await readJson<Record<string, StoredCredentialRecord>>(getScopedCredentialFile(root), {})) ?? {};
}

export async function listCredentials(root?: string): Promise<CredentialStatus[]> {
  const scopedStore = root ? await loadScopedStoredCredentials(root) : {};
  const store = await loadStoredCredentials();
  const aliases = new Set([...Object.keys(scopedStore), ...Object.keys(store), ...Object.keys(ENV_ALIASES)]);
  return [...aliases].sort().map((alias) => {
    const envMatch = (ENV_ALIASES[alias] ?? []).find((key) => process.env[key]);
    const fileRecord = scopedStore[alias] ?? store[alias];
    const fileMatch = Boolean(fileRecord?.value);
    const fileSource = fileRecord?.source ?? "file";
    return { alias, source: envMatch ? "env" : fileMatch ? fileSource : "missing", ready: Boolean(envMatch || fileMatch) };
  });
}

export async function getCredential(alias: string, root?: string): Promise<CredentialValue | null> {
  const envMatch = (ENV_ALIASES[alias] ?? []).find((key) => process.env[key]);
  if (envMatch) return { alias, value: process.env[envMatch], source: "env" };
  if (root) {
    const scopedStore = await loadScopedStoredCredentials(root);
    if (scopedStore[alias]?.value || scopedStore[alias]?.encrypted_value) {
      const scopedValue = scopedStore[alias].value ?? decryptCredentialValue(scopedStore[alias]);
      if (!scopedValue) return null;
      return {
        alias,
        value: scopedValue,
        source: scopedStore[alias].source ?? "file",
        metadata: scopedStore[alias].metadata
      };
    }
  }
  const store = await loadStoredCredentials();
  if (store[alias]?.value || store[alias]?.encrypted_value) {
    const value = store[alias].value ?? decryptCredentialValue(store[alias]);
    if (!value) return null;
    return {
      alias,
      value,
      source: store[alias].source ?? "file",
      metadata: store[alias].metadata
    };
  }
  return null;
}

export async function testCredential(alias: string, runtimeConfig: RuntimeConfig | null = null, root?: string) {
  const credential = await getCredential(alias, root);
  if (!credential) return { ok: false, alias, message: `No credential configured for '${alias}'.` };
  if (alias === "shopify") {
    const store = runtimeConfig?.providers?.shopify_default?.store ?? "";
    if (!store) {
      return { ok: false, alias, message: "Shopify credential exists, but no store is configured in runtime.json." };
    }
  }
  return { ok: true, alias, credential, message: `Credential '${alias}' is configured via ${credential.source}.` };
}
