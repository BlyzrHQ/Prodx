import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { runCli } from "../dist/cli.js";
import { buildShopifyPayload } from "../dist/connectors/shopify.js";
import { buildStarterPolicy } from "../dist/lib/policy-template.js";

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
      assert.equal(Array.isArray(policy.attributes_metafields_schema.metafields), true);
      assert.equal(typeof policy.attributes_metafields_schema.metafields[0].namespace, "string");
      assert.equal(Array.isArray(policy.attributes_metafields_schema.fill_rules), true);
    }
  },
  {
    name: "shopify payload carries selected image URLs",
    run: async () => {
      const payload = buildShopifyPayload({
        title: "Fresh Milk",
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
    name: "review and apply create decision and apply artifacts",
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
      assert.equal(await runCli(["review", jobId, "--action", "approve", "--json"], { cwd, stdout: io, stderr: io }), 0);
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
      assert.equal(await runCli(["review", jobId, "--action", "approve", "--json"], { cwd, stdout: io, stderr: io }), 0);
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
          title: "Fresh Milk",
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
      await fs.writeFile(catalogPath, JSON.stringify([
        { id: "prod-100", title: "Fresh Milk", brand: "Almarai", size: "1L", type: "Full Cream" }
      ], null, 2));
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
      assert.match(shopifyImport, /Fresh Milk/);
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
      assert.equal(metafieldSheet[0].Namespace, "custom");
      assert.equal(metafieldSheet[0].Key, "country_of_origin");
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
