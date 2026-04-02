import { getCredential } from "./credentials.js";
import { loadRuntimeConfig } from "./runtime.js";
import type { ResolvedProvider } from "../types.js";

export async function resolveProvider(root: string, moduleName: string, slotName: string): Promise<ResolvedProvider | null> {
  const runtime = await loadRuntimeConfig(root);
  const alias = runtime.modules?.[moduleName]?.[slotName];
  if (!alias) {
    return null;
  }

  const provider = runtime.providers?.[alias];
  if (!provider) {
    throw new Error(`Provider alias '${alias}' is not defined in runtime.json.`);
  }

  const credentialAlias = provider.credential;
  const credential = credentialAlias ? await getCredential(credentialAlias, root) : null;

  return {
    alias,
    providerAlias: alias,
    provider,
    credential,
    runtime
  };
}

export function requireResolvedCredential(resolved: ResolvedProvider | null, description: string): string {
  if (!resolved?.credential?.value) {
    throw new Error(`Missing credential for ${description}. Configure it with \`catalog auth set --provider ${resolved?.provider?.credential ?? "provider"}\`.`);
  }
  return resolved.credential.value;
}
