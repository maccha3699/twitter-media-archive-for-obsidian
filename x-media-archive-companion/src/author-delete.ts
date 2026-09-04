import type { Receipt } from "./types.ts";
import { accountMarkdown } from "./note-rendering.ts";

export interface AuthorMediaDeletePlan {
  removable: string[];
  preserved: string[];
}

export interface AuthorReceiptRewrite {
  changed: boolean;
  removedPosts: number;
  empty: boolean;
  receipt: Receipt;
}

export interface PostReceiptRewrite {
  changed: boolean;
  removedPosts: number;
  empty: boolean;
  receipt: Receipt;
}

function comparable(path: string): string { return path.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase(); }

export function isAuthorNotePath(path: string, root: string, folder: string): boolean {
  return comparable(path).startsWith(`${comparable(root)}/${comparable(folder)}/`);
}

/** Removes only the selected author's posts from a receipt. A bulk job may
 * contain several authors, so deleting the whole receipt would make unrelated
 * saved media disappear from a later ledger rebuild. */
export function receiptWithoutAuthor(value: unknown, root: string, folder: string): AuthorReceiptRewrite {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("receipt must be an object");
  const receipt = value as Receipt;
  if (!Array.isArray(receipt.posts)) throw new TypeError("receipt posts must be an array");
  for (const post of receipt.posts) {
    if (!post || typeof post !== "object" || typeof post.notePath !== "string") throw new TypeError("receipt post path is invalid");
  }
  const remaining = receipt.posts.filter((post) => !isAuthorNotePath(post.notePath, root, folder));
  const removedPosts = receipt.posts.length - remaining.length;
  if (removedPosts === 0) return { changed: false, removedPosts: 0, empty: false, receipt };
  const empty = remaining.length === 0;
  // An empty complete tombstone contains no media keys for a ledger rebuild,
  // while still preventing an old staged job from resurrecting the author.
  const state: Receipt["state"] = remaining.some((post) => post.state !== "complete") ? "partial" : "complete";
  return { changed: true, removedPosts, empty, receipt: { ...receipt, state, posts: remaining } };
}

/** Removes every receipt entry pointing at one note (reply trees share paths). */
export function receiptWithoutNote(value: unknown, notePath: string): PostReceiptRewrite {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("receipt must be an object");
  const receipt = value as Receipt;
  if (!Array.isArray(receipt.posts)) throw new TypeError("receipt posts must be an array");
  for (const post of receipt.posts) {
    if (!post || typeof post !== "object" || typeof post.notePath !== "string") throw new TypeError("receipt post path is invalid");
  }
  const target = comparable(notePath);
  const remaining = receipt.posts.filter((post) => comparable(post.notePath) !== target);
  const removedPosts = receipt.posts.length - remaining.length;
  if (removedPosts === 0) return { changed: false, removedPosts: 0, empty: false, receipt };
  const state: Receipt["state"] = remaining.some((post) => post.state !== "complete") ? "partial" : "complete";
  return { changed: true, removedPosts, empty: remaining.length === 0, receipt: { ...receipt, state, posts: remaining } };
}

/** Shared account-card renderer for deletion's account next-bytes. */
export function renderAccountAfterPostDelete(
  previous: string,
  root: string,
  folder: string,
  displayName: string,
  screenName: string,
  noteCount: number,
  mediaPaths: readonly string[],
  coverPath: string | null,
): string {
  return accountMarkdown(previous, root, folder, displayName, screenName, noteCount, mediaPaths.length, coverPath);
}

/** Media below an author directory is normally private, but old individual
 * notes, thread notes, and user-authored notes can share links. Only files with
 * no source outside the deletion set may move to trash. */
export function authorMediaDeletePlan(
  mediaPaths: readonly string[],
  internalSourcePaths: readonly string[],
  resolvedLinks: Readonly<Record<string, Readonly<Record<string, number>>>>,
): AuthorMediaDeletePlan {
  const internal = new Set(internalSourcePaths.map(comparable));
  const uniqueMedia = [...new Map(mediaPaths
    .filter((path) => path !== "")
    .map((path) => [comparable(path), path])).values()];
  const media = new Set(uniqueMedia.map(comparable));
  const externallyReferenced = new Set<string>();

  // Scan the Vault link index once. The previous media-first loop scanned all
  // sources again for every file, which blocked the UI for large authors.
  for (const [source, targets] of Object.entries(resolvedLinks)) {
    if (internal.has(comparable(source))) continue;
    for (const [target, count] of Object.entries(targets)) {
      const normalized = comparable(target);
      if (Number(count) > 0 && media.has(normalized)) externallyReferenced.add(normalized);
    }
  }
  return {
    removable: uniqueMedia.filter((path) => !externallyReferenced.has(comparable(path))),
    preserved: uniqueMedia.filter((path) => externallyReferenced.has(comparable(path))),
  };
}
