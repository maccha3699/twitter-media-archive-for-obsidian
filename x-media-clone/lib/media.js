// lib/media.js
// Pure logic only: no chrome API / DOM API references (verified by grep during acceptance).
// Responsibilities: resolve a tweet's media entities into a normalized
// MediaItem[] list (variant selection, URL normalization).

/**
 * @typedef {{ type: "photo"|"video"|"animated_gif", url: string, ext: string, mediaKey: string|null, ordinal: number }} MediaItem
 */

/**
 * Extract normalized media items from a tweet "result" object
 * (i.e. tweet_results.result, already unwrapped from TweetWithVisibilityResults).
 * @param {any} tweetResult
 * @returns {MediaItem[]}
 */
export function extractMedia(tweetResult) {
  const mediaList = getMediaEntities(tweetResult);
  if (!Array.isArray(mediaList) || mediaList.length === 0) return [];

  const result = [];
  for (let index = 0; index < mediaList.length; index += 1) {
    const media = mediaList[index];
    if (!media || typeof media !== "object") continue;
    const type = media.type;
    if (type === "photo") {
      const item = extractPhoto(media);
      if (item) result.push(withStableMediaIdentity(item, media, index));
    } else if (type === "video" || type === "animated_gif") {
      const item = extractVideoLike(media, type);
      if (item) result.push(withStableMediaIdentity(item, media, index));
    }
  }
  return result;
}

/**
 * Preserve X's raw media_key without synthesizing it.  The ordinal is based on
 * the original entity position (not just successfully downloadable items), so
 * a malformed/unsupported preceding entity cannot change fallback media keys.
 */
function withStableMediaIdentity(item, media, index) {
  return {
    ...item,
    mediaKey: typeof media.media_key === "string" && media.media_key.trim() !== "" ? media.media_key : null,
    ordinal: index + 1,
  };
}

export function normalizePhotoUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl === "") return null;

  let withoutQuery = rawUrl.split("?")[0];
  let ext = "";

  try {
    const parsed = new URL(rawUrl);
    withoutQuery = parsed.origin + parsed.pathname;
    const format = parsed.searchParams.get("format");
    if (typeof format === "string" && format !== "") {
      ext = format.toLowerCase();
    }
  } catch {
    // Fall back to simple string parsing below.
  }

  const lastDot = withoutQuery.lastIndexOf(".");
  const lastSlash = withoutQuery.lastIndexOf("/");

  let base = withoutQuery;
  if (lastDot > lastSlash) {
    base = withoutQuery.slice(0, lastDot);
    if (!ext) ext = withoutQuery.slice(lastDot + 1).toLowerCase();
  }

  if (!ext) return null;

  return { url: `${base}?format=${ext}&name=orig`, ext };
}

function getMediaEntities(tweetResult) {
  if (!tweetResult || typeof tweetResult !== "object") return [];
  const legacy = tweetResult.legacy;
  if (legacy && typeof legacy === "object" && legacy.extended_entities && Array.isArray(legacy.extended_entities.media)) {
    return legacy.extended_entities.media;
  }
  // Defensive fallback: try directly under tweetResult.
  if (tweetResult.extended_entities && Array.isArray(tweetResult.extended_entities.media)) {
    return tweetResult.extended_entities.media;
  }
  return [];
}

function extractPhoto(media) {
  const normalized = normalizePhotoUrl(media.media_url_https);
  if (!normalized) return null;
  return { type: "photo", url: normalized.url, ext: normalized.ext };
}

function extractVideoLike(media, type) {
  const videoInfo = media.video_info;
  const variants = videoInfo && Array.isArray(videoInfo.variants) ? videoInfo.variants : [];

  let candidates = variants.filter((v) => v && typeof v.bitrate === "number");
  if (candidates.length === 0) {
    candidates = variants.filter((v) => v && v.content_type === "video/mp4");
  }
  if (candidates.length === 0) return null;

  let best = candidates[0];
  for (const v of candidates) {
    if (typeof v.bitrate === "number" && typeof best.bitrate === "number") {
      if (v.bitrate > best.bitrate) best = v;
    }
  }

  const url = best.url;
  if (typeof url !== "string" || url === "") return null;

  let ext = "mp4";
  try {
    const pathname = url.split("?")[0];
    const lastDot = pathname.lastIndexOf(".");
    const lastSlash = pathname.lastIndexOf("/");
    if (lastDot > lastSlash) {
      const candidateExt = pathname.slice(lastDot + 1);
      if (candidateExt) ext = candidateExt.toLowerCase();
    }
  } catch {
    ext = "mp4";
  }

  return { type, url, ext };
}
