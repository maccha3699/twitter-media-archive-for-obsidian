import test from "node:test";
import assert from "node:assert/strict";

import { inferBulkReplyTrees } from "../src/reply-tree.ts";
import { sampleJob } from "./fixtures.ts";

test("bulk reply IDs become one same-author chain while standalone posts stay standalone", () => {
  const job = sampleJob();
  job.mode = "bulk";
  const root = { ...structuredClone(job.posts[0]), media: [] };
  const child = { ...structuredClone(root), tweetId: "1830000000000000001", replyToTweetId: root.tweetId, replyToUserId: "42" };
  const standalone = { ...structuredClone(root), tweetId: "1830000000000000009" };
  job.posts = [child, standalone, root];
  const inferred = inferBulkReplyTrees(job);
  assert.equal(inferred.posts.find((post) => post.tweetId === root.tweetId)!.replyTree?.position, 1);
  assert.equal(inferred.posts.find((post) => post.tweetId === child.tweetId)!.replyTree?.position, 2);
  assert.equal(inferred.posts.find((post) => post.tweetId === standalone.tweetId)!.replyTree, undefined);
});

test("bulk inference marks a visible fragment partial and never crosses authors", () => {
  const job = sampleJob();
  job.mode = "bulk";
  const first = { ...structuredClone(job.posts[0]), tweetId: "1830000000000000001", media: [], replyToTweetId: "1830000000000000000", replyToUserId: "42" };
  const second = { ...structuredClone(first), tweetId: "1830000000000000002", replyToTweetId: first.tweetId };
  const other = { ...structuredClone(second), tweetId: "1830000000000000003", replyToTweetId: second.tweetId,
    author: { ...second.author, id: "99", screenName: "other" } };
  job.posts = [first, second, other];
  const inferred = inferBulkReplyTrees(job);
  assert.equal(inferred.posts[0].replyTree?.partial, true);
  assert.equal(inferred.posts[1].replyTree?.size, 2);
  assert.equal(inferred.posts[2].replyTree, undefined);
});
