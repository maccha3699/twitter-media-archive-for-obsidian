import assert from "node:assert/strict";
import test from "node:test";
import {
  accountCardFrom, accountMatchesQuery, comparePostsNewestFirst, favoritePosts, groupAccounts, isArchiveAuthorFolder, isPinned, isPostFavorite, isPostNote,
  isPostPinned, managedMediaPaths, mediaDeletePlan, normalizeXmcViewState, pinnedEntriesEqual, pinnedFirst, pinnedPostsFirst, postCardFrom, previewFromNoteName, sortAccounts, splitByPostCount,
  postMatchesQuery, profileMatchesQuery, profileMatchingUrl, profileSearchCardFrom, updatedPinnedEntries, xmcScrollKey,
} from "../src/gallery-model.ts";
import { noteFileName } from "../src/naming.ts";

test("gallery deletion removes only media not referenced by another note", () => {
  const current = "XMediaArchive/a/old.md";
  const shared = "XMediaArchive/_media/a/shared.jpg";
  const privateMedia = "XMediaArchive/_media/a/private.jpg";
  const plan = mediaDeletePlan(current, [shared, privateMedia, shared], {
    [current]: { [shared]: 1, [privateMedia]: 1 },
    "XMediaArchive/a/tree.md": { [shared]: 1 },
    "XMediaArchive/a/unrelated.md": { [privateMedia]: 0 },
  });
  assert.deepEqual(plan, { removable: [privateMedia], preserved: [shared] });
});

test("gallery deletion preserves all media when the link index is unavailable", () => {
  const media = ["XMediaArchive/_media/a/one.jpg", "XMediaArchive/_media/a/two.jpg"];
  assert.deepEqual(mediaDeletePlan("XMediaArchive/a/post.md", media, null), {
    removable: [],
    preserved: media,
  });
  assert.deepEqual(mediaDeletePlan("XMediaArchive/a/post.md", media, {}), {
    removable: [],
    preserved: media,
  }, "an empty startup index is unavailable even though it is an object");
});

test("gallery deletion may remove media referenced only by the deleted note", () => {
  const note = "XMediaArchive/a/post.md";
  const media = "XMediaArchive/_media/a/one.jpg";
  assert.deepEqual(mediaDeletePlan(note, [media], { [note]: { [media]: 1 } }), {
    removable: [media],
    preserved: [],
  });
});

test("gallery cards keep only resolved managed media for the note tweet IDs", () => {
  const note = "XMediaArchive/Alice/post.md";
  const paths = [
    "XMediaArchive/_media/Alice/123_01_photo.jpg",
    "xmediaarchive/_MEDIA/alice/123_01_photo.jpg",
    "XMediaArchive/_media/Alice/456_01_photo.jpg",
    "XMediaArchive/_media/Alice/999_01_photo.jpg",
    "XMediaArchive/_media/Bob/123_02_photo.jpg",
    "https://x.example/123.jpg",
  ];
  assert.deepEqual(managedMediaPaths(note, paths, { tweet_id: "123", xmc_thread_tweet_ids: ["456"] }, "XMediaArchive"), [
    paths[0], paths[2],
  ]);
  assert.deepEqual(managedMediaPaths(note, ["XMediaArchive/_media/Alice/123_01_photo.jpg"], {}, "XMediaArchive"), []);
});

// Synthetic account frontmatter matching the captured schema.
const accountFrontmatter = {
  schemaVersion: 1,
  generated_by: "x-media-archive-companion",
  type: "folder",
  redirect: "XMediaArchive/sample_artist",
  title: "Sample Artist @sample_artist",
  summary: "投稿 765 ・ メディア 3",
  author_screen_name: "sample_artist",
  author_display_name: "Sample Artist",
  cover_media: "XMediaArchive/_media/sample_artist/2057995582829150228_01_3_x.jpg",
  post_count: 765,
  media_count: 3,
};

test("an account card is read straight out of the note's frontmatter", () => {
  const card = accountCardFrom("XMediaArchive/_accounts/sample_artist.md", accountFrontmatter, "XMediaArchive", 1755000000000);
  assert.deepEqual(card, {
    path: "XMediaArchive/_accounts/sample_artist.md",
    folder: "sample_artist",
    targetPath: "XMediaArchive/sample_artist",
    displayName: "Sample Artist",
    screenName: "sample_artist",
    summary: "投稿 765 ・ メディア 3",
    coverPath: "XMediaArchive/_media/sample_artist/2057995582829150228_01_3_x.jpg",
    postCount: 765,
    mediaCount: 3,
    updatedAt: 1755000000000,
  });
  const missing = accountCardFrom("XMediaArchive/_accounts/x.md", {}, "XMediaArchive");
  assert.equal(missing?.postCount, 0, "a card with no counts sorts as empty rather than as NaN");
  assert.equal(missing?.updatedAt, 0);
});

