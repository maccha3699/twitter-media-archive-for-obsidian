// Pure ArchiveJob v1 contract helpers.  This module deliberately has no
// Chrome, DOM, filesystem, or network dependency so both sides of the archive
// boundary can apply the same validation rules.

/** ArchiveJob v1 is the sole cross-application manifest contract. */
export const ARCHIVE_SCHEMA_VERSION = 1;
// Kept as an explicit alias while callers move to the shorter public name.
export const ARCHIVE_JOB_SCHEMA_VERSION = ARCHIVE_SCHEMA_VERSION;
export const ARCHIVE_JOB_STATES = new Set(["pending", "complete", "partial", "failed"]);
export const ARCHIVE_MEDIA_TYPES = new Set(["photo", "video", "animated_gif"]);
export const ARCHIVE_MEDIA_STATES = new Set(["pending", "complete", "skipped", "failed", "missing"]);

const INVALID_WINDOWS_SEGMENT_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;
const TRAILING_WINDOWS_DOT_OR_SPACE = /[.\s]+$/;
const RESERVED_WINDOWS_SEGMENT = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const DECIMAL_TWEET_ID = /^\d{1,30}$/;
const SAFE_EXTENSION = /^[A-Za-z0-9]{1,10}$/;
// Jobs are generated as UUID v4 values.  Refusing other UUID versions keeps
// the protocol's identifier format deterministic across the extension and
// Companion without accepting merely UUID-shaped values.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(path, message) {
  throw new TypeError(`${path}: ${message}`);
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") fail(path, "must be a non-empty string");
  return value;
}

function nullableString(value, path) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail(path, "must be a string or null");
  return value;
}

function tweetId(value, path, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  const result = requiredString(value, path);
  if (!DECIMAL_TWEET_ID.test(result)) fail(path, "must be a decimal tweet ID");
  return result;
}

function normalizeTimestamp(value, path, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  const source = requiredString(value, path);
  const timestamp = Date.parse(source);
  if (!Number.isFinite(timestamp)) fail(path, "must be an ISO-8601 timestamp");
  return new Date(timestamp).toISOString();
}

/** Return whether value is a canonical RFC 4122 UUID v4 job ID. */
export function isValidJobId(value) {
  return typeof value === "string" && UUID_V4_RE.test(value);
}

/** @deprecated Use isValidJobId. Retained for existing extension callers. */
export function isArchiveJobId(value) {
  return isValidJobId(value);
}

/**
 * Sanitize one Windows filename/path segment.  It never returns an empty or
 * reserved Windows device name.  Use path validation (not this function) for
 * untrusted staging paths, because silently rewriting paths can hide traversal.
 */
export function sanitizeWindowsSegment(value, fallback = "_") {
  let result = String(value ?? "").replace(INVALID_WINDOWS_SEGMENT_CHARS, "_");
  result = result.replace(TRAILING_WINDOWS_DOT_OR_SPACE, "");
  if (result === "" || result === "." || result === "..") result = fallback;
  result = String(result).replace(INVALID_WINDOWS_SEGMENT_CHARS, "_").replace(TRAILING_WINDOWS_DOT_OR_SPACE, "");
  if (result === "" || RESERVED_WINDOWS_SEGMENT.test(result)) result = `_${result}`;
  return result;
}

/**
 * Validate a normalized, forward-slash relative path.  Backslashes are
 * rejected instead of normalized so a Windows traversal cannot be smuggled
 * through a manifest authored for another platform.
 */
export function assertSafeStagingRelativePath(value) {
  const path = requiredString(value, "stagingRelativePath");
  if (path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    fail("stagingRelativePath", "must be a normalized relative path");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("stagingRelativePath", "must not contain empty, dot, or dot-dot segments");
  }
  if (segments.some((segment) => {
    const deviceBase = segment.split(".", 1)[0];
    return sanitizeWindowsSegment(segment) !== segment || RESERVED_WINDOWS_SEGMENT.test(deviceBase);
  })) {
    fail("stagingRelativePath", "contains an unsafe Windows path segment");
  }
  return path;
}

/** Prefer X's mediaKey; otherwise derive the stable tweetId:ordinal:type key. */
export function createMediaKey({ mediaKey, tweetId, ordinal, type }) {
  if (typeof mediaKey === "string" && mediaKey.trim() !== "") return mediaKey;
  const id = requiredString(tweetId, "tweetId");
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) fail("ordinal", "must be a positive safe integer");
  if (!ARCHIVE_MEDIA_TYPES.has(type)) fail("type", "must be a supported media type");
  return `${id}:${ordinal}:${type}`;
}

/**
 * Return the media's X key when available, otherwise its stable fallback key.
 * The argument order intentionally mirrors media extraction: media, tweet ID,
 * then the 1-based ordinal within the tweet.
 */
export function makeMediaKey(media, tweetId, ordinal) {
  if (!isRecord(media)) fail("media", "must be an object");
  return createMediaKey({ ...media, tweetId, ordinal });
}

