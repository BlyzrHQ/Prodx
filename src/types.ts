export interface BrandInfo {
  projectDir: string;
  name: string;
  description: string;
  industry: string;
}

export interface ApiKeys {
  openaiApiKey: string;
  geminiApiKey: string;
  anthropicApiKey: string;
  serperApiKey: string;
  shopifyStore: string;
  shopifyAccessToken: string;
}

export interface LlmConfig {
  primary: string;
  primaryModel: string;
  fallback: string;
  fallbackModel: string;
}

export interface ServiceFlags {
  convex: boolean;
  trigger: boolean;
  paperclip: boolean;
  syncShopify: boolean;
}

export type ProductSource = "shopify_sync" | "manual_input" | "generated";

export type ProductWorkflowStatus =
  | "synced"
  | "needs_review"
  | "needs_human_review"
  | "in_review"
  | "approved"
  | "rejected"
  | "published";

export type CollectionSource = "shopify_sync" | "generated";

export type CollectionWorkflowStatus =
  | "synced"
  | "needs_review"
  | "approved"
  | "rejected"
  | "published";

/** A custom metafield definition discovered from Shopify or defined in the guide */
export interface MetafieldDefinition {
  namespace: string;
  key: string;
  type: string;
  description?: string;
  required?: boolean;
  validations?: Array<{ name: string; value: string }>;
}

/** Store context fetched from Shopify and used by enricher/prompt builders */
export interface StoreContext {
  productTypes: string[];
  tags: string[];
  vendors: string[];
  metaobjectOptions: Array<{
    type: string;
    name: string;
    entries: Array<{ id: string; displayName: string; fields: Record<string, string> }>;
  }>;
  metafieldOptions: Array<{
    namespace: string;
    key: string;
    type?: string;
    validations: Array<{ name: string; value: string }>;
  }>;
  guide?: Record<string, unknown>;
  lastCatalogSyncAt?: number;
  lastCollectionSyncAt?: number;
}

export interface ProjectConfig {
  brand: BrandInfo;
  keys: ApiKeys;
  llm: LlmConfig;
  embedding: EmbeddingConfig;
  hasShopify: boolean;
  services: ServiceFlags;
  shopifyMetafields: MetafieldDefinition[];
  storeContext: StoreContext | null;
  guide: Record<string, unknown> | null;
}

export const INDUSTRY_OPTIONS = [
  { value: "food_and_beverage", label: "Food & Beverage" },
  { value: "apparel", label: "Apparel & Fashion" },
  { value: "electronics", label: "Electronics & Tech" },
  { value: "health_beauty", label: "Health & Beauty" },
  { value: "home_garden", label: "Home & Garden" },
  { value: "sports_outdoors", label: "Sports & Outdoors" },
  { value: "toys_games", label: "Toys & Games" },
  { value: "other", label: "Other" },
] as const;

export const LLM_PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Google Gemini" },
  { value: "anthropic", label: "Anthropic" },
] as const;

export const LLM_MODELS: Record<string, string[]> = {
  openai: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini", "o3", "o4-mini"],
  gemini: [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
  anthropic: [
    "claude-opus-4-6-20260205",
    "claude-sonnet-4-6-20260217",
    "claude-opus-4-20250514",
    "claude-sonnet-4-20250514",
  ],
};

export const LLM_DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-5",
  gemini: "gemini-2.5-flash",
  anthropic: "claude-sonnet-4-6-20260217",
};

export const EMBEDDING_MODELS = [
  {
    value: "text-embedding-3-small",
    label: "OpenAI text-embedding-3-small (1536 dims)",
    provider: "openai",
    dimensions: 1536,
  },
  {
    value: "text-embedding-3-large",
    label: "OpenAI text-embedding-3-large (3072 dims)",
    provider: "openai",
    dimensions: 3072,
  },
  {
    value: "text-embedding-004",
    label: "Gemini text-embedding-004 (768 dims)",
    provider: "gemini",
    dimensions: 768,
  },
] as const;

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export interface EmbeddingConfig {
  model: string;
  provider: string;
  dimensions: number;
}