test("an account with no cover, no display name and no redirect still resolves", () => {
  const card = accountCardFrom(
    "XMediaArchive/_accounts/_c_aca.md",
    { ...accountFrontmatter, cover_media: null, author_display_name: null, redirect: undefined, author_screen_name: "_c_aca" },
    "XMediaArchive",
  );
  assert.equal(card?.coverPath, null);
  assert.equal(card?.displayName, "_c_aca", "the screen name stands in for a missing display name");
  assert.equal(card?.targetPath, "XMediaArchive/_c_aca", "the folder is derived from the note name");
  assert.equal(card?.folder, "_c_aca", "a leading underscore is a real screen name, not a system note");
});

test("account search is Unicode-normalized, case-insensitive, and supports multiple terms", () => {
  const card = accountCardFrom("XMediaArchive/_accounts/Ronro_Koro.md", {
    author_display_name: "ろんろ",
    author_screen_name: "Ronro_Koro",
    summary: "投稿 24 ・ メディア 43",
  }, "XMediaArchive")!;
  assert.equal(accountMatchesQuery(card, "ろんろ"), true);
  assert.equal(accountMatchesQuery(card, "@ronro_koro"), true);
  assert.equal(accountMatchesQuery(card, "ＲＯＮＲＯ 24"), true);
  assert.equal(accountMatchesQuery(card, "ronro missing"), false);
  assert.equal(accountMatchesQuery(card, ""), true);
});

test("the account list's own folder note is not an account, but underscored handles are", () => {
  // Underscored handles are valid, so only the exact system notes are excluded.
  assert.equal(accountCardFrom("XMediaArchive/_accounts/_accounts.md", {}, "XMediaArchive"), null);
  assert.equal(accountCardFrom("XMediaArchive/_accounts/_index.md", {}, "XMediaArchive"), null);
  assert.equal(accountCardFrom("XMediaArchive/_accounts/.md", {}, "XMediaArchive"), null);
  assert.equal(accountCardFrom("XMediaArchive/_accounts/_sample_handle.md", {}, "XMediaArchive")?.folder, "_sample_handle");
});

test("a post card carries its first image and counts the rest for the badge", () => {
  const embeds = [
    "XMediaArchive/_media/sample_gallery/1723265821093531802_01_3_a.jpg",
    "XMediaArchive/_media/sample_gallery/1723265821093531802_02_3_b.jpg",
    "XMediaArchive/_media/sample_gallery/1723265821093531802_03_3_c.jpg",
  ];
  const card = postCardFrom(
    "XMediaArchive/sample_gallery/2023-11-11_180603 - sample note - 1723265821093531802.md",
    embeds,
    { author_screen_name: "renamed_author" },
  );
  assert.equal(card.firstEmbed, embeds[0]);
  assert.equal(card.authorFolder, "sample_gallery");
  assert.equal(card.authorScreenName, "renamed_author");
  assert.equal(card.pinned, false);
  assert.equal(card.favorite, false);
  assert.equal(card.extraImages, 2);
  assert.equal(card.preview, "sample note");

  assert.equal(postCardFrom("a/b - c - 1.md", [embeds[0]]).extraImages, 0, "one image needs no badge");
  const none = postCardFrom("a/b - c - 1.md", []);
  assert.equal(none.firstEmbed, null);
  assert.equal(none.authorScreenName, "a", "the stable folder is the fallback label");
  assert.equal(none.extraImages, 0);
});

test("post search matches note title, tweet ID, and author without reading note bodies", () => {
  const card = postCardFrom(
    "XMediaArchive/ronro_koro/2026-07-15_185627 - はんなり司書さんです - 2077331449813008849.md",
    [], { author_screen_name: "Ronro_Koro" },
  );
  assert.equal(postMatchesQuery(card, "はんなり"), true);
  assert.equal(postMatchesQuery(card, "2077331449813008849"), true);
  assert.equal(postMatchesQuery(card, "@ronro_koro 207733"), true);
  assert.equal(postMatchesQuery(card, "別の投稿"), false);
  assert.equal(postMatchesQuery(card, ""), true);
});

