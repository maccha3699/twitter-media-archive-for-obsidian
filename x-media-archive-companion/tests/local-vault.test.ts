import assert from "node:assert/strict";
import test from "node:test";
import { localVaultBasePath } from "../src/local-vault.ts";
import { DEFAULT_SETTINGS } from "../src/types.ts";

test("uses the desktop adapter capability without relying on class identity", () => {
  const crossRealmLikeAdapter = { getBasePath: () => "C:\\Vault" };
  assert.equal(localVaultBasePath(crossRealmLikeAdapter), "C:\\Vault");
});

test("rejects non-filesystem and invalid local adapters", () => {
  assert.throws(() => localVaultBasePath({}), /local filesystem vault/);
  assert.throws(() => localVaultBasePath({ getBasePath: () => "" }), /invalid local vault path/);
});

test("default archive root is top-level and separate from SaveXPost", () => {
  assert.equal(DEFAULT_SETTINGS.vaultRoot, "XMediaArchive");
  assert.doesNotMatch(DEFAULT_SETTINGS.vaultRoot, /^Tweets(?:\/|$)/);
});
