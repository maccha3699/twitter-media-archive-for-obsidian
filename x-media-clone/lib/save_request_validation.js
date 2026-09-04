// Pure trust-boundary validation for SavePostRequest values crossing into the
// service worker. This module intentionally has no browser, storage, listener,
// or network dependency; the URL constructor only parses the supplied CDN URL.

/** Validate and return the original SavePostRequest object. */
export function assertSavePostRequest(request) {
  if (!request || typeof request !== "object") throw new TypeError("save request must be an object");
  if (request.mode !== "manual" && request.mode !== "bulk") throw new TypeError("save mode is invalid");
  if (request.includePostWhenMediaSkipped === true && request.mode !== "bulk") {
    throw new TypeError("only bulk jobs may include posts whose media was skipped");
  }
  const post = request.post;
  if (!post || typeof post !== "object" || typeof post.tweetId !== "string" || !Array.isArray(post.media)) {
    throw new TypeError("save request post is invalid");
  }
  if (!post.author || typeof post.author.screenName !== "string") throw new TypeError("save request author is invalid");
  if (!/^\d+$/.test(post.tweetId) || typeof post.tweetUrl !== "string") throw new TypeError("save request tweet identity is invalid");
  for (const field of ["replyToTweetId", "replyToUserId", "conversationId"]) {
    if (post[field] !== null && post[field] !== undefined
      && (typeof post[field] !== "string" || !/^\d{1,30}$/.test(post[field]))) {
      throw new TypeError(`save request ${field} is invalid`);
    }
  }
  if (post.replyTree !== undefined) {
    const tree = post.replyTree;
    const validId = (value, nullable = false) =>
      (nullable && value === null) || (typeof value === "string" && /^\d{1,30}$/.test(value));
    if (!tree || typeof tree !== "object" || Array.isArray(tree)
      || !validId(tree.rootTweetId) || !validId(tree.previousTweetId, true) || !validId(tree.nextTweetId, true)
      || !Number.isSafeInteger(tree.position) || tree.position < 1
      || !Number.isSafeInteger(tree.size) || tree.size < 2 || tree.size > 50 || tree.position > tree.size
      || typeof tree.partial !== "boolean") {
      throw new TypeError("save request reply tree is invalid");
    }
  }
  const mediaKeys = new Set();
  const ordinals = new Set();
  for (const [index, media] of post.media.entries()) {
    if (!media || typeof media !== "object") throw new TypeError(`media[${index}] is invalid`);
    if (typeof media.mediaKey !== "string" || media.mediaKey === "" || mediaKeys.has(media.mediaKey)) {
      throw new TypeError("media keys must be non-empty and unique");
    }
    if (!Number.isSafeInteger(media.ordinal) || media.ordinal < 1 || ordinals.has(media.ordinal)) {
      throw new TypeError("media ordinals must be positive and unique");
    }
    if (!new Set(["photo", "video", "animated_gif"]).has(media.type)) throw new TypeError("media type is unsupported");
    let source;
    try { source = new URL(media.sourceUrl); } catch { throw new TypeError("media source URL is invalid"); }
    if (source.protocol !== "https:" || !(source.hostname === "twimg.com" || source.hostname.endsWith(".twimg.com"))) {
      throw new TypeError("media source URL must use an X CDN HTTPS host");
    }
    mediaKeys.add(media.mediaKey);
    ordinals.add(media.ordinal);
  }
  return request;
}
