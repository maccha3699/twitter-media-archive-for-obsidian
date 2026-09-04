import assert from "node:assert/strict";
import test from "node:test";
import { authorMediaDeletePlan, isAuthorNotePath, receiptWithoutAuthor, receiptWithoutNote } from "../src/author-delete.ts";

test("author receipt cleanup preserves posts from another author in the same bulk job", () => {
  const receipt = {
    schemaVersion: 1 as const, jobId: "job", state: "complete" as const, importedAt: "now",
    posts: [
      { tweetId: "1", state: "complete" as const, notePath: "XMediaArchive/alice/one.md", media: [] },
      { tweetId: "2", state: "complete" as const, notePath: "XMediaArchive/bob/two.md", media: [] },
    ],
  };
  const result = receiptWithoutAuthor(receipt, "XMediaArchive", "alice");
  assert.equal(result.changed, true);
  assert.equal(result.empty, false);
  assert.deepEqual(result.receipt.posts.map((post) => post.tweetId), ["2"]);
  assert.equal(result.receipt.state, "complete");
});

test("an author-only receipt becomes an empty complete tombstone", () => {
  const receipt = {
    schemaVersion: 1 as const, jobId: "job", state: "complete" as const, importedAt: "now",
    posts: [{ tweetId: "1", state: "complete" as const, notePath: "XMediaArchive/Alice/tree.md", media: [] }],
  };
  const result = receiptWithoutAuthor(receipt, "xmediaarchive", "alice");
  assert.equal(result.empty, true);
  assert.equal(result.receipt.state, "complete");
  assert.deepEqual(result.receipt.posts, []);
  assert.equal(isAuthorNotePath("XMediaArchive/alice2/no.md", "XMediaArchive", "alice"), false);
});

test("remaining partial posts keep a mixed receipt partial and unrelated receipts stay untouched", () => {
  const receipt = {
    schemaVersion: 1 as const, jobId: "job", state: "partial" as const, importedAt: "now",
    posts: [
      { tweetId: "1", state: "complete" as const, notePath: "XMediaArchive/alice/one.md", media: [] },
      { tweetId: "2", state: "partial" as const, notePath: "XMediaArchive/bob/two.md", media: [] },
    ],
  };
  const changed = receiptWithoutAuthor(receipt, "XMediaArchive", "alice");
  assert.equal(changed.receipt.state, "partial");
  const untouched = receiptWithoutAuthor(receipt, "XMediaArchive", "carol");
  assert.equal(untouched.changed, false);
  assert.equal(untouched.receipt, receipt);
});

test("author media cleanup preserves links from outside the deleted author", () => {
  const privateMedia = "XMediaArchive/_media/alice/private.jpg";
  const sharedMedia = "XMediaArchive/_media/alice/shared.jpg";
  const result = authorMediaDeletePlan(
    [privateMedia, sharedMedia, privateMedia],
    ["XMediaArchive/alice/one.md", "XMediaArchive/_accounts/alice.md"],
    {
      "XMediaArchive/alice/one.md": { [privateMedia]: 1, [sharedMedia]: 1 },
      "Notes/reference.md": { [sharedMedia]: 1 },
    },
  );
  assert.deepEqual(result, { removable: [privateMedia], preserved: [sharedMedia] });
});

test("author media cleanup scans each external link map once for many media", () => {
  const media = Array.from({ length: 200 }, (_, index) => `XMediaArchive/_media/alice/${index}.jpg`);
  let enumerations = 0;
  const targets = new Proxy({ [media[199]]: 1 }, {
    ownKeys(target) { enumerations += 1; return Reflect.ownKeys(target); },
  });
  const result = authorMediaDeletePlan(media, ["XMediaArchive/alice/post.md"], {
    "Notes/reference.md": targets,
  });
  assert.equal(enumerations, 1);
  assert.deepEqual(result.preserved, [media[199]]);
  assert.equal(result.removable.length, 199);
});

test("malformed receipt posts fail closed", () => {
  assert.throws(() => receiptWithoutAuthor({ posts: [{ tweetId: "1" }] }, "XMediaArchive", "alice"), /path is invalid/);
});

test("post receipt cleanup removes every reply-tree entry for one shared note", () => {
  const receipt = { schemaVersion: 1 as const, jobId: "job", state: "complete" as const, importedAt: "now", posts: [
    { tweetId: "1", state: "complete" as const, notePath: "XMediaArchive/Alice/tree.md", media: [] },
    { tweetId: "2", state: "complete" as const, notePath: "xmediaarchive/alice/tree.md", media: [] },
    { tweetId: "3", state: "complete" as const, notePath: "XMediaArchive/Alice/other.md", media: [] },
  ] };
  const result = receiptWithoutNote(receipt, "XMediaArchive/Alice/tree.md");
  assert.deepEqual(result.receipt.posts.map((post) => post.tweetId), ["3"]);
  assert.equal(result.receipt.state, "complete");
});
