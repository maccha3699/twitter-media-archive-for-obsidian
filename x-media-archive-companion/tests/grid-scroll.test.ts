import assert from "node:assert/strict";
import test from "node:test";
import { GridScrollMemory, gridScrollKey, scrollTopForViewportOffset } from "../src/grid-scroll.ts";

test("returning to a folder restores the offset it was left at", () => {
  const memory = new GridScrollMemory();
  // Browsing the account list downwards.
  assert.equal(memory.observe({ key: "folder:XMediaArchive/_accounts", scrollTop: 0 }), 0, "first sight restores nothing");
  assert.equal(memory.observe({ key: "folder:XMediaArchive/_accounts", scrollTop: 1400 }), null, "same folder only records");

  // Stepping into an author folder renders at the top.
  assert.equal(memory.observe({ key: "folder:XMediaArchive/noco916", scrollTop: 0 }), 0);
  assert.equal(memory.observe({ key: "folder:XMediaArchive/noco916", scrollTop: 320 }), null);

  // Going back must land where the account list was left, not at the top.
  assert.equal(memory.observe({ key: "folder:XMediaArchive/_accounts", scrollTop: 0 }), 1400);
  // And the author folder is remembered independently.
  assert.equal(memory.observe({ key: "folder:XMediaArchive/noco916", scrollTop: 0 }), 320);
});

test("a closed grid clears the current folder without losing its offset", () => {
  const memory = new GridScrollMemory();
  memory.observe({ key: "folder:a", scrollTop: 0 });
  memory.observe({ key: "folder:a", scrollTop: 900 });
  assert.equal(memory.observe({ key: null, scrollTop: 0 }), null, "no grid open, nothing to restore");
  assert.equal(memory.observe({ key: "folder:a", scrollTop: 0 }), 900, "reopening still lands where it was");
});

test("a replacement view instance restores even when Obsidian lifecycles overlap", () => {
  const pluginMemory = new GridScrollMemory();
  pluginMemory.save("xmc-author:artist", 73);
  // Obsidian back may create the replacement before the displaced view's
  // onClose completes. A read must not record the replacement's initial zero.
  assert.equal(pluginMemory.recall("xmc-author:artist"), 73);
  // The old view can finish later without the new view having erased its key.
  pluginMemory.save("xmc-author:artist", 73);
  assert.equal(pluginMemory.recall("xmc-author:artist"), 73);
});

test("keyed gallery memory ignores bad samples and forget removes it", () => {
  const memory = new GridScrollMemory();
  memory.save("xmc-author:artist", 48);
  memory.save("xmc-author:artist", Number.NaN);
  memory.save("xmc-author:artist", -1);
  assert.equal(memory.recall("xmc-author:artist"), 48);
  memory.forget("xmc-author:artist");
  assert.equal(memory.recall("xmc-author:artist"), 0);
});

test("nonsense offsets are ignored and forget drops a folder", () => {
  const memory = new GridScrollMemory();
  memory.observe({ key: "folder:a", scrollTop: 0 });
  memory.observe({ key: "folder:a", scrollTop: 500 });
  memory.observe({ key: "folder:a", scrollTop: Number.NaN });
  memory.observe({ key: "folder:a", scrollTop: -20 });
  assert.equal(memory.observe({ key: "folder:b", scrollTop: 0 }), 0);
  assert.equal(memory.observe({ key: "folder:a", scrollTop: 0 }), 500, "the last sane offset survives");
  memory.forget("folder:a");
  memory.observe({ key: "folder:b", scrollTop: 0 });
  assert.equal(memory.observe({ key: "folder:a", scrollTop: 0 }), 0);
});

test("the memory stays bounded and evicts the least recently seen folder", () => {
  const memory = new GridScrollMemory(2);
  for (const key of ["folder:a", "folder:b"]) { memory.observe({ key, scrollTop: 0 }); memory.observe({ key, scrollTop: 100 }); }
  memory.observe({ key: "folder:a", scrollTop: 0 });
  memory.observe({ key: "folder:a", scrollTop: 150 });   // a is now the most recent
  memory.observe({ key: "folder:c", scrollTop: 0 });
  memory.observe({ key: "folder:c", scrollTop: 200 });   // evicts b, the stalest
  assert.equal(memory.observe({ key: "folder:a", scrollTop: 0 }), 150);
  assert.equal(memory.observe({ key: "folder:b", scrollTop: 0 }), 0, "the evicted folder starts over");
});

test("a key needs a mode, and a missing path is still a folder of its own", () => {
  assert.equal(gridScrollKey("folder", "XMediaArchive/_accounts"), "folder:XMediaArchive/_accounts");
  assert.equal(gridScrollKey("folder", undefined), "folder:");
  assert.equal(gridScrollKey("", "x"), null);
  assert.equal(gridScrollKey(undefined, "x"), null);
});

test("a masonry tile returns to the same viewport offset without using offsetTop", () => {
  assert.equal(scrollTopForViewportOffset(1200, 180, 80), 1300);
  assert.equal(scrollTopForViewportOffset(40, 10, 80), 0, "the top of the document is clamped");
  assert.equal(scrollTopForViewportOffset(400, Number.NaN, 20), 400, "invalid geometry keeps the current position");
});
