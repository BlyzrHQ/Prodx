CREATE TABLE IF NOT EXISTS guest_sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  onboarding_completed INTEGER NOT NULL DEFAULT 0,
  business_name TEXT,
  business_description TEXT,
  industry TEXT,
  store_url TEXT,
  provider_models_json TEXT
);

CREATE TABLE IF NOT EXISTS workflow_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  input_source TEXT NOT NULL,
  input_name TEXT,
  parsed_count INTEGER NOT NULL DEFAULT 0,
  guide_generated INTEGER NOT NULL DEFAULT 0,
  guide_version TEXT,
  stage_state_json TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  artifact_ids_json TEXT NOT NULL,
  sync_batch_id TEXT
);

CREATE TABLE IF NOT EXISTS workflow_products (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  title TEXT NOT NULL,
  normalized_record_json TEXT NOT NULL,
  generated_product_path TEXT,
  generated_image_dir TEXT,
  selected_image_url TEXT,
  local_image_path TEXT,
  modules_json TEXT NOT NULL,
  disposition_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  title TEXT NOT NULL,
  blocking_module TEXT NOT NULL,
  issue_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  preview_image_url TEXT,
  current_fields_json TEXT NOT NULL,
  action_state TEXT NOT NULL,
  edit_payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generated_artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  type TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_batches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  approved_product_ids_json TEXT NOT NULL,
  results_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
