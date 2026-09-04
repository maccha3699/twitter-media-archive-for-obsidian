// Pure same-author reply-chain selection. X-specific response fields are
// normalized before this module is called; this code performs no DOM, Chrome,
// filesystem, or network work.

export const MAX_REPLY_TREE_POSTS = 50;

/**
 * A reply tree uses a bulk-shaped job only so Companion can aggregate several
 * posts into one note. The user still initiated it with the ordinary manual
 * save button, so it must retain manual save's explicit re-fetch semantics.
 */
export function directReplyTreeSaveOptions(jobId) {
  if (typeof jobId !== "string" || jobId === "") throw new TypeError("jobId must be a non-empty string");
  return {
    mode: "bulk",
    jobId,
    forceRedownload: true,
    includePostWhenMediaSkipped: true,
    allowNoMedia: true,
  };
}

function nonEmpty(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function authorIdentity(tweet) {
  const id = nonEmpty(tweet?.author?.id);
  if (id) return `id:${id}`;
  const screenName = nonEmpty(tweet?.author?.screenName) || nonEmpty(tweet?.authorScreenName);
  return screenName ? `screen:${screenName.toLowerCase()}` : null;
}

function sameAuthor(left, right) {
  const leftId = nonEmpty(left?.author?.id);
  const rightId = nonEmpty(right?.author?.id);
  if (leftId !== null && rightId !== null) return leftId === rightId;
  const leftScreenName = nonEmpty(left?.author?.screenName) || nonEmpty(left?.authorScreenName);
  const rightScreenName = nonEmpty(right?.author?.screenName) || nonEmpty(right?.authorScreenName);
  return leftScreenName !== null && rightScreenName !== null
    && leftScreenName.toLowerCase() === rightScreenName.toLowerCase();
}

function compareTweets(left, right) {
  const leftTime = Number.isFinite(left?.createdAtMs) ? left.createdAtMs : Number.POSITIVE_INFINITY;
  const rightTime = Number.isFinite(right?.createdAtMs) ? right.createdAtMs : Number.POSITIVE_INFINITY;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return String(left?.tweetId ?? "").localeCompare(String(right?.tweetId ?? ""), "en");
}

function replyTargetsSameMissingAuthor(tweet, root) {
  const replyToUserId = nonEmpty(tweet?.replyToUserId);
  const rootAuthorId = nonEmpty(root?.author?.id);
  return replyToUserId !== null && rootAuthorId !== null && replyToUserId === rootAuthorId;
}

/**
 * Build the one readable same-author chain containing `startTweetId` from the
 * tweets X has already displayed. At a branch, the clicked branch wins on the
 * ancestor side and the oldest direct child wins below it. The result is
 * flagged partial instead of silently claiming that an ambiguous/missing
 * chain is complete.
 */
export function buildSameAuthorReplyTree(startTweetId, tweets, { maxPosts = MAX_REPLY_TREE_POSTS } = {}) {
  if (typeof startTweetId !== "string" || startTweetId === "") {
    throw new TypeError("startTweetId must be a non-empty string");
  }
  if (!Array.isArray(tweets)) throw new TypeError("tweets must be an array");
  if (!Number.isSafeInteger(maxPosts) || maxPosts < 2) throw new TypeError("maxPosts must be at least 2");

  const byId = new Map();
  for (const tweet of tweets) {
    if (tweet && typeof tweet.tweetId === "string" && tweet.tweetId !== "") byId.set(tweet.tweetId, tweet);
  }
  const start = byId.get(startTweetId);
  if (!start || authorIdentity(start) === null) {
    return { posts: [], partial: true, reasons: ["start-missing"] };
  }

  const ancestors = [start];
  const visited = new Set([start.tweetId]);
  const reasons = new Set();
  let current = start;

  while (ancestors.length < maxPosts) {
    const parentId = nonEmpty(current.replyToTweetId);
    if (!parentId) break;
    const parent = byId.get(parentId);
    if (!parent) {
      if (replyTargetsSameMissingAuthor(current, start)
        || (nonEmpty(current.replyToUserId) !== null && nonEmpty(start?.author?.id) === null)) {
        reasons.add("missing-parent");
      }
      break;
    }
    if (!sameAuthor(parent, start)) break;
    if (visited.has(parent.tweetId)) {
      reasons.add("cycle");
      break;
    }
    ancestors.unshift(parent);
    visited.add(parent.tweetId);
    current = parent;
  }
  if (ancestors.length >= maxPosts && nonEmpty(current.replyToTweetId)) reasons.add("limit");

  const posts = [...ancestors];
  current = start;
  while (posts.length < maxPosts) {
    const children = [...byId.values()]
      .filter((tweet) => tweet.replyToTweetId === current.tweetId && sameAuthor(tweet, start) && !visited.has(tweet.tweetId))
      .sort(compareTweets);
    if (children.length === 0) break;
    if (children.length > 1) reasons.add("branch");
    current = children[0];
    posts.push(current);
    visited.add(current.tweetId);
  }
  if (posts.length >= maxPosts) {
    const hasMore = [...byId.values()].some(
      (tweet) => tweet.replyToTweetId === current.tweetId && sameAuthor(tweet, start) && !visited.has(tweet.tweetId)
    );
    if (hasMore) reasons.add("limit");
  }

  if (posts.length < 2) return { posts: [], partial: reasons.size > 0, reasons: [...reasons] };
  const rootTweetId = posts[0].tweetId;
  const partial = reasons.size > 0;
  return {
    posts: posts.map((tweet, index) => ({
      ...tweet,
      replyTree: {
        rootTweetId,
        previousTweetId: index > 0 ? posts[index - 1].tweetId : null,
        nextTweetId: index + 1 < posts.length ? posts[index + 1].tweetId : null,
        position: index + 1,
        size: posts.length,
        partial,
      },
    })),
    partial,
    reasons: [...reasons],
  };
}
