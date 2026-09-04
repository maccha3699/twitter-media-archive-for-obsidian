import assert from "node:assert/strict";
import test from "node:test";
import { dateFromPost, existingNoteName, isReplyTreeNoteName, noteFileName, replyTreeNoteFileName, tokyoStamp } from "../src/naming.ts";

test("Tokyo name is sortable, uses its first 32 characters, and includes tweet ID", () => {
  assert.equal(tokyoStamp(new Date("2025-01-02T03:04:05.000Z")), "2025-01-02_120405");
  assert.equal(noteFileName({ createdAt: "2025-01-02T03:04:05.000Z", tweetId: "99", text: "hello" }), "2025-01-02_120405 - hello - 99.md");
  assert.equal(noteFileName({ createdAt: "2025-01-02T03:04:05.000Z", tweetId: "99", text: null }), "2025-01-02_120405 - post - 99.md");
});
test("uses a snowflake timestamp when createdAt is absent", () => {
  const date = new Date("2024-01-01T00:00:00.000Z");
  const id = (((BigInt(date.getTime()) - 1288834974657n) << 22n) + 17n).toString();
  assert.equal(dateFromPost({ createdAt: null, tweetId: id }).getTime(), date.getTime());
});

test("the media t.co token stays out of the file name", () => {
  // It survived safeName as "https t.co ..." and, with the title cut at 32
  // characters, pushed the real text out of the name. 5,853 of 8,823 notes in
  // the live vault were named that way.
  const post = { createdAt: "2026-08-11T05:29:27.000Z", tweetId: "2087048728498803112", text: "毎度のことながら。 https://t.co/Xc6MB5QtWa", media: [{}] };
  assert.equal(noteFileName(post), "2026-08-11_142927 - 毎度のことながら。 - 2087048728498803112.md");
  assert.equal(replyTreeNoteFileName(post), "2026-08-11_142927 - ツリー - 毎度のことながら。 - 2087048728498803112.md");
});

test("a link is only dropped when the post has archived media, and only at the end", () => {
  const stamp = { createdAt: "2025-01-02T03:04:05.000Z", tweetId: "99" };
  // No archived media: the link is the content, not X's attachment token.
  assert.equal(noteFileName({ ...stamp, text: "見て https://t.co/abc123", media: [] }), "2025-01-02_120405 - 見て https t.co abc123 - 99.md");
  // A link in the middle belongs to the text.
  assert.equal(noteFileName({ ...stamp, text: "https://t.co/abc123 の続き", media: [{}] }), "2025-01-02_120405 - https t.co abc123 の続き - 99.md");
  // A post that was nothing but the token still gets the fallback title.
  assert.equal(noteFileName({ ...stamp, text: "https://t.co/abc123", media: [{}] }), "2025-01-02_120405 - post - 99.md");
});

test("a renamed tweet body resolves back to the note already holding that tweet", () => {
  // The real case: X's schema change started including the trailing media t.co
  // token, the generated name changed, and the next import wrote a second note
  // beside the first instead of replacing it.
  const before = { createdAt: "2026-07-23T09:59:54.000Z", tweetId: "2080231424020680929", text: "モエチャカMV2周年おめでとうございます❕" };
  const after = { ...before, text: `${before.text} https://t.co/abc123` };
  const stored = noteFileName(before);
  assert.notEqual(noteFileName(after), stored, "the drift this guards against must still be real");
  assert.equal(existingNoteName([stored], after.tweetId, "post"), stored);
});

test("an aggregate never claims the per-post note of the same tweet", () => {
  // Keeping the older individual notes is deliberate, so the two kinds must not
  // resolve to each other even though both end with the same tweet id.
  const post = { createdAt: "2025-01-02T03:04:05.000Z", tweetId: "99", text: "本文" };
  const single = noteFileName(post);
  const tree = replyTreeNoteFileName(post);
  assert.equal(isReplyTreeNoteName(tree), true);
  assert.equal(isReplyTreeNoteName(single), false);
  assert.equal(existingNoteName([single, tree], "99", "post"), single);
  assert.equal(existingNoteName([single, tree], "99", "tree"), tree);
});

test("only the trailing tweet id counts, and an unknown tweet finds nothing", () => {
  const names = [
    "2025-01-02_120405 - 見て 99 - 1234567890123456789.md",
    "2025-01-02_120405 - 別の投稿 - 99.md",
  ];
  assert.equal(existingNoteName(names, "99", "post"), "2025-01-02_120405 - 別の投稿 - 99.md");
  assert.equal(existingNoteName(names, "5555", "post"), null);
  assert.equal(existingNoteName([], "99", "post"), null);
});

test("duplicates left over from before this rule converge on one file", () => {
  // Eight of these exist in the real vault. Repeated imports must keep picking
  // the same one rather than alternating between them.
  const names = ["2026-07-23_185954 - あいう https t - 5.md", "2026-07-23_185954 - あいう - 5.md"];
  const first = existingNoteName(names, "5", "post");
  assert.equal(existingNoteName([...names].reverse(), "5", "post"), first);
});

test("an existing pair keeps using the name this import would generate", () => {
  // The live duplicates are a SaveXPost-migrated note plus an XMC import, and
  // the migrated name sorts first. Picking that one would write XMC content
  // into it and strand the note the receipts point at.
  const migrated = "2026-07-19_204913 - SUMMER IS COMING - 2078809379718262854.md";
  const imported = "2026-07-19_204913 - SUMMER IS COMING https t.c - 2078809379718262854.md";
  assert.equal([migrated, imported].sort()[0], migrated, "the migrated name really does sort first");
  assert.equal(existingNoteName([migrated, imported], "2078809379718262854", "post", imported), imported);
  // A name that drifted away still falls back to reusing what is there.
  assert.equal(existingNoteName([migrated], "2078809379718262854", "post", imported), migrated);
});
