import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function files(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
}
test("source has no HTTP, Obsidian request, or X authentication APIs", async () => {
  const sourceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
  const source = await Promise.all((await files(sourceDirectory)).map((file) => fs.readFile(file, "utf8")));
  const combined = source.join("\n");
  assert.doesNotMatch(combined, /\b(?:fetch|requestUrl)\s*\(|new\s+(?:XMLHttpRequest|WebSocket)\b|https?:\/\//i);
  assert.doesNotMatch(combined, /\bheaders\s*:\s*\{[^}]*\bAuthorization\b/i);
});
