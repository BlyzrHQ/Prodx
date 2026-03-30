import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { runCli } from "../dist/cli.js";
import { buildShopifyPayload } from "../dist/connectors/shopify.js";
import { buildStarterPolicy } from "../dist/lib/policy-template.js";
import { shouldUseWebVerification } from "../dist/modules/enrich.js";
import { loadRecordsFromSource } from "../dist/modules/ingest.js";
import { runMatchDecision } from "../dist/modules/match.js";

async function createTempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), "catalog-toolkit-"));
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
    name: "expert generate creates policy files",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
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
      const policy = JSON.parse(await fs.readFile(path.join(cwd, ".catalog", "policy", "catalog-policy.json"), "utf8"));
      assert.equal(policy.meta.business_name, "Test Store");
      assert.equal(policy.meta.business_description, "A grocery business focused on fresh dairy products.");
      assert.equal(policy.meta.operating_mode, "both");
      assert.equal(Array.isArray(policy.taxonomy_design.hierarchy), true);
      assert.equal(Array.isArray(policy.product_description_system.structure_template), true);
      assert.equal(Array.isArray(policy.automation_playbook.fully_automated), true);
      assert.equal(typeof policy.qa_validation_system.passing_score, "number");
    }
  },
  {
    name: "guide alias can generate and show the Catalog Guide",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      io.text = "";
      const generateCode = await runCli([
        "guide",
        "generate",
        "--industry",
        "electronics",
        "--business-name",
        "Guide Store",
        "--business-description",
        "A store selling practical consumer electronics.",
        "--json"
      ], { cwd, stdout: io, stderr: io });
      assert.equal(generateCode, 0);
      const guide = JSON.parse(await fs.readFile(path.join(cwd, ".catalog", "policy", "catalog-policy.json"), "utf8"));
      assert.equal(guide.meta.industry, "electronics");
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
    name: "qa fails when customer-facing description contains review placeholder text",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await runCli(["guide", "generate", "--industry", "grocery", "--business-name", "QA Store", "--json"], { cwd, stdout: io, stderr: io });
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
    name: "match detects exact duplicate by SKU",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await runCli(["expert", "generate", "--industry", "grocery", "--business-name", "Test Store", "--json"], { cwd, stdout: io, stderr: io });
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
    name: "apply can proceed without review when the run does not require it",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await runCli(["expert", "generate", "--industry", "grocery", "--business-name", "Test Store", "--json"], { cwd, stdout: io, stderr: io });
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
    name: "expert generate preserves existing learning content",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await runCli(["learn", "--lesson", "Do not publish customer-facing placeholder text.", "--json"], { cwd, stdout: io, stderr: io });
      io.text = "";
      await runCli(["guide", "generate", "--industry", "grocery", "--business-name", "Learning Store", "--json"], { cwd, stdout: io, stderr: io });
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
      await runCli(["expert", "generate", "--industry", "grocery", "--business-name", "Test Store", "--json"], { cwd, stdout: io, stderr: io });
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
      await runCli([
        "expert",
        "generate",
        "--industry",
        "grocery",
        "--business-name",
        "Workflow Store",
        "--business-description",
        "A grocery store using local files for listings.",
        "--json"
      ], { cwd, stdout: io, stderr: io });
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
      await fs.access(workflow.runs[0].generated_product_path);
      await fs.access(workflow.runs[0].generated_image_dir);
      const reviewQueue = await fs.readFile(path.join(cwd, ".catalog", "generated", "review-queue.csv"), "utf8");
      assert.match(reviewQueue, /product_key,source_record_id/);
      assert.match(reviewQueue, /p1|fresh-milk/);
      const shopifyImport = await fs.readFile(path.join(cwd, ".catalog", "generated", "shopify-import.csv"), "utf8");
      assert.match(shopifyImport, /Title,Handle,Body \(HTML\),Vendor/);
      assert.match(shopifyImport, /Country Of Origin \(product\.metafields\.custom\.country_of_origin\)/);
      assert.match(shopifyImport, /Fresh Milk Chocolate 1L/);
      assert.match(shopifyImport, /Saudi Arabia/);
      assert.match(shopifyImport, /https:\/\/example\.com\/fresh-milk\.jpg/);
      const excelWorkbookPath = path.join(cwd, ".catalog", "generated", "catalog-review.xlsx");
      const excelWorkbookBuffer = await fs.readFile(excelWorkbookPath);
      const workbook = XLSX.read(excelWorkbookBuffer, { type: "buffer" });
      assert.deepEqual(workbook.SheetNames, ["Runs", "Generated Products", "Images", "Metafields", "Shopify Import"]);
      const generatedProductsSheet = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["Generated Products"]);
      assert.equal(generatedProductsSheet[0]["Featured Image"], "https://example.com/fresh-milk.jpg");
      assert.match(generatedProductsSheet[0].Metafields, /custom\.country_of_origin=Saudi Arabia/);
      const imageSheet = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["Images"]);
      assert.equal(imageSheet[0]["Selected Image URL"], "https://example.com/fresh-milk.jpg");
      const metafieldSheet = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["Metafields"]);
      const originMetafield = metafieldSheet.find((row) => row.Namespace === "custom" && row.Key === "country_of_origin");
      assert.ok(originMetafield);
      assert.equal(originMetafield.Value, "Saudi Arabia");
      const shopifyImportSheet = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["Shopify Import"]);
      assert.equal(shopifyImportSheet[0]["Country Of Origin (product.metafields.custom.country_of_origin)"], "Saudi Arabia");
    }
  },
  {
    name: "workflow export keeps vendor empty when it is not explicitly generated and still uses default Shopify variant rows",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await runCli([
        "guide",
        "generate",
        "--industry",
        "electronics",
        "--business-name",
        "Device Store",
        "--business-description",
        "A store focused on practical device accessories.",
        "--json"
      ], { cwd, stdout: io, stderr: io });
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
      const generatedProduct = JSON.parse(await fs.readFile(path.join(cwd, ".catalog", "generated", "products", "e1.json"), "utf8"));
      assert.equal(generatedProduct.vendor ?? "", "");
      const workbook = XLSX.read(await fs.readFile(path.join(cwd, ".catalog", "generated", "catalog-review.xlsx")), { type: "buffer" });
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["Shopify Import"]);
      const row = rows[0];
      assert.equal(row["Vendor"], "");
      assert.equal(row["Option1 Name"], "Title");
      assert.equal(row["Option1 Value"], "Default Title");
      assert.equal(row["Option2 Name"], "");
      assert.equal(row["Option3 Name"], "");
    }
  },
  {
    name: "workflow excludes match-blocked products from Shopify import export",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await runCli(["guide", "generate", "--industry", "grocery", "--business-name", "Export Gate Store", "--json"], { cwd, stdout: io, stderr: io });
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
      await runCli(["guide", "generate", "--industry", "grocery", "--business-name", "Representative Store", "--json"], { cwd, stdout: io, stderr: io });
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
      await runCli(["guide", "generate", "--industry", "electronics", "--business-name", "Sibling Match Store", "--json"], { cwd, stdout: io, stderr: io });
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
    name: "review queue and bulk review work on workflow outputs",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await runCli(["expert", "generate", "--industry", "grocery", "--business-name", "Queue Store", "--json"], { cwd, stdout: io, stderr: io });
      const inputPath = path.join(cwd, "queue-products.json");
      const catalogPath = path.join(cwd, "queue-catalog.json");
      await fs.writeFile(inputPath, JSON.stringify([{ id: "p1", title: "Fresh Milk", brand: "Almarai" }], null, 2));
      await fs.writeFile(catalogPath, JSON.stringify([{ id: "prod-100", title: "Fresh Milk", brand: "Almarai" }], null, 2));
      io.text = "";
      await runCli(["workflow", "run", "--input", inputPath, "--catalog", catalogPath, "--json"], { cwd, stdout: io, stderr: io });
      io.text = "";
      const queueCode = await runCli(["review", "queue", "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(queueCode, 0);
      const queue = JSON.parse(io.text);
      assert.equal(queue.count > 0, true);
      io.text = "";
      const bulkCode = await runCli(["review", "bulk", "--action", "approve", "--json"], { cwd, stdout: io, stderr: io });
      assert.equal(bulkCode, 0);
      const bulk = JSON.parse(io.text);
      assert.equal(bulk.count > 0, true);
    }
  },
  {
    name: "publish applies latest sync runs only when QA passed and sync is safe",
    run: async () => {
      const cwd = await createTempProject();
      const io = writer();
      await runCli(["init", "--json", "--no-wizard"], { cwd, stdout: io, stderr: io });
      await runCli(["guide", "generate", "--industry", "grocery", "--business-name", "Publish Store", "--json"], { cwd, stdout: io, stderr: io });
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
      await runCli(["guide", "generate", "--industry", "grocery", "--business-name", "Publish Match Gate Store", "--json"], { cwd, stdout: io, stderr: io });
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
