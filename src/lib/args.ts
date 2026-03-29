import type { ParsedArgs } from "../types.js";

export function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  while (args.length > 0) {
    const token = args.shift();
    if (!token) continue;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    if (body.includes("=")) {
      const [key, ...rest] = body.split("=");
      flags[key] = rest.join("=");
      continue;
    }

    const next = args[0];
    if (!next || next.startsWith("--")) {
      flags[body] = true;
    } else {
      flags[body] = args.shift();
    }
  }

  return { positional, flags };
}

export function requireFlag(flags: Record<string, string | boolean>, name: string, message?: string): string {
  const value = flags[name];
  if (value === undefined || value === null || value === "" || typeof value !== "string") {
    throw new Error(message ?? `Missing required flag --${name}`);
  }
  return value;
}
