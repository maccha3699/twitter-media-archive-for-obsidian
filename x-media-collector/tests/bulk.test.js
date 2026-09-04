// tests/bulk.test.js
// T27-T36: lib/bulk.js (bulk-download engine pure logic) + related extensions
// to lib/graphql_extract.js and lib/filename.js.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  parseTwitterDate,
  normalizeBulkOptions,
  filterMediaByType,
  tweetMatchesFilters,
  evaluateStop,
  shouldStopForMaxTweets,
  BulkSession,
} from "../lib/bulk.js";
import { collectTweets } from "../lib/graphql_extract.js";
import { buildFilename, sanitizePathSegment } from "../lib/filename.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  const p = path.join(__dirname, "fixtures", name);
  return JSON.parse(readFileSync(p, "utf8"));
}

// T27 (mediaPageScreenName) moved to tests/x_surface.test.js with the module.

// --- T28: parseTwitterDate ----------------------------------------------

test("T28: parseTwitterDate parses legacy created_at format", () => {
  const ms = parseTwitterDate("Wed Oct 10 20:19:24 +0000 2018");
  assert.equal(typeof ms, "number");
  assert.equal(ms, Date.parse("Wed Oct 10 20:19:24 +0000 2018"));
  assert.equal(new Date(ms).getUTCFullYear(), 2018);
});

test("T28: parseTwitterDate returns null for invalid/empty/non-string", () => {
  assert.equal(parseTwitterDate("not a date"), null);
  assert.equal(parseTwitterDate(""), null);
  assert.equal(parseTwitterDate(null), null);
  assert.equal(parseTwitterDate(undefined), null);
  assert.equal(parseTwitterDate(12345), null);
});

// --- T29: normalizeBulkOptions defaults ----------------------------------

test("T29: normalizeBulkOptions defaults on empty input", () => {
  const opts = normalizeBulkOptions({});
  assert.deepEqual(opts, {
    maxTweets: null,
    startDateMs: null,
    endDateMs: null,
    includeImages: true,
    includeVideos: true,
    forceRedownload: false,
    maxConcurrent: 20,
    maxRunMs: 30 * 60 * 1000,
    noNewDataTimeoutMs: 60 * 1000,
  });
});

test("re-fetching what the ledger already has is opt-in and explicit", () => {
  // Anything short of a literal true leaves the archive alone; turning this on
  // by accident would re-download every post the user has ever saved.
  assert.equal(normalizeBulkOptions({ forceRedownload: "yes" }).forceRedownload, false);
  assert.equal(normalizeBulkOptions({ forceRedownload: 1 }).forceRedownload, false);
  assert.equal(normalizeBulkOptions({ forceRedownload: true }).forceRedownload, true);
});

// --- T30: normalizeBulkOptions validation --------------------------------

test("T30: normalizeBulkOptions falls back to defaults on negative/NaN", () => {
  const opts = normalizeBulkOptions({
    maxTweets: "-5",
    maxConcurrent: "abc",
    maxRunMinutes: "0",
    noNewDataTimeoutSec: "-1",
  });
  assert.equal(opts.maxTweets, null);
  assert.equal(opts.maxConcurrent, 20);
  assert.equal(opts.maxRunMs, 30 * 60 * 1000);
  assert.equal(opts.noNewDataTimeoutMs, 60 * 1000);
});

test("T30: normalizeBulkOptions ignores per-job directories", () => {
  const opts = normalizeBulkOptions({ directory: "legacy-folder" });
  assert.equal(Object.hasOwn(opts, "directory"), false);
});

test("T30: normalizeBulkOptions endDate treated as exclusive next-day midnight", () => {
  const opts = normalizeBulkOptions({ startDate: "2024-01-01", endDate: "2024-01-05" });
  const expectedStart = new Date(2024, 0, 1, 0, 0, 0, 0).getTime();
  const expectedEndExclusive = new Date(2024, 0, 6, 0, 0, 0, 0).getTime();
  assert.equal(opts.startDateMs, expectedStart);
  assert.equal(opts.endDateMs, expectedEndExclusive);

  // A tweet created exactly at the end date's midnight (still "that day")
  // must be included: endDateMs - 1ms is inside, endDateMs itself is not.
  const justInside = expectedEndExclusive - 1;
  assert.ok(justInside < opts.endDateMs);
  assert.ok(expectedEndExclusive >= opts.endDateMs);
});

