import test from "node:test";
import assert from "node:assert/strict";

test("content_main start waits for DOMContentLoaded when body is not available", async () => {
  const listeners = new Map();

  globalThis.Element = class Element {};
  globalThis.location = {
    href: "https://x.com/example/media",
    pathname: "/example/media",
  };
  globalThis.window = {
    addEventListener() {},
  };
  globalThis.document = {
    readyState: "loading",
    documentElement: null,
    head: null,
    body: null,
    addEventListener(type, callback, options) {
      listeners.set(type, { callback, options });
    },
  };
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(_key, callback) {
          callback({});
        },
      },
      onChanged: {
        addListener() {},
      },
    },
  };

  const { start, runtimeFailureMessage } = await import("../content_main.js");

  assert.match(runtimeFailureMessage("Extension context invalidated."), /Xタブも再読み込み/);
  assert.match(runtimeFailureMessage("Could not establish connection. Receiving end does not exist."), /Service Worker/);
  assert.equal(runtimeFailureMessage("line one\nline two"), "line one line two");

  assert.doesNotThrow(() => {
    start([], () => {}, {
      sendMessage() {},
      getLastError() {
        return null;
      },
    });
  });

  const registered = listeners.get("DOMContentLoaded");
  assert.ok(registered, "DOMContentLoaded handler should be registered");
  assert.equal(registered.options.once, true);
});
