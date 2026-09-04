// tests/x_surface.test.js
// lib/x_surface.js — everything the extension assumes about how x.com is shaped.
// These assertions are deliberately written so that both the pre-2026-08 site
// (a single unfiltered /media tab) and the current one (画像 / 動画 split by
// ?filter=) satisfy them, because nothing downstream may branch on which is live.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  SELECTORS,
  mediaFilterFromSearch,
  mediaFilterLabel,
  mediaPageScreenName,
} from "../lib/x_surface.js";

test("mediaPageScreenName matches /media pages only", () => {
  assert.equal(mediaPageScreenName("/foo/media"), "foo");
  assert.equal(mediaPageScreenName("/foo/media/"), "foo");
  assert.equal(mediaPageScreenName("/foo/with_replies"), null);
  assert.equal(mediaPageScreenName("/home"), null);
  assert.equal(mediaPageScreenName("/foo/status/1"), null);
  assert.equal(mediaPageScreenName(123), null);
  assert.equal(mediaPageScreenName(""), null);
});

/* The tab is chosen by query string, and location.pathname never carries it.
 * Matching on the path alone is what lets the same check serve the old single
 * media tab and the current split pair without knowing which one is live. */
test("the media page match ignores which tab is selected", () => {
  assert.equal(mediaPageScreenName("/sample_author/media"), "sample_author");
  assert.equal(mediaFilterFromSearch("?filter=photo"), "photo");
  assert.equal(mediaFilterFromSearch("filter=photo"), "photo");
  assert.equal(mediaFilterFromSearch("?src=x&filter=video&t=1"), "video");
});

test("an absent, empty, or unparseable filter reads as unfiltered", () => {
  assert.equal(mediaFilterFromSearch(""), null);
  assert.equal(mediaFilterFromSearch("?"), null);
  assert.equal(mediaFilterFromSearch("?src=typed_query"), null);
  assert.equal(mediaFilterFromSearch("?filter="), null);
  assert.equal(mediaFilterFromSearch("?filter"), null);
  assert.equal(mediaFilterFromSearch(undefined), null);
});

/* A tab X adds later must be named after itself rather than silently reported
 * as the unfiltered one, which would misdescribe what a run swept. */
test("tab labels cover the known tabs and pass unknown ones through", () => {
  assert.equal(mediaFilterLabel("photo"), "画像");
  assert.equal(mediaFilterLabel("video"), "動画");
  assert.equal(mediaFilterLabel(null), "メディア");
  assert.equal(mediaFilterLabel(""), "メディア");
  assert.equal(mediaFilterLabel("audio"), "audio");
});

/* This module is the one place site assumptions may live, so it must stay
 * loadable outside a page: no chrome.* and no DOM globals. */
test("the module stays pure logic", () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "x_surface.js"),
    "utf8"
  );
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of ["chrome.", "document.", "window."]) {
    assert.equal(code.includes(forbidden), false, `x_surface.js must not reference ${forbidden}`);
  }
});

test("selectors stay centralized here", () => {
  assert.equal(SELECTORS.tweetArticle, 'article[data-testid="tweet"]');
  assert.match(SELECTORS.avatarContainer, /UserAvatar-Container-/);
});
