// content_main.js — ESM body, loaded via dynamic import() from content.js.
// Responsibilities: parse buffered/streamed "xmc:graphql" payloads into a
// TweetCache, inject download buttons into tweet articles, detect the
// logged-in account on click (never cached — account switching must work),
// and talk to the service worker via the runtime bridge provided by content.js.
import { collectProfiles, collectTweets } from "./lib/graphql_extract.js";
import { ProfileCache } from "./lib/profile_cache.js";
import {
  photoMediaFromImageSrc,
  screenNameFromStatusHref,
  statusIdFromHref,
} from "./lib/dom_media.js";
import { pickScreenNameFromTexts, screenNameFromAvatarTestid } from "./lib/account.js";
import {
  normalizeBulkOptions,
  tweetMatchesFilters,
  evaluateStop,
  shouldStopForMaxTweets,
  BulkSession,
} from "./lib/bulk.js";
import {
  SELECTORS,
  mediaFilterFromSearch,
  mediaFilterLabel,
  mediaPageScreenName,
} from "./lib/x_surface.js";
import { buildSavePostRequest } from "./lib/save_request.js";
import { buildSameAuthorReplyTree, directReplyTreeSaveOptions } from "./lib/reply_tree.js";

// DEBUG flag: controls the "[xmc]" prefixed console.log tracing used while
// debugging in Chrome (SW errors are relayed into responses so they surface
// here instead of in the invisible service-worker console).
const DEBUG = false;

function debugLog(...args) {
  if (DEBUG) console.log("[xmc]", ...args);
}

const runtimeBridge = {
  sendMessage: null,
  getLastError: null,
};

function configureRuntimeBridge(bridge) {
  if (!bridge || typeof bridge !== "object") return;
  if (typeof bridge.sendMessage === "function") {
    runtimeBridge.sendMessage = bridge.sendMessage;
  }
  if (typeof bridge.getLastError === "function") {
    runtimeBridge.getLastError = bridge.getLastError;
  }
}

function sendRuntimeMessage(message, callback) {
  if (typeof runtimeBridge.sendMessage !== "function") {
    callback(null, { message: "runtime message bridge unavailable" });
    return;
  }

  try {
    runtimeBridge.sendMessage(message, (response) => {
      const lastError =
        typeof runtimeBridge.getLastError === "function" ? runtimeBridge.getLastError() : null;
      callback(response, lastError || null);
    });
  } catch (err) {
    callback(null, err);
  }
}

const CACHE_LIMIT = 2000;
const STYLE_ELEMENT_ID = "xmc-style";

// In-memory UI cache only. IndexedDB in the service worker is the durable
// media-level ledger; a tweet is painted as archived only when all its media
// records are complete.
const downloadedIds = new Set();

// Independent, self-contained class so it can be reused as-is by a future
// bulk-download feature.
class TweetCache {
  constructor(limit) {
    this.limit = limit;
    this.map = new Map();
  }

  set(tweetId, tweet) {
    if (this.map.has(tweetId)) {
      this.map.delete(tweetId);
    }
    this.map.set(tweetId, tweet);
    while (this.map.size > this.limit) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }

  get(tweetId) {
    return this.map.get(tweetId);
  }

  values() {
    return Array.from(this.map.values());
  }
}

const cache = new TweetCache(CACHE_LIMIT);
const profiles = new ProfileCache();

// Hooks invoked with the array of newly-collected NormalizedTweet objects
// every time a graphql payload yields at least one tweet. The bulk-download
// engine (below) registers itself here instead of patching this function.
const onNewTweetsHooks = [];

function handleGraphqlPayload(detail) {
  try {
    const json = JSON.parse(detail);
    for (const profile of collectProfiles(json)) profiles.put(profile);
    const tweets = collectTweets(json).map((tweet) => profiles.enrich(tweet));
    for (const tweet of tweets) {
      cache.set(tweet.tweetId, tweet);
    }
    if (tweets.length > 0) {
      debugLog("collected tweets", tweets.length);
      scanForTweets(document.documentElement);
      for (const hook of onNewTweetsHooks) {
        try {
          hook(tweets);
        } catch (err) {
          debugLog("onNewTweets hook error", err && err.message);
        }
      }
    }
  } catch (err) {
    debugLog("failed to parse xmc:graphql payload", err && err.message);
  }
}

// Collects every non-empty text node under `root` into an array. Used
// instead of textContent so pickScreenNameFromTexts (which expects an exact
// "@handle" match) sees each label as its own entry.
function collectTexts(root) {
  const texts = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const value = node.nodeValue ? node.nodeValue.trim() : "";
    if (value) texts.push(value);
    node = walker.nextNode();
  }
  return texts;
}

// Evaluated fresh on every click — never cached — so switching the logged-in
// account is picked up immediately. Returns the *display* handle (screen_name).
function detectMyScreenName() {
  const container = document.querySelector(SELECTORS.accountSwitcher);
  if (!container) return null;

  // Primary: the avatar's testid encodes the exact screen_name
  // ("UserAvatar-Container-<handle>") — far more reliable than text parsing.
  const avatar = container.querySelector(SELECTORS.avatarContainer);
  if (avatar) {
    const fromAvatar = screenNameFromAvatarTestid(
      avatar.getAttribute("data-testid") || ""
    );
    if (fromAvatar) return fromAvatar;
  }

  // Fallback: scan visible "@handle" text nodes inside the switcher.
  const texts = collectTexts(container);
  return pickScreenNameFromTexts(texts);
}

function extractTweetId(article) {
  const links = Array.from(article.querySelectorAll("a[href]"));
  const timeLink = links.find((a) => a.querySelector("time"));
  if (timeLink) {
    const tweetId = statusIdFromHref(timeLink.getAttribute("href") || "", location.href);
    if (tweetId) return tweetId;
  }
  for (const a of links) {
    const tweetId = statusIdFromHref(a.getAttribute("href") || "", location.href);
    if (tweetId) return tweetId;
  }
  return null;
}

function extractAuthorScreenNameFromArticle(article, tweetId) {
  const links = Array.from(article.querySelectorAll("a[href]"));
  for (const link of links) {
    const screenName = screenNameFromStatusHref(
      link.getAttribute("href") || "",
      tweetId,
      location.href
    );
    if (screenName) return screenName;
  }

  return screenNameFromStatusHref(location.href, tweetId, location.href) || "unknown";
}

