import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli } from "../dist/cli.js";

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

test("init creates .catalog structure and runtime config", async () => {
  const cwd = await createTempProject();
  const io = writer();
  const code = await runCli(["init"], { cwd, stdout: io, stderr: io });
  assert.equal(code, 0);
  const runtime = JSON.parse(await fs.readFile(path.join(cwd, ".catalog", "config", "runtime.json"), "utf8"));
  assert.equal(runtime.providers.openai_default.type, "openai");
});

test("expert generate creates policy files", async () => {
  const cwd = await createTempProject();
  const io = writer();
  await runCli(["init"], { cwd, stdout: io, stderr: io });
  const code = await runCli(["expert", "generate", "--industry", "grocery", "--business-name", "Test Store"], { cwd, stdout: io, stderr: io });
  assert.equal(code, 0);
  const policy = JSON.parse(await fs.readFile(path.join(cwd, ".catalog", "policy", "catalog-policy.json"), "utf8"));
  assert.equal(policy.meta.business_name, "Test Store");
});

test("match detects exact duplicate by SKU", async () => {
  const cwd = await createTempProject();
  const io = writer();
  await runCli(["init"], { cwd, stdout: io, stderr: io });
  await runCli(["expert", "generate", "--industry", "grocery", "--business-name", "Test Store"], { cwd, stdout: io, stderr: io });
  const inputPath = path.join(cwd, "input.json");
  const catalogPath = path.join(cwd, "catalog.json");
  await fs.writeFile(inputPath, JSON.stringify({ title: "Fresh Milk", brand: "Almarai", sku: "ALM-MILK-1L-FC", size: "1L", type: "Full Cream" }, null, 2));
  await fs.writeFile(catalogPath, JSON.stringify([{ id: "prod-1", title: "Fresh Milk", brand: "Almarai", sku: "ALM-MILK-1L-FC", size: "1L", type: "Full Cream" }], null, 2));
  io.text = "";
  const code = await runCli(["match", "--input", inputPath, "--catalog", catalogPath], { cwd, stdout: io, stderr: io });
  assert.equal(code, 0);
  assert.match(io.text, /DUPLICATE/);
});

test("review and apply create decision and apply artifacts", async () => {
  const cwd = await createTempProject();
  const io = writer();
  await runCli(["init"], { cwd, stdout: io, stderr: io });
  await runCli(["expert", "generate", "--industry", "grocery", "--business-name", "Test Store"], { cwd, stdout: io, stderr: io });
  const inputPath = path.join(cwd, "input.json");
  await fs.writeFile(inputPath, JSON.stringify({ title: "Fresh Milk", brand: "Almarai", size: "1L", type: "Low Fat" }, null, 2));
  io.text = "";
  await runCli(["enrich", "--input", inputPath], { cwd, stdout: io, stderr: io });
  const jobId = io.text.match(/"job_id":\s*"([^"]+)"/)[1];
  assert.equal(await runCli(["review", jobId, "--action", "approve"], { cwd, stdout: io, stderr: io }), 0);
  assert.equal(await runCli(["apply", jobId], { cwd, stdout: io, stderr: io }), 0);
  const apply = JSON.parse(await fs.readFile(path.join(cwd, ".catalog", "runs", jobId, "apply.json"), "utf8"));
  assert.equal(apply.status, "applied_local");
});

test("learn appends a lesson", async () => {
  const cwd = await createTempProject();
  const io = writer();
  await runCli(["init"], { cwd, stdout: io, stderr: io });
  assert.equal(await runCli(["learn", "--lesson", "Use weight before flavor in grocery titles."], { cwd, stdout: io, stderr: io }), 0);
  const learning = await fs.readFile(path.join(cwd, ".catalog", "learning", "catalog-learning.md"), "utf8");
  assert.match(learning, /Use weight before flavor/);
});
