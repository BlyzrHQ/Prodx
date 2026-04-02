import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli } from "../dist/cli.js";
import { loadOpenAICodexAuthSession } from "../dist/lib/credentials.js";

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

test("auth set stores provider model when requested", async () => {
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
});

test("loadOpenAICodexAuthSession returns null when no API key is present", async () => {
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
});

test("auth login openai imports local Codex API key and updates model", async () => {
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
    const credentialsPath = path.join(tempHome, ".catalog-toolkit", "credentials.json");
    const credentials = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
    assert.equal(runtime.providers.openai_default.model, "gpt-5");
    assert.equal(credentials.openai.value, "sk-from-codex");
    assert.equal(credentials.openai.source, "oauth");
  } finally {
    process.env.USERPROFILE = originalUserProfile;
    process.env.HOME = originalHome;
  }
});