function ensureStyleInjected() {
  if (document.getElementById(STYLE_ELEMENT_ID)) return true;
  const styleParent = document.head || document.documentElement;
  if (!styleParent) return false;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  // textContent only (not innerHTML) — plain CSS text, no markup parsing.
  // Per-instance width/height are set inline (measured from the sibling reply
  // icon) so the button matches native icon size in both timeline and detail.
  style.textContent =
    ".xmc-btn{display:inline-flex;align-items:center;justify-content:center;" +
    "margin-left:4px;cursor:pointer;color:rgb(113,118,123);flex:0 0 auto;}" +
    ".xmc-btn:hover{color:rgb(29,155,240);}" +
    ".xmc-btn[data-xmc-surface='media-viewer']{" +
    "display:inline-flex;align-items:center;justify-content:center;" +
    "flex:0 0 auto;margin-left:12px;}" +
    ".xmc-btn.xmc-loading{opacity:0.5;}" +
    ".xmc-btn.xmc-done{color:rgb(0,186,124);}" +
    ".xmc-btn.xmc-error{color:rgb(244,33,46);}" +
    ".xmc-notice{position:fixed;right:16px;bottom:64px;z-index:10000;" +
    "max-width:360px;padding:10px 14px;border-radius:8px;color:#fff;" +
    "background:rgba(21,32,43,.96);box-shadow:0 3px 14px rgba(0,0,0,.35);" +
    "font-size:13px;line-height:1.45;}" +
    ".xmc-notice.xmc-error{background:rgba(120,24,32,.97);}" +
    // Permanent "already downloaded" state (persisted via chrome.storage,
    // see downloadedIds/recordDownloaded) — distinct from the transient
    // xmc-done (green, on success) / xmc-error (red flash, 1.5s) above.
    ".xmc-btn.xmc-history-done{color:rgb(244,33,46);}";
  styleParent.appendChild(style);
  return true;
}

const SVG_NS = "http://www.w3.org/2000/svg";

const DEFAULT_ICON_SIZE = 18.75;

// Reads the pixel size of the native reply icon so our button can match it.
// Detail pages render larger action icons than the timeline; measuring keeps
// us in sync with either. Falls back to the timeline default size.
function measureIconSize(replyButton) {
  const nativeIcon = replyButton.querySelector("svg");
  if (nativeIcon) {
    const rect = nativeIcon.getBoundingClientRect();
    if (rect && rect.height >= 12 && rect.height <= 48) {
      return rect.height;
    }
  }
  return DEFAULT_ICON_SIZE;
}

// Built exclusively with createElement / createElementNS — innerHTML and
// insertAdjacentHTML are forbidden (x.com enforces Trusted Types).
function createDownloadButton(size) {
  const px = String(size);
  const wrapper = document.createElement("div");
  wrapper.className = "xmc-btn harvester";
  wrapper.dataset.xmcButton = "1";
  wrapper.setAttribute("role", "button");
  wrapper.setAttribute("tabindex", "0");
  wrapper.setAttribute("aria-label", "Download media (xmc)");
  wrapper.style.width = px + "px";
  wrapper.style.height = px + "px";

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", px);
  svg.setAttribute("height", px);

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute(
    "d",
    "M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41L7.71 " +
      "9.71 6.29 8.29 12 2.59zM21 15l-.02 3.51c0 1.38-1.12 " +
      "2.49-2.5 2.49H5.5C4.12 21 3 19.88 3 18.5V15h2v3.5c0 " +
      ".28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z"
  );
  path.setAttribute("transform", "rotate(180 12 12)");

  svg.appendChild(path);
  wrapper.appendChild(svg);
  return wrapper;
}

function showXmcNotice(message, error = false) {
  document.querySelector(".xmc-notice")?.remove();
  const notice = document.createElement("div");
  notice.className = error ? "xmc-notice xmc-error" : "xmc-notice";
  notice.setAttribute("role", "status");
  notice.textContent = message;
  (document.body || document.documentElement).appendChild(notice);
  setTimeout(() => notice.remove(), 4500);
}

function setButtonState(button, state) {
  button.classList.remove("xmc-loading", "xmc-done", "xmc-error");
  if (state) button.classList.add(state);
}

// Adds/removes the permanent xmc-history-done class based on the current
// downloadedIds Set. Safe to call with a null button (queried-but-missing).
function applyHistoryClass(button, tweetId) {
  if (!button) return;
  if (downloadedIds.has(tweetId)) {
    button.classList.add("xmc-history-done");
  } else {
    button.classList.remove("xmc-history-done");
  }
}

// Paints every currently-rendered button (single-DL surface inside the
// tweet's article + media-viewer surface, if open) for tweetId red. Cheaper
// than a full scanForTweets() re-render when we already know exactly which
// tweetId just finished downloading.
function paintHistoryButtonsForTweet(tweetId) {
  const article = findArticleByTweetId(tweetId);
  if (article) {
    applyHistoryClass(article.querySelector(SELECTORS.downloadButton), tweetId);
  }
  const viewerButtons = document.querySelectorAll(SELECTORS.mediaViewerDownloadButton);
  for (const button of viewerButtons) {
    if (button.dataset.xmcTweetId === tweetId) applyHistoryClass(button, tweetId);
  }
}

function updateTweetArchiveUi(tweetId, allComplete) {
  if (typeof tweetId !== "string" || tweetId === "") return;
  if (allComplete) downloadedIds.add(tweetId);
  else downloadedIds.delete(tweetId);
  paintHistoryButtonsForTweet(tweetId);
}

// IndexedDB remains service-worker-owned. The content script asks only for a
// single rendered tweet, avoiding an unbounded ledger scan on every X tab.
function refreshTweetArchiveStatus(tweetId) {
  sendRuntimeMessage({ type: "xmc:ledger:tweet-status", tweetId }, (response, lastError) => {
    if (lastError || !response || !response.ok) return;
    updateTweetArchiveUi(tweetId, response.allComplete === true);
  });
}

function migrateLegacyHistoryOnce() {
  sendRuntimeMessage({ type: "xmc:ledger:migrate-legacy" }, (_response, lastError) => {
    if (lastError) debugLog("ledger: legacy migration request failed", lastError.message);
  });
}

function extractDomPhotoMedia(root, tweetId) {
  const result = [];
  const seen = new Set();
  const rootIsArticle = root.matches(SELECTORS.tweetArticle);
  const images = Array.from(root.querySelectorAll("img[src]"));

  for (const img of images) {
    const nestedArticle = img.closest(SELECTORS.tweetArticle);
    if (rootIsArticle && nestedArticle && nestedArticle !== root) continue;
    if (!rootIsArticle && nestedArticle && extractTweetId(nestedArticle) !== tweetId) {
      continue;
    }

    const statusLink = img.closest('a[href*="/status/"]');
    const linkedTweetId = statusLink
      ? statusIdFromHref(statusLink.getAttribute("href") || "", location.href)
      : null;
    if (linkedTweetId && linkedTweetId !== tweetId) continue;
    if (!linkedTweetId && rootIsArticle) continue;

    const item = photoMediaFromImageSrc(img.currentSrc || img.src || img.getAttribute("src"));
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);
    result.push(item);
  }

  return result;
}

function resolveDownloadableTweet(root, tweetId) {
  const cached = cache.get(tweetId);
  if (cached && Array.isArray(cached.media) && cached.media.length > 0) {
    return cached;
  }

  const domMedia = extractDomPhotoMedia(root, tweetId);
  if (domMedia.length === 0) return null;

  return {
    tweetId,
    authorScreenName:
      cached?.authorScreenName ||
      (root.matches(SELECTORS.tweetArticle)
        ? extractAuthorScreenNameFromArticle(root, tweetId)
        : screenNameFromStatusHref(location.href, tweetId, location.href) || "unknown"),
    media: domMedia,
  };
}

