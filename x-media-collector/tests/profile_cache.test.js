import test from "node:test";
import assert from "node:assert/strict";
import { ProfileCache } from "../lib/profile_cache.js";

test("profile cache enriches timeline tweets without erasing stronger observed metadata", () => {
  const cache = new ProfileCache();
  cache.put({ id: "42", screenName: "Alice", displayName: "Alice", bio: "bio", urls: ["https://example.invalid/fanbox"], metadataStatus: "observed" });
  cache.put({ id: "42", screenName: "Alice", displayName: null, bio: null, urls: [], metadataStatus: "profile-pending" });
  const enriched = cache.enrich({ tweetId: "1", authorScreenName: "Alice", author: { id: "42", screenName: "Alice", displayName: null, bio: null, urls: [] } });
  assert.equal(enriched.author.bio, "bio"); assert.deepEqual(enriched.author.urls, ["https://example.invalid/fanbox"]); assert.equal(enriched.profileMetadataStatus, "observed");
});
