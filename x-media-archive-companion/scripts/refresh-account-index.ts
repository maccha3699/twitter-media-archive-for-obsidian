import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ArchiveImporter } from "../src/importer.ts";

function args(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < values.length; index++) {
    if (!values[index].startsWith("--")) throw new Error(`unexpected argument: ${values[index]}`);
    out[values[index].slice(2)] = values[++index];
  }
  return out;
}

export async function refreshAccountIndex(vaultBase: string, vaultRoot = "XMediaArchive"): Promise<number> {
  if (!path.isAbsolute(vaultBase)) throw new Error("--vault-base must be absolute");
  return new ArchiveImporter().refreshExistingAccounts(path.resolve(vaultBase), vaultRoot);
}

async function main(): Promise<void> {
  const arg = args(process.argv.slice(2));
  if (!arg["vault-base"]) throw new Error("--vault-base is required");
  console.log(JSON.stringify({ refreshed: await refreshAccountIndex(arg["vault-base"], arg["vault-root"]) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