function findArticleByTweetId(tweetId) {
  const articles = Array.from(document.querySelectorAll(SELECTORS.tweetArticle));
  return articles.find((article) => extractTweetId(article) === tweetId) || null;
}

function resolveMediaViewerTweet(tweetId) {
  const article = findArticleByTweetId(tweetId);
  if (article) {
    const tweet = resolveDownloadableTweet(article, tweetId);
    if (tweet) return tweet;
  }
  return resolveDownloadableTweet(document.documentElement, tweetId);
}

function requestSavePost(tweet, {
  mode,
  jobId = null,
  forceRedownload = false,
  includePostWhenMediaSkipped = false,
  allowNoMedia = false,
} = {}) {
  let request;
  try {
    request = buildSavePostRequest(profiles.enrich(tweet), {
      mode, jobId, forceRedownload, includePostWhenMediaSkipped, allowNoMedia,
    });
  } catch (error) {
    return Promise.resolve({ ok: false, error: error?.message || String(error) });
  }
  return new Promise((resolve) => {
    sendRuntimeMessage({ type: "xmc:save-post", request }, (response, lastError) => {
      if (lastError) {
        resolve({ ok: false, error: lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "empty service-worker response" });
    });
  });
}

async function saveReplyTree(button, tree) {
  if (button.dataset.xmcBusy === "1") return;
  button.dataset.xmcBusy = "1";
  try {
    setButtonState(button, "xmc-loading");
    const created = await sendArchiveControlMessage({ type: "xmc:job:create", mode: "bulk" });
    if (!created?.ok || !created.jobId) {
      setButtonState(button, "xmc-error");
      showXmcNotice(`返信ツリーの開始に失敗しました: ${runtimeFailureMessage(created?.error)}`, true);
      return;
    }

    let accepted = 0;
    for (const tweet of tree.posts) {
      const response = await requestSavePost(tweet, directReplyTreeSaveOptions(created.jobId));
      if (response?.ok) {
        accepted++;
        if (response.allComplete === true) updateTweetArchiveUi(tweet.tweetId, true);
      }
    }

    const finalized = await sendArchiveControlMessage({ type: "xmc:job:finalize", jobId: created.jobId });
    if (!finalized?.ok || accepted !== tree.posts.length) {
      setButtonState(button, "xmc-error");
      showXmcNotice(`返信ツリーは一部のみ受け付けられました (${accepted}/${tree.posts.length})。`, true);
      return;
    }

    setButtonState(button, "xmc-done");
    const suffix = tree.partial ? "（欠損・分岐・上限のため部分ツリー）" : "";
    showXmcNotice(`返信ツリー ${accepted}件を保存キューへ追加しました。${suffix}`);
  } finally {
    delete button.dataset.xmcBusy;
  }
}

async function onButtonClick(event, root, tweetId) {
  event.stopPropagation();
  event.preventDefault();

  const button = event.currentTarget;
  const tree = buildSameAuthorReplyTree(tweetId, cache.values());
  if (tree.posts.length >= 2) {
    await saveReplyTree(button, tree);
    return;
  }
  const tweet =
    root === document.documentElement
      ? resolveMediaViewerTweet(tweetId)
      : resolveDownloadableTweet(root, tweetId);

  if (!tweet) {
    // Tweet id was not captured with downloadable media and DOM photo fallback
    // could not prove that the article itself owns a pbs.twimg.com/media image.
    debugLog("cache MISS: tweet not captured", tweetId, "cacheSize=", cache.map.size);
    setButtonState(button, "xmc-error");
    setTimeout(() => setButtonState(button, null), 1500);
    return;
  }

  if (!Array.isArray(tweet.media) || tweet.media.length === 0) {
    // Tweet was captured but has no downloadable media of its own (e.g. a
    // quote-tweet whose media lives in the embedded quoted tweet).
    debugLog("cache HIT but media EMPTY", tweetId, "author=", tweet.authorScreenName);
    setButtonState(button, "xmc-error");
    setTimeout(() => setButtonState(button, null), 1500);
    return;
  }

  setButtonState(button, "xmc-loading");
  debugLog("dispatching archive save", { tweetId, mediaCount: tweet.media.length });
  const response = await requestSavePost(tweet, { mode: "manual" });
  if (response && response.ok) {
    debugLog("archive save accepted", response);
    setButtonState(button, "xmc-done");
    updateTweetArchiveUi(tweet.tweetId, response.allComplete === true);
  } else {
    debugLog("archive save failed", response && response.error);
    setButtonState(button, "xmc-error");
  }
}

function syncButton(article) {
  if (!(article instanceof Element)) return;

  const tweetId = extractTweetId(article);
  if (!tweetId) return;

  const replyButton = article.querySelector(SELECTORS.replyButton);
  if (!replyButton) return;

  const actionBar = replyButton.closest('[role="group"]');
  if (!actionBar) return;

  const existingButton = actionBar.querySelector(SELECTORS.downloadButton);
  const tweet = resolveDownloadableTweet(article, tweetId);
  if (!tweet) {
    if (existingButton) {
      existingButton.remove();
      article.removeAttribute("data-harvest-article");
      delete article.dataset.xmcInjected;
      debugLog("button removed: no downloadable media", tweetId);
    }
  } else if (existingButton) {
    article.setAttribute("data-harvest-article", "");
    article.dataset.xmcInjected = "1";
    applyHistoryClass(existingButton, tweetId);
  } else {
    ensureStyleInjected();
    const button = createDownloadButton(measureIconSize(replyButton));
    button.addEventListener("click", (event) => onButtonClick(event, article, tweetId));
    applyHistoryClass(button, tweetId);
    actionBar.appendChild(button);
    refreshTweetArchiveStatus(tweetId);

    article.setAttribute("data-harvest-article", "");
    article.dataset.xmcInjected = "1";
    debugLog("button injected", tweetId, "mediaCount=", tweet.media.length);
  }

}

function elementsIncludingRoot(root, selector) {
  if (!(root instanceof Element)) return [];
  const elements = [];
  if (root.matches(selector)) elements.push(root);
  elements.push(...root.querySelectorAll(selector));
  return elements;
}

function currentPageTweetId() {
  return statusIdFromHref(location.href, location.href);
}

function syncMediaViewerButtons(root) {
  const tweetId = currentPageTweetId();
  if (!tweetId || !(root instanceof Element)) return;

  const tweet = resolveMediaViewerTweet(tweetId);
  const shareButtons = elementsIncludingRoot(root, SELECTORS.shareButton).filter(
    (button) => !button.closest(SELECTORS.tweetArticle)
  );

  for (const shareButton of shareButtons) {
    const actionBar =
      shareButton.closest('[role="group"][aria-label]') ||
      shareButton.closest('[role="group"]') ||
      shareButton.parentElement;
    if (!actionBar) continue;

    let existingButton = actionBar.querySelector(
      `${SELECTORS.downloadButton}[data-xmc-surface="media-viewer"]`
    );
    if (existingButton && existingButton.dataset.xmcTweetId !== tweetId) {
      existingButton.remove();
      existingButton = null;
    }
    if (!tweet) {
      if (existingButton) existingButton.remove();
      continue;
    }
    if (existingButton) {
      applyHistoryClass(existingButton, tweetId);
      continue;
    }

    ensureStyleInjected();
    const button = createDownloadButton(measureIconSize(shareButton));
    button.dataset.xmcSurface = "media-viewer";
    button.dataset.xmcTweetId = tweetId;
    button.addEventListener("click", (event) =>
      onButtonClick(event, document.documentElement, tweetId)
    );
    applyHistoryClass(button, tweetId);

    actionBar.appendChild(button);
    refreshTweetArchiveStatus(tweetId);
    debugLog("media viewer button injected", tweetId, "mediaCount=", tweet.media.length);
  }
}

class TwitterKeyboardShortcut {
  constructor() {
    this.buttonQuery = SELECTORS.harvesterButton;
    this.downloadKey = "d";
    this.focusing = document.activeElement;
  }

  getButton(root) {
    return root.querySelector(this.buttonQuery);
  }

  handleKeyDown(event) {
    if (this.hasModifier(event)) return;
    if (!(event.target instanceof Element)) return;
    if (!this.shouldHandleTarget(event.target)) return;
    if (event.key !== this.downloadKey) return;
    this.updateFocusing(event);
  }

  handleKeyUp(event) {
    if (this.hasModifier(event)) return;
    if (!this.focusing) return;
    if (!(event.target instanceof Element)) return;
    if (!this.shouldHandleTarget(event.target)) return;
    if (event.key !== this.downloadKey) return;

    const article = this.focusing.closest(SELECTORS.harvestArticle);
    if (!article) return;

    const button = this.getButton(article);
    if (button && !this.isEditableTarget(event.target)) {
      button.click();
    }
  }

  hasModifier(event) {
    return event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;
  }

  updateFocusing(event) {
    if (event.target instanceof Element) {
      this.focusing = event.target;
    }
  }

  shouldHandleTarget(target) {
    return !this.isEditableTarget(target) && !this.isTwitterEditor(target);
  }

  isTwitterEditor(target) {
    return "classList" in target && target.classList.value.includes("Editor");
  }

  isEditableTarget(target) {
    const tagName = target.tagName.toLowerCase();
    if (["input", "textarea", "select"].includes(tagName)) return true;
    if (target.hasAttribute("contenteditable")) return true;
    if (target.closest('[contenteditable="true"]')) return true;

    if ("classList" in target) {
      const className = target.classList.value.toLowerCase();
      if (
        [
          "input",
          "textarea",
          "editor",
          "editable",
          "compose",
          "tweet-compose",
          "dm-compose",
          "search",
          "reply",
        ].some((name) => className.includes(name))
      ) {
        return true;
      }
    }

    const role = target.getAttribute("role");
    return Boolean(role && ["textbox", "searchbox", "combobox"].includes(role));
  }
}

function setupKeyboardShortcut() {
  const keyboardShortcut = new TwitterKeyboardShortcut();
  window.addEventListener("keyup", (event) => keyboardShortcut.handleKeyUp(event));
  window.addEventListener("keydown", (event) => keyboardShortcut.handleKeyDown(event));
}

function scanForTweets(root) {
  if (!(root instanceof Element)) return;
  if (root.matches(SELECTORS.tweetArticle)) {
    syncButton(root);
  }
  const articles = root.querySelectorAll(SELECTORS.tweetArticle);
  for (const article of articles) {
    syncButton(article);
  }
  syncMediaViewerButtons(root);
}

function setupObserver() {
  const observer = new MutationObserver((mutations) => {
    checkLocationChange();
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          scanForTweets(node);
        }
      } else if (mutation.type === "attributes" && mutation.target instanceof Element) {
        const article = mutation.target.matches(SELECTORS.tweetArticle)
          ? mutation.target
          : mutation.target.closest(SELECTORS.tweetArticle);
        if (article) syncButton(article);
        syncMediaViewerButtons(mutation.target);
      }
    }
    syncMediaViewerButtons(document.documentElement);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href", "src"],
  });
}

