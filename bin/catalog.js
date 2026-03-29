#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, "..", "dist", "cli.js");

if (!fs.existsSync(cliPath)) {
  console.error("The compiled CLI was not found. Run `npm run build` first.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  stdio: "inherit"
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
