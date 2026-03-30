import type { LooseRecord, ProductMetafieldValue } from "../types.js";

function isObject(value: unknown): value is LooseRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isFieldChangeRecord(value: unknown): value is { value: unknown; confidence: number; source: string } {
  return isObject(value)
    && "value" in value
    && "confidence" in value
    && "source" in value
    && typeof value.confidence === "number"
    && typeof value.source === "string";
}

function materializeMetafieldMap(value: unknown): ProductMetafieldValue[] {
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([identifier, entry]) => {
    if (!isFieldChangeRecord(entry)) return [];
    const [namespace, key] = identifier.split(".", 2);
    if (!namespace || !key) return [];
    const record = entry as LooseRecord;
    return [{
      namespace,
      key,
      type: typeof record.type === "string" ? record.type : "single_line_text_field",
      value: String(entry.value ?? ""),
      description: typeof record.description === "string" ? record.description : "",
      required: Boolean(record.required),
      source_field: typeof record.source_field === "string" ? record.source_field : "",
      source: entry.source,
      validation_rules: Array.isArray(record.validation_rules) ? record.validation_rules.map(String) : [],
      example_values: Array.isArray(record.example_values) ? record.example_values.map(String) : [],
      usage: Array.isArray(record.usage) ? record.usage.map(String) : [],
      automation_mode: typeof record.automation_mode === "string" ? record.automation_mode : "review_required",
      inferred: Boolean(record.inferred)
    }];
  });
}

export function materializeProposedChanges(proposedChanges: LooseRecord | null | undefined): LooseRecord {
  if (!proposedChanges) return {};
  const changeBlock = isObject(proposedChanges.changes) ? proposedChanges.changes as LooseRecord : proposedChanges;
  const materialized: LooseRecord = {};

  for (const [key, value] of Object.entries(changeBlock)) {
    if (key === "skipped_fields") continue;
    if (key === "metafields" && isObject(value)) {
      materialized.metafields = materializeMetafieldMap(value);
      continue;
    }
    if (isFieldChangeRecord(value)) {
      materialized[key] = value.value;
      continue;
    }
    materialized[key] = value;
  }

  return materialized;
}
