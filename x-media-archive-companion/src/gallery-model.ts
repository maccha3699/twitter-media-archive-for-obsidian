// Turns vault records into gallery cards.
//
// Everything here takes plain frontmatter objects and plain strings, never an
// Obsidian type, so it can be tested directly.  `gallery-vault.ts` is the only
// module that touches the vault API.

export type XmcMode = "accounts" | "author" | "favorites" | "allPosts";

export interface XmcViewState {
  mode: XmcMode;
  folder: string | null;
  /** Index of the card that was at the top of the viewport. */
  anchor: number;
}

export interface AccountCard {
  /** Vault path of the account note itself. */
  path: string;
  folder: string;
  /** Vault path of the author's post folder. */
  targetPath: string;
  displayName: string;
  screenName: string;
  summary: string;
  coverPath: string | null;
  postCount: number;
  mediaCount: number;
  /** When the account card was last rewritten, i.e. last imported into. */
  updatedAt: number;
}

export interface PostCard {
  path: string;
  /** Parent archive folder, shown when posts from many authors are mixed. */
  authorFolder: string;
  /** Screen name observed for this post; folder is the stable fallback. */
  authorScreenName: string;
  preview: string;
  firstEmbed: string | null;
  /** User-owned state stored in this post note's frontmatter. */
  pinned: boolean;
  favorite: boolean;
  /** Images beyond the first, shown as a badge. */
  extraImages: number;
  /** Every media this post owns, so deleting it leaves nothing orphaned. */
  mediaPaths: string[];
}

export interface ProfileSearchCard {
  path: string;
  authorFolder: string;
  screenName: string;
  displayName: string;
  previousScreenNames: string[];
  urls: string[];
  location: string;
  coverPath: string | null;
}

export interface MediaDeletePlan {
  /** Media that has no reference from a note other than the one being deleted. */
  removable: string[];
  /** Media still referenced by another note, or preserved because the link index is unavailable. */
  preserved: string[];
}

function comparablePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").toLocaleLowerCase();
}

/**
 * Keeps only canonical, importer-managed media for one post note. The caller
 * must resolve embeds through Obsidian first; this function never interprets
 * wikilinks, URLs, or note bodies.
 */
export function managedMediaPaths(
  notePath: string,
  canonicalPaths: readonly string[],
  frontmatter: Record<string, unknown> | undefined,
  root: string,
): string[] {
  const note = comparablePath(notePath);
  const archiveRoot = comparablePath(root).replace(/\/$/u, "");
  const slash = note.lastIndexOf("/");
  if (slash <= 0) return [];
  const authorFolder = note.slice(0, slash).split("/").at(-1) ?? "";
  if (!authorFolder || !note.startsWith(`${archiveRoot}/${authorFolder}/`)) return [];
  const mediaRoot = `${archiveRoot}/_media/${authorFolder}/`;
  const ids = new Set<string>();
  const tweetId = frontmatter?.tweet_id;
  if (typeof tweetId === "string" && tweetId.trim() !== "") ids.add(tweetId.trim().toLocaleLowerCase());
  const threadIds = frontmatter?.xmc_thread_tweet_ids;
  if (Array.isArray(threadIds)) {
    for (const id of threadIds) if (typeof id === "string" && id.trim() !== "") ids.add(id.trim().toLocaleLowerCase());
  }
  if (ids.size === 0) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of canonicalPaths) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const canonical = raw.replace(/\\/g, "/");
    const folded = comparablePath(canonical);
    if (!folded.startsWith(mediaRoot)) continue;
    const fileName = folded.slice(mediaRoot.length);
    if (fileName.includes("/") || ![...ids].some((id) => fileName.startsWith(`${id}_`))) continue;
    if (seen.has(folded)) continue;
    seen.add(folded);
    result.push(canonical);
  }
  return result;
}

/**
 * Plans a gallery deletion without orphaning another note's embeds.
 *
 * Reply-tree aggregate notes and older individual notes intentionally reuse
 * deterministic media paths.  The note being deleted therefore cannot be
 * treated as the sole owner of every embed shown on its card.
 */