// ---------------------------------------------------------------------------
// Bulk download (profile /media page only)
// ---------------------------------------------------------------------------
// Everything below is a thin UI/engine layer over the pure logic in
// lib/bulk.js. It reuses TweetCache / handleGraphqlPayload / cache /
// resolveDownloadableTweet-adjacent helpers (detectMyScreenName,
// setButtonState, ensureStyleInjected) already defined above and does not
// touch the single-download button path (scanForTweets / syncButton /
// onButtonClick are untouched).

const STATE_LABELS = {
  idle: "未開始",
  collecting: "収集中",
  paused: "一時停止",
  complete: "完了",
  stopped: "停止",
  error: "エラー",
};

const STOP_REASON_LABELS = {
  maxTweets: "件数上限に到達",
  maxTime: "最大実行時間に到達",
  noNewData: "新規データなしタイムアウト",
  reachedStartDate: "開始日より前のツイートに到達",
  userStop: "手動停止",
};

function bulkStateLabel(state) {
  return STATE_LABELS[state] || state;
}

function bulkStopReasonLabel(reason) {
  return STOP_REASON_LABELS[reason] || reason;
}

// Module-level engine state. Only one bulk session can run at a time (single
// modal instance), matching the "個人用ミニ版" scope of the feature.
const bulkState = {
  session: null, // BulkSession instance while a run exists (idle..error)
  opts: null, // normalized options + pageScreenName, set at start()
  jobId: null,
  workerPromises: [],
  finalizing: false,
  startedAtMs: null,
  lastNewDataAtMs: null,
  oldestSeenCreatedAtMs: null,
  // Downloaded media the finished job could not account for. Reported by the
  // service worker at finalize; 0 on a healthy run.
  orphanedMedia: 0,
  scrollTimer: null,
  stopCheckTimer: null,
  statsTimer: null,
  triggerButton: null,
  modal: null,
  modalEls: null,
};

let lastHref = null;
let bulkStylesInjected = false;