/** Format a timestamp in the stable Asia/Tokyo note-name form. */
export function formatTokyoNoteTimestamp(createdAt) {
  const date = new Date(normalizeTimestamp(createdAt, "createdAt"));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  return `${part.year}-${part.month}-${part.day}_${part.hour}${part.minute}${part.second}`;
}

/** Build the canonical, chronologically sortable Obsidian note filename. */
export function buildTokyoNoteFilename({ createdAt, text, tweetId }) {
  const id = sanitizeWindowsSegment(requiredString(tweetId, "tweetId"));
  const snippet = Array.from(typeof text === "string" ? text : "").slice(0, 32).join("").trim();
  const title = sanitizeWindowsSegment(snippet || "post", "post");
  return `${formatTokyoNoteTimestamp(createdAt)} - ${title} - ${id}.md`;
}

function normalizeAuthor(author, path) {
  if (!isRecord(author)) fail(path, "must be an object");
  const urls = author.urls === undefined || author.urls === null ? [] : author.urls;
  if (!Array.isArray(urls) || urls.some((url) => typeof url !== "string")) fail(`${path}.urls`, "must be an array of strings");
  const location = author.location === undefined ? undefined : nullableString(author.location, `${path}.location`);
  const followers = author.followers === undefined ? undefined : author.followers;
  if (followers !== undefined && followers !== null && (!Number.isSafeInteger(followers) || followers < 0)) {
    fail(`${path}.followers`, "must be a non-negative integer or null");
  }
  return {
    ...author,
    id: nullableString(author.id, `${path}.id`),
    screenName: requiredString(author.screenName, `${path}.screenName`),
    displayName: nullableString(author.displayName, `${path}.displayName`),
    bio: nullableString(author.bio, `${path}.bio`),
    urls: [...urls],
    ...(location === undefined ? {} : { location }),
    ...(followers === undefined ? {} : { followers }),
  };
}

function normalizeReplyTree(value, path) {
  if (!isRecord(value)) fail(path, "must be an object");
  const position = value.position;
  const size = value.size;
  if (!Number.isSafeInteger(position) || position < 1) fail(`${path}.position`, "must be a positive safe integer");
  if (!Number.isSafeInteger(size) || size < 2 || size > 50 || position > size) fail(`${path}.size`, "must be between 2 and 50");
  if (typeof value.partial !== "boolean") fail(`${path}.partial`, "must be a boolean");
  return {
    ...value,
    rootTweetId: tweetId(value.rootTweetId, `${path}.rootTweetId`),
    previousTweetId: tweetId(value.previousTweetId, `${path}.previousTweetId`, true),
    nextTweetId: tweetId(value.nextTweetId, `${path}.nextTweetId`, true),
    position,
    size,
    partial: value.partial,
  };
}

function normalizeMedia(media, index, tweetId, path) {
  if (!isRecord(media)) fail(path, "must be an object");
  const ordinal = media.ordinal === undefined ? index + 1 : media.ordinal;
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) fail(`${path}.ordinal`, "must be a positive safe integer");
  if (!ARCHIVE_MEDIA_TYPES.has(media.type)) fail(`${path}.type`, "must be photo, video, or animated_gif");
  const downloadState = media.downloadState ?? "pending";
  if (!ARCHIVE_MEDIA_STATES.has(downloadState)) fail(`${path}.downloadState`, "must be a supported media state");
  const stagingRelativePath = media.stagingRelativePath === null || media.stagingRelativePath === undefined
    ? null
    : assertSafeStagingRelativePath(media.stagingRelativePath);
  const extension = nullableString(media.extension, `${path}.extension`);
  if (extension !== null && !SAFE_EXTENSION.test(extension)) fail(`${path}.extension`, "is unsafe");
  if (downloadState === "complete" && stagingRelativePath === null) {
    fail(`${path}.stagingRelativePath`, "complete media requires stagingRelativePath");
  }
  // Carried to the consumer so a failed download can explain itself there; the
  // consumer renders it into a note, so it is bounded and single-line.
  const error = media.error === null || media.error === undefined
    ? null
    : nullableString(media.error, `${path}.error`)?.replace(/[\r\n\t]+/g, " ").slice(0, 256) ?? null;
  return {
    ...media,
    error,
    mediaKey: createMediaKey({ mediaKey: media.mediaKey, tweetId, ordinal, type: media.type }),
    ordinal,
    type: media.type,
    extension: extension === null ? null : extension.replace(/^\.+/, "").toLowerCase(),
    stagingRelativePath,
    downloadState,
  };
}