test("global search finds saved profile URLs and identity metadata from frontmatter", () => {
  const card = profileSearchCardFrom("XMediaArchive/ronro_koro/_profile.md", {
    latest_screen_name: "ronro_koro",
    display_name: "ろんろ",
    previous_screen_names: ["old_ronro"],
    urls: ["https://www.pixiv.net/users/123", "https://example.booth.pm/"],
    location: "東京",
  });
  assert.equal(profileMatchesQuery(card, "pixiv"), true);
  assert.equal(profileMatchesQuery(card, "BOOTH ronro"), true);
  assert.equal(profileMatchesQuery(card, "old_ronro"), true);
  assert.equal(profileMatchesQuery(card, "東京 123"), true);
  assert.equal(profileMatchesQuery(card, "fanbox"), false);
  assert.equal(profileMatchingUrl(card, "BOOTH ronro"), "https://example.booth.pm/");
  assert.equal(profileMatchingUrl(card, "東京"), null);
});

test("the profile and the GridExplorer folder note are not posts", () => {
  // Both stay on disk so GridExplorer keeps working, so both must be excluded
  // here by name.
  assert.equal(isPostNote("_profile.md", "dummy"), false);
  assert.equal(isPostNote("dummy.md", "dummy"), false);
  assert.equal(isPostNote("2026-08-12_120000 - text - 1.md", "dummy"), true);
  assert.equal(isPostNote("cover.jpg", "dummy"), false);
});

test("posts sort newest first, because their names start with their timestamp", () => {
  const older = "2023-11-11_180603 - a - 1.md";
  const newer = "2026-08-12_070904 - b - 2.md";
  assert.ok(comparePostsNewestFirst(newer, older) < 0);
  assert.deepEqual([older, newer].sort(comparePostsNewestFirst), [newer, older]);
});

test("the card preview round-trips whatever noteFileName produced", () => {
  // If naming.ts ever changes shape, this fails rather than silently showing
  // timestamps as post text.
  const cases = [
    { text: "おはむー('ω'`)", tweetId: "2087300294233461173", createdAt: "2026-08-12T07:09:04.000Z" },
    { text: "a - b - c inside the title", tweetId: "1830000000000000000", createdAt: "2025-01-02T03:04:05.000Z" },
    { text: null, tweetId: "1830000000000000001", createdAt: "2025-01-02T03:04:05.000Z" },
  ];
  for (const post of cases) {
    const name = noteFileName(post);
    const expected = [...(post.text ?? "").trim()].slice(0, 32).join("").trim() || "post";
    assert.equal(previewFromNoteName(name), expected, name);
  }
  assert.equal(previewFromNoteName("no-separators.md"), "no-separators", "an unexpected name is shown as-is");
});

test("scroll keys separate the account list from each author", () => {
  assert.equal(xmcScrollKey("accounts", null), "xmc-accounts:");
  assert.equal(xmcScrollKey("author", "dummy"), "xmc-author:dummy");
  assert.equal(xmcScrollKey("favorites", null), "xmc-favorites:");
  assert.equal(xmcScrollKey("allPosts", null), "xmc-all-posts:");
  assert.notEqual(xmcScrollKey("author", "a"), xmcScrollKey("author", "b"));
});

test("saved favorite view state survives reload while invalid author state fails closed", () => {
  assert.deepEqual(normalizeXmcViewState({ mode: "favorites", folder: "stale", anchor: 42 }), {
    mode: "favorites", folder: null, anchor: 42,
  });
  assert.deepEqual(normalizeXmcViewState({ mode: "author", folder: "dummy", anchor: 7 }), {
    mode: "author", folder: "dummy", anchor: 7,
  });
  assert.deepEqual(normalizeXmcViewState({ mode: "allPosts", folder: "stale", anchor: 9 }), {
    mode: "allPosts", folder: null, anchor: 9,
  });
  assert.deepEqual(normalizeXmcViewState({ mode: "author", folder: null, anchor: -1 }), {
    mode: "accounts", folder: null, anchor: 0,
  });
});

test("cross-author scans exclude only exact system folders, not underscored handles", () => {
  assert.equal(isArchiveAuthorFolder("_accounts"), false);
  assert.equal(isArchiveAuthorFolder("_MEDIA"), false);
  assert.equal(isArchiveAuthorFolder("_system"), false);
  assert.equal(isArchiveAuthorFolder("_c_aca"), true);
  assert.equal(isArchiveAuthorFolder("_1funeral"), true);
  assert.equal(isArchiveAuthorFolder("ordinary"), true);
});