export function mediaDeletePlan(
  notePath: string,
  mediaPaths: readonly string[],
  resolvedLinks: Readonly<Record<string, Readonly<Record<string, number>>>> | null | undefined,
): MediaDeletePlan {
  const unique = [...new Map(mediaPaths.filter((path) => path !== "").map((path) => [comparablePath(path), path])).values()];
  // Obsidian can expose an empty resolvedLinks object while its metadata cache
  // is still starting. A media-bearing current note must be present as a
  // source before an absent backlink can safely mean "not shared".
  if (!resolvedLinks || (unique.length > 0 && !Object.prototype.hasOwnProperty.call(resolvedLinks, notePath))) {
    return { removable: [], preserved: unique };
  }

  const removable: string[] = [];
  const preserved: string[] = [];
  for (const mediaPath of unique) {
    const shared = Object.entries(resolvedLinks).some(([sourcePath, targets]) =>
      comparablePath(sourcePath) !== comparablePath(notePath)
      && Object.entries(targets).some(([target, count]) => comparablePath(target) === comparablePath(mediaPath) && Number(count) > 0));
    (shared ? preserved : removable).push(mediaPath);
  }
  return { removable, preserved };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

function stem(fileName: string): string {
  return fileName.toLowerCase().endsWith(".md") ? fileName.slice(0, -3) : fileName;
}

// `_c_aca`, `_1funeral` and `_kawaii_sticker` are real screen names, so a
// leading underscore cannot be used to recognise a system note. Only the notes
// this plugin writes into `_accounts` itself may be excluded, and only by name.
const RESERVED_ACCOUNT_NOTES = new Set(["_accounts.md", "_index.md"]);
const RESERVED_ARCHIVE_FOLDERS = new Set(["_accounts", "_media", "_system"]);

/** Leading underscores are valid X handles; only exact Companion-owned root
 * folders are system folders. */
export function isArchiveAuthorFolder(folderName: string): boolean {
  return folderName !== "" && !RESERVED_ARCHIVE_FOLDERS.has(folderName.toLowerCase());
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

export function normalizeXmcViewState(value: unknown): XmcViewState {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const mode: XmcMode = source.mode === "author" ? "author"
    : source.mode === "favorites" ? "favorites"
    : source.mode === "allPosts" ? "allPosts"
    : "accounts";
  const folder = typeof source.folder === "string" && source.folder !== "" ? source.folder : null;
  const anchor = Number.isInteger(source.anchor) && (source.anchor as number) >= 0 ? source.anchor as number : 0;
  if (mode === "author" && folder === null) return { mode: "accounts", folder: null, anchor };
  return { mode, folder: mode === "author" ? folder : null, anchor };
}

/**
 * Reads one `_accounts/<folder>.md`.  `redirect` is the authoritative pointer
 * to the post folder because the importer writes it, but a note predating that
 * field still resolves through its own name.
 */
function count(value: unknown): number {
  return Number.isFinite(value) && (value as number) >= 0 ? Math.floor(value as number) : 0;
}

export function accountCardFrom(
  path: string,
  frontmatter: Record<string, unknown> | undefined,
  root: string,
  updatedAt = 0,
): AccountCard | null {
  const fileName = basename(path);
  if (RESERVED_ACCOUNT_NOTES.has(fileName.toLowerCase())) return null;
  const folder = stem(fileName);
  if (folder === "") return null;
  const fields = frontmatter ?? {};
  const screenName = text(fields.author_screen_name) ?? folder;
  return {
    path,
    folder,
    targetPath: text(fields.redirect) ?? `${root}/${folder}`,
    displayName: text(fields.author_display_name) ?? screenName,
    screenName,
    summary: text(fields.summary) ?? "",
    coverPath: text(fields.cover_media),
    postCount: count(fields.post_count),
    mediaCount: count(fields.media_count),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}

export function isPostPinned(frontmatter: Record<string, unknown> | undefined): boolean {
  return frontmatter?.xmc_pinned === true;
}

export function isPostFavorite(frontmatter: Record<string, unknown> | undefined): boolean {
  return frontmatter?.xmc_favorite === true;
}

function parentFolder(path: string): string {
  const cut = path.lastIndexOf("/");
  if (cut <= 0) return "";
  return basename(path.slice(0, cut));
}

export function postCardFrom(
  path: string,
  embedLinks: readonly string[],
  frontmatter?: Record<string, unknown>,
  root?: string,
): PostCard {
  const links = root === undefined
    ? embedLinks.filter((link) => typeof link === "string" && link.trim() !== "")
    : managedMediaPaths(path, embedLinks, frontmatter, root);
  const authorFolder = parentFolder(path);
  return {
    path,
    authorFolder,
    authorScreenName: text(frontmatter?.author_screen_name) ?? authorFolder,
    preview: previewFromNoteName(basename(path)),
    firstEmbed: links[0] ?? null,
    pinned: isPostPinned(frontmatter),
    favorite: isPostFavorite(frontmatter),
    extraImages: Math.max(links.length - 1, 0),
    mediaPaths: links,
  };
}

/** Keeps the selected chronological order inside both groups while moving
 * pinned posts ahead of ordinary posts. */
export function pinnedPostsFirst(cards: readonly PostCard[]): PostCard[] {
  const pinned: PostCard[] = [];
  const rest: PostCard[] = [];
  for (const card of cards) (card.pinned ? pinned : rest).push(card);
  return [...pinned, ...rest];
}

/** A stable filter: the cross-author view keeps the chronological order its
 * caller selected and never mutates the source list. */
export function favoritePosts(cards: readonly PostCard[]): PostCard[] {
  return cards.filter((card) => card.favorite);
}

function searchTokens(query: string): string[] {
  return query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
}

function matchesEveryToken(query: string, fields: readonly string[]): boolean {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return true;
  const haystack = fields.join("\n").normalize("NFKC").toLocaleLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/** Searches visible account metadata without reading profile or note bodies. */
export function accountMatchesQuery(card: AccountCard, query: string): boolean {
  return matchesEveryToken(query, [card.displayName, card.screenName, `@${card.screenName}`, card.folder, card.summary]);
}

/** Searches stable post-card metadata. The path includes note title and tweet ID. */
export function postMatchesQuery(card: PostCard, query: string): boolean {
  return matchesEveryToken(query, [card.preview, card.path, card.authorScreenName, `@${card.authorScreenName}`, card.authorFolder]);
}

export function profileSearchCardFrom(
  path: string,
  frontmatter: Record<string, unknown> | undefined,
  coverPath: string | null = null,
): ProfileSearchCard {
  const authorFolder = parentFolder(path);
  const screenName = text(frontmatter?.latest_screen_name) ?? text(frontmatter?.first_screen_name) ?? authorFolder;
  return {
    path,
    authorFolder,
    screenName,
    displayName: text(frontmatter?.display_name) ?? screenName,
    previousScreenNames: textList(frontmatter?.previous_screen_names),
    urls: textList(frontmatter?.urls),
    location: text(frontmatter?.location) ?? "",
    coverPath,
  };
}

export function profileMatchesQuery(card: ProfileSearchCard, query: string): boolean {
  return matchesEveryToken(query, [
    card.displayName, card.screenName, `@${card.screenName}`, card.authorFolder,
    card.location, ...card.previousScreenNames, ...card.urls,
  ]);
}

/** Chooses the URL that explains a profile hit, while other query tokens may match its identity fields. */
export function profileMatchingUrl(card: ProfileSearchCard, query: string): string | null {
  const tokens = searchTokens(query);
  return card.urls.find((url) => {
    const normalized = url.normalize("NFKC").toLocaleLowerCase();
    return tokens.some((token) => normalized.includes(token));
  }) ?? null;
}

/**
 * A post note, as opposed to the profile or the GridExplorer folder note.  Both
 * of those stay on disk so GridExplorer keeps working, so both must be excluded
 * here by name.
 */
export function isPostNote(fileName: string, folderName: string): boolean {
  if (!fileName.toLowerCase().endsWith(".md")) return false;
  if (fileName.startsWith("_")) return false;
  return fileName !== `${folderName}.md`;
}

/** Names begin with the post's timestamp, so descending by name is newest first. */
export function comparePostsNewestFirst(a: string, b: string): number {
  return b.localeCompare(a);
}

/**
 * Recovers the post text from its file name, which `noteFileName` built as
 * `<stamp> - <first 32 characters> - <tweetId>.md`.  Reading it back costs
 * nothing, where reading 40,000 note bodies to show a one-line preview would
 * cost a great deal.  The title itself may contain " - ", so only the first and
 * last segments are dropped.
 */
export function previewFromNoteName(fileName: string): string {
  const name = stem(fileName);
  const parts = name.split(" - ");
  if (parts.length < 3) return name;
  return parts.slice(1, -1).join(" - ").trim() || name;
}

/**
 * The accounts the user pinned, in the order they pinned them, ahead of the
 * rest.  GridExplorer keeps that list in `_accounts/_accounts.md`, and reading
 * the same place means one set of pins serves both views.
 */
export function pinnedFirst(cards: readonly AccountCard[], pinned: unknown): AccountCard[] {
  const names = Array.isArray(pinned)
    ? pinned.filter((entry): entry is string => typeof entry === "string").map((entry) => stem(entry).toLowerCase())
    : [];
  if (names.length === 0) return [...cards];
  const rank = new Map(names.map((name, index) => [name, index]));
  const head: AccountCard[] = [];
  const tail: AccountCard[] = [];
  for (const card of cards) {
    if (rank.has(card.folder.toLowerCase())) head.push(card); else tail.push(card);
  }
  head.sort((a, b) => (rank.get(a.folder.toLowerCase()) ?? 0) - (rank.get(b.folder.toLowerCase()) ?? 0));
  return [...head, ...tail];
}

export function isPinned(folder: string, pinned: unknown): boolean {
  return Array.isArray(pinned)
    && pinned.some((entry) => typeof entry === "string" && stem(entry).toLowerCase() === folder.toLowerCase());
}

/** Returns the exact frontmatter list for a pin action, preserving unrelated
 * entries while making the target case-insensitively idempotent. */
export function updatedPinnedEntries(pinned: unknown, folder: string, remove: boolean): string[] {
  const entry = `${folder}.md`;
  const current = Array.isArray(pinned)
    ? pinned.filter((value): value is string => typeof value === "string")
    : [];
  const withoutTarget = current.filter((value) => value.toLowerCase() !== entry.toLowerCase());
  return remove ? withoutTarget : [...withoutTarget, entry];
}

/** Whether metadataCache has published the same pin list the view already
 * rendered optimistically. Case is immaterial because account matching is
 * case-insensitive everywhere else as well. */
export function pinnedEntriesEqual(left: unknown, right: unknown): boolean {
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
  const a = strings(left);
  const b = strings(right);
  return a.length === b.length && a.every((entry, index) => entry.toLowerCase() === b[index].toLowerCase());
}

export type AccountSort = "name" | "posts" | "media" | "recent";
export type PostSort = "newest" | "oldest";
export const ACCOUNT_SORTS: ReadonlyArray<{ key: AccountSort; label: string }> = [
  { key: "name", label: "名前順" },
  { key: "posts", label: "投稿数順" },
  { key: "media", label: "メディア数順" },
  { key: "recent", label: "最近取り込んだ順" },
];
export const POST_SORTS: ReadonlyArray<{ key: PostSort; label: string }> = [
  { key: "newest", label: "新しい順" },
  { key: "oldest", label: "古い順" },
];

/** Sorts a copy; the caller's order is never mutated. */
export function sortAccounts(cards: readonly AccountCard[], sort: AccountSort): AccountCard[] {
  const byName = (a: AccountCard, b: AccountCard) => a.folder.localeCompare(b.folder);
  const sorted = [...cards];
  // Counts and timestamps tie constantly -- 150 accounts hold one post each --
  // so every order falls back to the name to stay stable between renders.
  if (sort === "posts") sorted.sort((a, b) => b.postCount - a.postCount || byName(a, b));
  else if (sort === "media") sorted.sort((a, b) => b.mediaCount - a.mediaCount || byName(a, b));
  else if (sort === "recent") sorted.sort((a, b) => b.updatedAt - a.updatedAt || byName(a, b));
  else sorted.sort(byName);
  return sorted;
}

/**
 * Splits off the accounts holding no more than `threshold` posts.  An author
 * saved once sits beside one saved a thousand times otherwise, and opening the
 * first is rarely worth the trip.  A threshold of 0 keeps them together.
 */
export function splitByPostCount(
  cards: readonly AccountCard[],
  threshold: number,
): { many: AccountCard[]; few: AccountCard[] } {
  if (!Number.isFinite(threshold) || threshold < 1) return { many: [...cards], few: [] };
  const many: AccountCard[] = [];
  const few: AccountCard[] = [];
  for (const card of cards) (card.postCount <= threshold ? few : many).push(card);
  return { many, few };
}

/**
 * Partitions every account into exactly one visible section.
 *
 * Pinning is the strongest classification: a pinned account never falls into
 * the low-post section, even when its count is at or below the threshold. Keep
 * this decision in one pure function so the DOM cannot accidentally apply the
 * filters in a different order and either duplicate or lose a card.
 */
export function groupAccounts(
  cards: readonly AccountCard[],
  pinned: unknown,
  threshold: number,
): { pinned: AccountCard[]; main: AccountCard[]; few: AccountCard[] } {
  const pinnedCards: AccountCard[] = [];
  const unpinned: AccountCard[] = [];
  for (const card of cards) (isPinned(card.folder, pinned) ? pinnedCards : unpinned).push(card);
  const split = splitByPostCount(unpinned, threshold);
  return {
    pinned: pinnedFirst(pinnedCards, pinned),
    main: split.many,
    few: split.few,
  };
}

export function xmcScrollKey(mode: XmcMode, folder: string | null): string {
  if (mode === "author") return `xmc-author:${folder ?? ""}`;
  if (mode === "favorites") return "xmc-favorites:";
  return mode === "allPosts" ? "xmc-all-posts:" : "xmc-accounts:";
}