function normalizePost(post, index) {
  const path = `posts[${index}]`;
  if (!isRecord(post)) fail(path, "must be an object");
  const tweetIdValue = tweetId(post.tweetId, `${path}.tweetId`);
  if (!Array.isArray(post.media)) fail(`${path}.media`, "must be an array");
  const directReplyFields = {};
  for (const field of ["replyToTweetId", "replyToUserId", "conversationId"]) {
    if (post[field] !== undefined) directReplyFields[field] = tweetId(post[field], `${path}.${field}`, true);
  }
  const metadataStatus = post.metadataStatus === undefined ? undefined : requiredString(post.metadataStatus, `${path}.metadataStatus`);
  if (metadataStatus !== undefined && metadataStatus !== "complete" && metadataStatus !== "incomplete") {
    fail(`${path}.metadataStatus`, "must be complete or incomplete");
  }
  const profileMetadataStatus = post.profileMetadataStatus === undefined ? undefined : requiredString(post.profileMetadataStatus, `${path}.profileMetadataStatus`);
  if (profileMetadataStatus !== undefined && profileMetadataStatus !== "observed" && profileMetadataStatus !== "profile-pending") {
    fail(`${path}.profileMetadataStatus`, "must be observed or profile-pending");
  }
  return {
    ...post,
    tweetId: tweetIdValue,
    tweetUrl: requiredString(post.tweetUrl, `${path}.tweetUrl`),
    text: nullableString(post.text, `${path}.text`),
    createdAt: normalizeTimestamp(post.createdAt, `${path}.createdAt`, true),
    author: normalizeAuthor(post.author, `${path}.author`),
    media: post.media.map((media, mediaIndex) => normalizeMedia(media, mediaIndex, tweetIdValue, `${path}.media[${mediaIndex}]`)),
    ...directReplyFields,
    ...(metadataStatus === undefined ? {} : { metadataStatus }),
    ...(profileMetadataStatus === undefined ? {} : { profileMetadataStatus }),
    ...(post.replyTree === undefined ? {} : { replyTree: normalizeReplyTree(post.replyTree, `${path}.replyTree`) }),
  };
}

function validateReplyTreeConsistency(posts) {
  const postsById = new Map(posts.map((post) => [post.tweetId, post]));
  const sameAuthor = (left, right) => left.author.id !== null && right.author.id !== null
    ? left.author.id === right.author.id
    : left.author.screenName.toLowerCase() === right.author.screenName.toLowerCase();
  const groups = new Map();
  for (const post of posts) {
    if (!post.replyTree) continue;
    for (const related of [post.replyTree.rootTweetId, post.replyTree.previousTweetId, post.replyTree.nextTweetId]) {
      const target = related === null ? null : postsById.get(related);
      if (related !== null && !target) fail("post.replyTree", "references a post outside the job");
      if (target && !sameAuthor(target, post)) fail("post.replyTree", "crosses authors");
    }
    const group = groups.get(post.replyTree.rootTweetId) ?? [];
    group.push(post);
    groups.set(post.replyTree.rootTweetId, group);
  }
  for (const [rootTweetId, group] of groups) {
    const ordered = [...group].sort((left, right) => left.replyTree.position - right.replyTree.position);
    const size = ordered[0].replyTree.size;
    const partial = ordered[0].replyTree.partial;
    if (ordered.length !== size || ordered.some((post) => post.replyTree.size !== size || post.replyTree.partial !== partial)
      || ordered[0].tweetId !== rootTweetId || ordered[0].replyTree.position !== 1
      || ordered.some((post, index) => post.replyTree.position !== index + 1
        || post.replyTree.previousTweetId !== (index > 0 ? ordered[index - 1].tweetId : null)
        || post.replyTree.nextTweetId !== (index + 1 < ordered.length ? ordered[index + 1].tweetId : null))) {
      fail("post.replyTree", "chain metadata is inconsistent");
    }
  }
}

/**
 * Validate and normalize ArchiveJob v1.  Unknown fields are retained at every
 * level for forward-compatible producers; unknown schema versions are refused.
 */
export function normalizeArchiveJob(input) {
  if (!isRecord(input)) fail("ArchiveJob", "must be an object");
  if (input.schemaVersion !== ARCHIVE_JOB_SCHEMA_VERSION) {
    fail("schemaVersion", `unsupported schema version ${String(input.schemaVersion)}`);
  }
  if (!isValidJobId(input.jobId)) fail("jobId", "must be a canonical UUID v4");
  if (typeof input.mode !== "string" || !["manual", "bulk"].includes(input.mode)) {
    fail("mode", "must be manual or bulk");
  }
  // A manifest is only published after all of its chunks and download states
  // are final.  Pending/partial jobs remain in the extension's private state.
  if (input.state !== "complete") fail("state", "must be complete");
  if (!Array.isArray(input.posts)) fail("posts", "must be an array");
  const posts = input.posts.map(normalizePost);
  validateReplyTreeConsistency(posts);
  return {
    ...input,
    schemaVersion: ARCHIVE_JOB_SCHEMA_VERSION,
    jobId: input.jobId.toLowerCase(),
    mode: input.mode,
    state: input.state,
    createdAt: normalizeTimestamp(input.createdAt, "createdAt"),
    posts,
  };
}

/** A non-throwing validation helper for UI and diagnostics code. */
export function validateArchiveJob(input) {
  try {
    return { ok: true, value: normalizeArchiveJob(input), errors: [] };
  } catch (error) {
    return { ok: false, value: null, errors: [error instanceof Error ? error.message : String(error)] };
  }
}