test("T30: normalizeBulkOptions honors explicit includeImages/includeVideos false", () => {
  const opts = normalizeBulkOptions({ includeImages: false, includeVideos: false });
  assert.equal(opts.includeImages, false);
  assert.equal(opts.includeVideos, false);
});

// --- T31: filterMediaByType ----------------------------------------------

const PHOTO = { type: "photo", url: "https://pbs.twimg.com/media/a.jpg?format=jpg", ext: "jpg" };
const VIDEO = { type: "video", url: "https://video.twimg.com/a.mp4", ext: "mp4" };
const GIF = { type: "animated_gif", url: "https://video.twimg.com/a.mp4", ext: "mp4" };

test("T31: filterMediaByType images only", () => {
  const result = filterMediaByType([PHOTO, VIDEO, GIF], {
    includeImages: true,
    includeVideos: false,
  });
  assert.deepEqual(result, [PHOTO]);
});

test("T31: filterMediaByType videos only (gif counted as video)", () => {
  const result = filterMediaByType([PHOTO, VIDEO, GIF], {
    includeImages: false,
    includeVideos: true,
  });
  assert.deepEqual(result, [VIDEO, GIF]);
});

test("T31: filterMediaByType both off yields empty array", () => {
  const result = filterMediaByType([PHOTO, VIDEO, GIF], {
    includeImages: false,
    includeVideos: false,
  });
  assert.deepEqual(result, []);
});

// --- T32: tweetMatchesFilters --------------------------------------------

function baseOpts(extra) {
  return {
    pageScreenName: "alice",
    includeImages: true,
    includeVideos: true,
    startDateMs: null,
    endDateMs: null,
    ...extra,
  };
}

test("T32: tweetMatchesFilters rejects mismatched author", () => {
  const tweet = { authorScreenName: "bob", createdAtMs: 100, media: [PHOTO] };
  const result = tweetMatchesFilters(tweet, baseOpts());
  assert.equal(result.match, false);
  assert.deepEqual(result.media, []);
});

test("T32: tweetMatchesFilters author match is case-insensitive", () => {
  const tweet = { authorScreenName: "ALICE", createdAtMs: 100, media: [PHOTO] };
  const result = tweetMatchesFilters(tweet, baseOpts());
  assert.equal(result.match, true);
});

test("T32: tweetMatchesFilters date range inside/outside/boundaries", () => {
  const opts = baseOpts({ startDateMs: 1000, endDateMs: 2000 });
  const inside = tweetMatchesFilters(
    { authorScreenName: "alice", createdAtMs: 1500, media: [PHOTO] },
    opts
  );
  assert.equal(inside.match, true);

  const atStart = tweetMatchesFilters(
    { authorScreenName: "alice", createdAtMs: 1000, media: [PHOTO] },
    opts
  );
  assert.equal(atStart.match, true);

  const atEndExclusive = tweetMatchesFilters(
    { authorScreenName: "alice", createdAtMs: 2000, media: [PHOTO] },
    opts
  );
  assert.equal(atEndExclusive.match, false);

  const beforeStart = tweetMatchesFilters(
    { authorScreenName: "alice", createdAtMs: 999, media: [PHOTO] },
    opts
  );
  assert.equal(beforeStart.match, false);
});

test("T32: tweetMatchesFilters createdAt null + date filter set -> false", () => {
  const opts = baseOpts({ startDateMs: 1000, endDateMs: 2000 });
  const result = tweetMatchesFilters(
    { authorScreenName: "alice", createdAtMs: null, media: [PHOTO] },
    opts
  );
  assert.equal(result.match, false);
});

test("T32: tweetMatchesFilters createdAt null + no date filter -> true", () => {
  const result = tweetMatchesFilters(
    { authorScreenName: "alice", createdAtMs: null, media: [PHOTO] },
    baseOpts()
  );
  assert.equal(result.match, true);
});

test("T32: tweetMatchesFilters type filter leaves zero media -> false", () => {
  const opts = baseOpts({ includeImages: false, includeVideos: false });
  const result = tweetMatchesFilters(
    { authorScreenName: "alice", createdAtMs: 100, media: [PHOTO, VIDEO] },
    opts
  );
  assert.equal(result.match, false);
  assert.deepEqual(result.media, []);
});

// --- T33: evaluateStop -----------------------------------------------------

