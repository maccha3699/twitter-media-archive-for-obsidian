// lib/graphql_extract.js
// Pure logic only: no chrome API / DOM API references (verified by grep during acceptance).
// Responsibilities: walk an arbitrary GraphQL response JSON tree and collect
// normalized tweet objects (envelope-agnostic recursive walker).

import { extractMedia } from "./media.js";
import { parseTwitterDate } from "./bulk.js";

const MAX_DEPTH = 50;

/**
 * @typedef {{ tweetId: string, author: { id: string|null, screenName: string|null, displayName: string|null, bio: string|null, urls: string[] }, authorScreenName: string, media: import("./media.js").MediaItem[], createdAt: string|null, createdAtMs: number|null, fullText: string|null, replyToTweetId: string|null, replyToUserId: string|null, conversationId: string|null }} NormalizedTweet
 */

/**
 * Recursively walk `root` and collect every node that looks like a Tweet
 * (__typename === "Tweet" && typeof rest_id === "string"), as well as the
 * inner tweet of any TweetWithVisibilityResults wrapper (used for /media
 * and sensitive/limited-visibility tweets, whose inner .tweet object lacks
 * __typename but carries rest_id/legacy/core). Continues recursing into a
 * matched node's descendants so nested/quoted tweets are also collected.
 * Results are deduplicated by tweetId.
 * @param {any} root
 * @returns {NormalizedTweet[]}
 */
export function collectTweets(root) {
  const found = new Map();
  const visited = new WeakSet();
  walk(root, 0, found, visited);
  return Array.from(found.values());
}

/** Collect normalized user records from UserByScreenName and embedded user results. */
export function collectProfiles(root) {
  const found = new Map(); const visited = new WeakSet();
  function visit(node, depth) {
    if (depth > MAX_DEPTH || node === null || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);
    if (looksLikeUser(node)) {
      const profile = normalizeUserResult(node);
      const key = profile.id ? `id:${profile.id}` : profile.screenName ? `screen:${profile.screenName.toLowerCase()}` : null;
      if (key) found.set(key, mergeProfile(found.get(key), profile));
    }
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    for (const key of Object.keys(node)) visit(node[key], depth + 1);
  }
  visit(root, 0);
  return Array.from(found.values());
}

/**
 * The original post behind a retweet, or null for anything else.
 *
 * X mirrors the original's `extended_entities` onto the retweet wrapper, so a
 * wrapper normalizes into a post that claims the retweeter authored someone
 * else's media, at a status URL belonging to neither.  Collecting the original
 * instead keeps the media with its author, and lets a profile bulk save drop
 * retweets through the screen-name filter it already applies.
 */
function retweetedOriginal(node) {
  const result = node.legacy?.retweeted_status_result?.result;
  if (result === null || typeof result !== "object") return null;
  const inner = typeof result.rest_id === "string" ? result : result.tweet;
  return inner !== null && typeof inner === "object" && typeof inner.rest_id === "string" ? inner : null;
}

function collectTweet(candidate, found) {
  const tweet = retweetedOriginal(candidate) ?? candidate;
  if (!found.has(tweet.rest_id)) {
    found.set(tweet.rest_id, normalizeTweet(tweet));
  }
}

function walk(node, depth, found, visited) {
  if (depth > MAX_DEPTH) return;
  if (node === null || typeof node !== "object") return;
  if (visited.has(node)) return;
  visited.add(node);

  if (node.__typename === "Tweet" && typeof node.rest_id === "string") {
    collectTweet(node, found);
    // Continue into descendants: quoted tweets nest another Tweet node.
  }

  if (
    node.__typename === "TweetWithVisibilityResults" &&
    node.tweet !== null &&
    typeof node.tweet === "object" &&
    typeof node.tweet.rest_id === "string"
  ) {
    collectTweet(node.tweet, found);
    // Continue into descendants: quoted tweets may nest further Tweet nodes.
  }

  if (Array.isArray(node)) {
    for (const item of node) walk(item, depth + 1, found, visited);
    return;
  }

  for (const key of Object.keys(node)) {
    walk(node[key], depth + 1, found, visited);
  }
}

