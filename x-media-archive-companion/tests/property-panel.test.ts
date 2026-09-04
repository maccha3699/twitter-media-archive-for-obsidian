import assert from "node:assert/strict";
import test from "node:test";
import { isXmcPropertyNote, propertyDocument } from "../src/property-model.ts";

test("only archive posts and reserved profiles receive property panels", () => {
  assert.equal(isXmcPropertyNote("XMediaArchive/SampleAuthor/post.md", "XMediaArchive", { tweet_id: "1" }), true);
  assert.equal(isXmcPropertyNote("XMediaArchive/SampleAuthor/_profile.md", "XMediaArchive", { display_name: "Sample Author" }), true);
  assert.equal(isXmcPropertyNote("XMediaArchive/_accounts/SampleAuthor.md", "XMediaArchive", { type: "folder" }), false);
  assert.equal(isXmcPropertyNote("Notes/post.md", "XMediaArchive", { tweet_id: "1" }), false);
});

test("central and sidebar panels share one normalized property document", () => {
  const document = propertyDocument("XMediaArchive/SampleAuthor/post.md", "XMediaArchive", {
    schemaVersion: 1, tweet_id: "2087002852036362698", tweet_url: "https://x.com/SampleAuthor/status/1",
    tags: ["one", "two"], position: { start: 0, end: 10 },
  });
  assert.equal(document?.kind, "post");
  assert.deepEqual(document?.rows, [
    { key: "schemaVersion", text: "1", href: null },
    { key: "tweet_id", text: "2087002852036362698", href: null },
    { key: "tweet_url", text: "https://x.com/SampleAuthor/status/1", href: "https://x.com/SampleAuthor/status/1" },
    { key: "tags", text: "one, two", href: null },
  ]);
  assert.equal(propertyDocument("XMediaArchive/SampleAuthor/_profile.md", "XMediaArchive", { display_name: "Sample Author" })?.kind, "profile");
});
