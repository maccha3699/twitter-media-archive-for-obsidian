// lib/bulk.js
// Pure logic only: no chrome API / DOM API references (verified by grep during acceptance).
// Responsibilities: bulk-download engine logic for the /media profile page —
// twitter date parsing, option normalization, media/date filtering,
// stop-condition evaluation, and the BulkSession state machine.
// This module has zero knowledge of chrome.* or document/window — the UI
// layer (content_main.js) is the only place those are touched. What x.com's
// pages look like lives in lib/x_surface.js, so this engine never learns which
// version of the site produced the tweets it is filtering.

/**
 * Parse a legacy.created_at style date string
 * (e.g. "Wed Oct 10 20:19:24 +0000 2018") into epoch milliseconds.
 * Invalid/empty/non-string input returns null.
 * @param {unknown} s
 * @returns {number|null}
 */
export function parseTwitterDate(s) {
  if (typeof s !== "string" || s === "") return null;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  return ms;
}

const DEFAULT_MAX_CONCURRENT = 20;
const DEFAULT_MAX_RUN_MINUTES = 30;
const DEFAULT_NO_NEW_DATA_TIMEOUT_SEC = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

// Accepts strings/numbers coming from a <input type="number"> (always a
// string in practice, but tolerate a real number too). Empty/missing/NaN/
// less-than-1 all fall back to `fallback`.
function parsePositiveInt(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? Math.trunc(value) : parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

// Parses a <input type="date"> value ("YYYY-MM-DD") into the epoch ms of
// local midnight for that day. Invalid/empty input returns null.
function parseDateOnlyMs(s) {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const d = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (Number.isNaN(d.getTime())) return null;
  // Reject overflowed dates (e.g. 2024-02-30 silently rolling to March).
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return d.getTime();
}

/**
 * @typedef {object} BulkOptions
 * @property {number|null} maxTweets
 * @property {number|null} startDateMs
 * @property {number|null} endDateMs
 * @property {boolean} includeImages
 * @property {boolean} includeVideos
 * @property {number} maxConcurrent
 * @property {number} maxRunMs
 * @property {number} noNewDataTimeoutMs
 */

/**
 * Normalize raw modal input (all strings/booleans) into a BulkOptions
 * object with defaults applied.
 * @param {object} raw
 * @returns {BulkOptions}
 */
export function normalizeBulkOptions(raw) {
  const source = raw && typeof raw === "object" ? raw : {};

  const maxTweets = parsePositiveInt(source.maxTweets, null);
  const maxConcurrent = parsePositiveInt(source.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  const maxRunMinutes = parsePositiveInt(source.maxRunMinutes, DEFAULT_MAX_RUN_MINUTES);
  const noNewDataTimeoutSec = parsePositiveInt(
    source.noNewDataTimeoutSec,
    DEFAULT_NO_NEW_DATA_TIMEOUT_SEC
  );

  const startDateMs = parseDateOnlyMs(source.startDate);
  const endDateOnlyMs = parseDateOnlyMs(source.endDate);
  // Inclusive of the end date itself: upper bound is the *next* day's
  // midnight, used as an exclusive bound by callers ([start, end)).
  const endDateMs = endDateOnlyMs === null ? null : endDateOnlyMs + DAY_MS;

  const includeImages = source.includeImages !== false;
  const includeVideos = source.includeVideos !== false;
  // Opt-in only. Defaulting this on would re-fetch the whole archive.
  const forceRedownload = source.forceRedownload === true;

  return {
    maxTweets,
    startDateMs,
    endDateMs,
    includeImages,
    includeVideos,
    forceRedownload,
    maxConcurrent,
    maxRunMs: maxRunMinutes * 60 * 1000,
    noNewDataTimeoutMs: noNewDataTimeoutSec * 1000,
  };
}

/**
 * Filter a tweet's media list by the includeImages/includeVideos options.
 * @param {import("./media.js").MediaItem[]} media
 * @param {{includeImages: boolean, includeVideos: boolean}} opts
 * @returns {import("./media.js").MediaItem[]}
 */
export function filterMediaByType(media, opts) {
  if (!Array.isArray(media)) return [];
  const includeImages = Boolean(opts && opts.includeImages);
  const includeVideos = Boolean(opts && opts.includeVideos);
  return media.filter((item) => {
    if (!item || typeof item !== "object") return false;
    if (item.type === "photo") return includeImages;
    if (item.type === "video" || item.type === "animated_gif") return includeVideos;
    return false;
  });
}

/**
 * Decide whether `tweet` belongs in the bulk-download set: same author as
 * the /media page owner (case-insensitive), inside the [startDateMs,
 * endDateMs) window (if any date filter is set), and has at least one media
 * item surviving the type filter.
 * @param {object} tweet
 * @param {BulkOptions & {pageScreenName: string}} opts
 * @returns {{match: boolean, media: import("./media.js").MediaItem[]}}
 */
export function tweetMatchesFilters(tweet, opts) {
  const noMatch = { match: false, media: [] };
  if (!tweet || typeof tweet !== "object") return noMatch;
  if (!opts || typeof opts !== "object") return noMatch;

  const pageScreenName = opts.pageScreenName;
  if (typeof pageScreenName !== "string" || typeof tweet.authorScreenName !== "string") {
    return noMatch;
  }
  if (pageScreenName.toLowerCase() !== tweet.authorScreenName.toLowerCase()) {
    return noMatch;
  }

  const hasDateFilter = opts.startDateMs != null || opts.endDateMs != null;
  if (hasDateFilter) {
    const createdAtMs = tweet.createdAtMs;
    if (createdAtMs === null || createdAtMs === undefined) return noMatch;
    if (opts.startDateMs != null && createdAtMs < opts.startDateMs) return noMatch;
    if (opts.endDateMs != null && createdAtMs >= opts.endDateMs) return noMatch;
  }

  const media = filterMediaByType(tweet.media, opts);
  if (media.length === 0) return noMatch;

  return { match: true, media };
}

/**
 * @typedef {object} StopState
 * @property {number} now
 * @property {number|null} startedAtMs
 * @property {number|null} lastNewDataAtMs
 * @property {number} processedCount
 * @property {number|null} oldestSeenCreatedAtMs
 * @property {BulkOptions} opts
 */

/**
 * Evaluate whether the bulk session should stop, and why. Checked in order:
 * maxTweets -> maxTime -> noNewData -> reachedStartDate.
 * @param {StopState} state
 * @returns {{stop: boolean, reason: "maxTweets"|"maxTime"|"noNewData"|"reachedStartDate"|null}}
 */
export function evaluateStop(state) {
  const { now, startedAtMs, lastNewDataAtMs, processedCount, oldestSeenCreatedAtMs, opts } =
    state || {};

  if (opts && opts.maxTweets != null && processedCount >= opts.maxTweets) {
    return { stop: true, reason: "maxTweets" };
  }

  if (opts && opts.maxRunMs != null && startedAtMs != null && now - startedAtMs >= opts.maxRunMs) {
    return { stop: true, reason: "maxTime" };
  }

  if (
    opts &&
    opts.noNewDataTimeoutMs != null &&
    lastNewDataAtMs != null &&
    now - lastNewDataAtMs >= opts.noNewDataTimeoutMs
  ) {
    return { stop: true, reason: "noNewData" };
  }

  if (
    oldestSeenCreatedAtMs != null &&
    opts &&
    opts.startDateMs != null &&
    oldestSeenCreatedAtMs < opts.startDateMs
  ) {
    return { stop: true, reason: "reachedStartDate" };
  }

  return { stop: false, reason: null };
}

/**
 * Pure predicate used to enforce the maxTweets cap the instant a tweet is
 * discovered (rather than waiting for the next 1s evaluateStop poll, which
 * lets a synchronous cache-replay loop or a single scroll batch overshoot
 * the limit by dozens of tweets). `discovered` is the session's current
 * BulkSession.stats().discovered count; `maxTweets` is opts.maxTweets
 * (null/undefined means unlimited).
 * @param {number} discovered
 * @param {number|null|undefined} maxTweets
 * @returns {boolean}
 */
export function shouldStopForMaxTweets(discovered, maxTweets) {
  if (maxTweets === null || maxTweets === undefined) return false;
  return discovered >= maxTweets;
}

const NON_TERMINAL_STATES = new Set(["collecting", "paused"]);

/**
 * State machine for a single bulk-download run.
 * idle -> collecting <-> paused -> (complete|stopped|error)
 * All mutating methods silently ignore invalid transitions (never throw).
 */
export class BulkSession {
  constructor() {
    this.state = "idle";
    this.opts = null;
    this.stopReason = null;
    this.errorMessage = null;
    this.tweets = new Map(); // tweetId -> { tweet, status }
    this.queueOrder = [];
  }

  start(opts) {
    if (this.state !== "idle") return;
    this.opts = opts;
    this.state = "collecting";
    this.stopReason = null;
    this.errorMessage = null;
    this.tweets = new Map();
    this.queueOrder = [];
  }

  pause() {
    if (this.state !== "collecting") return;
    this.state = "paused";
  }

  resume() {
    if (this.state !== "paused") return;
    this.state = "collecting";
  }

  stop() {
    if (!NON_TERMINAL_STATES.has(this.state)) return;
    this.state = "stopped";
    this.stopReason = "userStop";
  }

  finish(reason) {
    if (!NON_TERMINAL_STATES.has(this.state)) return;
    this.state = "complete";
    this.stopReason = reason || null;
  }

  fail(msg) {
    if (!NON_TERMINAL_STATES.has(this.state)) return;
    this.state = "error";
    this.errorMessage = msg || null;
  }

  addTweet(tweet) {
    if (!tweet || typeof tweet.tweetId !== "string") return;
    if (this.tweets.has(tweet.tweetId)) return;
    this.tweets.set(tweet.tweetId, { tweet, status: "queued" });
    this.queueOrder.push(tweet.tweetId);
  }

  takeNext() {
    while (this.queueOrder.length > 0) {
      const tweetId = this.queueOrder.shift();
      const entry = this.tweets.get(tweetId);
      if (entry && entry.status === "queued") {
        entry.status = "downloading";
        return entry.tweet;
      }
    }
    return null;
  }

  markDownloaded(tweetId) {
    this._mark(tweetId, "downloaded");
  }

  markSkipped(tweetId) {
    this._mark(tweetId, "skipped");
  }

  markFailed(tweetId) {
    this._mark(tweetId, "failed");
  }

  _mark(tweetId, status) {
    const entry = this.tweets.get(tweetId);
    if (!entry) return;
    entry.status = status;
  }

  /**
   * What this session actually collected, by media type. Reported instead of
   * inferred: X decides which tab yields which kinds, and a run should show
   * what it got rather than what the page was expected to hold.
   * @returns {{photos: number, videos: number}}
   */
  mediaCounts() {
    let photos = 0;
    let videos = 0;
    for (const entry of this.tweets.values()) {
      const media = Array.isArray(entry.tweet?.media) ? entry.tweet.media : [];
      for (const item of media) {
        if (item && item.type === "photo") photos += 1;
        else if (item) videos += 1;
      }
    }
    return { photos, videos };
  }

  stats() {
    let queued = 0;
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    for (const entry of this.tweets.values()) {
      if (entry.status === "queued") queued += 1;
      else if (entry.status === "downloaded") downloaded += 1;
      else if (entry.status === "skipped") skipped += 1;
      else if (entry.status === "failed") failed += 1;
    }
    return {
      state: this.state,
      discovered: this.tweets.size,
      queued,
      downloaded,
      skipped,
      failed,
      stopReason: this.stopReason,
    };
  }
}
