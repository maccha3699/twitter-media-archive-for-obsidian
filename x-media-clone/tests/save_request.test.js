import test from "node:test";
import assert from "node:assert/strict";

import { buildSavePostRequest } from "../lib/save_request.js";

const tweet = {
  tweetId: "1234567890",
  replyToTweetId: "1234567889",
  replyToUserId: "42",
  conversationId: "1234567889",
  authorScreenName: "alice",
  fullText: "hello",
  createdAt: "Wed Oct 10 20:19:24 +0000 2018",
  author: {
    id: "42",
    screenName: "alice",
    displayName: "Alice",
    bio: "bio",
    urls: ["https://example.com"],
  },
  media: [
    { type: "photo", url: "https://pbs.twimg.com/media/a.jpg", ext: "jpg", mediaKey: "3_abc" },
    { type: "video", url: "https://video.twimg.com/a.mp4", ext: ".MP4", ordinal: 3 },
  ],
};

test("manual and bulk saves share the same normalized post contract", () => {
  const manual = buildSavePostRequest(tweet, { mode: "manual" });
  const bulk = buildSavePostRequest(tweet, {
    mode: "bulk",
    jobId: "6ba7b810-9dad-4d80-bccb-4c01b97b67ef",
  });

  assert.deepEqual(manual.post, bulk.post);
  assert.equal(manual.retryFailed, true);
  assert.equal(manual.post.media[0].mediaKey, "3_abc");
  assert.equal(manual.post.media[1].mediaKey, "1234567890:3:video");
  assert.equal(manual.post.media[1].ordinal, 3);
  assert.equal(manual.post.media[1].extension, "mp4");
  assert.equal(manual.post.tweetUrl, "https://x.com/alice/status/1234567890");
  assert.equal(manual.post.profileMetadataStatus, "profile-pending");
  assert.equal(manual.post.replyToTweetId, "1234567889");
});

test("DOM fallback metadata remains a valid partial save request", () => {
  const request = buildSavePostRequest(
    {
      tweetId: "9",
      authorScreenName: "fallback_user",
      media: [{ type: "photo", url: "https://pbs.twimg.com/media/b.jpg", ext: "jpg" }],
    },
    { mode: "manual" }
  );

  assert.equal(request.post.createdAt, null);
  assert.equal(request.post.text, null);
  assert.equal(request.post.author.id, null);
  assert.deepEqual(request.post.author.urls, []);
});

test("save requests reject unsupported modes and missing source URLs", () => {
  assert.throws(() => buildSavePostRequest(tweet, { mode: "other" }), /mode/);
  assert.throws(
    () => buildSavePostRequest({ ...tweet, media: [{ type: "photo" }] }, { mode: "manual" }),
    /source URL|\.url/
  );
});

test("reply-tree jobs keep validated navigation and allow text-only posts", () => {
  const request = buildSavePostRequest({
    ...tweet,
    tweetId: "1234567891",
    media: [],
    replyTree: {
      rootTweetId: "1234567890", previousTweetId: "1234567890", nextTweetId: null,
      position: 2, size: 2, partial: false,
    },
  }, {
    mode: "bulk", jobId: "6ba7b810-9dad-4d80-bccb-4c01b97b67ef",
    includePostWhenMediaSkipped: true, allowNoMedia: true,
  });
  assert.equal(request.includePostWhenMediaSkipped, true);
  assert.deepEqual(request.post.media, []);
  assert.equal(request.post.replyTree.position, 2);
  assert.throws(() => buildSavePostRequest({ ...tweet, replyTree: { size: 500 } }, { mode: "manual" }), /replyTree/);
});