test("pinned accounts come first, in the order they were pinned", () => {
  // The same list GridExplorer uses, so one set of pins serves both views.
  const card = (folder: string) => accountCardFrom(`XMediaArchive/_accounts/${folder}.md`, {}, "XMediaArchive")!;
  const cards = [card("aaa"), card("sample_artist"), card("bbb"), card("pinned_two")];
  const pinned = ["pinned_two.md", "sample_artist.md"];
  assert.deepEqual(pinnedFirst(cards, pinned).map((entry) => entry.folder),
    ["pinned_two", "sample_artist", "aaa", "bbb"]);
  assert.equal(isPinned("pinned_two", pinned), true);
  assert.equal(isPinned("aaa", pinned), false);
});

test("a vault with no pins keeps its original order", () => {
  const card = (folder: string) => accountCardFrom(`XMediaArchive/_accounts/${folder}.md`, {}, "XMediaArchive")!;
  const cards = [card("bbb"), card("aaa")];
  assert.deepEqual(pinnedFirst(cards, undefined).map((entry) => entry.folder), ["bbb", "aaa"]);
  assert.deepEqual(pinnedFirst(cards, ["nope.md"]).map((entry) => entry.folder), ["bbb", "aaa"]);
  assert.equal(isPinned("aaa", null), false);
});

test("post pins come from namespaced frontmatter and stay first within the selected date order", () => {
  const make = (name: string, pinned: unknown) => postCardFrom(
    `XMediaArchive/dummy/${name}.md`,
    [],
    { xmc_pinned: pinned },
  );
  assert.equal(isPostPinned({ xmc_pinned: true }), true);
  assert.equal(isPostPinned({ xmc_pinned: "true" }), false, "only a YAML boolean is a pin");
  const newestOrder = [make("newest", false), make("pinned-new", true), make("older", false), make("pinned-old", true)];
  assert.deepEqual(pinnedPostsFirst(newestOrder).map((card) => card.preview),
    ["pinned-new", "pinned-old", "newest", "older"]);
  assert.deepEqual(newestOrder.map((card) => card.preview),
    ["newest", "pinned-new", "older", "pinned-old"], "the sorted input is untouched");
});

test("favorites use only a YAML boolean and keep cross-author chronological order", () => {
  const make = (folder: string, name: string, favorite: unknown) => postCardFrom(
    `XMediaArchive/${folder}/${name}.md`, [], { xmc_favorite: favorite },
  );
  assert.equal(isPostFavorite({ xmc_favorite: true }), true);
  assert.equal(isPostFavorite({ xmc_favorite: "true" }), false);
  const chronological = [
    make("first", "newest", true),
    make("second", "middle", false),
    make("third", "oldest", true),
  ];
  assert.deepEqual(favoritePosts(chronological).map((card) => [card.authorFolder, card.preview]), [
    ["first", "newest"], ["third", "oldest"],
  ]);
  assert.equal(chronological.length, 3, "filtering does not mutate the source list");
});

test("pin updates are immediate, idempotent, and preserve unrelated entries", () => {
  assert.deepEqual(updatedPinnedEntries(["a.md", "B.MD"], "b", false), ["a.md", "b.md"]);
  assert.deepEqual(updatedPinnedEntries(["a.md", "B.MD"], "b", true), ["a.md"]);
  assert.deepEqual(updatedPinnedEntries(undefined, "new", false), ["new.md"]);
  assert.deepEqual(updatedPinnedEntries(["keep.md", 7, null], "new", true), ["keep.md"]);
});

test("a matching metadata pin event does not need a second render", () => {
  assert.equal(pinnedEntriesEqual(["a.md", "B.MD"], ["A.MD", "b.md"]), true);
  assert.equal(pinnedEntriesEqual(["a.md", 7], ["a.md"]), true, "frontmatter junk is ignored consistently");
  assert.equal(pinnedEntriesEqual(["a.md", "b.md"], ["b.md", "a.md"]), false, "pin order is visible");
  assert.equal(pinnedEntriesEqual(["a.md"], undefined), false);
  assert.equal(pinnedEntriesEqual(undefined, null), true);
});

test("a post card lists every media it owns, so deleting it leaves no orphans", () => {
  const embeds = ["a/x_01.jpg", "a/x_02.jpg", "a/x_03.mp4"];
  const card = postCardFrom("XMediaArchive/dummy/2026-01-01_000000 - t - 1.md", embeds);
  assert.deepEqual(card.mediaPaths, embeds);
  assert.deepEqual(postCardFrom("a/b - c - 1.md", []).mediaPaths, []);
});

