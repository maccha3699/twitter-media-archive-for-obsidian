import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorRegistry, resolveAuthorFolder } from "../lib/author_registry.js";

test("author ID keeps its first screen name folder and records later names", () => {
  const first = resolveAuthorFolder(createAuthorRegistry(), { id: "100", screenName: "Alice" });
  const renamed = resolveAuthorFolder(first.registry, { id: "100", screenName: "AliceNew" });
  assert.equal(first.folderName, "Alice");
  assert.equal(renamed.folderName, "Alice");
  assert.deepEqual(renamed.registry.authors["id:100"].screenNames, ["Alice", "AliceNew"]);
  assert.deepEqual(createAuthorRegistry(), { schemaVersion: 1, authors: {} });
});

test("a provisional screen-name identity is adopted once its ID is known", () => {
  const provisional = resolveAuthorFolder(createAuthorRegistry(), { screenName: "Alice" });
  const resolved = resolveAuthorFolder(provisional.registry, { id: "100", screenName: "alice" });
  assert.equal(provisional.folderName, "Alice");
  assert.equal(resolved.folderName, "Alice");
  assert.equal(resolved.registry.authors["screen:alice"], undefined);
  assert.equal(resolved.registry.authors["id:100"].authorId, "100");
});

test("different IDs with the same initial screen name receive a stable suffix", () => {
  const first = resolveAuthorFolder(createAuthorRegistry(), { id: "111111111", screenName: "Alice" });
  const second = resolveAuthorFolder(first.registry, { id: "222222222", screenName: "Alice" });
  assert.equal(first.folderName, "Alice");
  assert.equal(second.folderName, "Alice--22222222");
});
