import assert from "node:assert/strict";
import test from "node:test";
import { AspectRatioCache } from "../src/aspect-cache.ts";

test("a remembered shape comes back clamped", () => {
  const cache = new AspectRatioCache(10, 0.55, 1.6);
  assert.equal(cache.get("a.jpg"), null, "an unseen image has no shape yet");
  cache.set("a.jpg", 1000, 1500);
  assert.equal(cache.get("a.jpg"), 1.5);
  cache.set("wide.jpg", 4000, 400);
  assert.equal(cache.get("wide.jpg"), 0.55);
  cache.set("tall.jpg", 400, 4000);
  assert.equal(cache.get("tall.jpg"), 1.6);
});

test("dimensions a browser never produced are ignored", () => {
  // naturalWidth is 0 until the image decodes, and recording that would reserve
  // a zero-height tile for the rest of the session.
  const cache = new AspectRatioCache();
  cache.set("pending.jpg", 0, 0);
  cache.set("broken.jpg", Number.NaN, 100);
  cache.set("negative.jpg", -10, 100);
  assert.equal(cache.get("pending.jpg"), null);
  assert.equal(cache.get("broken.jpg"), null);
  assert.equal(cache.get("negative.jpg"), null);
});

test("the cache stays bounded and drops what was looked at longest ago", () => {
  const cache = new AspectRatioCache(3);
  cache.set("a", 100, 100); cache.set("b", 100, 100); cache.set("c", 100, 100);
  cache.get("a");                       // a is now the most recently used
  cache.set("d", 100, 100);             // evicts b
  assert.equal(cache.get("b"), null);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 1);
  assert.equal(cache.get("d"), 1);
});
