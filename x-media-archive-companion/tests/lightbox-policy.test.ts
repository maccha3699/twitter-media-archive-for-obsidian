import assert from "node:assert/strict";
import test from "node:test";
import { isPlainPrimaryActivation, localLightboxUrl } from "../src/lightbox-policy.ts";

const plain = { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };

test("only a plain left click is consumed by image focus", () => {
  assert.equal(isPlainPrimaryActivation(plain), true);
  assert.equal(isPlainPrimaryActivation({ ...plain, button: 1 }), false);
  for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"] as const) {
    assert.equal(isPlainPrimaryActivation({ ...plain, [modifier]: true }), false, modifier);
  }
});

test("lightbox accepts local Obsidian resources without inventing a network request", () => {
  assert.equal(localLightboxUrl("app://obsidian.md/vault/image.jpg"), "app://obsidian.md/vault/image.jpg");
  assert.equal(localLightboxUrl("file:///C:/vault/image.jpg"), "file:///C:/vault/image.jpg");
  assert.equal(localLightboxUrl("blob:local-preview"), "blob:local-preview");
  assert.equal(localLightboxUrl("data:image/gif;base64,R0lGODlhAQABAAAAACw="), "data:image/gif;base64,R0lGODlhAQABAAAAACw=");
});

test("lightbox rejects remote, relative, empty, and malformed sources", () => {
  assert.equal(localLightboxUrl("https://example.com/image.jpg"), null);
  assert.equal(localLightboxUrl("http://example.com/image.jpg"), null);
  assert.equal(localLightboxUrl("../image.jpg", "", null), null);
  assert.equal(localLightboxUrl("not a URL"), null);
});

test("lightbox source selection skips unsafe candidates and uses the first local one", () => {
  assert.equal(
    localLightboxUrl("https://example.com/image.jpg", "app://obsidian.md/vault/image.jpg", "file:///later.jpg"),
    "app://obsidian.md/vault/image.jpg",
  );
});
