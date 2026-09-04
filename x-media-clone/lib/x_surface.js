// lib/x_surface.js
// Pure logic only: no chrome API / DOM API references (verified by grep during acceptance).
// Responsibilities: every assumption this extension makes about how x.com is
// shaped -- its profile URLs, its query parameters, its DOM test ids. Nothing
// here decides behaviour; the collection engine and the ledger never learn
// which version of the site they are talking to.
//
// Why this file exists
// --------------------
// In 2026-08 X reworked the profile tabs. What used to be a single メディア tab
// at `/<screen_name>/media`, rendered as a three-column grid, became:
//
//   /<screen_name>/media                -> 動画 tab   (GraphQL UserVideoTimeline)
//   /<screen_name>/media?filter=photo   -> 画像 tab   (GraphQL UserPhotoTimeline)
//
// both rendered as a vertical column of post cards.
//
// Nothing outside this file was changed to follow that, and nothing here
// branches on which version is live. The page match reads the path only, so it
// holds for the old single tab and the new pair alike; the filter value is
// passed through as the raw string X wrote, never interpreted. If X reverts,
// `filter` simply stops appearing and MEDIA_FILTER_LABELS falls back to its
// unfiltered entry -- no code path has to be removed.
//
// 2026-08-22 update: Chrome showed a partial rollback instead. The split URLs
// and tab labels above remained, the photo tab returned to the old three-column
// grid, and the video tab kept the post-card column. The previous paragraph is
// retained as the original full-rollback assumption; it does not describe this
// mixed state. Treat URL, tab label, and DOM layout as independently variable.
//
// Deliberately NOT here, because the overhaul did not move them:
//   - inject.js's "/api/graphql" marker, which matches every operation name and
//     cannot import from lib/ anyway (MAIN world, classic script)
//   - lib/graphql_extract.js's recursive walker, which is envelope-agnostic and
//     handled UserMedia, UserPhotoTimeline and UserVideoTimeline unchanged
//   - lib/media.js's CDN URL normalization, which is about pbs.twimg.com rather
//     than about the site's UI

const MEDIA_PAGE_RE = /^\/([A-Za-z0-9_]{1,15})\/media\/?$/;

/**
 * Match `/<screen_name>/media` (optionally with a trailing slash) and return
 * the screen_name. Anything else (`/foo/with_replies`, `/home`,
 * `/foo/status/123`, ...) returns null.
 *
 * The query string is deliberately not part of this: `?filter=photo` selects
 * which media tab is shown, not whether the page is a media page, and the bulk
 * button belongs on both.
 * @param {unknown} pathname
 * @returns {string|null}
 */
export function mediaPageScreenName(pathname) {
  if (typeof pathname !== "string") return null;
  const match = MEDIA_PAGE_RE.exec(pathname);
  return match ? match[1] : null;
}

/**
 * The raw `filter` query value of a media page, or null when there is none.
 * Returned verbatim: an unknown value is a label this build has not seen yet,
 * not an error, and callers must keep working when one appears.
 * @param {unknown} search location.search, with or without its leading "?"
 * @returns {string|null}
 */
export function mediaFilterFromSearch(search) {
  if (typeof search !== "string" || search === "") return null;
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const separator = pair.indexOf("=");
    const key = separator === -1 ? pair : pair.slice(0, separator);
    if (decodeURIComponent(key) !== "filter") continue;
    const value = separator === -1 ? "" : decodeURIComponent(pair.slice(separator + 1).replace(/\+/g, " "));
    return value === "" ? null : value;
  }
  return null;
}

/** Display names for the media tabs, keyed by `mediaFilterFromSearch`. The
 * `null` entry is the whole table an unfiltered `/media` needs, which is what
 * the pre-2026-08 site had and what it would return to. */
const MEDIA_FILTER_LABELS = { photo: "画像", video: "動画" };
const UNFILTERED_MEDIA_LABEL = "メディア";

/**
 * Human label for the tab a media page is currently showing. Falls back to the
 * raw filter value so a tab X adds later is still named honestly instead of
 * being reported as the unfiltered one.
 * @param {string|null} filter
 * @returns {string}
 */
export function mediaFilterLabel(filter) {
  if (typeof filter !== "string" || filter === "") return UNFILTERED_MEDIA_LABEL;
  return MEDIA_FILTER_LABELS[filter] ?? filter;
}

// Centralized so future x.com DOM/testid changes only require edits here.
export const SELECTORS = {
  tweetArticle: 'article[data-testid="tweet"]',
  accountSwitcher: '[data-testid="SideNav_AccountSwitcher_Button"]',
  avatarContainer: '[data-testid^="UserAvatar-Container-"]',
  replyButton: '[data-testid="reply"]',
  downloadButton: '.xmc-btn[data-xmc-button="1"]',
  mediaViewerDownloadButton:
    '.xmc-btn[data-xmc-button="1"][data-xmc-surface="media-viewer"]',
  harvestArticle: "[data-harvest-article]",
  harvesterButton: ".harvester",
  shareButton:
    '[data-testid="share"],[aria-label*="Share"],[aria-label*="share"],' +
    '[aria-label*="共有"],[aria-label*="シェア"]',
};