test("accounts sort by every axis, and ties fall back to the name", () => {
  // 150 accounts hold exactly one post, so without a tiebreak the order would
  // shuffle between renders.
  const make = (folder: string, posts: number, media: number, updated: number) =>
    accountCardFrom(`XMediaArchive/_accounts/${folder}.md`,
      { post_count: posts, media_count: media }, "XMediaArchive", updated)!;
  const cards = [make("b", 1, 5, 300), make("a", 1, 9, 100), make("c", 40, 1, 200)];
  assert.deepEqual(sortAccounts(cards, "name").map((card) => card.folder), ["a", "b", "c"]);
  assert.deepEqual(sortAccounts(cards, "posts").map((card) => card.folder), ["c", "a", "b"]);
  assert.deepEqual(sortAccounts(cards, "media").map((card) => card.folder), ["a", "b", "c"]);
  assert.deepEqual(sortAccounts(cards, "recent").map((card) => card.folder), ["b", "c", "a"]);
  assert.deepEqual(cards.map((card) => card.folder), ["b", "a", "c"], "the input order is untouched");
});

test("accounts with barely anything saved are split off, and zero keeps them together", () => {
  const make = (folder: string, posts: number) =>
    accountCardFrom(`XMediaArchive/_accounts/${folder}.md`, { post_count: posts }, "XMediaArchive")!;
  const cards = [make("many", 40), make("one", 1), make("three", 3)];
  const split = splitByPostCount(cards, 3);
  assert.deepEqual(split.many.map((card) => card.folder), ["many"]);
  assert.deepEqual(split.few.map((card) => card.folder), ["one", "three"], "the threshold is inclusive");
  assert.deepEqual(splitByPostCount(cards, 0).few, [], "zero turns the split off");
  assert.equal(splitByPostCount(cards, 0).many.length, 3);
});

test("pinned accounts are never classified as few, even below the threshold", () => {
  const make = (folder: string, posts: number) =>
    accountCardFrom(`XMediaArchive/_accounts/${folder}.md`, { post_count: posts }, "XMediaArchive")!;
  const cards = [make("pinned-one", 1), make("main", 40), make("few", 3), make("pinned-zero", 0)];
  const groups = groupAccounts(cards, ["pinned-zero.md", "pinned-one.md"], 3);
  assert.deepEqual(groups.pinned.map((card) => card.folder), ["pinned-zero", "pinned-one"]);
  assert.deepEqual(groups.main.map((card) => card.folder), ["main"]);
  assert.deepEqual(groups.few.map((card) => card.folder), ["few"]);
});

test("account grouping is exhaustive and exclusive at threshold boundaries", () => {
  const make = (folder: string, posts: number) =>
    accountCardFrom(`XMediaArchive/_accounts/${folder}.md`, { post_count: posts }, "XMediaArchive")!;
  const cards = [make("zero", 0), make("three", 3), make("four", 4), make("forty", 40)];
  for (const threshold of [0, 1, 3, 5, 10]) {
    const groups = groupAccounts(cards, ["THREE.MD", "missing.md"], threshold);
    const all = [...groups.pinned, ...groups.main, ...groups.few].map((card) => card.folder);
    assert.equal(all.length, cards.length, `threshold ${threshold} keeps every card`);
    assert.equal(new Set(all).size, cards.length, `threshold ${threshold} duplicates none`);
    assert.deepEqual(new Set(all), new Set(cards.map((card) => card.folder)));
    assert.equal(groups.few.some((card) => card.folder === "three"), false, "pin wins over threshold");
  }
});

test("a view containing only pinned or few accounts still has no missing cards", () => {
  const make = (folder: string, posts: number) =>
    accountCardFrom(`XMediaArchive/_accounts/${folder}.md`, { post_count: posts }, "XMediaArchive")!;
  const pinnedOnly = groupAccounts([make("a", 1), make("b", 2)], ["a.md", "b.md"], 3);
  assert.equal(pinnedOnly.main.length, 0);
  assert.equal(pinnedOnly.few.length, 0);
  assert.equal(pinnedOnly.pinned.length, 2);
  const fewOnly = groupAccounts([make("a", 1), make("b", 2)], [], 3);
  assert.equal(fewOnly.main.length, 0);
  assert.equal(fewOnly.pinned.length, 0);
  assert.equal(fewOnly.few.length, 2);
});