// Appends bulk-UI-only CSS to the shared <style id="xmc-style"> element
// (created by ensureStyleInjected). textContent assignment only — no
// innerHTML/insertAdjacentHTML anywhere in this file.
function injectBulkStyles() {
  if (bulkStylesInjected) return;
  const style = document.getElementById(STYLE_ELEMENT_ID);
  if (!style) return;
  bulkStylesInjected = true;
  style.textContent +=
    ".xmc-bulk-trigger{position:fixed;right:16px;bottom:16px;z-index:9999;" +
    "padding:8px 14px;border-radius:9999px;border:none;" +
    "background:rgb(29,155,240);color:#fff;font-size:13px;font-weight:700;" +
    "cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.35);}" +
    ".xmc-bulk-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.6);" +
    "z-index:10000;align-items:center;justify-content:center;}" +
    ".xmc-bulk-panel{background:rgb(21,32,43);color:#fff;border-radius:12px;" +
    "padding:20px;width:340px;max-height:82vh;overflow-y:auto;font-size:13px;" +
    "box-shadow:0 4px 24px rgba(0,0,0,0.5);}" +
    ".xmc-bulk-title{margin:0 0 12px;font-size:16px;font-weight:700;}" +
    ".xmc-bulk-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;" +
    "font-size:12px;}" +
    ".xmc-bulk-field input[type='text'],.xmc-bulk-field input[type='number']," +
    ".xmc-bulk-field input[type='date']{background:rgb(32,35,39);color:#fff;" +
    "border:1px solid rgb(83,100,113);border-radius:4px;padding:4px 6px;" +
    "font-size:12px;}" +
    ".xmc-bulk-field-checkbox{flex-direction:row;align-items:center;gap:6px;}" +
    ".xmc-bulk-stats{margin:12px 0;font-size:12px;line-height:1.7;" +
    "white-space:pre-wrap;}" +
    ".xmc-bulk-buttons{display:flex;flex-wrap:wrap;gap:8px;}" +
    ".xmc-bulk-btn{padding:6px 10px;border-radius:6px;" +
    "border:1px solid rgb(83,100,113);background:transparent;color:#fff;" +
    "cursor:pointer;font-size:12px;}" +
    ".xmc-bulk-btn:disabled{opacity:0.4;cursor:not-allowed;}";
}

function createFieldWrapper(labelText, extraClass) {
  const wrapper = document.createElement("label");
  wrapper.className = extraClass
    ? "xmc-bulk-field " + extraClass
    : "xmc-bulk-field";
  const span = document.createElement("span");
  span.textContent = labelText;
  wrapper.appendChild(span);
  return wrapper;
}

function createFieldText(labelText, defaultValue) {
  const wrapper = createFieldWrapper(labelText);
  const input = document.createElement("input");
  input.type = "text";
  input.value = defaultValue;
  wrapper.appendChild(input);
  return { wrapper, input };
}

function createFieldNumber(labelText, defaultValue) {
  const wrapper = createFieldWrapper(labelText);
  const input = document.createElement("input");
  input.type = "number";
  input.value = defaultValue;
  wrapper.appendChild(input);
  return { wrapper, input };
}

function createFieldDate(labelText) {
  const wrapper = createFieldWrapper(labelText);
  const input = document.createElement("input");
  input.type = "date";
  wrapper.appendChild(input);
  return { wrapper, input };
}

function createFieldCheckbox(labelText, defaultChecked) {
  const wrapper = createFieldWrapper(labelText, "xmc-bulk-field-checkbox");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = defaultChecked;
  wrapper.insertBefore(input, wrapper.firstChild);
  return { wrapper, input };
}

function createModalButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "xmc-bulk-btn";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

// Built exclusively with createElement — innerHTML/insertAdjacentHTML are
// forbidden site-wide (x.com enforces Trusted Types).
function buildBulkModalDom() {
  const overlay = document.createElement("div");
  overlay.className = "xmc-bulk-overlay";
  overlay.style.display = "none";

  const panel = document.createElement("div");
  panel.className = "xmc-bulk-panel";
  overlay.appendChild(panel);

  const title = document.createElement("h2");
  title.className = "xmc-bulk-title";
  // Filled in by openBulkModal, which names the tab being swept.
  title.textContent = "一括ダウンロード";
  panel.appendChild(title);

  const els = { title };

  const maxTweetsField = createFieldNumber("最初のNツイートのみ (空欄=無制限)", "");
  panel.appendChild(maxTweetsField.wrapper);
  els.maxTweets = maxTweetsField.input;

  const startDateField = createFieldDate("開始日 (空欄=無制限)");
  panel.appendChild(startDateField.wrapper);
  els.startDate = startDateField.input;

  const endDateField = createFieldDate("終了日 (空欄=無制限・当日を含む)");
  panel.appendChild(endDateField.wrapper);
  els.endDate = endDateField.input;

  const includeImagesField = createFieldCheckbox("画像を含む", true);
  panel.appendChild(includeImagesField.wrapper);
  els.includeImages = includeImagesField.input;

  const includeVideosField = createFieldCheckbox("動画を含む", true);
  panel.appendChild(includeVideosField.wrapper);
  els.includeVideos = includeVideosField.input;

  // The ledger suppresses anything it has already saved, and nothing tells it
  // when the archive loses a file. This is the only way to get those back.
  const forceRedownloadField = createFieldCheckbox("保存済みも再取得する (欠損の修復用)", false);
  panel.appendChild(forceRedownloadField.wrapper);
  els.forceRedownload = forceRedownloadField.input;

  const maxConcurrentField = createFieldNumber("最大同時DL数", "20");
  panel.appendChild(maxConcurrentField.wrapper);
  els.maxConcurrent = maxConcurrentField.input;

  const maxRunMinutesField = createFieldNumber("最大実行時間(分)", "30");
  panel.appendChild(maxRunMinutesField.wrapper);
  els.maxRunMinutes = maxRunMinutesField.input;

  const noNewDataTimeoutSecField = createFieldNumber(
    "新データなしタイムアウト(秒)",
    "60"
  );
  panel.appendChild(noNewDataTimeoutSecField.wrapper);
  els.noNewDataTimeoutSec = noNewDataTimeoutSecField.input;

  const statsDiv = document.createElement("div");
  statsDiv.className = "xmc-bulk-stats";
  statsDiv.textContent = "状態: " + bulkStateLabel("idle");
  panel.appendChild(statsDiv);
  els.stats = statsDiv;

  const ledgerDiv = document.createElement("div");
  ledgerDiv.className = "xmc-bulk-stats";
  ledgerDiv.textContent = "Ledger: loading";
  panel.appendChild(ledgerDiv);
  els.ledger = ledgerDiv;

  const buttonRow = document.createElement("div");
  buttonRow.className = "xmc-bulk-buttons";
  panel.appendChild(buttonRow);

  els.startBtn = createModalButton("開始", handleBulkStartClick);
  els.pauseBtn = createModalButton("一時停止", handleBulkPauseClick);
  els.resumeBtn = createModalButton("続行", handleBulkResumeClick);
  els.stopBtn = createModalButton("停止", handleBulkStopClick);
  els.closeBtn = createModalButton("閉じる", handleBulkCloseClick);
  buttonRow.appendChild(els.startBtn);
  buttonRow.appendChild(els.pauseBtn);
  buttonRow.appendChild(els.resumeBtn);
  buttonRow.appendChild(els.stopBtn);
  buttonRow.appendChild(els.closeBtn);

  bulkState.modalEls = els;
  return overlay;
}

function ensureBulkModal() {
  if (bulkState.modal) return bulkState.modal;
  if (!document.body || !ensureStyleInjected()) return null;
  injectBulkStyles();
  const overlay = buildBulkModalDom();
  document.body.appendChild(overlay);
  bulkState.modal = overlay;
  return overlay;
}

