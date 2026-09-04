import type { ArchivePost } from "./types.ts";
import { COMPONENT_BUDGET, RESERVED_AUTHOR_FOLDERS, safeSegment, shortenSegment, unsafeSegment, pathHash } from "./path-safety.ts";
const TWITTER_EPOCH_MS = 1288834974657n;
const JAPAN_OFFSET_MS = 9 * 60 * 60 * 1000;

export function dateFromPost(post: Pick<ArchivePost, "createdAt" | "tweetId">): Date {
  return post.createdAt ? new Date(post.createdAt) : new Date(Number((BigInt(post.tweetId) >> 22n) + TWITTER_EPOCH_MS));
}
export function tokyoStamp(date: Date): string {
  const tokyo = new Date(date.getTime() + JAPAN_OFFSET_MS); const pad = (value: number) => String(value).padStart(2, "0");
  return `${tokyo.getUTCFullYear()}-${pad(tokyo.getUTCMonth() + 1)}-${pad(tokyo.getUTCDate())}_${pad(tokyo.getUTCHours())}${pad(tokyo.getUTCMinutes())}${pad(tokyo.getUTCSeconds())}`;
}
export function safeName(value: string, fallback: string): string {
  return safeSegment(value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " "), fallback);
}
type NamedPost = Pick<ArchivePost, "createdAt" | "tweetId" | "text"> & { media?: readonly unknown[] };

/**
 * The body without the t.co token X appends for attached media.
 *
 * The rendered note already drops that token; the file name did not. It
 * survives `safeName` as "https t.co Xc6MB5QtW", and because the title is cut
 * at 32 characters it also pushes the real text out of the name -- 5,853 of
 * 8,823 notes in the live vault are named that way. Posts with no archived
 * media keep every link, since those may point somewhere real.
 */
export function noteTitleSource(post: Pick<ArchivePost, "text"> & { media?: readonly unknown[] }): string {
  const text = post.text ?? "";
  if (!post.media || post.media.length === 0) return text;
  return text.trimEnd().replace(/(?:^|\s+)https:\/\/t\.co\/[A-Za-z0-9]+$/u, "").trimEnd();
}

function noteTitle(post: NamedPost): string {
  return safeName([...noteTitleSource(post).trim()].slice(0, 32).join(""), "post");
}

export function postStem(post: Pick<ArchivePost, "createdAt" | "tweetId">): string { return `${tokyoStamp(dateFromPost(post))}_${post.tweetId}`; }
export function noteFileName(post: NamedPost): string {
  return `${tokyoStamp(dateFromPost(post))} - ${noteTitle(post)} - ${post.tweetId}.md`;
}
export function replyTreeNoteFileName(post: NamedPost): string {
  return `${tokyoStamp(dateFromPost(post))} - ツリー - ${noteTitle(post)} - ${post.tweetId}.md`;
}
const TREE_NOTE_PREFIX = /^\d{4}-\d{2}-\d{2}_\d{6} - ツリー - /u;

/** Both generators end a note with ` - <tweetId>.md`, and only the reply-tree
 * one puts a ツリー marker directly after the timestamp. A post whose own text
 * begins with "ツリー - " is indistinguishable here; it would at worst reuse the
 * aggregate note's path, whose body is rewritten from the manifest either way. */
export function isReplyTreeNoteName(name: string): boolean { return TREE_NOTE_PREFIX.test(name); }

/**
 * Finds the note already holding this tweet, whatever it is currently called.
 *
 * The generated file name embeds the first 32 characters of the tweet body, so
 * any change in how the extension extracts text renames the note and the next
 * import writes a second copy beside the first rather than replacing it. That
 * happened for real when X's schema change started including the trailing media
 * t.co token. tweetId is the identity everywhere else -- media file names,
 * frontmatter, receipts -- so resolve the path by tweetId here too.
 *
 * Individual notes and reply-tree aggregates are kept apart on purpose: an
 * aggregate is deliberately a separate note from the older per-post ones.
 */
export function existingNoteName(names: readonly string[], tweetId: string, kind: "post" | "tree", generatedName?: string): string | null {
  const suffix = ` - ${tweetId}.md`;
  const matches = names
    .filter((name) => name.endsWith(suffix) && isReplyTreeNoteName(name) === (kind === "tree"))
    .sort();
  // Prefer the name this import would generate anyway. Eight tweets in the live
  // vault exist twice -- once as a note migrated from SaveXPost and once as an
  // XMC import -- and the migrated name happens to sort first. Without this the
  // rule would start writing XMC content into the SaveXPost-named file and
  // strand the one the receipts point at.
  if (generatedName !== undefined && matches.includes(generatedName)) return generatedName;
  // Otherwise deterministic, so repeated imports converge on one file rather
  // than alternating between the leftovers.
  return matches[0] ?? null;
}

export function profileFolderBase(screenName: string): string {
  const base = safeName(screenName, "unknown");
  if (RESERVED_AUTHOR_FOLDERS.has(base.toLowerCase())) return `${base.slice(0, Math.max(1, COMPONENT_BUDGET - pathHash(screenName).length - 3))}--${pathHash(screenName)}`;
  if (unsafeSegment(base) || base.length > COMPONENT_BUDGET) return shortenSegment(base, screenName);
  return base;
}
export function mediaFileName(tweetId: string, ordinal: number, mediaKey: string, extension: string | null): string {
  const ext = extension ?? "bin";
  const prefix = `${tweetId}_${String(ordinal).padStart(2, "0")}_`;
  const key = safeName(mediaKey, "media");
  const normal = `${prefix}${key}.${ext}`;
  if (normal.length <= COMPONENT_BUDGET) return normal;
  const hash = pathHash(mediaKey);
  const room = COMPONENT_BUDGET - prefix.length - ext.length - hash.length - 3;
  if (room < 1) throw new Error("media filename cannot fit component budget");
  return `${prefix}${key.slice(0, room)}-${hash}.${ext}`;
}
