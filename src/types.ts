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

export interface RecommendedMetafield extends LooseRecord {
  namespace: string;
  key: string;
  type: string;
  purpose: string;
  example_values?: string[];
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

export interface AgentRouteConfig extends LooseRecord {
  enabled?: boolean;
  primary_provider?: string;
  fallback_provider?: string;
}

export interface AgenticRuntimeConfig extends LooseRecord {
  enabled?: boolean;
  max_enrich_retries?: number;
  max_image_retries?: number;
  max_iterations_per_product?: number;
  strict_cost_guardrail?: boolean;
  qa_passing_score_override?: number;
  agents?: Record<string, AgentRouteConfig>;
}

export interface RuntimeConfig {
  providers: Record<string, ProviderConfig>;
  modules: Record<string, Record<string, string>>;
  agentic?: AgenticRuntimeConfig;
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
  guideDir: string;
  policyDir: string;
  learningDir: string;
  configDir: string;
  indexDir: string;
  runsDir: string;
  generatedDir: string;
  generatedProductsDir: string;
  generatedImagesDir: string;
  generatedWorkflowProductsJson: string;
  generatedWorkflowCostsJson: string;
  generatedReviewCsv: string;
  generatedShopifyCsv: string;
  generatedRejectedCsv: string;
  generatedExcelWorkbook: string;
  guideMarkdown: string;
  guideJson: string;
  policyMarkdown: string;
  policyJson: string;
  legacyPolicyDir: string;
  legacyPolicyMarkdown: string;
  legacyPolicyJson: string;
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
  agent_run?: AgentRun;
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
  agentic_commerce_readiness?: {
    principles?: string[];
    required_signals?: string[];
    description_requirements?: string[];
    faq_requirements?: string[];
    catalog_mapping_recommendations?: string[];
    recommended_metafields?: RecommendedMetafield[];
    scoring_model?: string[];
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
  body_html?: string;
  seo_title?: string;
  seo_description?: string;
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

export interface ProviderUsage {
  provider?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  reasoning_tokens?: number;
  raw?: LooseRecord;
}

export interface ProviderCostEstimate extends LooseRecord {
  provider?: string;
  model?: string;
  pricing_basis?: string;
  currency: "USD";
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  total_tokens?: number;
  estimated_input_cost_usd: number;
  estimated_output_cost_usd: number;
  estimated_cache_cost_usd: number;
  estimated_total_cost_usd: number;
  estimation_note?: string;
}

export interface AgentAttempt extends LooseRecord {
  agent_id: string;
  module: string;
  attempt_number: number;
  started_at: string;
  completed_at: string;
  retry_reason?: string;
  parent_attempt?: number | null;
  accepted?: boolean;
  needs_review?: boolean;
  status?: string;
  summary?: string;
  provider_usage?: ProviderUsage | null;
  input_snapshot?: LooseRecord;
  output_snapshot?: LooseRecord;
}

export interface QaRetryFeedback extends LooseRecord {
  fixable_findings: QaFinding[];
  hard_blockers: QaFinding[];
  review_blockers: QaFinding[];
  retry_targets: string[];
  retry_instructions: string[];
  confidence_delta: number;
  recommended_next_agent: string | null;
}

export interface SupervisorDecision extends LooseRecord {
  action: "accept" | "retry_enrich" | "retry_image" | "retry_both" | "review" | "reject";
  reason: string;
  next_agent?: string | null;
  qa_feedback?: QaRetryFeedback;
}

export interface LearningRecord extends LooseRecord {
  id: string;
  created_at: string;
  source: string;
  lesson: string;
  scope?: string;
  product_key?: string;
  metadata?: LooseRecord;
}

export interface WorkflowMemory extends LooseRecord {
  product_key: string;
  source_record_id: string;
  created_at: string;
  updated_at: string;
  enrich_retries: number;
  image_retries: number;
  total_iterations: number;
  last_retry_reason?: string;
  qa_feedback?: QaRetryFeedback;
  attempts: AgentAttempt[];
  supervisor_decisions: SupervisorDecision[];
  learning_records: LearningRecord[];
}

export interface AgentRun extends LooseRecord {
  workflow: string;
  attempts: AgentAttempt[];
  supervisor_decisions: SupervisorDecision[];
  memory_path?: string;
  learning_records?: LearningRecord[];
  accepted_attempt?: number | null;
}

export interface ConnectorJsonResponse<T> {
  raw: unknown;
  text: string;
  json: T;
  usage?: ProviderUsage;
}

export interface EnrichmentOutput {
  title: string;
  description: string;
  description_html: string;
  handle: string;
  seo_title?: string | null;
  seo_description?: string | null;
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
  seoTitle?: string;
  seoDescription?: string;
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
  attachToProductId?: string | null;
  attachToProductHandle?: string | null;
  attachToProductTitle?: string | null;
  variantOptionValues?: Array<{ name: string; value: string }>;
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
  cost_summary?: {
    currency: "USD";
    total_tokens: number;
    estimated_total_cost_usd: number;
    stages: Array<{
      module: string;
      job_id: string;
      provider?: string;
      model?: string;
      total_tokens?: number;
      estimated_total_cost_usd: number;
    }>;
  };
}

export interface GuestSession {
  id: string;
  created_at: string;
  expires_at: string;
  onboarding_completed: boolean;
  business_name?: string;
  business_description?: string;
  industry?: string;
  store_url?: string;
  provider_models?: Record<string, string>;
}

export interface SessionSecret {
  provider: string;
  encrypted_value: string;
  iv: string;
  tag: string;
  created_at: string;
}

export interface WorkflowProductDisposition {
  status: "passed" | "duplicate" | "variant" | "rejected" | "pending_review";
  reason?: string;
}

export interface WorkflowProduct {
  id: string;
  session_id: string;
  workflow_id: string;
  product_key: string;
  source_record_id: string;
  title: string;
  normalized_record: LooseRecord;
  generated_product_path?: string;
  generated_image_dir?: string;
  selected_image_url?: string;
  local_image_path?: string;
  modules: WorkflowRunSummary["modules"];
  disposition: WorkflowProductDisposition;
}

export interface ReviewItem {
  id: string;
  session_id: string;
  workflow_id: string;
  product_id: string;
  product_key: string;
  title: string;
  blocking_module: string;
  issue_type: string;
  reason: string;
  preview_image_url?: string;
  current_fields: LooseRecord;
  action_state: "pending" | "approved" | "rejected";
  edit_payload?: LooseRecord;
  created_at: string;
  updated_at: string;
}

export interface GeneratedArtifact {
  id: string;
  session_id: string;
  workflow_id: string;
  type: "guide_markdown" | "shopify_import" | "rejected_products" | "workflow_summary";
  storage_key: string;
  file_name: string;
  content_type: string;
  created_at: string;
}

export interface SyncBatch {
  id: string;
  session_id: string;
  workflow_id: string;
  status: "idle" | "running" | "complete" | "failed";
  approved_product_ids: string[];
  results: Array<{
    product_id: string;
    product_key: string;
    status: "success" | "failed" | "skipped";
    message: string;
  }>;
  created_at: string;
  updated_at: string;
}

export interface WorkflowStageState {
  guide: "idle" | "running" | "complete" | "failed";
  match: "idle" | "running" | "complete" | "failed";
  enrich: "idle" | "running" | "complete" | "failed";
  image: "idle" | "running" | "complete" | "failed";
  qa: "idle" | "running" | "complete" | "failed";
  sync_prep: "idle" | "running" | "complete" | "failed";
}

export interface WorkflowSummaryCounts {
  total_entries: number;
  passed_products: number;
  duplicate_products: number;
  variant_products: number;
  rejected_products: number;
  pending_review_products: number;
  manually_reviewed_products: number;
}

export interface WorkflowSession {
  id: string;
  session_id: string;
  status: "idle" | "running" | "needs_review" | "ready" | "failed";
  created_at: string;
  updated_at: string;
  input_source: "text" | "file";
  input_name?: string;
  parsed_count: number;
  guide_generated: boolean;
  guide_version?: string;
  stage_state: WorkflowStageState;
  counts: WorkflowSummaryCounts;
  artifact_ids: string[];
  sync_batch_id?: string;
}
