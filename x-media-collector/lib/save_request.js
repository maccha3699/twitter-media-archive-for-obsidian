import { makeMediaKey } from "./archive_contract.js";

const SAVE_MODES = new Set(["manual", "bulk"]);

function nullableString(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function authorFromTweet(tweet) {
  const source = tweet.author && typeof tweet.author === "object" ? tweet.author : {};
  const screenName =
    nullableString(source.screenName) || nullableString(tweet.authorScreenName) || "unknown";
  return {
    id: nullableString(source.id),
    screenName,
    displayName: nullableString(source.displayName),
    bio: nullableString(source.bio),
    urls: Array.isArray(source.urls)
      ? source.urls.filter((url) => typeof url === "string" && url !== "")
      : [],
    // Shown next to the bio on a profile page. `location` is free text that
    // authors often use for a contact address rather than a place.
    location: nullableString(source.location),
    followers: Number.isSafeInteger(source.followers) && source.followers >= 0 ? source.followers : null,
  };
}

function extensionFromMedia(media) {
  const value = nullableString(media.extension) || nullableString(media.ext);
  return value ? value.replace(/^\.+/, "").toLowerCase() : null;
}

function nullableTweetId(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) {
    throw new TypeError(`${field} must be a tweet ID or null`);
  }
  return value;
}

function normalizeReplyTree(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("replyTree must be an object");
  const decimalId = (item, field, nullable = false) => {
    if (nullable && (item === null || item === undefined)) return null;
    if (typeof item !== "string" || !/^\d{1,30}$/.test(item)) {
      throw new TypeError(`replyTree.${field} must be a tweet ID`);
    }
    return item;
  };
  if (!Number.isSafeInteger(value.position) || value.position < 1) {
    throw new TypeError("replyTree.position must be positive");
  }
  if (!Number.isSafeInteger(value.size) || value.size < 2 || value.size > 50 || value.position > value.size) {
    throw new TypeError("replyTree.size must be between 2 and 50");
  }
  return {
    rootTweetId: decimalId(value.rootTweetId, "rootTweetId"),
    previousTweetId: decimalId(value.previousTweetId, "previousTweetId", true),
    nextTweetId: decimalId(value.nextTweetId, "nextTweetId", true),
    position: value.position,
    size: value.size,
    partial: value.partial === true,
  };
}

/**
 * Build the sole content-script to service-worker save contract. Source URLs
 * are private download inputs; the service worker removes them from the
 * ArchiveJob manifest published to Downloads.
 */
export function buildSavePostRequest(tweet, {
  mode,
  jobId = null,
  forceRedownload = false,
  includePostWhenMediaSkipped = false,
  allowNoMedia = false,
} = {}) {
  if (!tweet || typeof tweet !== "object") throw new TypeError("tweet must be an object");
  if (!SAVE_MODES.has(mode)) throw new TypeError("mode must be manual or bulk");
  if (includePostWhenMediaSkipped && mode !== "bulk") {
    throw new TypeError("includePostWhenMediaSkipped is only valid for bulk jobs");
  }
  if (allowNoMedia && !includePostWhenMediaSkipped) {
    throw new TypeError("allowNoMedia requires includePostWhenMediaSkipped");
  }
  if (typeof tweet.tweetId !== "string" || tweet.tweetId === "") {
    throw new TypeError("tweetId must be a non-empty string");
  }
  if (!Array.isArray(tweet.media) || (!allowNoMedia && tweet.media.length === 0)) {
    throw new TypeError(allowNoMedia ? "tweet.media must be an array" : "tweet must contain media");
  }

  const author = authorFromTweet(tweet);
  const replyTree = normalizeReplyTree(tweet.replyTree);
  const media = tweet.media.map((item, index) => {
    if (!item || typeof item !== "object" || typeof item.url !== "string" || item.url === "") {
      throw new TypeError(`media[${index}].url must be a non-empty string`);
    }
    const type = typeof item.type === "string" ? item.type : "photo";
    const ordinal = Number.isSafeInteger(item.ordinal) && item.ordinal > 0 ? item.ordinal : index + 1;
    return {
      mediaKey: makeMediaKey({ ...item, type }, tweet.tweetId, ordinal),
      ordinal,
      type,
      extension: extensionFromMedia(item),
      sourceUrl: item.url,
    };
  });

  return {
    mode,
    jobId,
    // Every request originates from a direct user click (manual save or the
    // bulk Start button). This is the explicit retry signal; the service
    // worker never retries failed media on timers or recovery by itself.
    retryFailed: true,
    // Set by the user, never by the code: the archive lost a file the ledger
    // still counts as saved, and only the user can know that.
    forceRedownload: forceRedownload === true,
    // A direct reply-tree save must still publish text-only and already
    // archived posts so Companion can build one aggregate note without a
    // redundant media download.
    includePostWhenMediaSkipped: includePostWhenMediaSkipped === true,
    post: {
      tweetId: tweet.tweetId,
      tweetUrl: `https://x.com/${author.screenName}/status/${tweet.tweetId}`,
      text: nullableString(tweet.text) || nullableString(tweet.fullText),
      createdAt: nullableString(tweet.createdAt),
      replyToTweetId: nullableTweetId(tweet.replyToTweetId, "replyToTweetId"),
      replyToUserId: nullableTweetId(tweet.replyToUserId, "replyToUserId"),
      conversationId: nullableTweetId(tweet.conversationId, "conversationId"),
      profileMetadataStatus: tweet.profileMetadataStatus === "observed" ? "observed" : "profile-pending",
      author,
      media,
      ...(replyTree ? { replyTree } : {}),
    },
  };
}