function stopState(overrides) {
  return {
    now: 100000,
    startedAtMs: 0,
    lastNewDataAtMs: 100000,
    processedCount: 0,
    oldestSeenCreatedAtMs: null,
    opts: {
      maxTweets: null,
      maxRunMs: 30 * 60 * 1000,
      noNewDataTimeoutMs: 60 * 1000,
      startDateMs: null,
    },
    ...overrides,
  };
}

test("T33: evaluateStop maxTweets", () => {
  const state = stopState({ processedCount: 5, opts: { ...stopState().opts, maxTweets: 5 } });
  assert.deepEqual(evaluateStop(state), { stop: true, reason: "maxTweets" });
});

test("T33: evaluateStop maxTime", () => {
  const state = stopState({ now: 2_000_000, startedAtMs: 0, opts: { ...stopState().opts, maxRunMs: 1_000_000 } });
  assert.deepEqual(evaluateStop(state), { stop: true, reason: "maxTime" });
});

test("T33: evaluateStop noNewData", () => {
  const state = stopState({
    now: 200_000,
    lastNewDataAtMs: 100_000,
    opts: { ...stopState().opts, maxRunMs: 999_999_999, noNewDataTimeoutMs: 60_000 },
  });
  assert.deepEqual(evaluateStop(state), { stop: true, reason: "noNewData" });
});

test("T33: evaluateStop reachedStartDate", () => {
  const state = stopState({
    now: 100_000,
    lastNewDataAtMs: 100_000,
    oldestSeenCreatedAtMs: 500,
    opts: { ...stopState().opts, maxRunMs: 999_999_999, noNewDataTimeoutMs: 999_999_999, startDateMs: 1000 },
  });
  assert.deepEqual(evaluateStop(state), { stop: true, reason: "reachedStartDate" });
});

test("T33: evaluateStop continues when nothing triggers", () => {
  const state = stopState({
    now: 100_050,
    lastNewDataAtMs: 100_000,
    opts: { ...stopState().opts, maxRunMs: 999_999_999, noNewDataTimeoutMs: 999_999_999 },
  });
  assert.deepEqual(evaluateStop(state), { stop: false, reason: null });
});

// --- shouldStopForMaxTweets (per-addTweet cap enforcement) -----------------

test("shouldStopForMaxTweets true once discovered reaches maxTweets", () => {
  assert.equal(shouldStopForMaxTweets(3, 3), true);
  assert.equal(shouldStopForMaxTweets(4, 3), true);
});

test("shouldStopForMaxTweets false while under maxTweets", () => {
  assert.equal(shouldStopForMaxTweets(0, 3), false);
  assert.equal(shouldStopForMaxTweets(2, 3), false);
});

test("shouldStopForMaxTweets false when maxTweets is unlimited (null/undefined)", () => {
  assert.equal(shouldStopForMaxTweets(1000, null), false);
  assert.equal(shouldStopForMaxTweets(1000, undefined), false);
});

// --- T34: BulkSession state machine ---------------------------------------

test("T34: BulkSession start -> pause -> resume -> stop transitions", () => {
  const session = new BulkSession();
  assert.equal(session.stats().state, "idle");

  session.start(normalizeBulkOptions({}));
  assert.equal(session.stats().state, "collecting");

  session.pause();
  assert.equal(session.stats().state, "paused");

  session.resume();
  assert.equal(session.stats().state, "collecting");

  session.stop();
  assert.equal(session.stats().state, "stopped");
  assert.equal(session.stats().stopReason, "userStop");
});

test("T34: BulkSession ignores invalid transitions instead of throwing", () => {
  const session = new BulkSession();
  assert.doesNotThrow(() => session.pause()); // idle -> pause: no-op
  assert.equal(session.stats().state, "idle");

  assert.doesNotThrow(() => session.resume()); // idle -> resume: no-op
  assert.equal(session.stats().state, "idle");

  assert.doesNotThrow(() => session.stop()); // idle -> stop: no-op
  assert.equal(session.stats().state, "idle");

  session.start(normalizeBulkOptions({}));
  session.finish("maxTweets");
  assert.equal(session.stats().state, "complete");

  assert.doesNotThrow(() => session.start(normalizeBulkOptions({}))); // complete -> start: no-op (not idle)
  assert.equal(session.stats().state, "complete");

  assert.doesNotThrow(() => session.pause()); // complete -> pause: no-op
  assert.equal(session.stats().state, "complete");
});

