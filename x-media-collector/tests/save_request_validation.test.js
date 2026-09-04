import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertSavePostRequest } from "../lib/save_request_validation.js";

const source = readFileSync(new URL("../lib/save_request_validation.js", import.meta.url), "utf8");

function media(overrides = {}) {
  return {
    mediaKey: "3_photo",
    ordinal: 1,
    type: "photo",
    sourceUrl: "https://pbs.twimg.com/media/synthetic.jpg",
    ...overrides,
  };
}

function post(overrides = {}) {
  return {
    tweetId: "1900000000000000001",
    tweetUrl: "https://example.invalid/x/status/1900000000000000001",
    author: { id: "42", screenName: "synthetic_author" },
    media: [media()],
    ...overrides,
  };
}

test("save request validator is runtime-independent and returns the original request", () => {
  assert.doesNotMatch(source, /\b(?:chrome|indexeddb|addlistener|fetch|xmlhttprequest)\b/i);
  const request = { mode: "manual", post: post() };
  assert.equal(assertSavePostRequest(request), request);
});

test("save request validator accepts manual/bulk and valid reply tree requests", () => {
  assert.doesNotThrow(() => assertSavePostRequest({ mode: "manual", post: post() }));
  assert.doesNotThrow(() => assertSavePostRequest({
    mode: "bulk",
    includePostWhenMediaSkipped: true,
    post: post({
      replyToTweetId: "1900000000000000000",
      replyToUserId: "42",
      conversationId: "1900000000000000000",
      replyTree: {
        rootTweetId: "1900000000000000000",
        previousTweetId: null,
        nextTweetId: "1900000000000000002",
        position: 1,
        size: 2,
        partial: false,
      },
    }),
  }));
});

test("save request validator preserves mode and media trust-boundary rejects", () => {
  const cases = [
    [{ mode: "other", post: post() }, /save mode/],
    [{ mode: "manual", includePostWhenMediaSkipped: true, post: post() }, /only bulk/],
    [{ mode: "manual", post: post({ tweetId: "not-decimal" }) }, /tweet identity/],
    [{ mode: "manual", post: post({ replyToTweetId: "bad" }) }, /replyToTweetId/],
    [{ mode: "manual", post: post({ replyTree: { position: 1 } }) }, /reply tree/],
    [{ mode: "manual", post: post({ media: [media(), media({ mediaKey: "3_photo-duplicate" })] }) }, /ordinals/],
    [{ mode: "manual", post: post({ media: [media(), media({ ordinal: 2, mediaKey: "3_photo" })] }) }, /media keys/],
    [{ mode: "manual", post: post({ media: [media({ type: "audio" })] }) }, /unsupported/],
    [{ mode: "manual", post: post({ media: [media({ sourceUrl: "http://pbs.twimg.com/media/synthetic.jpg" })] }) }, /HTTPS/],
    [{ mode: "manual", post: post({ media: [media({ sourceUrl: "https://example.invalid/media.jpg" })] }) }, /X CDN/],
  ];
  for (const [request, error] of cases) assert.throws(() => assertSavePostRequest(request), error);
});