function ensureTriggerButton() {
  if (bulkState.triggerButton) return bulkState.triggerButton;
  if (!document.body || !ensureStyleInjected()) return null;
  injectBulkStyles();
  const button = document.createElement("button");
  button.type = "button";
  button.className = "xmc-bulk-trigger";
  button.textContent = "一括DL";
  button.addEventListener("click", () => openBulkModal());
  document.body.appendChild(button);
  bulkState.triggerButton = button;
  return button;
}

// Shown only while on a `/<screen_name>/media` profile page.
function updateTriggerButtonVisibility() {
  const screenName = mediaPageScreenName(location.pathname);
  if (screenName) {
    const button = ensureTriggerButton();
    if (button) button.style.display = "inline-flex";
  } else if (bulkState.triggerButton) {
    bulkState.triggerButton.style.display = "none";
  }
}

// Detects SPA (pushState-based) navigation: called from the existing
// MutationObserver callback (fires continuously during route changes) and
// from a `popstate` listener (back/forward navigation).
function checkLocationChange() {
  if (location.href === lastHref) return;
  lastHref = location.href;
  debugLog("bulk: location changed", location.href);
  // Moving to another profile is the normal way to line up the next sweep, and
  // it used to leave the finished run in place so the next start did nothing.
  discardFinishedBulkSession();
  updateTriggerButtonVisibility();
}

// Exported for tests: this is the whole UI of the bulk feature, and it is
// built with DOM calls that no other test path reaches.
export function openBulkModal() {
  const modal = ensureBulkModal();
  if (!modal) return;
  // Named on every open, not once at build time: X splits its media page into
  // separate tabs by query string, and a run only ever sweeps the one that is
  // showing. Reading it here keeps the heading true after a tab switch.
  if (bulkState.modalEls?.title) {
    bulkState.modalEls.title.textContent =
      `一括ダウンロード（${mediaFilterLabel(mediaFilterFromSearch(location.search))}）`;
  }
  modal.style.display = "flex";
  updateStatsDisplay();
  refreshLedgerStats();
  collectUnfinishedJobs();
}

/**
 * Publishes anything a previous run downloaded but never got a manifest out
 * for. Opening this modal is the one moment every bulk user passes through, so
 * it is where stranded jobs get collected -- not on a timer, and not on a
 * service-worker restart that may never come while the tab is closed.
 */
async function collectUnfinishedJobs() {
  const response = await sendArchiveControlMessage({
    type: "xmc:job:finish-pending",
    exceptJobId: bulkState.jobId,
  });
  if (!response?.ok) {
    debugLog("bulk: could not collect unfinished jobs", response);
    return;
  }
  debugLog("bulk: collected unfinished jobs", response);
  const posts = response.published.reduce((total, job) => total + job.posts, 0);
  const failed = response.published.reduce((total, job) => total + (job.failedMedia ?? 0), 0);
  if (posts > 0) {
    const lost = failed > 0
      ? `メディア ${failed} 件は取得できていないため、必要なら「保存済みも再取得する」で拾い直してください。`
      : "";
    showXmcNotice(`前回までの未完了ジョブ ${response.published.length} 件（${posts} 投稿）を保存記録へ書き出しました。Obsidianが取り込みます。${lost}`);
  }
  if (response.stuck.length > 0) {
    const detail = response.stuck
      .map((job) => `${job.jobId.slice(0, 8)} (${job.posts}投稿 / 未確定DL ${job.pending}/${job.media})`)
      .join("、");
    showXmcNotice(`未完了のジョブが ${response.stuck.length} 件残っています: ${detail}`, true);
  }
}

function refreshLedgerStats() {
  const target = bulkState.modalEls?.ledger;
  if (!target) return;
  sendRuntimeMessage({ type: "xmc:ledger:stats" }, (response, lastError) => {
    if (lastError || !response?.ok) {
      const detail = runtimeFailureMessage(lastError?.message || response?.error);
      target.textContent = `Ledger: unavailable (${detail})`;
      return;
    }
    const bytes = Number(response.estimatedBytes) || 0;
    const mib = bytes / (1024 * 1024);
    const warning = bytes >= 1024 * 1024 * 1024 ? " / WARNING >= 1 GiB" : bytes >= 500 * 1024 * 1024 ? " / warning >= 500 MiB" : "";
    target.textContent = `Ledger: ${response.count} media / ${mib.toFixed(1)} MiB${warning}`;
  });
}

function readModalInputs() {
  const els = bulkState.modalEls;
  return {
    maxTweets: els.maxTweets.value,
    startDate: els.startDate.value,
    endDate: els.endDate.value,
    includeImages: els.includeImages.checked,
    includeVideos: els.includeVideos.checked,
    forceRedownload: els.forceRedownload.checked,
    maxConcurrent: els.maxConcurrent.value,
    maxRunMinutes: els.maxRunMinutes.value,
    noNewDataTimeoutSec: els.noNewDataTimeoutSec.value,
  };
}

function updateModalButtons() {
  const els = bulkState.modalEls;
  if (!els) return;
  const state = bulkState.session ? bulkState.session.state : "idle";
  els.startBtn.disabled = state !== "idle";
  els.pauseBtn.disabled = state !== "collecting";
  els.resumeBtn.disabled = state !== "paused";
  els.stopBtn.disabled = state !== "collecting" && state !== "paused";
}

function updateStatsDisplay() {
  const els = bulkState.modalEls;
  if (!els) return;
  if (!bulkState.session) {
    els.stats.textContent = "状態: " + bulkStateLabel("idle");
    updateModalButtons();
    return;
  }
  const stats = bulkState.session.stats();
  // Counted from what was collected, never from which tab we think we are on.
  // X decides what a tab yields; if it changes, these numbers change with it
  // and nothing here needs editing.
  const counts = bulkState.session.mediaCounts();
  const segments = [
    "状態: " + bulkStateLabel(stats.state),
    "検出: " + stats.discovered,
    `内訳: 画像 ${counts.photos} / 動画 ${counts.videos}`,
    "待機: " + stats.queued,
    "完了: " + stats.downloaded,
    "スキップ: " + stats.skipped,
    "失敗: " + stats.failed,
  ];
  if (stats.stopReason) {
    segments.push("停止理由: " + bulkStopReasonLabel(stats.stopReason));
  }
  if (bulkState.orphanedMedia > 0) {
    segments.push("記録漏れ: " + bulkState.orphanedMedia);
  }
  els.stats.textContent = segments.join(" / ");
  updateModalButtons();
}