test("T34: BulkSession addTweet dedupes by tweetId", () => {
  const session = new BulkSession();
  session.start(normalizeBulkOptions({}));
  session.addTweet({ tweetId: "1", authorScreenName: "alice", media: [PHOTO] });
  session.addTweet({ tweetId: "1", authorScreenName: "alice", media: [PHOTO] });
  session.addTweet({ tweetId: "2", authorScreenName: "alice", media: [PHOTO] });
  assert.equal(session.stats().discovered, 2);
  assert.equal(session.stats().queued, 2);
});

test("T34: BulkSession stats/takeNext/mark* stay consistent", () => {
  const session = new BulkSession();
  session.start(normalizeBulkOptions({}));
  session.addTweet({ tweetId: "1", authorScreenName: "alice", media: [PHOTO] });
  session.addTweet({ tweetId: "2", authorScreenName: "alice", media: [PHOTO] });
  session.addTweet({ tweetId: "3", authorScreenName: "alice", media: [PHOTO] });

  const first = session.takeNext();
  assert.equal(first.tweetId, "1");
  assert.equal(session.stats().queued, 2);

  session.markDownloaded(first.tweetId);
  assert.equal(session.stats().downloaded, 1);
  assert.equal(session.stats().queued, 2);

  const second = session.takeNext();
  session.markFailed(second.tweetId);
  const third = session.takeNext();
  session.markSkipped(third.tweetId);

  assert.equal(session.takeNext(), null);
  const stats = session.stats();
  assert.equal(stats.discovered, 3);
  assert.equal(stats.queued, 0);
  assert.equal(stats.downloaded, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.skipped, 1);
});

// --- T35: collectTweets extended with createdAt/createdAtMs/fullText ------

test("T35: collectTweets exposes createdAt/createdAtMs/fullText", () => {
  const fixture = loadFixture("timeline_photos.json");
  const tweets = collectTweets(fixture);
  assert.equal(tweets.length, 1);
  // Original T1 assertions still hold.
  assert.equal(tweets[0].tweetId, "1900000000000000001");
  assert.equal(tweets[0].authorScreenName, "alice");
  assert.equal(tweets[0].media.length, 2);
  // New fields.
  assert.equal(tweets[0].createdAt, "Wed Oct 10 20:19:24 +0000 2018");
  assert.equal(tweets[0].createdAtMs, Date.parse("Wed Oct 10 20:19:24 +0000 2018"));
  assert.equal(tweets[0].fullText, "sample tweet with two photos");
});

test("T35: collectTweets defaults createdAt/createdAtMs/fullText to null when absent", () => {
  const fixture = loadFixture("no_media.json");
  const tweets = collectTweets(fixture);
  assert.equal(tweets.length, 1);
  assert.equal(tweets[0].createdAt, null);
  assert.equal(tweets[0].createdAtMs, null);
  assert.equal(tweets[0].fullText, null);
});

// --- T36: buildFilename with custom directory ------------------------------

test("T36: buildFilename with custom directory", () => {
  const result = buildFilename({
    directory: "mydir",
    accountFolder: "acct",
    authorScreenName: "author",
    tweetId: "id",
    serial: 1,
    ext: "jpg",
  });
  assert.equal(result, "mydir/acct/author-id-01.jpg");
});

test("T36: buildFilename sanitizes an unsafe custom directory", () => {
  const result = buildFilename({
    directory: "a<b>:c",
    accountFolder: null,
    authorScreenName: "alice",
    tweetId: "1",
    serial: 1,
    ext: "jpg",
  });
  assert.equal(result, `${sanitizePathSegment("a<b>:c")}/alice-1-01.jpg`);
});

/* Reported, never inferred: X decides which of its media tabs yields photos
 * and which yields videos, and a run should show what it actually collected
 * rather than what the page was assumed to hold. */
test("mediaCounts reports the collected media by type", () => {
  const session = new BulkSession();
  session.start(normalizeBulkOptions({}));
  assert.deepEqual(session.mediaCounts(), { photos: 0, videos: 0 });

  session.addTweet({ tweetId: "1", media: [{ type: "photo" }, { type: "photo" }] });
  session.addTweet({ tweetId: "2", media: [{ type: "video" }] });
  session.addTweet({ tweetId: "3", media: [{ type: "animated_gif" }] });
  session.addTweet({ tweetId: "4", media: [] });
  assert.deepEqual(session.mediaCounts(), { photos: 2, videos: 2 });

  // Counts what was collected, not what is still queued: a downloaded tweet
  // is still part of the run's result.
  session.takeNext();
  assert.deepEqual(session.mediaCounts(), { photos: 2, videos: 2 });
});
