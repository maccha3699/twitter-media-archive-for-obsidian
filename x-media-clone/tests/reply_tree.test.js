import test from "node:test";
import assert from "node:assert/strict";

import { buildSameAuthorReplyTree, directReplyTreeSaveOptions, MAX_REPLY_TREE_POSTS } from "../lib/reply_tree.js";

function tweet(tweetId, replyToTweetId, { authorId = "42", screenName = "alice", time = Number(tweetId) } = {}) {
  return {
    tweetId,
    replyToTweetId,
    replyToUserId: replyToTweetId ? authorId : null,
    author: { id: authorId, screenName },
    authorScreenName: screenName,
    createdAtMs: time,
    media: [],
  };
}

test("the ordinary reply-tree button keeps manual re-fetch semantics", () => {
  assert.deepEqual(directReplyTreeSaveOptions("6ba7b810-9dad-4d80-bccb-4c01b97b67ef"), {
    mode: "bulk",
    jobId: "6ba7b810-9dad-4d80-bccb-4c01b97b67ef",
    forceRedownload: true,
    includePostWhenMediaSkipped: true,
    allowNoMedia: true,
  });
  assert.throws(() => directReplyTreeSaveOptions(""), /jobId/);
});

test("same-author chain walks to its root and forward without crossing authors", () => {
  const tweets = [
    tweet("100", null, { time: 1 }),
    tweet("101", "100", { time: 2 }),
    tweet("102", "101", { time: 3 }),
    tweet("103", "102", { authorId: "99", screenName: "bob", time: 4 }),
  ];
  const result = buildSameAuthorReplyTree("101", tweets);
  assert.deepEqual(result.posts.map((post) => post.tweetId), ["100", "101", "102"]);
  assert.equal(result.partial, false);
  assert.deepEqual(result.posts.map((post) => post.replyTree), [
    { rootTweetId: "100", previousTweetId: null, nextTweetId: "101", position: 1, size: 3, partial: false },
    { rootTweetId: "100", previousTweetId: "100", nextTweetId: "102", position: 2, size: 3, partial: false },
    { rootTweetId: "100", previousTweetId: "101", nextTweetId: null, position: 3, size: 3, partial: false },
  ]);
  const missingId = tweet("104", "102", { authorId: "", screenName: "ALICE", time: 4 });
  assert.deepEqual(buildSameAuthorReplyTree("102", [...tweets, missingId]).posts.map((post) => post.tweetId),
    ["100", "101", "102", "104"], "screenName is the fallback when either ID is absent");
});

test("missing same-author parents and branches are explicit partial chains", () => {
  const missing = tweet("201", "200", { time: 2 });
  const childA = tweet("202", "201", { time: 3 });
  const childB = tweet("203", "201", { time: 4 });
  const result = buildSameAuthorReplyTree("201", [missing, childB, childA]);
  assert.deepEqual(result.posts.map((post) => post.tweetId), ["201", "202"]);
  assert.equal(result.partial, true);
  assert.deepEqual(new Set(result.reasons), new Set(["missing-parent", "branch"]));
  assert.ok(result.posts.every((post) => post.replyTree.partial));
});

test("single posts are not mislabeled as a tree and the hard cap is bounded", () => {
  assert.deepEqual(buildSameAuthorReplyTree("300", [tweet("300", null)]).posts, []);
  const tweets = [];
  for (let index = 0; index <= MAX_REPLY_TREE_POSTS; index++) {
    tweets.push(tweet(String(400 + index), index === 0 ? null : String(399 + index), { time: index }));
  }
  const result = buildSameAuthorReplyTree("400", tweets);
  assert.equal(result.posts.length, MAX_REPLY_TREE_POSTS);
  assert.equal(result.partial, true);
  assert.ok(result.reasons.includes("limit"));
});
