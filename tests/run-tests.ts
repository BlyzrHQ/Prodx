import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { resolveLiveVariantAttachPayload, runCli, shouldSkipAfterMatch } from "../dist/cli.js";
import { buildShopifyPayload } from "../dist/connectors/shopify.js";
import { analyzeImageWithOpenAI } from "../dist/connectors/openai.js";
import { createOpenAIJsonResponse } from "../dist/connectors/openai.js";
import { createGeminiJsonResponse } from "../dist/connectors/gemini.js";
import { buildGeneratedProduct, writeShopifyImportCsv } from "../dist/lib/generated.js";
import { loadOpenAICodexAuthSession } from "../dist/lib/credentials.js";
import { appendLearningRecords, loadWorkflowMemory, saveWorkflowMemory } from "../dist/lib/learning.js";
import {
  buildCollectionSourceSummary,
  loadCollectionProposals,
  loadCollectionRegistry,
  mergeCollectionRegistryEntries,
  saveCollectionProposals,
  saveCollectionRegistry
} from "../dist/lib/collections.js";
import { defaultRuntimeConfig } from "../dist/lib/runtime.js";
import { buildStarterPolicy, initialLearningMarkdown, renderPolicyMarkdown } from "../dist/lib/policy-template.js";
import { hasPopulatedProductField } from "../dist/lib/product.js";
import { estimateProviderCost } from "../dist/lib/provider-cost.js";
import { importShopifyCollectionsToRegistry } from "../dist/connectors/shopify.js";
import { decideSupervisorAction } from "../dist/agents/supervisor-agent.js";
import { sanitizeProviderEvaluationAgainstInput } from "../dist/modules/qa.js";
import { runEnrich, sanitizeCustomerFacingDescription, shouldUseWebVerification } from "../dist/modules/enrich.js";
import { buildImageSearchQueries, buildImageSearchQuery, evaluateImageCandidateUrl, rankImageCandidates } from "../dist/modules/image-optimize.js";
import { loadRecordsFromSource, loadRecordsFromText } from "../dist/modules/ingest.js";
import { runMatchDecision } from "../dist/modules/match.js";

async function createTempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), "catalog-toolkit-"));
}

async function seedGuideFiles(
  cwd: string,
  input: { industry: string; businessName: string; businessDescription?: string; operatingMode?: string }
) {
  const policy = buildStarterPolicy({
    industry: input.industry,
    businessName: input.businessName,
    businessDescription: input.businessDescription ?? "",
    operatingMode: input.operatingMode ?? "both"
  });
  const policyDir = path.join(cwd, ".catalog", "guide");
  const learningDir = path.join(cwd, ".catalog", "learning");
  await fs.mkdir(policyDir, { recursive: true });
  await fs.mkdir(learningDir, { recursive: true });
  await fs.writeFile(path.join(policyDir, "catalog-guide.json"), JSON.stringify(policy, null, 2));
  await fs.writeFile(path.join(policyDir, "catalog-guide.md"), renderPolicyMarkdown(policy));
  try {
    await fs.access(path.join(learningDir, "catalog-learning.md"));
  } catch {
    await fs.writeFile(path.join(learningDir, "catalog-learning.md"), initialLearningMarkdown(policy));
  }
}

async function seedWorkflowLedger(cwd: string, products: Array<Record<string, unknown>>) {
  const generatedDir = path.join(cwd, ".catalog", "generated");
  await fs.mkdir(generatedDir, { recursive: true });
  await fs.writeFile(path.join(generatedDir, "workflow-products.json"), JSON.stringify({
    generated_at: new Date().toISOString(),
    count: products.length,
    products
  }, null, 2));
}

function writer() {
  return {
    text: "",
    write(chunk) {
      this.text += chunk;
    }
  };
}