// Feeds one NormalizedTweet through the current session's filters. Used both
// for the onNewTweets hook and for the initial cache replay at session
// start. No-op unless a session is actively collecting.
function processTweetForBulk(tweet) {
  const session = bulkState.session;
  if (!session || session.state !== "collecting") return;
  if (!tweet || typeof tweet !== "object") return;

  const opts = bulkState.opts;
  const pageScreenName = opts && opts.pageScreenName;
  if (
    typeof pageScreenName !== "string" ||
    typeof tweet.authorScreenName !== "string" ||
    pageScreenName.toLowerCase() !== tweet.authorScreenName.toLowerCase()
  ) {
    return;
  }

  // Track the oldest-seen date for this author regardless of the date/media
  // filters below, so evaluateStop's reachedStartDate can fire once scrolling
  // has paged past the configured start date.
  if (typeof tweet.createdAtMs === "number") {
    if (
      bulkState.oldestSeenCreatedAtMs === null ||
      tweet.createdAtMs < bulkState.oldestSeenCreatedAtMs
    ) {
      bulkState.oldestSeenCreatedAtMs = tweet.createdAtMs;
    }
  }

  const result = tweetMatchesFilters(tweet, opts);
  if (!result.match) return;

  const beforeSize = session.tweets.size;
  session.addTweet({ ...tweet, media: result.media });
  if (session.tweets.size > beforeSize) {
    bulkState.lastNewDataAtMs = Date.now();
    debugLog("bulk: tweet queued", tweet.tweetId, "media=", result.media.length);
  }

  // Enforce maxTweets the instant it is reached, rather than waiting for the
  // next 1s checkStopConditions() poll. Without this, a synchronous replay
  // of the entire GraphQL cache at session start (see handleBulkStartClick)
  // or a single auto-scroll batch (UserMedia can deliver ~20 tweets in one
  // payload) can blow far past the configured cap before the poller ever
  // runs. session.state flips to "complete" here, so the early-return guard
  // at the top of this function makes any further tweets in the same
  // synchronous loop (e.g. the cache-replay for-loop) a no-op automatically.
  if (shouldStopForMaxTweets(session.stats().discovered, opts.maxTweets)) {
    debugLog("bulk: maxTweets reached, stopping immediately", session.stats().discovered);
    session.finish("maxTweets");
    stopCollectionTimers();
    updateStatsDisplay();
  }
}

function checkStopConditions() {
  const session = bulkState.session;
  if (!session || session.state !== "collecting") return;

  const result = evaluateStop({
    now: Date.now(),
    startedAtMs: bulkState.startedAtMs,
    lastNewDataAtMs: bulkState.lastNewDataAtMs,
    processedCount: session.stats().discovered,
    oldestSeenCreatedAtMs: bulkState.oldestSeenCreatedAtMs,
    opts: bulkState.opts,
  });

  if (result.stop) {
    debugLog("bulk: stop condition met", result.reason);
    session.finish(result.reason);
    stopCollectionTimers();
    updateStatsDisplay();
  }
}

function startAutoScrollTimer() {
  clearInterval(bulkState.scrollTimer);
  bulkState.scrollTimer = setInterval(() => {
    const session = bulkState.session;
    if (!session || session.state !== "collecting") return;
    window.scrollTo(0, document.body.scrollHeight);
  }, 800);
}

function startStopCheckTimer() {
  clearInterval(bulkState.stopCheckTimer);
  bulkState.stopCheckTimer = setInterval(checkStopConditions, 1000);
}

function startStatsTimer() {
  clearInterval(bulkState.statsTimer);
  bulkState.statsTimer = setInterval(updateStatsDisplay, 500);
}

// Stops the collection-side timers (auto-scroll + stop-condition polling).
// The stats timer keeps running until the modal is closed so the user still
// sees live download progress after collection has finished.
function stopCollectionTimers() {
  clearInterval(bulkState.scrollTimer);
  bulkState.scrollTimer = null;
  clearInterval(bulkState.stopCheckTimer);
  bulkState.stopCheckTimer = null;
}

