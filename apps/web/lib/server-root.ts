import path from "node:path";

export function getProjectRoot(): string {
  return path.resolve(process.cwd(), "../..");
}
