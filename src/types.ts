export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export interface LooseRecord {
  [key: string]: unknown;
}

export interface ProductMetafieldValue extends LooseRecord {
  namespace: string;
  key: string;
  type: string;
  value: string;
  description?: string;
  required?: boolean;
  source_field?: string;
}

export interface ProviderConfig {
  type: string;
  credential?: string;
  model?: string;
  store?: string;
  api_version?: string;
  [key: string]: JsonValue | undefined;
}

export interface RuntimeConfig {
  providers: Record<string, ProviderConfig>;
  modules: Record<string, Record<string, string>>;
}

export interface CredentialValue {
  alias: string;
  value: string;
  source: "env" | "file";
}

export interface CredentialStatus {
  alias: string;
  source: "env" | "file" | "missing";
  ready: boolean;
}

export interface CatalogPaths {
  base: string;
  policyDir: string;
  learningDir: string;
  configDir: string;
  indexDir: string;
  runsDir: string;
  generatedDir: string;
  generatedProductsDir: string;
  generatedImagesDir: string;
  generatedReviewCsv: string;
  generatedShopifyCsv: string;
  generatedExcelWorkbook: string;
  policyMarkdown: string;
  policyJson: string;
  learningMarkdown: string;
  runtimeJson: string;
  indexJson: string;
}

export interface ModuleResult {
  job_id: string;
  module: string;
  status: string;
  needs_review: boolean;
  proposed_changes: LooseRecord;
  warnings: string[];
  errors: string[];
  reasoning: string[];
  artifacts: LooseRecord;
  next_actions: string[];
}

export interface RunData {
  runDir: string;
  input: unknown;
  result: ModuleResult | null;
  review: LooseRecord | null;
  decision: LooseRecord | null;
  reviewMarkdown: string;
}

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export interface OutputWriter {
  write(chunk: string): void;
}

export interface CliStreams {
  cwd?: string;
  stdout?: OutputWriter;
  stderr?: OutputWriter;
}

export interface ResolvedProvider {
  alias: string;
  providerAlias: string;
  provider: ProviderConfig;
  credential: CredentialValue | null;
  runtime: RuntimeConfig;
}

export interface PolicyDocument extends LooseRecord {
  meta?: {
    business_name?: string;
    business_description?: string;
    industry?: string;
    target_market?: string;
    operating_mode?: string;
    store_url?: string;
    generated_at?: string;
    generation_method?: string;
  };
  product_title_structure?: {
    pattern?: string;
    examples?: string[];
  };
  description_structure?: {
    guidance?: string;
    required_sections?: string[];
  };
  product_listing_checklist?: {
    required?: string[];
    optional?: string[];
  };
  attributes_metafields_schema?: {
    required_fields?: string[];
    optional_fields?: string[];
    standard_shopify_fields?: string[];
    metafields?: ProductMetafieldValue[];
    fill_rules?: string[];
    guidance?: string;
  };
  qa_scoring_criteria?: {
    passing_score?: number;
    weights?: LooseRecord;
    success_definition?: string;
    weighted_areas?: string[];
  };
  image_requirements?: LooseRecord;
  variant_structure?: {
    primary_dimensions?: string[];
    guidance?: string;
  };
}

export interface ProductRecord extends LooseRecord {
  id?: string;
  product_id?: string;
  title?: string;
  description?: string;
  description_html?: string;
  brand?: string;
  vendor?: string;
  handle?: string;
  product_type?: string;
  size?: string;
  type?: string;
  color?: string;
  storage?: string;
  option1?: string;
  option2?: string;
  option3?: string;
  primary_variant?: string;
  secondary_variant?: string;
  sku?: string;
  barcode?: string;
  tags?: string[];
  variants?: ProductVariant[];
  images?: string[];
  featured_image?: string;
  image_alt_text?: string;
  metafields?: ProductMetafieldValue[];
  ingredients_text?: string;
  allergen_note?: string;
  storage_instructions?: string;
}

export interface ProductVariant extends LooseRecord {
  id?: string;
  title?: string;
  sku?: string;
  barcode?: string;
  option1?: string;
  option2?: string;
  option3?: string;
}

export interface ConnectorJsonResponse<T> {
  raw: unknown;
  text: string;
  json: T;
}

export interface EnrichmentOutput {
  title: string;
  description: string;
  handle: string;
  product_type: string;
  tags: string[];
  metafields: ProductMetafieldValue[];
  warnings: string[];
  summary: string;
}

export interface ImageReviewOutput {
  decision: string;
  summary: string;
  issues: string[];
  recommended_image_url: string;
}

export interface SerperImageCandidate {
  title: string;
  image_url: string;
  source?: string;
  domain?: string;
  page_url?: string;
  position?: number;
}

export interface ShopifyPayload extends LooseRecord {
  id?: string | null;
  title?: string;
  handle?: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  variants?: ProductVariant[];
  featuredImage?: string;
  images?: string[];
  imageAltText?: string;
  metafields?: ProductMetafieldValue[];
}

export interface ReviewDecision extends LooseRecord {
  job_id: string;
  action: string;
  notes: string;
  edits: LooseRecord;
  decided_at: string;
}

export interface ApplyResult extends LooseRecord {
  job_id: string;
  module: string;
  applied_at: string;
  status: string;
  applied_changes?: LooseRecord;
  live_result?: LooseRecord;
}

export interface WorkflowRunSummary {
  index: number;
  product_key: string;
  source_record_id: string;
  generated_product_path: string;
  generated_image_dir: string;
  selected_image_url?: string;
  local_image_path?: string;
  modules: Array<{
    module: string;
    job_id: string;
    status: string;
    needs_review: boolean;
  }>;
}
