// tests/bulk_modal.test.js
// The bulk modal is the entire UI of the feature and is built entirely from
// DOM calls, so nothing else in the suite executes it. A reference error in
// that builder is invisible to `node --check` and leaves the button dead.
import test from "node:test";
import assert from "node:assert/strict";

/** The smallest element that content_main.js's builders actually use. */
function createElementStub(tag) {
  return {
    tagName: tag,
    className: "",
    textContent: "",
    type: "",
    value: "",
    checked: false,
    id: "",
    style: {},
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child, before) {
      const at = this.children.indexOf(before);
      this.children.splice(at === -1 ? this.children.length : at, 0, child);
      return child;
    },
    addEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    remove() {},
  };
}

function installDom(search) {
  const created = [];
  globalThis.Element = class Element {};
  globalThis.location = {
    href: `https://x.com/sample_author/media${search}`,
    pathname: "/sample_author/media",
    search,
  };
  globalThis.window = { addEventListener() {} };
  const head = createElementStub("head");
  const body = createElementStub("body");
  globalThis.document = {
    readyState: "complete",
    documentElement: createElementStub("html"),
    head,
    body,
    createElement(tag) {
      const element = createElementStub(tag);
      created.push(element);
      return element;
    },
    getElementById: () => null,
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: {
      local: { get(_key, callback) { callback({}); } },
      onChanged: { addListener() {} },
    },
  };
  return created;
}

test("the bulk modal builds and names the media tab it will sweep", async () => {
  const created = installDom("?filter=photo");
  const { openBulkModal } = await import("../content_main.js");

  assert.doesNotThrow(() => openBulkModal());

  const title = created.find((element) => element.className === "xmc-bulk-title");
  assert.ok(title, "the modal heading is built");
  assert.equal(title.textContent, "一括ダウンロード（画像）");

  // Reopening after a tab switch renames the heading rather than keeping the
  // tab the modal happened to be built on.
  globalThis.location.search = "?filter=video";
  openBulkModal();
  assert.equal(title.textContent, "一括ダウンロード（動画）");

  // The pre-2026-08 single media tab has no filter at all and must still read
  // as a media sweep rather than as one of the split tabs.
  globalThis.location.search = "";
  openBulkModal();
  assert.equal(title.textContent, "一括ダウンロード（メディア）");

  const stats = created.filter((element) => element.className === "xmc-bulk-stats");
  assert.equal(stats.length >= 1, true);
  assert.match(stats[0].textContent, /状態:/);

  const concurrencyInput = created.find((element) => element.tagName === "input" && element.value === "20");
  assert.ok(concurrencyInput, "the modal defaults the maximum concurrent post workers to 20");
});