const tests = [
  {
    name: "starter policy includes structured metafield schema",
    run: async () => {
      const policy = buildStarterPolicy({ industry: "grocery", businessName: "Test Store" });
      assert.equal(Array.isArray(policy.taxonomy_design?.hierarchy), true);
      assert.equal(Array.isArray(policy.product_title_system?.examples), true);
      assert.equal(Array.isArray(policy.automation_playbook?.fallback_rules), true);
      assert.equal(Array.isArray(policy.qa_validation_system?.pass_fail_conditions), true);
      assert.equal(Array.isArray(policy.attributes_metafields_schema.metafields), true);
      assert.equal(typeof policy.attributes_metafields_schema.metafields[0].namespace, "string");
      assert.equal(Array.isArray(policy.attributes_metafields_schema.fill_rules), true);
    }
  },
  {
    name: "rendered catalog guide reads like an expert playbook with worked examples and edge cases",
    run: async () => {
      const policy = buildStarterPolicy({ industry: "food_and_beverage", businessName: "Playbook Store" });
      const markdown = renderPolicyMarkdown(policy);
      assert.match(markdown, /## How To Use This Guide/);
      assert.match(markdown, /### Variant Decision Playbook/);
      assert.match(markdown, /## Worked Examples & Operator Guidance/);
      assert.match(markdown, /duplicates/i);
      assert.match(markdown, /new variants/i);
      assert.match(markdown, /## Agentic Commerce Readiness/);
      assert.match(markdown, /Recommended Metafields To Add/);
      assert.doesNotMatch(markdown, /Audience: requires_review/i);
    }
  },
  {
    name: "OpenAI connector returns usage metadata when available",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "{\"status\":\"ok\"}"
                }
              ]
            }
          ],
          usage: {
            input_tokens: 1200,
            output_tokens: 300,
            total_tokens: 1500,
            input_tokens_details: {
              cached_tokens: 100,
              cache_read_tokens: 50
            },
            output_tokens_details: {
              reasoning_tokens: 25
            }
          }
        })
      }) as Response;

      try {
        const response = await createOpenAIJsonResponse<{ status: string }>({
          apiKey: "test",
          model: "gpt-5",
          instructions: "Return JSON",
          input: "test",
          schema: {
            name: "test_schema",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: { status: { type: "string" } },
              required: ["status"]
            }
          }
        });
        assert.equal(response.usage?.input_tokens, 1200);
        assert.equal(response.usage?.output_tokens, 300);
        assert.equal(response.usage?.total_tokens, 1500);
        assert.equal(response.usage?.reasoning_tokens, 25);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  },
  {
    name: "Gemini connector returns usage metadata when available",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  { text: "{\"status\":\"ok\"}" }
                ]
              }
            }
          ],
          usageMetadata: {
            promptTokenCount: 900,
            candidatesTokenCount: 200,
            totalTokenCount: 1100
          }
        })
      }) as Response;

      try {
        const response = await createGeminiJsonResponse<{ status: string }>({
          apiKey: "test",
          model: "gemini-2.5-flash",
          textPrompt: "Return JSON",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { status: { type: "string" } },
            required: ["status"]
          }
        });
        assert.equal(response.usage?.input_tokens, 900);
        assert.equal(response.usage?.output_tokens, 200);
        assert.equal(response.usage?.total_tokens, 1100);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  },
  {
    name: "enricher enables web verification only for missing high-risk factual fields",
    run: async () => {
      const electronicsPolicy = buildStarterPolicy({ industry: "electronics", businessName: "Test Store" });
      const groceryPolicy = buildStarterPolicy({ industry: "food_and_beverage", businessName: "Test Store" });
      assert.equal(shouldUseWebVerification({ title: "Anker 20W USB-C Charger" }, electronicsPolicy), true);
      assert.equal(shouldUseWebVerification({
        title: "Fresh Milk",
        ingredients_text: "Milk",
        allergen_note: "Contains milk",
        metafields: [
          {
            namespace: "custom",
            key: "dietary_preferences",
            type: "list.single_line_text_field",
            value: "halal"
          }
        ]
      }, groceryPolicy), false);
    }
  },
  {
    name: "product field aliases treat body_html and description_html as the same populated field",
    run: async () => {
      assert.equal(hasPopulatedProductField({
        description_html: "<p>Example</p>"
      }, "body_html"), true);
      assert.equal(hasPopulatedProductField({
        body_html: "<p>Example</p>"
      }, "description_html"), true);
    }
  },
  {
    name: "auth set stores provider model in runtime config",
    run: async () => {
      const cwd = await createTempProject();
      const tempHome = await createTempProject();
      const originalUserProfile = process.env.USERPROFILE;
      const originalHome = process.env.HOME;
      process.env.USERPROFILE = tempHome;
      process.env.HOME = tempHome;
      const io = writer();
      try {
        await runCli(["init"], { cwd, stdout: io, stderr: io });
        const code = await runCli(["auth", "set", "--provider", "openai", "--value", "sk-test", "--model", "gpt-5-mini"], { cwd, stdout: io, stderr: io });
        assert.equal(code, 0);
        const runtime = JSON.parse(await fs.readFile(path.join(cwd, ".catalog", "config", "runtime.json"), "utf8"));
        assert.equal(runtime.providers.openai_default.model, "gpt-5-mini");
      } finally {
        process.env.USERPROFILE = originalUserProfile;
        process.env.HOME = originalHome;
      }
    }
  },
  {
    name: "OpenAI auth session import returns null when Codex auth has no reusable API key",
    run: async () => {
      const tempHome = await createTempProject();
      const originalUserProfile = process.env.USERPROFILE;
      const originalHome = process.env.HOME;
      process.env.USERPROFILE = tempHome;
      process.env.HOME = tempHome;
      await fs.mkdir(path.join(tempHome, ".codex"), { recursive: true });
      await fs.writeFile(path.join(tempHome, ".codex", "auth.json"), JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        last_refresh: "2026-04-02T00:00:00.000Z"
      }, null, 2));

      try {
        const session = await loadOpenAICodexAuthSession();
        assert.equal(session, null);
      } finally {
        process.env.USERPROFILE = originalUserProfile;
        process.env.HOME = originalHome;
      }
    }
  },
  {
    name: "auth login openai imports local Codex API key and updates selected model",
    run: async () => {
      const cwd = await createTempProject();
      const tempHome = await createTempProject();
      const originalUserProfile = process.env.USERPROFILE;
      const originalHome = process.env.HOME;
      process.env.USERPROFILE = tempHome;
      process.env.HOME = tempHome;
      await fs.mkdir(path.join(tempHome, ".codex"), { recursive: true });
      await fs.writeFile(path.join(tempHome, ".codex", "auth.json"), JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: "sk-from-codex",
        last_refresh: "2026-04-02T00:00:00.000Z"
      }, null, 2));

      const io = writer();
      try {
        await runCli(["init"], { cwd, stdout: io, stderr: io });
        const code = await runCli(["auth", "login", "--provider", "openai", "--model", "gpt-5"], { cwd, stdout: io, stderr: io });
        assert.equal(code, 0);
        const runtime = JSON.parse(await fs.readFile(path.join(cwd, ".catalog", "config", "runtime.json"), "utf8"));
        const credentials = JSON.parse(await fs.readFile(path.join(tempHome, ".catalog-toolkit", "credentials.json"), "utf8"));
        assert.equal(runtime.providers.openai_default.model, "gpt-5");
        assert.equal(credentials.openai.value, "sk-from-codex");
        assert.equal(credentials.openai.source, "oauth");
      } finally {
        process.env.USERPROFILE = originalUserProfile;
        process.env.HOME = originalHome;
      }
    }
  },
  {
    name: "default runtime config enables bounded agentic workflow settings",
    run: async () => {
      const runtime = defaultRuntimeConfig();
      assert.equal(runtime.agentic?.enabled, true);
      assert.equal(runtime.agentic?.max_enrich_retries, 1);
      assert.equal(runtime.agentic?.max_image_retries, 1);
      assert.equal(runtime.agentic?.max_iterations_per_product, 4);
      assert.equal(runtime.agentic?.agents?.["enrich-agent"]?.enabled, true);
      assert.equal(runtime.agentic?.agents?.["qa-agent"]?.primary_provider, "openai_default");
    }
  },
  {
    name: "default runtime config enables smart collections with local-first defaults",
    run: async () => {
      const runtime = defaultRuntimeConfig();
      assert.equal(runtime.collections?.enabled, true);
      assert.equal(runtime.collections?.min_products_per_collection, 5);
      assert.equal(runtime.collections?.max_iterations_per_candidate, 2);
      assert.deepEqual(runtime.collections?.allowed_rule_sources, ["product_type", "guide_metafields"]);
      assert.equal(runtime.modules["collection-builder"].llm_provider, "openai_default");
      assert.equal(runtime.modules["collection-evaluator"].fallback_llm_provider, "gemini_flash_default");
    }
  },
  {
    name: "collection source summary groups product types and allowed metafield values from the generated ledger",
    run: async () => {
      const cwd = await createTempProject();
      const runtime = defaultRuntimeConfig();
      await seedGuideFiles(cwd, { industry: "grocery", businessName: "Collections Store" });

      const guidePath = path.join(cwd, ".catalog", "guide", "catalog-guide.json");
      const guide = JSON.parse(await fs.readFile(guidePath, "utf8"));
      guide.agentic_commerce_readiness = {
        ...(guide.agentic_commerce_readiness ?? {}),
        recommended_metafields: [
          {
            namespace: "custom",
            key: "dietary_preferences",
            type: "single_line_text_field",
            purpose: "Dietary merchandising"
          }
        ]
      };
      await fs.writeFile(guidePath, JSON.stringify(guide, null, 2));

      await seedWorkflowLedger(cwd, [
        ...Array.from({ length: 6 }, (_, index) => ({
          id: `milk-${index + 1}`,
          title: `Milk ${index + 1}`,
          product_type: "Milk",
          metafields: [
            {
              namespace: "custom",
              key: "dietary_preferences",
              type: "single_line_text_field",
              value: "Halal"
            }
          ]
        })),
        {
          id: "sparse-1",
          title: "Sparse",
          product_type: "Seasonal",
          metafields: [
            {
              namespace: "custom",
              key: "dietary_preferences",
              type: "single_line_text_field",
              value: "Limited"
            }
          ]
        }
      ]);

      const summary = await buildCollectionSourceSummary({
        root: cwd,
        policy: guide,
        runtimeConfig: runtime
      });
      assert.equal(summary.total_products_analyzed, 7);
      assert.equal(summary.candidates.some((entry) => entry.source_type === "product_type" && entry.source_value === "Milk" && entry.product_count === 6), true);
      assert.equal(summary.candidates.some((entry) => entry.source_type === "metafield" && entry.source_key === "custom.dietary_preferences" && entry.source_value === "Halal" && entry.product_count === 6), true);
      assert.equal(summary.skipped.some((entry) => entry.source_value === "Seasonal" && /below_minimum_5/.test(entry.skipped_reason)), true);
    }
  },
  {
    name: "collection registry merge avoids duplicate imported rows",
    run: async () => {
      const first = {
        id: "gid://shopify/Collection/1",
        title: "Milk",
        handle: "milk",
        source_type: "product_type",
        source_key: "product_type",
        source_label: "Product type",
        source_value: "Milk",
        normalized_value: "milk",
        product_count: 0,
        status: "imported",
        rule: {
          applied_disjunctively: false,
          rules: [{ column: "TYPE", relation: "EQUALS", condition: "Milk" }]
        },
        shopify_id: "gid://shopify/Collection/1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      const merged = mergeCollectionRegistryEntries([first], [first]);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].title, "Milk");
    }
  },
  {
    name: "collections propose saves approved proposals and skips duplicates from the local registry",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, { industry: "grocery", businessName: "Collection CLI Store" });

      const guidePath = path.join(cwd, ".catalog", "guide", "catalog-guide.json");
      const guide = JSON.parse(await fs.readFile(guidePath, "utf8"));
      guide.agentic_commerce_readiness = {
        ...(guide.agentic_commerce_readiness ?? {}),
        recommended_metafields: [
          {
            namespace: "custom",
            key: "dietary_preferences",
            type: "single_line_text_field",
            purpose: "Dietary merchandising"
          }
        ]
      };
      await fs.writeFile(guidePath, JSON.stringify(guide, null, 2));

      await seedWorkflowLedger(cwd, Array.from({ length: 6 }, (_, index) => ({
        id: `item-${index + 1}`,
        title: `Item ${index + 1}`,
        product_type: "Greek Yogurt",
        metafields: [
          {
            namespace: "custom",
            key: "dietary_preferences",
            type: "single_line_text_field",
            value: "Halal"
          }
        ]
      })));

      await saveCollectionRegistry(cwd, [{
        id: "existing-type-yogurt",
        title: "Greek Yogurt",
        handle: "type-greek-yogurt",
        source_type: "product_type",
        source_key: "product_type",
        source_label: "Product type",
        source_value: "Greek Yogurt",
        normalized_value: "greek yogurt",
        product_count: 6,
        status: "created",
        rule: {
          applied_disjunctively: false,
          rules: [{ column: "TYPE", relation: "EQUALS", condition: "Greek Yogurt" }]
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }]);

      io.text = "";
      const code = await runCli(["collections", "propose", "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      const output = JSON.parse(io.text);
      assert.equal(output.proposals.length >= 2, true);

      const proposals = await loadCollectionProposals(cwd);
      const skippedType = proposals.find((proposal) => proposal.source_type === "product_type");
      const approvedMetafield = proposals.find((proposal) => proposal.source_type === "metafield");
      assert.equal(skippedType?.status, "skipped_duplicate");
      assert.equal(approvedMetafield?.status, "approved");
      assert.equal((approvedMetafield?.attempts.builder.length ?? 0) >= 2, true);
      assert.equal((approvedMetafield?.title ?? "").includes("Dietary Preferences"), true);
    }
  },
  {
    name: "collections import normalizes existing Shopify smart collections into the local registry format",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          data: {
            collections: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Collection/10",
                    title: "Milk",
                    handle: "milk",
                    ruleSet: {
                      appliedDisjunctively: false,
                      rules: [
                        {
                          column: "TYPE",
                          relation: "EQUALS",
                          condition: "Milk"
                        }
                      ]
                    }
                  }
                },
                {
                  node: {
                    id: "gid://shopify/Collection/11",
                    title: "Dietary Preferences: Halal",
                    handle: "dietary-preferences-halal",
                    ruleSet: {
                      appliedDisjunctively: false,
                      rules: [
                        {
                          column: "PRODUCT_METAFIELD_DEFINITION",
                          relation: "EQUALS",
                          condition: "Halal",
                          conditionObject: {
                            metafieldDefinition: {
                              id: "gid://shopify/MetafieldDefinition/1",
                              namespace: "custom",
                              key: "dietary_preferences"
                            }
                          }
                        }
                      ]
                    }
                  }
                }
              ],
              pageInfo: {
                hasNextPage: false,
                endCursor: null
              }
            }
          }
        })
      }) as Response;

      try {
        const imported = await importShopifyCollectionsToRegistry({
          store: "demo.myshopify.com",
          accessToken: "shpat_test"
        });
        assert.equal(imported.length, 2);
        assert.equal(imported.some((entry) => entry.source_type === "product_type" && entry.source_value === "Milk"), true);
        assert.equal(imported.some((entry) => entry.source_type === "metafield" && entry.source_key === "custom.dietary_preferences" && entry.source_value === "Halal"), true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  },
  {
    name: "collections apply creates approved smart collections and writes created state back to the registry",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });

      const runtimePath = path.join(cwd, ".catalog", "config", "runtime.json");
      const runtime = JSON.parse(await fs.readFile(runtimePath, "utf8"));
      runtime.providers.shopify_default.store = "demo.myshopify.com";
      await fs.writeFile(runtimePath, JSON.stringify(runtime, null, 2));

      const tempHome = await createTempProject();
      const originalUserProfile = process.env.USERPROFILE;
      const originalHome = process.env.HOME;
      process.env.USERPROFILE = tempHome;
      process.env.HOME = tempHome;
      await fs.mkdir(path.join(tempHome, ".catalog-toolkit"), { recursive: true });
      await fs.writeFile(path.join(tempHome, ".catalog-toolkit", "credentials.json"), JSON.stringify({
        shopify: {
          alias: "shopify",
          value: "shpat_test",
          source: "file"
        }
      }, null, 2));

      await saveCollectionProposals(cwd, [{
        id: "proposal-milk",
        candidate_id: "candidate-milk",
        title: "Milk",
        handle: "type-milk",
        description_html: "<p>Milk collection</p>",
        rationale: "Useful store collection",
        source_type: "product_type",
        source_key: "product_type",
        source_label: "Product type",
        source_value: "Milk",
        normalized_value: "milk",
        product_count: 8,
        product_ids: ["1", "2"],
        product_keys: ["milk-1", "milk-2"],
        rule: {
          applied_disjunctively: false,
          rules: [{ column: "TYPE", relation: "EQUALS", condition: "Milk" }]
        },
        evaluator_decision: "APPROVE",
        evaluation: {
          decision: "APPROVE",
          summary: "Looks good",
          reasons: [],
          retry_instructions: []
        },
        status: "approved",
        attempts: { builder: [], evaluator: [] },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }]);
      await saveCollectionRegistry(cwd, []);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          data: {
            collectionCreate: {
              collection: {
                id: "gid://shopify/Collection/99",
                title: "Milk",
                handle: "type-milk"
              },
              userErrors: []
            }
          }
        })
      }) as Response;

      try {
        io.text = "";
        const code = await runCli(["collections", "apply", "--json"], { cwd, stdout: io, stderr: io });
        assert.equal(code, 0);
        const output = JSON.parse(io.text);
        assert.equal(output.applied.length, 1);
        assert.equal(output.applied[0].status, "created");

        const registry = await loadCollectionRegistry(cwd);
        assert.equal(registry.some((entry) => entry.status === "created" && entry.shopify_id === "gid://shopify/Collection/99"), true);
      } finally {
        globalThis.fetch = originalFetch;
        process.env.USERPROFILE = originalUserProfile;
        process.env.HOME = originalHome;
      }
    }
  },
  {
    name: "supervisor retries fixable enrich and image issues within the configured cap",
    run: async () => {
      const runtime = defaultRuntimeConfig();
      const decision = decideSupervisorAction({
        runtimeConfig: runtime,
        memory: {
          product_key: "sample",
          source_record_id: "sample",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          enrich_retries: 0,
          image_retries: 0,
          total_iterations: 1,
          attempts: [],
          supervisor_decisions: [],
          learning_records: []
        },
        qaPassed: false,
        qaNeedsReview: true,
        qaFeedback: {
          fixable_findings: [
            { field: "description_html", issue_type: "format", severity: "major", message: "Description needs work", expected: "clean", actual: "rough", deduction: 5 },
            { field: "featured_image", issue_type: "invalid", severity: "major", message: "Hero image is weak", expected: "exact match", actual: "logo", deduction: 5 }
          ],
          hard_blockers: [],
          review_blockers: [],
          retry_targets: ["enrich-agent", "image-agent"],
          retry_instructions: ["retry both"],
          confidence_delta: -0.1,
          recommended_next_agent: "enrich-agent"
        },
        lastModuleStatus: "needs_review"
      });
      assert.equal(decision.action, "retry_both");
      assert.match(decision.reason, /both retry budgets/i);
    }
  },
  {
    name: "learning records and workflow memory persist without duplicating lessons",
    run: async () => {
      const cwd = await createTempProject();
      await seedGuideFiles(cwd, { industry: "grocery", businessName: "Learning Store" });
      const appended = await appendLearningRecords(cwd, [
        {
          id: "lesson-1",
          created_at: new Date().toISOString(),
          source: "qa-agent",
          lesson: "Keep shopper descriptions free of internal review text."
        },
        {
          id: "lesson-2",
          created_at: new Date().toISOString(),
          source: "qa-agent",
          lesson: "Keep shopper descriptions free of internal review text."
        }
      ]);
      assert.equal(appended.length, 1);
      const memory = await loadWorkflowMemory(cwd, "sample-product", "source-1");
      memory.total_iterations = 2;
      memory.last_retry_reason = "Retry image selection.";
      const savedPath = await saveWorkflowMemory(cwd, memory);
      const reloaded = await loadWorkflowMemory(cwd, "sample-product", "source-1");
      assert.equal(reloaded.total_iterations, 2);
      assert.equal(reloaded.last_retry_reason, "Retry image selection.");
      assert.match(savedPath, /workflow-memory/);
    }
  },
  {
    name: "provider cost estimator computes usd totals from tracked tokens",
    run: async () => {
      const estimate = estimateProviderCost({
        provider: "openai",
        model: "gpt-5",
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        cache_read_input_tokens: 200
      });
      assert.ok(estimate);
      assert.equal(estimate.currency, "USD");
      assert.equal(estimate.total_tokens, 1500);
      assert.equal(estimate.estimated_total_cost_usd > 0, true);
      assert.match(String(estimate.pricing_basis), /OpenAI/i);
    }
  },
  {
    name: "enricher falls back to gemini when the primary openai provider fails",
    run: async () => {
      const cwd = await createTempProject();
      await seedGuideFiles(cwd, { industry: "grocery", businessName: "Fallback Store" });
      const originalOpenAi = process.env.OPENAI_API_KEY;
      const originalGemini = process.env.GEMINI_API_KEY;
      const originalFetch = globalThis.fetch;
      process.env.OPENAI_API_KEY = "openai-test";
      process.env.GEMINI_API_KEY = "gemini-test";
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.includes("api.openai.com")) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: { message: "upstream openai failure" } })
          } as Response;
        }
        if (url.includes("generativelanguage.googleapis.com")) {
          return {
            ok: true,
            json: async () => ({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          title: "Baladna Greek Yogurt Plain 500g",
                          description: "Plain Greek yogurt.",
                          description_html: "<p>Plain Greek yogurt.</p>",
                          handle: "baladna-greek-yogurt-plain-500g",
                          seo_title: "Baladna Greek Yogurt Plain 500g",
                          seo_description: "Plain Greek yogurt.",
                          vendor: "Baladna",
                          brand: "Baladna",
                          product_type: "Yogurt",
                          tags: ["yogurt"],
                          metafields: [],
                          warnings: [],
                          summary: "Fallback Gemini enrichment succeeded.",
                          confidence: 0.88,
                          skipped_reasons: []
                        })
                      }
                    ]
                  }
                }
              ],
              usageMetadata: {
                promptTokenCount: 800,
                candidatesTokenCount: 120,
                totalTokenCount: 920
              }
            })
          } as Response;
        }
        throw new Error(`Unexpected fetch: ${url}`);
      };

      try {
        const policy = buildStarterPolicy({ industry: "grocery", businessName: "Fallback Store" });
        const result = await runEnrich({
          root: cwd,
          jobId: "enrich-fallback-test",
          input: {
            id: "p1",
            title: "Baladna Greek Yogurt Plain 500g",
            brand: "Baladna",
            size: "500g"
          },
          policy
        });
        assert.equal(result.status, "success");
        assert.equal(result.needs_review, false);
        assert.equal(result.artifacts.provider_used, "gemini_flash_default");
        assert.equal((result.artifacts.provider_usage as any)?.provider, "gemini");
        assert.match(result.warnings.join("\n"), /openai_default/i);
      } finally {
        globalThis.fetch = originalFetch;
        if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = originalOpenAi;
        if (originalGemini === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = originalGemini;
      }
    }
  },
  {
    name: "shopify payload carries selected image URLs",
    run: async () => {
      const payload = buildShopifyPayload({
        title: "Fresh Milk",
        price: "12.50",
        compare_at_price: "15.00",
        featured_image: "https://example.com/featured.jpg",
        images: ["https://example.com/featured.jpg", "https://example.com/extra.jpg"],
        image_alt_text: "Fresh Milk bottle",
        metafields: [
          {
            namespace: "custom",
            key: "country_of_origin",
            type: "single_line_text_field",
            value: "Saudi Arabia"
          }
        ]
      });
      assert.equal(payload.featuredImage, "https://example.com/featured.jpg");
      assert.deepEqual(payload.images, ["https://example.com/featured.jpg", "https://example.com/extra.jpg"]);
      assert.equal(payload.imageAltText, "Fresh Milk bottle");
      assert.equal(payload.price, "12.50");
      assert.equal(payload.compareAtPrice, "15.00");
      assert.equal(payload.metafields?.[0].key, "country_of_origin");
    }
  },
  {
    name: "shopify payload carries variant attachment metadata for NEW_VARIANT matches",
    run: async () => {
      const payload = buildShopifyPayload({
        id: "child-1",
        title: "Uniqlo Club T-Shirt",
        handle: "uniqlo-club-t-shirt-large",
        vendor: "Uniqlo",
        product_type: "T-Shirt",
        size: "Large",
        price: "29.00",
        _catalog_match: {
          decision: "NEW_VARIANT",
          proposed_action: {
            action: "attach_as_variant",
            product_id: "parent-1",
            product_handle: "uniqlo-club-t-shirt",
            product_title: "Uniqlo Club T-Shirt",
            option_values: [{ name: "size", value: "Large" }]
          }
        }
      });
      assert.equal(payload.id, null);
      assert.equal(payload.attachToProductId, "parent-1");
      assert.equal(payload.attachToProductHandle, "uniqlo-club-t-shirt");
      assert.equal(payload.variantOptionValues?.[0].value, "Large");
    }
  },
  {
    name: "openai image analysis omits reasoning parameters for vision requests",
    run: async () => {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? "{}"));
          assert.equal("reasoning" in body, false);
          return {
            ok: true,
            json: async () => ({
              output_text: "{\"status\":\"PASS\",\"confidence\":0.9,\"selected\":{\"hero\":{\"url\":\"https://example.com/hero.jpg\",\"confidence\":0.9},\"secondary\":[]},\"scored_candidates\":[],\"rejected\":[],\"findings\":[],\"skipped_reasons\":[]}"
            })
          } as Response;
        };

        const result = await analyzeImageWithOpenAI({
          apiKey: "test-key",
          model: "gpt-4.1-mini",
          instructions: "Review product images.",
          prompt: "Pick the best image.",
          imageUrls: ["https://example.com/hero.jpg"],
          schema: {
            name: "catalog_image_review",
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["status", "confidence", "selected", "scored_candidates", "rejected", "findings", "skipped_reasons"],
              properties: {
                status: { type: "string" },
                confidence: { type: "number" },
                selected: { type: "object" },
                scored_candidates: { type: "array", items: { type: "object" } },
                rejected: { type: "array", items: { type: "object" } },
                findings: { type: "array", items: { type: "object" } },
                skipped_reasons: { type: "array", items: { type: "string" } }
              }
            }
          }
        });
        assert.equal(result.json.status, "PASS");
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  },
  {
    name: "openai json connector retries with a larger output budget after truncation",
    run: async () => {
      const originalFetch = globalThis.fetch;
      let callCount = 0;
      try {
        globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
          callCount += 1;
          const body = JSON.parse(String(init?.body ?? "{}"));
          if (callCount === 1) {
            assert.equal(body.max_output_tokens, 1200);
            return {
              ok: true,
              json: async () => ({
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" }
              })
            } as Response;
          }
          assert.equal(body.max_output_tokens > 1200, true);
          return {
            ok: true,
            json: async () => ({
              output_text: "{\"value\":\"ok\"}"
            })
          } as Response;
        };

        const result = await createOpenAIJsonResponse<{ value: string }>({
          apiKey: "test-key",
          model: "gpt-5-mini",
          instructions: "Return JSON.",
          input: "hello",
          schema: {
            name: "simple",
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["value"],
              properties: { value: { type: "string" } }
            }
          },
          maxOutputTokens: 1200
        });
        assert.equal(result.json.value, "ok");
        assert.equal(callCount, 2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  },
  {
    name: "gemini json connector omits responseMimeType when google search is enabled",
    run: async () => {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? "{}"));
          assert.equal(Boolean(body.tools?.[0]?.google_search), true);
          assert.equal("responseMimeType" in body.generationConfig, false);
          assert.equal("responseJsonSchema" in body.generationConfig, false);
          return {
            ok: true,
            json: async () => ({
              candidates: [
                {
                  content: {
                    parts: [
                      { text: "{\"value\":\"ok\"}" }
                    ]
                  }
                }
              ]
            })
          } as Response;
        };

        const result = await createGeminiJsonResponse<{ value: string }>({
          apiKey: "test-key",
          model: "gemini-2.5-flash",
          systemInstruction: "Return JSON.",
          textPrompt: "hello",
          schema: {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["value"],
              properties: { value: { type: "string" } }
            }
          },
          googleSearch: true
        });
        assert.equal(result.json.value, "ok");
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  },
  {
    name: "init creates .catalog structure and runtime config",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      const code = await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      const runtime = JSON.parse(await fs.readFile(path.join(cwd, ".catalog", "config", "runtime.json"), "utf8"));
      assert.equal(runtime.providers.openai_default.type, "openai");
      assert.equal(runtime.providers.gemini_flash_default.type, "gemini");
      assert.equal(runtime.providers.anthropic_default.type, "anthropic");
      assert.equal(runtime.modules["image-optimizer"].vision_provider, "openai_vision_default");
      assert.equal(runtime.modules["catalogue-expert"].llm_provider, "openai_default");
      assert.equal(runtime.modules["catalogue-qa"].llm_provider, "openai_default");
      await fs.access(path.join(cwd, ".catalog", "generated", "products"));
      await fs.access(path.join(cwd, ".catalog", "generated", "images"));
    }
  },
  {
    name: "guide generation fails cleanly without writing a fallback template when no provider is ready",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      io.text = "";
      const code = await runCli([
        "expert",
        "generate",
        "--industry",
        "grocery",
        "--business-name",
        "Test Store",
        "--business-description",
        "A grocery business focused on fresh dairy products.",
        "--operating-mode",
        "both",
        "--json"
      ], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      const output = JSON.parse(io.text);
      assert.equal(output.result.status, "failed");
      assert.equal(Array.isArray(output.result.errors), true);
      assert.equal(output.result.errors.length > 0, true);
      await assert.rejects(fs.access(path.join(cwd, ".catalog", "guide", "catalog-guide.json")));
    }
  },
  {
    name: "guide show renders an existing Catalog Guide",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, {
        industry: "electronics",
        businessName: "Guide Store",
        businessDescription: "A store selling practical consumer electronics."
      });
      io.text = "";
      const showCode = await runCli(["guide", "show", "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(showCode, 0);
      const shown = JSON.parse(io.text);
      assert.equal(shown.title, "Catalog Guide");
      assert.match(shown.markdown, /# Catalog Guide/);
    }
  },
  {
    name: "doctor reports missing provider credentials per module slot",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      io.text = "";
      const code = await runCli(["doctor", "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      const doctor = JSON.parse(io.text);
      const enricher = doctor.module_checks.find((item) => item.module === "product-enricher");
      assert.equal(Boolean(enricher), true);
      assert.equal(enricher.slots.some((slot) => slot.provider_alias === "openai_default"), true);
    }
  },
  {
    name: "ingest normalizes alternate JSON field names and nested record arrays",
    run: async () => {
      const cwd = await createTempProject();
      const inputPath = path.join(cwd, "alt-products.json");
      await fs.writeFile(inputPath, JSON.stringify({
        products: [
          {
            product_name: "Anker 20W USB-C Charger",
            sale_price: "19.99",
            brand_name: "Anker",
            image_url: "https://example.com/anker.jpg",
            labels: "charger;usb-c;anker"
          }
        ]
      }, null, 2));
      const records = await loadRecordsFromSource(inputPath);
      assert.equal(records.length, 1);
      assert.equal(records[0].title, "Anker 20W USB-C Charger");
      assert.equal(records[0].price, "19.99");
      assert.equal(records[0].brand, "Anker");
      assert.equal(records[0].featured_image, "https://example.com/anker.jpg");
      assert.deepEqual(records[0].tags, ["charger", "usb-c", "anker"]);
    }
  },
  {
    name: "ingest normalizes alternate CSV headers and quoted values",
    run: async () => {
      const cwd = await createTempProject();
      const csvPath = path.join(cwd, "alt-products.csv");
      await fs.writeFile(
        csvPath,
        'Product Name,Sale Price,Brand Name,Image URL,Labels\n"Greek Yogurt, Plain 500g",12.50,Baladna,https://example.com/yogurt.jpg,"dairy|yogurt|plain"\n'
      );
      const records = await loadRecordsFromSource(csvPath);
      assert.equal(records.length, 1);
      assert.equal(records[0].title, "Greek Yogurt, Plain 500g");
      assert.equal(records[0].price, "12.50");
      assert.equal(records[0].brand, "Baladna");
      assert.equal(records[0].featured_image, "https://example.com/yogurt.jpg");
      assert.deepEqual(records[0].tags, ["dairy", "yogurt", "plain"]);
    }
  },
  {
    name: "ingest parses plain text title-price lines",
    run: async () => {
      const records = loadRecordsFromText(`
Almarai Fresh Milk Low Fat 1L - 8.50
Baladna Greek Yogurt Plain 500g - 12.50
      `);
      assert.equal(records.length, 2);
      assert.equal(records[0].title, "Almarai Fresh Milk Low Fat 1L");
      assert.equal(records[0].price, "8.50");
      assert.equal(records[1].title, "Baladna Greek Yogurt Plain 500g");
      assert.equal(records[1].price, "12.50");
    }
  },
  {
    name: "ingest parses plain text key value blocks",
    run: async () => {
      const records = loadRecordsFromText(`
title: Uniqlo Club T-Shirt
brand: Uniqlo
price: 29.00
size: Large

title: JBL Tune 520BT Wireless On-Ear Headphones Black
brand: JBL
price: 199
      `);
      assert.equal(records.length, 2);
      assert.equal(records[0].title, "Uniqlo Club T-Shirt");
      assert.equal(records[0].brand, "Uniqlo");
      assert.equal(records[0].size, "Large");
      assert.equal(records[1].title, "JBL Tune 520BT Wireless On-Ear Headphones Black");
      assert.equal(records[1].price, "199");
    }
  },
  {
    name: "qa fails when customer-facing description contains review placeholder text",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, { industry: "grocery", businessName: "QA Store" });
      const inputPath = path.join(cwd, "qa-input.json");
      await fs.writeFile(inputPath, JSON.stringify({
        title: "Baladna Greek Yogurt Plain 500g",
        product_type: "Yogurt",
        vendor: "Baladna",
        handle: "baladna-greek-yogurt-plain-500g",
        description_html: "<h3>Ingredients</h3><p>Requires review before publishing.</p>",
        featured_image: "https://example.com/yogurt.jpg"
      }, null, 2));
      io.text = "";
      const code = await runCli(["qa", "--input", inputPath, "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      const output = JSON.parse(io.text);
      assert.equal(output.result.status, "needs_review");
      assert.match(JSON.stringify(output.result.proposed_changes), /description_html/);
      const learning = await fs.readFile(path.join(cwd, ".catalog", "learning", "catalog-learning.md"), "utf8");
      assert.match(learning, /Never place internal review notes, placeholders, or QA text/);
    }
  },
  {
    name: "qa returns agentic commerce readiness recommendations when recommended metafields are missing",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, { industry: "apparel", businessName: "Agentic Store" });
      const inputPath = path.join(cwd, "agentic-qa-input.json");
      await fs.writeFile(inputPath, JSON.stringify({
        title: "Uniqlo Club T-Shirt",
        product_type: "T-Shirt",
        vendor: "Uniqlo",
        handle: "uniqlo-club-t-shirt",
        price: "29.00",
        description_html: "<h3>Overview</h3><p>A cotton t-shirt for everyday wear.</p><h3>Key Features</h3><p>Soft and breathable.</p><h3>Material And Fit</h3><p>Cotton fabric.</p><h3>Care Or Usage</h3><p>Machine wash cold.</p>",
        featured_image: "https://example.com/shirt.jpg"
      }, null, 2));
      io.text = "";
      const code = await runCli(["qa", "--input", inputPath, "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      const output = JSON.parse(io.text);
      const changes = output.result.proposed_changes;
      assert.equal(typeof changes.agentic_commerce_readiness_score, "number");
      assert.equal(Array.isArray(changes.agentic_commerce_recommendations), true);
      assert.equal(Array.isArray(changes.recommended_metafields_to_add), true);
      assert.match(JSON.stringify(changes.recommended_metafields_to_add), /custom\.use_case|use_case|audience|faq_summary/);
    }
  },
  {
    name: "enrich sanitizer removes uncertain sections from customer-facing descriptions instead of leaking review text",
    run: async () => {
      const sanitized = sanitizeCustomerFacingDescription({
        title: "Baladna Greek Yogurt Plain 500g",
        description: "",
        description_html: "<h3>Overview</h3><p>Thick and creamy yogurt for breakfasts and cooking.</p><h3>Ingredients Or Composition</h3><p>Exact on-pack ingredients are under review before publishing.</p><h3>Storage Or Handling</h3><p>Keep refrigerated.</p>",
        handle: "baladna-greek-yogurt-plain-500g",
        vendor: "Baladna",
        brand: "Baladna",
        product_type: "Yogurt",
        tags: [],
        ingredients_text: null,
        allergen_note: null,
        nutritional_facts: null,
        metafields: [],
        warnings: [],
        summary: "",
        confidence: 0.8,
        skipped_reasons: []
      });
      assert.match(sanitized.description_html, /Overview/);
      assert.match(sanitized.description_html, /Storage Or Handling/);
      assert.doesNotMatch(sanitized.description_html, /Ingredients Or Composition/);
      assert.equal(sanitized.removedPlaceholderContent, true);
    }
  },
  {
    name: "match detects exact duplicate by SKU",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, { industry: "grocery", businessName: "Test Store" });
      const inputPath = path.join(cwd, "input.json");
      const catalogPath = path.join(cwd, "catalog.json");
      await fs.writeFile(inputPath, JSON.stringify({ title: "Fresh Milk", brand: "Almarai", sku: "ALM-MILK-1L-FC", size: "1L", type: "Full Cream" }, null, 2));
      await fs.writeFile(catalogPath, JSON.stringify([{ id: "prod-1", title: "Fresh Milk", brand: "Almarai", sku: "ALM-MILK-1L-FC", size: "1L", type: "Full Cream" }], null, 2));
      io.text = "";
      const code = await runCli(["match", "--input", inputPath, "--catalog", catalogPath, "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      assert.match(io.text, /DUPLICATE/);
    }
  },
  {
    name: "match treats compact and spaced variant words as the same duplicate",
    run: async () => {
      const policy = buildStarterPolicy({ industry: "food_and_beverage", businessName: "Test Store" });
      const result = runMatchDecision({
        jobId: "job-1",
        input: {
          title: "Almarai Fresh Milk Lowfat 1L",
          brand: "Almarai"
        },
        catalog: [
          {
            id: "prod-1",
            title: "Fresh Milk Low Fat 1L",
            brand: "Almarai"
          }
        ],
        policy
      });
      assert.equal(result.decision, "DUPLICATE");
      assert.equal(result.needs_review, false);
    }
  },
  {
    name: "match does not route different-brand lookalike products to review when only generic category terms overlap",
    run: async () => {
      const policy = buildStarterPolicy({ industry: "electronics", businessName: "Test Store" });
      const result = runMatchDecision({
        jobId: "job-2",
        input: {
          title: "Belkin BoostCharge 45W USB-C Wall Charger White"
        },
        catalog: [
          {
            id: "prod-anker",
            title: "Anker Nano 30W USB-C Wall Charger White"
          }
        ],
        policy
      });
      assert.equal(result.decision, "NEW_PRODUCT");
      assert.equal(result.needs_review, false);
    }
  },
  {
    name: "match infers title-only variant option values for safe new variants",
    run: async () => {
      const policy = buildStarterPolicy({ industry: "electronics", businessName: "Test Store" });
      const result = runMatchDecision({
        jobId: "job-3",
        input: {
          title: "JBL Tune 520BT Wireless On-Ear Headphones Black"
        },
        catalog: [
          {
            id: "prod-jbl",
            title: "JBL Tune 520BT Wireless On-Ear Headphones Blue"
          }
        ],
        policy
      });
      assert.equal(result.decision, "NEW_VARIANT");
      assert.equal(result.proposed_action.action, "attach_as_variant");
      assert.equal(Array.isArray(result.proposed_action.option_values), true);
      assert.equal(result.proposed_action.option_values[0].name, "Color");
      assert.equal(result.proposed_action.option_values[0].value, "Black");
    }
  },
  {
    name: "match treats equivalent unit wording as duplicate when no real variant value exists",
    run: async () => {
      const policy = buildStarterPolicy({ industry: "food_and_beverage", businessName: "Test Store" });
      const result = runMatchDecision({
        jobId: "job-dup-grocery",
        input: {
          title: "Baladna Greek Yogurt Plain 500 Gram"
        },
        catalog: [
          {
            id: "prod-yogurt",
            title: "Baladna Greek Yogurt Plain 500g"
          }
        ],
        policy
      });
      assert.equal(result.decision, "DUPLICATE");
      assert.equal(result.proposed_action.action, "skip_duplicate");
    }
  },
  {
    name: "match blocks new variant when family matched but no shopper-facing option value is available",
    run: async () => {
      const policy = buildStarterPolicy({ industry: "apparel", businessName: "Test Store" });
      const result = runMatchDecision({
        jobId: "job-review-variant",
        input: {
          title: "Uniqlo Club T-Shirt"
        },
        catalog: [
          {
            id: "prod-shirt",
            title: "Uniqlo Club T-Shirt Blue"
          }
        ],
        policy
      });
      assert.equal(result.decision, "NEEDS_REVIEW");
      assert.equal(result.proposed_action.action, "manual_review");
    }
  },
  {
    name: "generated variant product reuses the matched parent handle",
    run: async () => {
      const generated = buildGeneratedProduct(
        {
          id: "shirt-large",
          title: "Uniqlo Club T-Shirt",
          handle: "uniqlo-club-t-shirt-large",
          _catalog_match: {
            decision: "NEW_VARIANT",
            matched_product_handle: "uniqlo-club-t-shirt"
          }
        },
        {
          job_id: "job-generated-variant",
          module: "catalogue-match",
          status: "success",
          needs_review: false,
          proposed_changes: {},
          warnings: [],
          errors: [],
          reasoning: [],
          artifacts: {},
          next_actions: []
        }
      );

      assert.equal(generated.handle, "uniqlo-club-t-shirt");
    }
  },
  {
    name: "live variant attach resolves the parent Shopify product id from generated live state",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, { industry: "apparel", businessName: "Variant Live Resolve Store" });
      await fs.mkdir(path.join(cwd, ".catalog", "generated", "products"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".catalog", "generated", "products", "shirt-parent.json"),
        JSON.stringify({
          id: "shirt-parent",
          title: "Uniqlo Club T-Shirt",
          handle: "uniqlo-club-t-shirt",
          _catalog_apply: {
            status: "applied_live",
            live_result: {
              productId: "gid://shopify/Product/1234567890",
              handle: "uniqlo-club-t-shirt"
            }
          }
        }, null, 2)
      );

      const resolved = await resolveLiveVariantAttachPayload(cwd, {
        attachToProductId: "shirt-parent",
        attachToProductHandle: "uniqlo-club-t-shirt",
        attachToProductTitle: "Uniqlo Club T-Shirt"
      });

      assert.equal(resolved.attachToProductId, "gid://shopify/Product/1234567890");
      assert.equal(resolved.attachToProductHandle, "uniqlo-club-t-shirt");
    }
  },
  {
    name: "match treats retail title synonyms like tee and jogger singular-plural forms as duplicates when identity is otherwise the same",
    run: async () => {
      const policy = buildStarterPolicy({ industry: "apparel", businessName: "Synonym Store" });
      const teeResult = runMatchDecision({
        jobId: "job-tee",
        input: {
          id: "input-tee",
          title: "Uniqlo Oversized Cotton Tee Black Medium",
          price: "29.00"
        },
        catalog: [
          {
            id: "catalog-tee",
            title: "Uniqlo Oversized Cotton T-Shirt Black Medium",
            price: "29.00"
          }
        ],
        policy
      });
      assert.equal(teeResult.decision, "DUPLICATE");

      const joggerResult = runMatchDecision({
        jobId: "job-jogger",
        input: {
          id: "input-jogger",
          title: "Nike Club Fleece Jogger Grey Large",
          price: "65.00"
        },
        catalog: [
          {
            id: "catalog-jogger",
            title: "Nike Club Fleece Joggers Grey Large",
            price: "65.00"
          }
        ],
        policy
      });
      assert.equal(joggerResult.decision, "DUPLICATE");
    }
  },
  {
    name: "image search query uses high quality product image wording and ranks product-like candidates ahead of weak assets",
    run: async () => {
      const query = buildImageSearchQuery({
        title: "Baladna Greek Yogurt Plain 500g"
      });
      assert.equal(query, "\"Baladna Greek Yogurt Plain 500g\" high quality product image");

      const queries = buildImageSearchQueries({
        title: "Baladna Greek Yogurt Plain 500g"
      });
      assert.deepEqual(queries, [
        "\"Baladna Greek Yogurt Plain 500g\" high quality product image",
        "\"Baladna Greek Yogurt Plain 500g\" product packaging front"
      ]);

      const ranked = rankImageCandidates(
        { title: "Baladna Greek Yogurt Plain 500g", brand: "Baladna" },
        [
          {
            url: "https://baladna.com/storage/brand_image/logo.png",
            title: "Greek Style Yoghurt",
            source: "Baladna",
            domain: "baladna.com",
            page_url: "https://baladna.com/product/yoghurt/greek-style-yoghurt",
            position: 1
          },
          {
            url: "https://retailer.example.com/images/baladna-greek-yogurt-plain-500g-front.jpg",
            title: "Baladna Greek Yogurt Plain 500g Product Image",
            source: "Retailer",
            domain: "retailer.example.com",
            page_url: "https://retailer.example.com/products/baladna-greek-yogurt-plain-500g",
            position: 5
          }
        ]
      );

      assert.equal(ranked[0].url, "https://retailer.example.com/images/baladna-greek-yogurt-plain-500g-front.jpg");
    }
  },
  {
    name: "image candidate ranking keeps real product images ahead of brand asset URLs",
    run: async () => {
      const ranked = rankImageCandidates(
        { title: "Acme Protein Bar Chocolate 60g", brand: "Acme" },
        [
          {
            url: "https://acme.example.com/storage/brand_image/protein-bar.png",
            title: "Protein Bar",
            source: "Acme",
            domain: "acme.example.com",
            page_url: "https://acme.example.com/products/protein-bar"
          },
          {
            url: "https://shop.example.com/images/acme-protein-bar-chocolate-60g-front.jpg",
            title: "Acme Protein Bar Chocolate 60g Product Image",
            source: "Retailer",
            domain: "shop.example.com",
            page_url: "https://shop.example.com/products/acme-protein-bar-chocolate-60g"
          }
        ]
      );

      assert.equal(ranked[0].url, "https://shop.example.com/images/acme-protein-bar-chocolate-60g-front.jpg");
    }
  },
  {
    name: "image candidate preflight accepts supported image content types",
    run: async () => {
      const result = await evaluateImageCandidateUrl(
        "https://images.example.com/product/front.jpg",
        async () =>
          new Response(null, {
            status: 200,
            headers: { "content-type": "image/jpeg" }
          })
      );

      assert.equal(result.status, "usable");
      assert.equal(result.contentType, "image/jpeg");
    }
  },
  {
    name: "image candidate preflight rejects non-image content",
    run: async () => {
      const result = await evaluateImageCandidateUrl(
        "https://images.example.com/product/front.jpg",
        async () =>
          new Response("<html></html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          })
      );

      assert.equal(result.status, "unusable");
      assert.match(String(result.reason), /unsupported_content_type/i);
    }
  },
  {
    name: "image candidate preflight keeps uncertain URLs for later review",
    run: async () => {
      let calls = 0;
      const result = await evaluateImageCandidateUrl(
        "https://images.example.com/product/front.jpg",
        async () => {
          calls += 1;
          if (calls === 1) {
            return new Response(null, { status: 403 });
          }
          throw new Error("network timeout");
        }
      );

      assert.equal(result.status, "inconclusive");
      assert.equal(result.reason, "preflight_inconclusive");
    }
  },
  {
    name: "apply can proceed without review when the run does not require it",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, { industry: "grocery", businessName: "Test Store" });
      const inputPath = path.join(cwd, "input.json");
      await fs.writeFile(inputPath, JSON.stringify({ title: "Fresh Milk", brand: "Almarai", size: "1L", type: "Low Fat" }, null, 2));
      io.text = "";
      await runCli(["enrich", "--input", inputPath, "--json"], { cwd, stdout: io, stderr: io });
      const jobId = io.text.match(/"job_id":\s*"([^"]+)"/)[1];
      assert.equal(await runCli(["apply", jobId, "--json"], { cwd, stdout: io, stderr: io }), 0);
      const apply = JSON.parse(await fs.readFile(path.join(cwd, ".catalog", "runs", jobId, "apply.json"), "utf8"));
      assert.equal(apply.status, "applied_local");
      const generatedProducts = await fs.readdir(path.join(cwd, ".catalog", "generated", "products"));
      assert.equal(generatedProducts.length > 0, true);
    }
  },
  {
    name: "live apply stays gated when Shopify provider is not configured",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      const inputPath = path.join(cwd, "input.json");
      await fs.writeFile(inputPath, JSON.stringify({ title: "Fresh Milk", brand: "Almarai" }, null, 2));
      io.text = "";
      await runCli(["sync", "--input", inputPath, "--json"], { cwd, stdout: io, stderr: io });
      const match = io.text.match(/"job_id":\s*"([^"]+)"/);
      assert.ok(match);
      const jobId = match[1];
      assert.equal(await runCli(["apply", jobId, "--live", "--json"], { cwd, stdout: io, stderr: io }), 1);
      assert.match(io.text, /Shopify provider is not ready|Configure the store domain/i);
    }
  },
  {
    name: "learn appends a lesson",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      assert.equal(await runCli(["learn", "--lesson", "Use weight before flavor in grocery titles.", "--json"], { cwd, stdout: io, stderr: io }), 0);
      const learning = await fs.readFile(path.join(cwd, ".catalog", "learning", "catalog-learning.md"), "utf8");
      assert.match(learning, /Use weight before flavor/);
    }
  },
  {
    name: "seeding a guide preserves existing learning content",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await runCli(["learn", "--lesson", "Do not publish customer-facing placeholder text.", "--json"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, { industry: "grocery", businessName: "Learning Store" });
      const learning = await fs.readFile(path.join(cwd, ".catalog", "learning", "catalog-learning.md"), "utf8");
      assert.match(learning, /Do not publish customer-facing placeholder text/);
    }
  },
  {
    name: "batch enrich processes multiple records from a local file",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, { industry: "grocery", businessName: "Test Store" });
      const inputPath = path.join(cwd, "products.json");
      await fs.writeFile(inputPath, JSON.stringify([
        { id: "p1", title: "Fresh Milk", brand: "Almarai", size: "1L" },
        { id: "p2", title: "Greek Yogurt", brand: "Baladna", size: "500g" }
      ], null, 2));
      io.text = "";
      const code = await runCli(["batch", "enrich", "--input", inputPath, "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      const batch = JSON.parse(io.text);
      assert.equal(batch.processed, 2);
      assert.equal(batch.runs.length, 2);
    }
  },
  {
    name: "workflow run processes records and saves durable generated outputs",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, {
        industry: "grocery",
        businessName: "Workflow Store",
        businessDescription: "A grocery store using local files for listings."
      });
      const inputPath = path.join(cwd, "workflow-products.json");
      const catalogPath = path.join(cwd, "workflow-catalog.json");
      await fs.writeFile(inputPath, JSON.stringify([
        {
          id: "p1",
          title: "Fresh Milk Chocolate 1L",
          brand: "Almarai",
          size: "1L",
          type: "Low Fat",
          featured_image: "https://example.com/fresh-milk.jpg",
          images: ["https://example.com/fresh-milk.jpg"],
          metafields: [
            {
              namespace: "custom",
              key: "country_of_origin",
              type: "single_line_text_field",
              value: "Saudi Arabia"
            }
          ]
        }
      ], null, 2));
      await fs.writeFile(catalogPath, JSON.stringify([], null, 2));
      io.text = "";
      const code = await runCli(["workflow", "run", "--input", inputPath, "--catalog", catalogPath, "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      const workflow = JSON.parse(io.text);
      assert.equal(workflow.processed, 1);
      assert.equal(workflow.runs[0].modules.length >= 4, true);
      assert.equal(Number(workflow.runs[0].cost_summary?.estimated_total_cost_usd ?? 0) >= 0, true);
      await fs.access(workflow.runs[0].generated_product_path);
      await fs.access(workflow.runs[0].generated_image_dir);
      const memoryDir = path.join(cwd, ".catalog", "learning", "workflow-memory");
      const memoryFiles = await fs.readdir(memoryDir);
      assert.equal(memoryFiles.length > 0, true);
      const workflowCosts = JSON.parse(await fs.readFile(path.join(cwd, ".catalog", "generated", "workflow-costs.json"), "utf8"));
      assert.equal(workflowCosts.workflow_count, 1);
      assert.equal(Array.isArray(workflowCosts.stages), true);
      const reviewQueue = await fs.readFile(path.join(cwd, ".catalog", "generated", "review-queue.csv"), "utf8");
      assert.match(reviewQueue, /product_key,source_record_id/);
      assert.match(reviewQueue, /p1|fresh-milk/);
      io.text = "";
      await runCli(["review", "bulk", "--action", "approve", "--json"], { cwd, stdout: io, stderr: io });
      const shopifyImport = await fs.readFile(path.join(cwd, ".catalog", "generated", "shopify-import.csv"), "utf8");
      assert.match(shopifyImport, /Title,URL handle,Description,Vendor/);
      assert.match(shopifyImport, /Country Of Origin \(product\.metafields\.custom\.country_of_origin\)/);
      assert.match(shopifyImport, /Fresh Milk Chocolate 1L/);
      assert.match(shopifyImport, /Saudi Arabia/);
      assert.match(shopifyImport, /https:\/\/example\.com\/fresh-milk\.jpg/);
      const excelWorkbookPath = path.join(cwd, ".catalog", "generated", "catalog-review.xlsx");
      const excelWorkbookBuffer = await fs.readFile(excelWorkbookPath);
      const workbook = XLSX.read(excelWorkbookBuffer, { type: "buffer" });
      assert.deepEqual(workbook.SheetNames, ["Runs", "Generated Products", "Images", "Metafields", "Pending Review", "Shopify Import"]);
      const generatedProductsSheet = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["Generated Products"]);
      assert.equal(generatedProductsSheet[0]["Featured Image"], "https://example.com/fresh-milk.jpg");
      assert.match(generatedProductsSheet[0].Metafields, /custom\.country_of_origin=Saudi Arabia/);
      const imageSheet = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["Images"]);
      assert.equal(imageSheet[0]["Selected Image URL"], "https://example.com/fresh-milk.jpg");
      const productJson = JSON.parse(await fs.readFile(workflow.runs[0].generated_product_path, "utf8"));
      assert.ok(productJson._catalog_stage_metrics);
      const metafieldSheet = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["Metafields"]);
      const originMetafield = metafieldSheet.find((row) => row.Namespace === "custom" && row.Key === "country_of_origin");
      assert.ok(originMetafield);
      assert.equal(originMetafield.Value, "Saudi Arabia");
      const shopifyImportSheet = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["Shopify Import"]);
      assert.equal(shopifyImportSheet[0]["Country Of Origin (product.metafields.custom.country_of_origin)"], "Saudi Arabia");
    }
  },
  {
    name: "workflow run accepts pasted text input",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, {
        industry: "grocery",
        businessName: "Text Input Store",
        businessDescription: "A store testing pasted product text."
      });
      const catalogPath = path.join(cwd, "empty-catalog.json");
      await fs.writeFile(catalogPath, "[]");
      io.text = "";
      const code = await runCli([
        "workflow",
        "run",
        "--text",
        "Almarai Fresh Milk Low Fat 1L - 8.50\nBaladna Greek Yogurt Plain 500g - 12.50",
        "--catalog",
        catalogPath,
        "--json"
      ], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      const workflow = JSON.parse(io.text);
      assert.equal(workflow.processed, 2);
      assert.equal(workflow.input, "--text");
    }
  },
  {
    name: "workflow export keeps vendor empty when it is not explicitly generated and still uses default Shopify variant rows",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, {
        industry: "electronics",
        businessName: "Device Store",
        businessDescription: "A store focused on practical device accessories."
      });
      const inputPath = path.join(cwd, "devices.json");
      const catalogPath = path.join(cwd, "devices-catalog.json");
      await fs.writeFile(inputPath, JSON.stringify([
        {
          id: "e1",
          title: "Anker 20W USB-C Charger",
          price: "19.99"
        }
      ], null, 2));
      await fs.writeFile(catalogPath, JSON.stringify([], null, 2));
      io.text = "";
      const code = await runCli(["workflow", "run", "--input", inputPath, "--catalog", catalogPath, "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      io.text = "";
      await runCli(["review", "bulk", "--action", "approve", "--json"], { cwd, stdout: io, stderr: io });
      const generatedProduct = JSON.parse(await fs.readFile(path.join(cwd, ".catalog", "generated", "products", "e1.json"), "utf8"));
      assert.equal(generatedProduct.vendor ?? "", "");
      const workbook = XLSX.read(await fs.readFile(path.join(cwd, ".catalog", "generated", "catalog-review.xlsx")), { type: "buffer" });
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["Shopify Import"]);
      const row = rows[0];
      assert.equal(row["Vendor"], "");
      assert.equal(row["Option1 name"], "Title");
      assert.equal(row["Option1 value"], "Default Title");
      assert.equal(row["Option2 name"], "");
      assert.equal(row["Option3 name"], "");
    }
  },
  {
    name: "workflow excludes match-blocked products from Shopify import export",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, { industry: "grocery", businessName: "Export Gate Store" });
      const inputPath = path.join(cwd, "match-blocked-products.json");
      const catalogPath = path.join(cwd, "match-blocked-catalog.json");
      await fs.writeFile(inputPath, JSON.stringify([
        {
          id: "dup-1",
          title: "Almarai Fresh Milk Lowfat 1L",
          brand: "Almarai",
          price: "8.95",
          featured_image: "https://example.com/milk.jpg",
          images: ["https://example.com/milk.jpg"]
        }
      ], null, 2));
      await fs.writeFile(catalogPath, JSON.stringify([
        {
          id: "prod-1",
          title: "Fresh Milk Low Fat 1L",
          brand: "Almarai"
        }
      ], null, 2));
      io.text = "";
      const code = await runCli(["workflow", "run", "--input", inputPath, "--catalog", catalogPath, "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      io.text = "";
      await runCli(["review", "bulk", "--action", "approve", "--json"], { cwd, stdout: io, stderr: io });
      const shopifyImport = await fs.readFile(path.join(cwd, ".catalog", "generated", "shopify-import.csv"), "utf8");
      assert.doesNotMatch(shopifyImport, /Almarai Fresh Milk Lowfat 1L/);
    }
  },
  {
    name: "workflow keeps one representative row when duplicate inputs collapse to the same product identity",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, { industry: "grocery", businessName: "Representative Store" });
      const inputPath = path.join(cwd, "representative-products.json");
      const catalogPath = path.join(cwd, "representative-catalog.json");
      await fs.writeFile(inputPath, JSON.stringify([
        {
          id: "dup-a",
          title: "Anker 20W USB-C Charger",
          brand: "Anker",
          price: "19.99",
          handle: "anker-20w-usb-c-charger"
        },
        {
          id: "dup-b",
          title: "Anker 20W USB C Charger",
          brand: "Anker",
          price: "19.99",
          handle: "anker-20w-usb-c-charger"
        }
      ], null, 2));
      await fs.writeFile(catalogPath, JSON.stringify([], null, 2));
      io.text = "";
      const code = await runCli(["workflow", "run", "--input", inputPath, "--catalog", catalogPath, "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      io.text = "";
      await runCli(["review", "bulk", "--action", "approve", "--json"], { cwd, stdout: io, stderr: io });
      const shopifyImport = await fs.readFile(path.join(cwd, ".catalog", "generated", "shopify-import.csv"), "utf8");
      const occurrences = (shopifyImport.match(/anker-20w-usb-c-charger/g) ?? []).length;
      assert.equal(occurrences, 1);
      const workflowProducts = JSON.parse(await fs.readFile(path.join(cwd, ".catalog", "generated", "workflow-products.json"), "utf8"));
      assert.equal(workflowProducts.count, 1);
      assert.equal(workflowProducts.products[0].handle, "anker-20w-usb-c-charger");
    }
  },
  {
    name: "workflow match compares later input rows against earlier generated products in the same run",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, { industry: "electronics", businessName: "Sibling Match Store" });
      const inputPath = path.join(cwd, "sibling-duplicates.json");
      const catalogPath = path.join(cwd, "sibling-catalog.json");
      await fs.writeFile(inputPath, JSON.stringify([
        {
          id: "s1",
          title: "Anker 20W USB-C Charger",
          brand: "Anker",
          price: "19.99"
        },
        {
          id: "s2",
          title: "Anker 20W USB C Charger",
          brand: "Anker",
          price: "19.99"
        }
      ], null, 2));
      await fs.writeFile(catalogPath, JSON.stringify([], null, 2));
      io.text = "";
      const code = await runCli(["workflow", "run", "--input", inputPath, "--catalog", catalogPath, "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      const secondProduct = JSON.parse(await fs.readFile(path.join(cwd, ".catalog", "generated", "products", "s2.json"), "utf8"));
      assert.equal(secondProduct._catalog_match.decision, "DUPLICATE");
    }
  },
  {
    name: "workflow stops after match when a row is classified as duplicate",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, { industry: "grocery", businessName: "Duplicate Stop Store" });
      const inputPath = path.join(cwd, "stop-after-match.json");
      const catalogPath = path.join(cwd, "stop-after-match-catalog.json");
      await fs.writeFile(inputPath, JSON.stringify([{ id: "dup-1", title: "Fresh Milk", brand: "Almarai" }], null, 2));
      await fs.writeFile(catalogPath, JSON.stringify([{ id: "catalog-1", title: "Fresh Milk", brand: "Almarai" }], null, 2));
      io.text = "";
      const code = await runCli(["workflow", "run", "--input", inputPath, "--catalog", catalogPath, "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      const workflow = JSON.parse(io.text);
      assert.equal(workflow.runs[0].modules.length, 1);
      assert.equal(workflow.runs[0].modules[0].module, "catalogue-match");
    }
  },
  {
    name: "workflow stops after match when a row is classified as needs review",
    run: async () => {
      assert.equal(shouldSkipAfterMatch({
        id: "review-1",
        title: "Review Candidate",
        _catalog_match: {
          decision: "NEEDS_REVIEW",
          needs_review: true
        }
      }), true);
    }
  },
  {
    name: "workflow export writes parent and attached variant rows under the same Shopify handle",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, { industry: "apparel", businessName: "Variant Export Store" });
      const inputPath = path.join(cwd, "variant-family.json");
      const catalogPath = path.join(cwd, "variant-family-catalog.json");
      await fs.writeFile(inputPath, JSON.stringify([
        {
          id: "shirt-parent",
          title: "Uniqlo Club T-Shirt",
          brand: "Uniqlo",
          vendor: "Uniqlo",
          handle: "uniqlo-club-t-shirt",
          product_type: "T-Shirt",
          description_html: "<h3>Overview</h3><p>Club T-Shirt.</p><h3>Key Product Details</h3><p>Soft cotton.</p><h3>Ingredients Or Composition</h3><p>Cotton.</p><h3>Storage Or Handling</h3><p>Machine wash cold.</p>",
          featured_image: "https://example.com/shirt.jpg",
          images: ["https://example.com/shirt.jpg"],
          size: "Medium",
          price: "29.00"
        },
        {
          id: "shirt-large",
          title: "Uniqlo Club T-Shirt",
          brand: "Uniqlo",
          vendor: "Uniqlo",
          handle: "uniqlo-club-t-shirt-large",
          product_type: "T-Shirt",
          description_html: "<h3>Overview</h3><p>Club T-Shirt.</p><h3>Key Product Details</h3><p>Soft cotton.</p><h3>Ingredients Or Composition</h3><p>Cotton.</p><h3>Storage Or Handling</h3><p>Machine wash cold.</p>",
          featured_image: "https://example.com/shirt.jpg",
          images: ["https://example.com/shirt.jpg"],
          size: "Large",
          price: "29.00"
        }
      ], null, 2));
      await fs.writeFile(catalogPath, JSON.stringify([], null, 2));
      io.text = "";
      const code = await runCli(["workflow", "run", "--input", inputPath, "--catalog", catalogPath, "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      io.text = "";
      await runCli(["review", "bulk", "--action", "approve", "--json"], { cwd, stdout: io, stderr: io });
      const shopifyImport = await fs.readFile(path.join(cwd, ".catalog", "generated", "shopify-import.csv"), "utf8");
      assert.match(shopifyImport, /uniqlo-club-t-shirt/);
      assert.match(shopifyImport, /Medium/);
      assert.match(shopifyImport, /Large/);
    }
  },
  {
    name: "shopify export uses inferred attached variant option names instead of guide default dimensions",
    run: async () => {
      const cwd = await createTempProject();
      const policy = buildStarterPolicy({ industry: "apparel", businessName: "Variant Names Store" });
      await seedGuideFiles(cwd, { industry: "apparel", businessName: "Variant Names Store" });
      await writeShopifyImportCsv(cwd, [
        {
          id: "variant-parent",
          title: "Uniqlo Club T-Shirt",
          handle: "uniqlo-club-t-shirt",
          vendor: "Uniqlo",
          brand: "Uniqlo",
          product_type: "T-Shirts",
          price: "29.00"
        },
        {
          id: "variant-child",
          title: "Uniqlo Club T-Shirt",
          handle: "uniqlo-club-t-shirt-black",
          vendor: "Uniqlo",
          brand: "Uniqlo",
          product_type: "T-Shirts",
          price: "29.00",
          _catalog_match: {
            decision: "NEW_VARIANT",
            needs_review: false,
            matched_product_id: "variant-parent",
            proposed_action: {
              action: "attach_as_variant",
              product_id: "variant-parent",
              product_title: "Uniqlo Club T-Shirt",
              option_values: [
                {
                  name: "color",
                  value: "Black"
                }
              ]
            }
          }
        }
      ], policy);

      const csv = await fs.readFile(path.join(cwd, ".catalog", "generated", "shopify-import.csv"), "utf8");
      const workbook = XLSX.read(csv, { type: "string" });
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets[workbook.SheetNames[0]]);
      const blackRow = rows.find((row) => row["Option1 value"] === "Black");
      assert.ok(blackRow);
      assert.equal(blackRow["Option1 name"], "color");
    }
  },
  {
    name: "shopify export normalizes family title by moving shared variant value out of the base title",
    run: async () => {
      const cwd = await createTempProject();
      const policy = buildStarterPolicy({ industry: "food_and_beverage", businessName: "Family Title Store" });
      await seedGuideFiles(cwd, { industry: "food_and_beverage", businessName: "Family Title Store" });
      await writeShopifyImportCsv(cwd, [
        {
          id: "yogurt-parent",
          title: "Baladna Greek Yogurt Plain 500g",
          handle: "baladna-greek-yogurt-plain-500g",
          vendor: "Baladna",
          brand: "Baladna",
          product_type: "Greek Yogurt",
          price: "12.50"
        },
        {
          id: "yogurt-child",
          title: "Baladna Greek Yogurt Plain 500g",
          vendor: "Baladna",
          brand: "Baladna",
          product_type: "Greek Yogurt",
          price: "12.50",
          _catalog_match: {
            decision: "NEW_VARIANT",
            needs_review: false,
            matched_product_id: "yogurt-parent",
            proposed_action: {
              action: "attach_as_variant",
              product_id: "yogurt-parent",
              product_title: "Baladna Greek Yogurt Plain 500g",
              option_values: [
                {
                  name: "Type",
                  value: "Plain"
                }
              ]
            }
          }
        }
      ], policy);

      const csv = await fs.readFile(path.join(cwd, ".catalog", "generated", "shopify-import.csv"), "utf8");
      const workbook = XLSX.read(csv, { type: "string" });
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets[workbook.SheetNames[0]]);
      assert.equal(rows[0]["Title"], "Baladna Greek Yogurt 500g");
      assert.equal(rows[0]["Option1 value"], "Plain");
    }
  },
  {
    name: "qa does not fail omitted compliance sections when high-risk facts are intentionally skipped",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, {
        industry: "food_and_beverage",
        businessName: "Safe Omission Store",
        businessDescription: "A store validating skipped high-risk facts do not force QA failure."
      });

      const inputPath = path.join(cwd, "safe-omission-product.json");
      await fs.writeFile(inputPath, JSON.stringify({
        id: "safe-omit-1",
        title: "Baladna Greek Yogurt Plain 500g",
        handle: "baladna-greek-yogurt-plain-500g",
        vendor: "Baladna",
        brand: "Baladna",
        product_type: "Greek Yogurt",
        description_html: "<h3>Overview</h3><p>Greek-style plain yogurt.</p><h3>Key Product Details</h3><p>500g refrigerated tub.</p>",
        featured_image: "https://example.com/yogurt.jpg",
        images: ["https://example.com/yogurt.jpg"],
        price: "12.50"
      }, null, 2));

      io.text = "";
      const code = await runCli(["qa", "--input", inputPath, "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      const output = JSON.parse(io.text);
      const findings = output.result?.proposed_changes?.qa_findings ?? [];
      assert.equal(findings.some((finding: { field?: string; expected?: string }) => finding.field === "description_html" && /Ingredients Or Composition/i.test(String(finding.expected ?? ""))), false);
      assert.equal(findings.some((finding: { field?: string }) => /custom\.(ingredients_text|allergens|nutrition_facts|nutritional_facts)/i.test(String(finding.field ?? ""))), false);
    }
  },
  {
    name: "review queue and bulk review work on workflow outputs",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, { industry: "grocery", businessName: "Queue Store" });
      const inputPath = path.join(cwd, "queue-products.json");
      const catalogPath = path.join(cwd, "queue-catalog.json");
      await fs.writeFile(inputPath, JSON.stringify([{ id: "p1", title: "Fresh Milk", brand: "Almarai", price: "8.95" }], null, 2));
      await fs.writeFile(catalogPath, JSON.stringify([], null, 2));
      io.text = "";
      await runCli(["workflow", "run", "--input", inputPath, "--catalog", catalogPath, "--json"], { cwd, stdout: io, stderr: io });
      io.text = "";
      const queueCode = await runCli(["review", "queue", "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(queueCode, 0);
      const queue = JSON.parse(io.text);
      assert.equal(queue.count > 0, true);
      const workbookBefore = XLSX.read(await fs.readFile(path.join(cwd, ".catalog", "generated", "catalog-review.xlsx")), { type: "buffer" });
      const pendingBefore = XLSX.utils.sheet_to_json<Record<string, string>>(workbookBefore.Sheets["Pending Review"]);
      assert.equal(pendingBefore.length > 0, true);
      io.text = "";
      const bulkCode = await runCli(["review", "bulk", "--action", "approve", "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(bulkCode, 0);
      const bulk = JSON.parse(io.text);
      assert.equal(bulk.count > 0, true);
      io.text = "";
      const queueAfterCode = await runCli(["review", "queue", "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(queueAfterCode, 0);
      const queueAfter = JSON.parse(io.text);
      assert.equal(queueAfter.count, 0);
      const workbookAfter = XLSX.read(await fs.readFile(path.join(cwd, ".catalog", "generated", "catalog-review.xlsx")), { type: "buffer" });
      const pendingAfter = XLSX.utils.sheet_to_json<Record<string, string>>(workbookAfter.Sheets["Pending Review"]);
      assert.equal(pendingAfter.length, 0);
      const shopifyImport = await fs.readFile(path.join(cwd, ".catalog", "generated", "shopify-import.csv"), "utf8");
      assert.match(shopifyImport, /Title,URL handle,Description,Vendor/);
    }
  },
  {
    name: "qa does not fail required body_html when description_html is present",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, {
        industry: "apparel",
        businessName: "QA Alias Store",
        businessDescription: "A store validating description field aliases."
      });

      const inputPath = path.join(cwd, "qa-alias-product.json");
      await fs.writeFile(inputPath, JSON.stringify({
        id: "qa-alias-1",
        title: "Uniqlo Club T-Shirt",
        handle: "uniqlo-club-t-shirt",
        vendor: "Uniqlo",
        brand: "Uniqlo",
        product_type: "T-Shirts",
        description_html: "<h3>Overview</h3><p>Everyday cotton t-shirt.</p><h3>Key Features</h3><p>Soft and breathable.</p><h3>Material And Fit</h3><p>100% cotton with a regular fit.</p><h3>Care Or Usage</h3><p>Machine wash cold.</p>",
        featured_image: "https://example.com/shirt.jpg",
        images: ["https://example.com/shirt.jpg"],
        price: "29.00"
      }, null, 2));

      io.text = "";
      const code = await runCli(["qa", "--input", inputPath, "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(code, 0);
      const output = JSON.parse(io.text);
      const findings = output.result?.proposed_changes?.qa_findings ?? [];
      assert.equal(findings.some((finding: { field?: string; issue_type?: string }) => finding.field === "body_html" && finding.issue_type === "missing"), false);
    }
  },
  {
    name: "provider QA findings drop body_html missing errors when description_html is already populated",
    run: async () => {
      const sanitized = sanitizeProviderEvaluationAgainstInput(
        {
          description_html: "<p>Ready</p>"
        },
        {
          score: 75,
          status: "FAIL",
          confidence: 0.9,
          summary: {
            critical_issues: 1,
            major_issues: 0,
            minor_issues: 0
          },
          findings: [
            {
              field: "body_html",
              issue_type: "missing_required_field",
              severity: "critical",
              message: "Required Shopify field body_html is missing.",
              expected: "A populated body_html field.",
              actual: "description_html present instead.",
              deduction: 25
            }
          ],
          skipped_reasons: []
        }
      );
      assert.equal(sanitized.findings.length, 0);
      assert.equal(sanitized.score, 100);
      assert.equal(sanitized.summary.critical_issues, 0);
    }
  },
  {
    name: "publish applies latest sync runs only when QA passed and sync is safe",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, { industry: "grocery", businessName: "Publish Store" });
      const inputPath = path.join(cwd, "publish-products.json");
      await fs.writeFile(inputPath, JSON.stringify({
        id: "p1",
        title: "Almarai Fresh Milk Low Fat 1L",
        handle: "almarai-fresh-milk-low-fat-1l",
        vendor: "Almarai",
        brand: "Almarai",
        product_type: "Milk",
        description_html: "<h3>Overview</h3><p>Fresh milk.</p><h3>Key Product Details</h3><p>1L low fat milk.</p><h3>Ingredients Or Composition</h3><p>Milk.</p><h3>Storage Or Handling</h3><p>Keep refrigerated.</p>",
        featured_image: "https://example.com/milk.jpg",
        images: ["https://example.com/milk.jpg"],
        price: "8.95",
        qa_status: "PASS",
        qa_score: 98
      }, null, 2));
      io.text = "";
      const syncCode = await runCli(["sync", "--input", inputPath, "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(syncCode, 0);
      io.text = "";
      const publishCode = await runCli(["publish", "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(publishCode, 0);
      const publish = JSON.parse(io.text);
      assert.equal(publish.published >= 1, true);
    }
  },
  {
    name: "publish skips sync runs blocked by catalogue-match",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await seedGuideFiles(cwd, { industry: "grocery", businessName: "Publish Match Gate Store" });
      const inputPath = path.join(cwd, "publish-match-blocked.json");
      await fs.writeFile(inputPath, JSON.stringify({
        id: "p1",
        title: "Almarai Fresh Milk Lowfat 1L",
        handle: "almarai-fresh-milk-lowfat-1l",
        vendor: "Almarai",
        brand: "Almarai",
        product_type: "Milk",
        description_html: "<h3>Overview</h3><p>Fresh milk.</p>",
        featured_image: "https://example.com/milk.jpg",
        images: ["https://example.com/milk.jpg"],
        price: "8.95",
        qa_status: "PASS",
        qa_score: 98,
        _catalog_match: {
          decision: "DUPLICATE",
          needs_review: false
        }
      }, null, 2));
      io.text = "";
      const syncCode = await runCli(["sync", "--input", inputPath, "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(syncCode, 0);
      io.text = "";
      const publishCode = await runCli(["publish", "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(publishCode, 0);
      const publish = JSON.parse(io.text);
      assert.equal(publish.published, 0);
      assert.match(JSON.stringify(publish.skipped), /DUPLICATE/);
    }
  }
];

let failures = 0;
for (const current of tests) {
  try {
    await current.run();
    console.log(`PASS ${current.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${current.name}`);
    console.error(error);
  }
}

if (failures > 0) {
  process.exit(1);
}

console.log(`PASS ${tests.length} tests`);