function normalizeTweet(tweetNode) {
  const legacy = tweetNode && typeof tweetNode === "object" ? tweetNode.legacy : null;
  const createdAt =
    legacy && typeof legacy === "object" && typeof legacy.created_at === "string"
      ? legacy.created_at
      : null;
  const fullText =
    legacy && typeof legacy === "object" && typeof legacy.full_text === "string"
      ? legacy.full_text
      : null;

  const author = extractAuthor(tweetNode);
  return {
    tweetId: tweetNode.rest_id,
    author,
    // Existing download and bulk code expects a non-empty string here.  Keep
    // that boundary compatible while exposing nullable canonical author data.
    authorScreenName: author.screenName ?? "unknown",
    media: extractMedia(tweetNode),
    createdAt,
    createdAtMs: createdAt !== null ? parseTwitterDate(createdAt) : null,
    fullText,
    // These are the relationship fields carried by X's Tweet `legacy` node.
    // Keep them in the X-only extraction layer so the archive contract and
    // Companion never need to understand a GraphQL response shape.
    replyToTweetId: firstNonEmptyString(legacy?.in_reply_to_status_id_str),
    replyToUserId: firstNonEmptyString(legacy?.in_reply_to_user_id_str),
    conversationId: firstNonEmptyString(legacy?.conversation_id_str),
  };
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
function looksLikeUser(value) {
  if (!asRecord(value) || (value.__typename !== undefined && value.__typename !== "User")) return false;
  const legacy = asRecord(value.legacy) ? value.legacy : {}; const core = asRecord(value.core) ? value.core : {};
  return firstNonEmptyString(value.rest_id, value.id_str, value.id, legacy.id_str, core.id) !== null
    && firstNonEmptyString(legacy.screen_name, core.screen_name) !== null;
}
function mergeProfile(previous, next) {
  if (!previous) return next;
  return {
    id: next.id ?? previous.id, screenName: next.screenName ?? previous.screenName,
    displayName: next.displayName ?? previous.displayName, bio: next.bio ?? previous.bio,
    urls: [...new Set([...(previous.urls ?? []), ...(next.urls ?? [])])],
    location: next.location ?? previous.location ?? null,
    followers: next.followers ?? previous.followers ?? null,
    metadataStatus: previous.metadataStatus === "observed" || next.metadataStatus === "observed" ? "observed" : "profile-pending",
  };
}

function extractUrls(entities) {
  if (!asRecord(entities)) return [];
  const candidates = [entities.url?.urls, entities.description?.urls];
  const urls = [];
  for (const entries of candidates) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!asRecord(entry)) continue;
      const url = firstNonEmptyString(entry.expanded_url, entry.url);
      if (url !== null && !urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

/**
 * Project legacy and core GraphQL user shapes into the archive author record.
 * This is deliberately extraction-only: no X request or profile lookup occurs
 * here, and absent user data remains nullable rather than throwing.
 */
export function extractAuthor(tweetNode) {
  const userResult = tweetNode?.core?.user_results?.result;
  if (!asRecord(userResult)) {
    return { id: null, screenName: null, displayName: null, bio: null, urls: [], location: null, followers: null };
  }

  const profile = normalizeUserResult(userResult);
  return { id: profile.id, screenName: profile.screenName, displayName: profile.displayName, bio: profile.bio, urls: profile.urls, location: profile.location, followers: profile.followers };
}

/**
 * X has retired the `legacy` block on the user node and split what it held
 * across dedicated fields: the bio and its entities into `profile_bio`, the
 * place into a `location` object, the counts into `relationship_counts`.  Both
 * shapes are read, current first, because a node that still carries `legacy`
 * (an older cached payload, an embedded quote author) must keep working.
 *
 * The consequence of missing this is silent: `core` still supplies the screen
 * name, so a user node is still recognised and simply arrives with every
 * profile field empty.  Every archived profile was blank for that reason.
 */
function normalizeUserResult(userResult) {
  const legacy = asRecord(userResult.legacy) ? userResult.legacy : {};
  const core = asRecord(userResult.core) ? userResult.core : {};
  const profileBio = asRecord(userResult.profile_bio) ? userResult.profile_bio : {};
  const counts = asRecord(userResult.relationship_counts) ? userResult.relationship_counts : {};
  const entities = asRecord(profileBio.entities) ? profileBio.entities
    : asRecord(legacy.entities) ? legacy.entities : core.entities;
  const followers = [counts.followers, legacy.followers_count].find((value) => Number.isSafeInteger(value));
  return {
    // `rest_id` is the GraphQL user identity when present; older shapes use an
    // ID field instead, which is retained as a safe fallback.
    id: firstNonEmptyString(userResult.rest_id, userResult.id_str, userResult.id, legacy.id_str, core.id),
    screenName: firstNonEmptyString(legacy.screen_name, core.screen_name),
    displayName: firstNonEmptyString(legacy.name, core.name),
    bio: firstNonEmptyString(profileBio.description, legacy.description, core.description),
    urls: extractUrls(entities),
    // X shows these beside the bio on a profile page.  `location` is free text
    // that authors often use for a contact address rather than a place, and it
    // now arrives wrapped in an object of its own.
    location: firstNonEmptyString(
      asRecord(userResult.location) ? userResult.location.location : userResult.location,
      legacy.location, core.location),
    followers: followers === undefined ? null : followers,
    // Having looked at the profile is what makes it observed, even for an
    // author who wrote no bio at all.
    metadataStatus: [profileBio, legacy, core].some((source) =>
      Object.prototype.hasOwnProperty.call(source, "description")
      || Object.prototype.hasOwnProperty.call(source, "entities"))
      ? "observed" : "profile-pending",
  };
}

function extractAuthorScreenName(tweetNode) {
  return extractAuthor(tweetNode).screenName ?? "unknown";
}
