import type { ArchiveJob, ArchivePost } from "./types.ts";

const MAX_POSTS = 50;

function sameAuthor(left: ArchivePost, right: ArchivePost): boolean {
  if (left.author.id !== null && right.author.id !== null) return left.author.id === right.author.id;
  return left.author.screenName.toLowerCase() === right.author.screenName.toLowerCase();
}

function comparePosts(left: ArchivePost, right: ArchivePost): number {
  const leftTime = left.createdAt ? Date.parse(left.createdAt) : Number.POSITIVE_INFINITY;
  const rightTime = right.createdAt ? Date.parse(right.createdAt) : Number.POSITIVE_INFINITY;
  return leftTime - rightTime || left.tweetId.localeCompare(right.tweetId, "en");
}

/**
 * Bulk collection streams posts before the whole reply chain is known. The
 * producer therefore carries only X's direct reply IDs; this offline consumer
 * turns the posts present in that one job into bounded, non-overlapping chains.
 */
export function inferBulkReplyTrees(job: ArchiveJob): ArchiveJob {
  if (job.mode !== "bulk") return job;
  const byId = new Map(job.posts.map((post) => [post.tweetId, post]));
  const assigned = new Set(job.posts.filter((post) => post.replyTree).map((post) => post.tweetId));
  const output = new Map(job.posts.map((post) => [post.tweetId, post]));

  for (const start of job.posts) {
    if (assigned.has(start.tweetId)) continue;
    const ancestors = [start];
    const visited = new Set([start.tweetId]);
    const reasons = new Set<string>();
    let current = start;
    while (ancestors.length < MAX_POSTS && current.replyToTweetId) {
      const parent = byId.get(current.replyToTweetId);
      if (!parent) {
        if (current.replyToUserId !== null && current.replyToUserId !== undefined
          && (start.author.id === null || current.replyToUserId === start.author.id)) reasons.add("missing-parent");
        break;
      }
      if (!sameAuthor(parent, start) || assigned.has(parent.tweetId)) break;
      if (visited.has(parent.tweetId)) { reasons.add("cycle"); break; }
      ancestors.unshift(parent); visited.add(parent.tweetId); current = parent;
    }
    const chain = [...ancestors];
    current = start;
    while (chain.length < MAX_POSTS) {
      const children = job.posts
        .filter((post) => post.replyToTweetId === current.tweetId && sameAuthor(post, start)
          && !visited.has(post.tweetId) && !assigned.has(post.tweetId))
        .sort(comparePosts);
      if (children.length === 0) break;
      if (children.length > 1) reasons.add("branch");
      current = children[0]; chain.push(current); visited.add(current.tweetId);
    }
    if (chain.length >= MAX_POSTS && job.posts.some((post) => post.replyToTweetId === current.tweetId
      && sameAuthor(post, start) && !visited.has(post.tweetId))) reasons.add("limit");
    if (chain.length < 2 || chain.some((post) => assigned.has(post.tweetId))) continue;
    const rootTweetId = chain[0].tweetId;
    chain.forEach((post, index) => {
      assigned.add(post.tweetId);
      output.set(post.tweetId, { ...post, replyTree: {
        rootTweetId,
        previousTweetId: index > 0 ? chain[index - 1].tweetId : null,
        nextTweetId: index + 1 < chain.length ? chain[index + 1].tweetId : null,
        position: index + 1,
        size: chain.length,
        partial: reasons.size > 0,
      } });
    });
  }
  return { ...job, posts: job.posts.map((post) => output.get(post.tweetId) ?? post) };
}