function stopAllTimers() {
  stopCollectionTimers();
  clearInterval(bulkState.statsTimer);
  bulkState.statsTimer = null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendArchiveControlMessage(message) {
  return new Promise((resolve) => {
    sendRuntimeMessage(message, (response, lastError) => {
      if (lastError) {
        resolve({ ok: false, error: lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

function isExtensionContextInvalidated(error) {
  return typeof error === "string" && error.includes("Extension context invalidated");
}

export function runtimeFailureMessage(error) {
  const text = typeof error === "string" ? error : "unknown error";
  if (isExtensionContextInvalidated(text)) return "拡張再読込後に、このXタブも再読み込みしてください";
  if (/Receiving end does not exist|message port closed|could not establish connection/i.test(text)) {
    return "Service Workerへ接続できません。Xタブを再読み込みしてください";
  }
  if (/IndexedDB upgrade is blocked/i.test(text)) return "他のXタブを再読み込みしてから再試行してください";
  return text.replace(/[\r\n]+/g, " ").slice(0, 160);
}

async function downloadBulkTweet(session, tweet) {
  debugLog("bulk: download start", tweet.tweetId, "mediaCount=", tweet.media.length);
  const response = await requestSavePost(tweet, { mode: "bulk", jobId: bulkState.jobId, forceRedownload: bulkState.opts?.forceRedownload === true });

  if (response && response.ok) {
    if (response.allComplete === true && (!response.downloadIds || response.downloadIds.length === 0)) {
      session.markSkipped(tweet.tweetId);
      updateTweetArchiveUi(tweet.tweetId, true);
    } else {
      session.markDownloaded(tweet.tweetId);
    }
    debugLog("bulk: save accepted", tweet.tweetId, response);
  } else {
    session.markFailed(tweet.tweetId);
    debugLog("bulk: download failed", tweet.tweetId, response && response.error);
    if (isExtensionContextInvalidated(response && response.error)) {
      session.fail("Extension context invalidated. Reload this X tab after reloading the extension.");
      stopCollectionTimers();
      updateStatsDisplay();
    }
  }
}

const BULK_TERMINAL_STATES = new Set(["complete", "stopped", "error"]);

// One worker = one long-lived async loop pulling from session.takeNext().
// Keeps draining the queue even after the session reaches a terminal state
// (collection stopped, but already-queued tweets still need downloading);
// only exits once the queue is empty AND the session is terminal, or the
// session has been discarded (modal closed).
async function runBulkDownloadWorker(session) {
  for (;;) {
    if (bulkState.session !== session) return;
    const tweet = session.takeNext();
    if (tweet) {
      await downloadBulkTweet(session, tweet);
      continue;
    }
    if (BULK_TERMINAL_STATES.has(session.state)) return;
    await sleep(300);
  }
}

function startDownloadWorkers(session) {
  const concurrency = Math.max(1, bulkState.opts.maxConcurrent || 1);
  bulkState.workerPromises = [];
  for (let i = 0; i < concurrency; i += 1) {
    bulkState.workerPromises.push(runBulkDownloadWorker(session));
  }
  // A rejected worker used to skip finalize entirely and leave the job open
  // forever, with the failure going nowhere. Whatever happened to one worker,
  // the media the others staged still need their manifest.
  Promise.all(bulkState.workerPromises)
    .catch((error) => {
      const message = error?.message || String(error);
      debugLog("bulk: a download worker failed", message);
      showXmcNotice(`一括DLの処理が1件失敗しました: ${runtimeFailureMessage(message)}`, true);
    })
    .then(() => finalizeBulkJob(session));
}

async function finalizeBulkJob(session) {
  if (bulkState.session !== session || bulkState.finalizing || !bulkState.jobId) return;
  bulkState.finalizing = true;
  const jobId = bulkState.jobId;
  const response = await sendArchiveControlMessage({ type: "xmc:job:finalize", jobId });
  if (!response || !response.ok) {
    session.fail(response?.error || "bulk job finalization failed");
    debugLog("bulk: finalize failed", response);
  } else {
    debugLog("bulk: job finalized", jobId, response);
    // The service worker only reports this; it still publishes what it has.
    // Saying nothing here is what let a run drop most of its posts and still
    // read as 完了.
    if (response.orphanedMedia > 0) {
      bulkState.orphanedMedia = response.orphanedMedia;
      showXmcNotice(
        `ダウンロード済みメディア ${response.orphanedMedia} 件が保存記録に入りませんでした。` +
          "この投稿者をもう一度、「保存済みも再取得する」を有効にして一括DLしてください。",
        true
      );
    }
  }
  bulkState.jobId = null;
  bulkState.workerPromises = [];
  bulkState.finalizing = false;
  updateStatsDisplay();
}

/**
 * True once a run is over and its job has been handed off, so the engine can be
 * pointed at the next author.
 *
 * Nothing used to clear a finished session -- not closing the modal while a job
 * id lingered, and not navigating to another profile -- so the start button
 * silently did nothing and reloading the tab was the only way to sweep a second
 * author. A session is state, not a lock: once it is terminal and its job is
 * published, it is just the previous run's result.
 */
function bulkSessionIsFinished() {
  const session = bulkState.session;
  if (!session) return true;
  return BULK_TERMINAL_STATES.has(session.state) && !bulkState.jobId && !bulkState.finalizing;
}

function discardFinishedBulkSession() {
  if (!bulkSessionIsFinished()) return;
  stopAllTimers();
  bulkState.session = null;
  bulkState.opts = null;
  bulkState.orphanedMedia = 0;
}

async function handleBulkStartClick() {
  discardFinishedBulkSession();
  if (bulkState.session) {
    // Never fail silently: the button doing nothing is indistinguishable from
    // a broken extension, which is what sent people to the reload button.
    const stats = bulkState.session.stats();
    showXmcNotice(
      `前回の一括DLがまだ終わっていません（状態: ${bulkStateLabel(stats.state)} / 待機 ${stats.queued}）。` +
        "終わるまで待つか「停止」を押してください。",
      true
    );
    return;
  }

  const pageScreenName = mediaPageScreenName(location.pathname);
  if (!pageScreenName) {
    debugLog("bulk: cannot start, not on a /media page");
    return;
  }

  const raw = readModalInputs();
  const normalized = normalizeBulkOptions(raw);
  const opts = { ...normalized, pageScreenName };
  const created = await sendArchiveControlMessage({ type: "xmc:job:create", mode: "bulk" });
  if (!created || !created.ok || typeof created.jobId !== "string") {
    debugLog("bulk: job creation failed", created);
    if (bulkState.modalEls) {
      bulkState.modalEls.stats.textContent = `状態: 開始失敗 / ${runtimeFailureMessage(created?.error)}`;
    }
    return;
  }

  const session = new BulkSession();
  session.start(opts);
  if (session.state !== "collecting") {
    debugLog("bulk: session failed to start");
    return;
  }

  bulkState.session = session;
  bulkState.opts = opts;
  bulkState.jobId = created.jobId;
  bulkState.workerPromises = [];
  bulkState.finalizing = false;
  bulkState.startedAtMs = Date.now();
  bulkState.lastNewDataAtMs = Date.now();
  bulkState.oldestSeenCreatedAtMs = null;
  bulkState.orphanedMedia = 0;

  debugLog("bulk: session started", {
    pageScreenName,
    opts,
    jobId: bulkState.jobId,
  });

  // Seed with tweets already sitting in the GraphQL cache (e.g. from
  // scrolling before opening the modal) using the same code path as
  // newly-arriving tweets.
  for (const tweet of cache.map.values()) {
    processTweetForBulk(tweet);
  }

  startAutoScrollTimer();
  startStopCheckTimer();
  startStatsTimer();
  startDownloadWorkers(session);

  updateStatsDisplay();
}

function handleBulkPauseClick() {
  if (!bulkState.session) return;
  bulkState.session.pause();
  // Stop auto-scroll + stop-condition polling while paused (the stats timer
  // keeps running so the modal still reflects in-flight downloads). Without
  // this, auto-scroll kept firing during "pause", which combined with bug A
  // above made the session look like it finished before the user could ever
  // click pause.
  stopCollectionTimers();
  debugLog("bulk: paused");
  updateStatsDisplay();
}

function handleBulkResumeClick() {
  if (!bulkState.session) return;
  bulkState.session.resume();
  bulkState.lastNewDataAtMs = Date.now();
  startAutoScrollTimer();
  startStopCheckTimer();
  debugLog("bulk: resumed");
  updateStatsDisplay();
}

function handleBulkStopClick() {
  if (!bulkState.session) return;
  bulkState.session.stop();
  debugLog("bulk: user stop", bulkState.session.stopReason);
  stopCollectionTimers();
  updateStatsDisplay();
}

function handleBulkCloseClick() {
  debugLog("bulk: modal closed");
  const active = bulkState.session && !BULK_TERMINAL_STATES.has(bulkState.session.state);
  if (active) {
    bulkState.session.stop();
    stopCollectionTimers();
  } else {
    discardFinishedBulkSession();
  }
  if (bulkState.modal) bulkState.modal.style.display = "none";
  updateStatsDisplay();
}

function initializeDomFeatures() {
  scanForTweets(document.documentElement);
  setupObserver();
  setupKeyboardShortcut();

  updateTriggerButtonVisibility();
  window.addEventListener("popstate", checkLocationChange);
}

function initializeDomFeaturesWhenReady() {
  if (
    document.readyState === "loading" ||
    !document.documentElement ||
    !document.body
  ) {
    document.addEventListener("DOMContentLoaded", initializeDomFeatures, { once: true });
    return;
  }

  initializeDomFeatures();
}

export function start(buffer, subscribe, runtimeApi) {
  configureRuntimeBridge(runtimeApi);
  debugLog("content_main starting", { bufferedCount: buffer.length });

  lastHref = location.href;

  for (const detail of buffer) {
    handleGraphqlPayload(detail);
  }
  subscribe(handleGraphqlPayload);

  onNewTweetsHooks.push((tweets) => {
    for (const tweet of tweets) processTweetForBulk(tweet);
  });

  // content.js runs at document_start. On a hard load (especially directly on
  // /<screen_name>/media), <head>/<body> may not exist yet. Starting the DOM
  // observer and bulk UI at that point used to throw on appendChild(null),
  // which aborted the entire content module and left downloads unhandled.
  initializeDomFeaturesWhenReady();

  migrateLegacyHistoryOnce();
}
