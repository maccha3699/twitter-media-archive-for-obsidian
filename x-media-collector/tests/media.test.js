// tests/media.test.js
// T2-T4: lib/media.js extractMedia() behavior, exercised via collectTweets()
// so fixtures stay a single source of truth (T2 explicitly derives from T1's
// collected media[0]).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { collectTweets } from "../lib/graphql_extract.js";
import { normalizePhotoUrl } from "../lib/media.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  const p = path.join(__dirname, "fixtures", name);
  return JSON.parse(readFileSync(p, "utf8"));
}

test("T2: photo url normalized (query stripped, format=orig)", () => {
  const fixture = loadFixture("timeline_photos.json");
  const tweets = collectTweets(fixture);
  const media0 = tweets[0].media[0];
  assert.equal(media0.type, "photo");
  assert.equal(media0.url, "https://pbs.twimg.com/media/AbCd1234?format=jpg&name=orig");
  assert.equal(media0.ext, "jpg");
  assert.equal(media0.mediaKey, "3_1900000000000000001");
  assert.equal(media0.ordinal, 1);
  assert.equal(tweets[0].media[1].mediaKey, "3_1900000000000000002");
  assert.equal(tweets[0].media[1].ordinal, 2);
});

test("T3: highest bitrate mp4 selected, HLS excluded", () => {
  const fixture = loadFixture("video.json");
  const tweets = collectTweets(fixture);
  assert.equal(tweets[0].media.length, 1);
  const item = tweets[0].media[0];
  assert.equal(item.url, "https://video.twimg.com/ext_tw_video/123/pu/vid/1280x720/high.mp4");
  assert.ok(!item.url.includes(".m3u8"));
  assert.equal(item.ext, "mp4");
});

test("T4: animated_gif bitrate 0 kept", () => {
  const fixture = loadFixture("animated_gif.json");
  const tweets = collectTweets(fixture);
  assert.equal(tweets[0].media.length, 1);
  assert.equal(tweets[0].media[0].type, "animated_gif");
  assert.equal(tweets[0].media[0].ext, "mp4");
});

test("T4b: photo query format normalized", () => {
  const item = normalizePhotoUrl("https://pbs.twimg.com/media/QueryOnly?format=png&name=small");
  assert.deepEqual(item, {
    url: "https://pbs.twimg.com/media/QueryOnly?format=png&name=orig",
    ext: "png",
  });
});
