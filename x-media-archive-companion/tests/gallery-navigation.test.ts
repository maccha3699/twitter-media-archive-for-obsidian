import assert from "node:assert/strict";
import test from "node:test";
import { galleryNavigationLeaf, type RequestedPane } from "../src/gallery-navigation.ts";

interface FakeLeaf { id: number; pane: RequestedPane }

test("ordinary card clicks navigate the gallery leaf without creating a tab", () => {
  const gallery = { id: 0, pane: false } satisfies FakeLeaf;
  const created: FakeLeaf[] = [];
  const result = galleryNavigationLeaf(false, gallery, (pane) => {
    const leaf = { id: created.length + 1, pane };
    created.push(leaf);
    return leaf;
  });
  assert.equal(result, gallery);
  assert.deepEqual(created, []);
});

test("middle and modified clicks create the exact pane Obsidian requested", () => {
  const gallery = { id: 0, pane: false } satisfies FakeLeaf;
  const created: FakeLeaf[] = [];
  const create = (pane: RequestedPane): FakeLeaf => {
    const leaf = { id: created.length + 1, pane };
    created.push(leaf);
    return leaf;
  };
  assert.notEqual(galleryNavigationLeaf("tab", gallery, create), gallery);
  assert.notEqual(galleryNavigationLeaf("split", gallery, create), gallery);
  assert.notEqual(galleryNavigationLeaf("window", gallery, create), gallery);
  assert.deepEqual(created.map((leaf) => leaf.pane), ["tab", "split", "window"]);
});
