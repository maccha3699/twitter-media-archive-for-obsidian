// tests/graphql_extract.test.js
// T1, T5-T9: lib/graphql_extract.js collectTweets() behavior.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { collectProfiles, collectTweets } from "../lib/graphql_extract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  const p = path.join(__dirname, "fixtures", name);
  return JSON.parse(readFileSync(p, "utf8"));
}

test("T1: timeline photos collected", () => {
  const fixture = loadFixture("timeline_photos.json");
  const tweets = collectTweets(fixture);
  assert.equal(tweets.length, 1);
  assert.equal(tweets[0].tweetId, "1900000000000000001");
  assert.equal(tweets[0].authorScreenName, "alice");
  assert.equal(tweets[0].media.length, 2);
});

test("T5: visibility results unwrapped (inner Tweet collected)", () => {
  const fixture = loadFixture("visibility_wrapped.json");
  const tweets = collectTweets(fixture);
  const ids = tweets.map((t) => t.tweetId);
  assert.ok(ids.includes("1900000000000000004"));
});

test("T5b: UserMedia TweetWithVisibilityResults entries all collected", () => {
  const fixture = loadFixture("user_media.json");
  const tweets = collectTweets(fixture);
  const ids = ["1900000000000000101", "1900000000000000102", "1900000000000000103"];
  assert.equal(tweets.length, 3);
  for (const id of ids) {
    const tweet = tweets.find((t) => t.tweetId === id);
    assert.ok(tweet, `expected tweet ${id} to be collected`);
    assert.ok(tweet.media.length >= 1, `expected tweet ${id} to have media`);
    assert.notEqual(tweet.authorScreenName, "unknown");
  }
});

test("T6: quoted tweet also collected", () => {
  const fixture = loadFixture("quoted.json");
  const tweets = collectTweets(fixture);
  assert.equal(tweets.length, 2);
  const ids = tweets.map((t) => t.tweetId);
  assert.ok(ids.includes("1900000000000000005"));
  assert.ok(ids.includes("1900000000000000006"));
  const quoted = tweets.find((t) => t.tweetId === "1900000000000000006");
  assert.equal(quoted.media.length, 1);
});

test("T7: tweet without media", () => {
  const fixture = loadFixture("no_media.json");
  const tweets = collectTweets(fixture);
  assert.equal(tweets.length, 1);
  assert.deepEqual(tweets[0].media, []);
});

test("T8: module items", () => {
  const fixture = loadFixture("module_items.json");
  const tweets = collectTweets(fixture);
  assert.equal(tweets.length, 2);
});

test("T9: new core author path", () => {
  const fixture = loadFixture("new_core_author.json");
  const tweets = collectTweets(fixture);
  assert.equal(tweets.length, 1);
  assert.notEqual(tweets[0].authorScreenName, "unknown");
  assert.equal(tweets[0].authorScreenName, "ivan_new");
});

test("author projection supports legacy/core shapes, URL fallback, and missing users", () => {
  const tweets = collectTweets(loadFixture("author_variants.json"));
  const legacy = tweets.find((tweet) => tweet.tweetId === "1900000000000000201");
  const core = tweets.find((tweet) => tweet.tweetId === "1900000000000000202");
  const missing = tweets.find((tweet) => tweet.tweetId === "1900000000000000203");
  assert.deepEqual(legacy.author, {
    id: "preferred-rest-id", screenName: "legacy_author", displayName: "Legacy Display", bio: "Legacy bio",
    urls: ["https://example.invalid/expanded", "https://t.co/fallback", "https://example.invalid/in-bio"],
    location: null, followers: null,
  });
  assert.equal(legacy.authorScreenName, "legacy_author");
  assert.deepEqual(core.author, {
    id: "core-fallback-id", screenName: "core_author", displayName: "Core Display", bio: "Core bio", urls: ["https://example.invalid/core"],
    location: null, followers: null,
  });
  assert.equal(core.authorScreenName, "core_author");
  assert.deepEqual(missing.author, { id: null, screenName: null, displayName: null, bio: null, urls: [], location: null, followers: null });
  assert.equal(missing.authorScreenName, "unknown");
  assert.equal(missing.fullText, "unchanged text");
  assert.equal(missing.createdAt, "Wed Oct 10 20:19:24 +0000 2018");
});

test("standalone profile GraphQL records expose bio, external URLs, and observed status", () => {
  const profiles = collectProfiles(loadFixture("profile_user.json"));
  assert.deepEqual(profiles, [{ id: "777", screenName: "profile_author", displayName: "Profile Author", bio: "FANBOX and Pixiv", urls: ["https://profile.example/fanbox", "https://profile.example/pixiv"], location: "Tokyo", followers: 12345, metadataStatus: "observed" }]);
});

test("the current profile shape is read even though the user node has no legacy block", () => {
  // X retired `legacy` and split what it held across profile_bio, location and
  // relationship_counts. `core` still carries the screen name, so a user node
  // in the new shape is still recognised -- it just used to arrive with every
  // profile field empty, which is why no archived profile ever had a bio.
  const profiles = collectProfiles(loadFixture("profile_user_2026.json"));
  assert.deepEqual(profiles, [{
    id: "778",
    screenName: "modern_author",
    displayName: "Modern Author",
    bio: "連載始めました。→https://t.co/4Q5qz1X1lH",
    urls: ["https://modern.example/fanbox", "https://modern.example/youtube"],
    location: "依頼の際はwebページ内のFANBOXプロフをご一読下さい",
    followers: 216349,
    metadataStatus: "observed",
  }]);
});

test("a retweet is collected as the original post, not as the retweeter's own", () => {
  // X mirrors the original's extended_entities onto the wrapper, so the wrapper
  // normalizes into a post claiming the retweeter authored someone else's
  // media. 38 notes were archived that way before this was noticed.
  const tweets = collectTweets(loadFixture("retweet.json"));
  assert.equal(tweets.length, 1, "the wrapper and the original are one post, not two");
  const [tweet] = tweets;
  assert.equal(tweet.tweetId, "2084907004540465202", "the original's ID, so its status URL resolves");
  assert.equal(tweet.authorScreenName, "original_acct");
  assert.equal(tweet.author.id, "555000111");
  assert.equal(tweet.fullText, "作品です https://t.co/mirrored", "not the RT @ prefixed mirror");
  assert.equal(tweet.media.length, 1);
  assert.equal(tweet.createdAt, "Wed Aug 12 08:44:00 +0000 2026", "the original's time, not the retweet's");
});

test("Tweet legacy reply relationships are normalized without leaking GraphQL shape downstream", () => {
  const [tweet] = collectTweets({ __typename: "Tweet", rest_id: "1900000000000000302", legacy: {
    created_at: "Wed Aug 12 08:44:00 +0000 2026", full_text: "part two",
    in_reply_to_status_id_str: "1900000000000000301",
    in_reply_to_user_id_str: "42",
    conversation_id_str: "1900000000000000301",
  }, core: { user_results: { result: { __typename: "User", rest_id: "42", legacy: { screen_name: "alice" } } } } });
  assert.equal(tweet.replyToTweetId, "1900000000000000301");
  assert.equal(tweet.replyToUserId, "42");
  assert.equal(tweet.conversationId, "1900000000000000301");
});
