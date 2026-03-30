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
  source?: string;
  validation_rules?: string[];
  example_values?: string[];
  usage?: string[];
  automation_mode?: string;
  inferred?: boolean;
}

export interface AutomationClassification extends LooseRecord {
  safe_for_automation?: boolean;
  requires_human_review?: boolean;
  never_auto_fill?: boolean;
  inferred?: boolean;
}

export interface ProviderConfig {
  type: string;
  credential?: string;
  model?: string;
  store?: string;
  api_version?: string;
  client_id?: string;
  scopes?: string[];
  [key: string]: JsonValue | undefined;
}

export interface RuntimeConfig {
  providers: Record<string, ProviderConfig>;
  modules: Record<string, Record<string, string>>;
}

export interface CredentialValue {
  alias: string;
  value: string;
  source: "env" | "file" | "oauth";
  metadata?: LooseRecord;
}

export interface CredentialStatus {
  alias: string;
  source: "env" | "file" | "oauth" | "missing";
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
  generatedWorkflowProductsJson: string;
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
  apply: LooseRecord | null;
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
  industry_business_context?: {
    summary?: string;
    audience?: string;
    notes?: string;
    operating_mode?: string;
  };
  eligibility_rules?: {
    accept?: string[];
    reject?: string[];
  };
  taxonomy_design?: {
    hierarchy?: string[];
    category_tree?: unknown[];
    collection_logic?: string[];
    tagging_system?: string[];
    product_type_rules?: string[];
    handle_structure_rules?: string[];
  };
  product_title_system?: {
    formula?: string;
    examples?: string[];
    disallowed_patterns?: string[];
    seo_rules?: string[];
    edge_case_rules?: string[];
  };
  product_description_system?: {
    structure_template?: string[];
    tone_rules?: string[];
    length_rules?: string[];
    formatting_rules?: string[];
    auto_generatable?: string[];
    manual_required?: string[];
    guidance?: string[];
  };
  variant_architecture?: {
    allowed_dimensions?: string[];
    split_vs_variant_rules?: string[];
    max_variant_logic?: string[];
    naming_conventions?: string[];
    duplicate_rules?: string[];
  };
  image_media_standards?: {
    image_types?: string[];
    background_rules?: string[];
    aspect_ratios?: string[];
    naming_conventions?: string[];
    alt_text_rules?: string[];
    automation_tagging_rules?: string[];
    avoid?: string[];
  };
  merchandising_rules?: {
    collection_sorting_logic?: string[];
    cross_sell_rules?: string[];
    upsell_rules?: string[];
    product_grouping_logic?: string[];
    seasonal_overrides?: string[];
    featured_product_logic?: string[];
  };
  seo_discovery_rules?: {
    meta_title_format?: string[];
    meta_description_rules?: string[];
    url_handle_rules?: string[];
    internal_linking_logic?: string[];
    keyword_usage_patterns?: string[];
  };
  automation_playbook?: {
    fully_automated?: string[];
    validation_checkpoints?: string[];
    human_approval_required?: string[];
    transformation_logic?: string[];
    fallback_rules?: string[];
    error_handling_rules?: string[];
  };
  qa_validation_system?: {
    title_validation?: string[];
    variant_validation?: string[];
    metafield_completeness?: string[];
    image_checks?: string[];
    seo_checks?: string[];
    pass_fail_conditions?: string[];
    auto_fix_rules?: string[];
    passing_score?: number;
  };
  product_title_structure?: {
    pattern?: string;
    examples?: string[];
    disallowed_patterns?: string[];
    seo_rules?: string[];
    edge_case_rules?: string[];
  };
  description_structure?: {
    tone?: string;
    word_count?: string;
    guidance?: string;
    required_sections?: string[];
    formatting_rules?: string[];
    auto_generatable?: string[];
    manual_required?: string[];
  };
  categorization_taxonomy?: {
    type?: string;
    tree?: unknown[];
    guidance?: string;
    collection_logic?: string[];
    tagging_rules?: string[];
    product_type_rules?: string[];
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
  image_requirements?: {
    primary_image?: string;
    background?: string;
    preferred_styles?: string[];
    avoid?: string[];
    media_types?: string[];
    aspect_ratios?: string[];
    alt_text_rules?: string[];
    [key: string]: unknown;
  };
  seo_handle_rules?: {
    handle_format?: string;
    seo_description_pattern?: string;
    title_guidance?: string;
  };
  variant_structure?: {
    primary_dimensions?: string[];
    guidance?: string;
    duplicate_rules?: string[];
    split_vs_variant_rules?: string[];
    max_variant_logic?: string[];
    naming_conventions?: string[];
  };
  pricing_discount_display_rules?: {
    compare_at_price?: string;
    pricing_copy?: string;
    bundles?: string;
    unit_pricing?: string;
  };
  collections_merchandising_rules?: {
    status?: string;
    guidance?: string;
    default_collection_types?: string[];
  };
  automation_review_guidance?: {
    safe_to_automate?: string[];
    requires_review?: string[];
    escalation_rules?: string[];
    never_auto_fill?: string[];
    fallback_rules?: string[];
    error_handling_rules?: string[];
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
  price?: string;
  compare_at_price?: string;
  tags?: string[];
  variants?: ProductVariant[];
  images?: string[];
  featured_image?: string;
  image_alt_text?: string;
  metafields?: ProductMetafieldValue[];
  ingredients_text?: string;
  allergen_note?: string;
  nutritional_facts?: string;
  storage_instructions?: string;
}

export interface ProductVariant extends LooseRecord {
  id?: string;
  title?: string;
  sku?: string;
  barcode?: string;
  price?: string;
  compare_at_price?: string;
  option1?: string;
  option2?: string;
  option3?: string;
}

export interface OAuthCredentialSession {
  access_token: string;
  method: "oauth";
  obtained_at: string;
}

export interface ShopifyAuthSession extends OAuthCredentialSession {
  store: string;
  scope?: string;
  scopes?: string[];
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  token_type?: string;
}

export interface ConnectorJsonResponse<T> {
  raw: unknown;
  text: string;
  json: T;
}

export interface EnrichmentOutput {
  title: string;
  description: string;
  description_html: string;
  handle: string;
  vendor?: string | null;
  brand?: string | null;
  product_type: string;
  tags: string[];
  ingredients_text?: string | null;
  allergen_note?: string | null;
  nutritional_facts?: string | null;
  metafields: ProductMetafieldValue[];
  warnings: string[];
  summary: string;
  confidence: number;
  skipped_reasons: string[];
}

export interface QaFinding {
  field: string;
  issue_type: string;
  severity: "critical" | "major" | "minor";
  message: string;
  expected: string;
  actual: string;
  deduction: number;
}

export interface QaOutput {
  score: number;
  status: "PASS" | "FAIL";
  confidence: number;
  summary: {
    critical_issues: number;
    major_issues: number;
    minor_issues: number;
  };
  findings: QaFinding[];
  skipped_reasons: string[];
}

export interface ImageReviewOutput {
  status: "PASS" | "FAIL";
  confidence: number;
  selected: {
    hero: {
      url: string;
      confidence: number;
    } | null;
    secondary: Array<{
      url: string;
      type: string;
      confidence: number;
    }>;
  };
  scored_candidates: Array<{
    url: string;
    type: string;
    approved: boolean;
    score: number;
    confidence: number;
    issues: string[];
  }>;
  rejected: Array<{
    url: string;
    reason: string;
    details: string;
  }>;
  findings: Array<{
    type: string;
    message: string;
  }>;
  skipped_reasons: string[];
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
  price?: string;
  compareAtPrice?: string;
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
