import { ItemView, Menu, Modal, Notice, TFile, TFolder, setIcon } from "obsidian";
import type { App, TAbstractFile, WorkspaceLeaf } from "obsidian";
import { randomUUID } from "node:crypto";
import { AspectRatioCache } from "./aspect-cache.ts";
import { authorMediaDeletePlan, receiptWithoutAuthor, receiptWithoutNote, renderAccountAfterPostDelete } from "./author-delete.ts";
import {
  executeAuthorDelete,
  type AuthorDeleteAdapter as ExecutorAdapter,
  type AuthorDeletePlan as ExecutorPlan,
} from "./author-delete-executor.ts";
import {
  ACCOUNT_SORTS, POST_SORTS, accountCardFrom, accountMatchesQuery, comparePostsNewestFirst, favoritePosts, groupAccounts, isPostFavorite,
  isPostNote, isPostPinned, mediaDeletePlan, normalizeXmcViewState, pinnedEntriesEqual, pinnedPostsFirst, postCardFrom, sortAccounts,
  postMatchesQuery, profileMatchesQuery, profileMatchingUrl, profileSearchCardFrom, updatedPinnedEntries, xmcScrollKey,
  type AccountCard, type AccountSort, type PostCard, type PostSort, type ProfileSearchCard, type XmcViewState,
} from "./gallery-model.ts";
import { GridScrollMemory, scrollTopForViewportOffset } from "./grid-scroll.ts";
import {
  fileAt, frontmatterOf, hasIndexed, listAccountFiles, listAllPostFiles, listPostFiles, resolveMedia, resolvedEmbedPathsOf, resourceUrlOf,
} from "./gallery-vault.ts";
import { executePostDelete, type PostDeletePlan as ExecutorPostPlan } from "./post-delete-executor.ts";
import { clampRatio, columnCountFor, shortestColumn } from "./masonry.ts";

export const VIEW_TYPE_XMC_GALLERY = "xmc-gallery";

const TARGET_COLUMN = 220;
const COLUMN_GAP = 14;
const MAX_COLUMNS = 8;
// Far enough ahead that an image is decoded before it is scrolled to, near
// enough that opening a folder does not request everything at once.
const IMAGE_MARGIN = "800px 0px";
const RATIO_MIN = 0.55;
const RATIO_MAX = 1.6;
// Enough to fill any pane on the first pass without materialising a folder of
// several thousand posts before the reader has scrolled at all.
const PAGE_SIZE = 96;
const SENTINEL_MARGIN = "1200px 0px";
const FILL_MARGIN = 1200;
const ACCOUNT_RATIO = 1.25;
const POST_RATIO = 1;
// A video has no <img> to show, but Chromium will paint the frame at a given
// time offset once metadata loads, which is the still the reader wants.
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v"]);
const VIDEO_FRAME = "#t=0.1";
// A vault path can hold almost anything except a newline, so it separates the
// media list a tile carries in a data attribute.
const MEDIA_SEPARATOR = "\n";

type CardSource =
  | { kind: "account"; card: AccountCard; pinned: boolean }
  | { kind: "post"; card: PostCard }
  | { kind: "profile"; path: string; cover: string | null; label: string; detail?: string };

interface GalleryReturnPoint {
  /** The selected card is a stable anchor across sorting and grouping. */
  path: string;
  /** Its distance from the gallery viewport top when it was opened. */
  viewportOffset: number;
}

interface GalleryHistoryEntry {
  state: XmcViewState;
  returnPoint: GalleryReturnPoint | null;
}

interface AuthorReceiptChange {
  file: TFile;
  original: string;
  next: string;
  removedPosts: number;
}

interface AuthorDeletePlan {
  folder: string;
  displayName: string;
  accountFile: TFile;
  authorFolder: TFolder;
  noteFiles: TFile[];
  mediaFolder: TFolder | null;
  removableMedia: TFile[];
  preservedMedia: TFile[];
  receiptChanges: AuthorReceiptChange[];
  signature: string;
}

interface PostDeletePlan {
  stagePath: string;
  note: TFile;
  notePath: string;
  noteOriginal: string;
  removableMedia: TFile[];
  preservedMedia: TFile[];
  receiptChanges: Array<{ file: TFile; original: string; next: string; label: string }>;
  accountFile: TFile;
  accountOriginal: string;
  accountNext: string;
  signature: string;
}

const RECEIPT_READ_BATCH_SIZE = 16;

function filesRecursively(folder: TFolder | null): TFile[] {
  if (!folder) return [];
  const files: TFile[] = [];
  const visit = (current: TFolder): void => {
    for (const child of current.children) {
      if (child instanceof TFile) files.push(child);
      else if (child instanceof TFolder) visit(child);
    }
  };
  visit(folder);
  return files;
}

function folderEntry(app: App, path: string): TFolder | null {
  const entry = app.vault.getAbstractFileByPath(path);
  return entry instanceof TFolder ? entry : null;
}

/** What the view needs from the plugin, kept structural to avoid a cycle. */
export interface GalleryHost {
  app: App;
  galleryScrollMemory: GridScrollMemory;
  settings: {
    vaultRoot: string;
    accountSort: AccountSort;
    postSort: PostSort;
    fewPostsThreshold: number;
  };
  saveSettings(): Promise<void>;
  importPending(reconcileOnly: boolean): Promise<void>;
  runAuthorDeletion(task: () => Promise<void>): Promise<boolean>;
  runPostDeletion(task: () => Promise<void>): Promise<boolean>;
  logDiagnostic(event: string, details?: Record<string, unknown>): void;
  openGalleryFile(file: TFile, event: MouseEvent, galleryLeaf: WorkspaceLeaf): Promise<void>;
}

/**
 * Field names here must not collide with anything on ItemView.
 *
 * Under ES2022 class-field semantics a bare `private titleEl!: HTMLElement;`
 * compiles to `titleEl;`, which defines an own property set to `undefined` and
 * so overwrites what the base constructor put there. Obsidian's own `load()`
 * then calls `this.titleEl.setText(...)` and throws before this view's `onOpen`
 * ever runs -- the pane stays blank and the stack trace contains no frame from
 * this plugin, which makes it look like an Obsidian bug. Hence `barTitleEl`.
 */
export class XmcGalleryView extends ItemView {
  private readonly host: GalleryHost;
  private readonly ratios = new AspectRatioCache();
  private readonly history: GalleryHistoryEntry[] = [];
  private viewState: XmcViewState = { mode: "accounts", folder: null, anchor: 0 };

  private barEl!: HTMLElement;
  private barTitleEl!: HTMLElement;
  private backButtonEl!: HTMLElement;
  private barGlobalSearchButtonEl!: HTMLElement;
  private barFavoriteButtonEl!: HTMLElement;
  private searchInputEl!: HTMLInputElement;
  private searchClearEl!: HTMLButtonElement;
  private scrollEl!: HTMLElement;
  private columnsEl!: HTMLElement;

  private cards: CardSource[] = [];
  private tiles: HTMLElement[] = [];
  private columnEls: HTMLElement[] = [];
  private columnHeights: number[] = [];
  private pinnedSectionEl!: HTMLElement;
  private pinnedColumnsEl!: HTMLElement;
  private pinnedTiles: HTMLElement[] = [];
  private mainSectionEl!: HTMLElement;
  private fewSectionEl!: HTMLElement;
  private fewColumnsEl!: HTMLElement;
  private fewTiles: HTMLElement[] = [];
  private sentinelEl!: HTMLElement;
  private sentinelObserver: IntersectionObserver | null = null;
  private scrollKey: string | null = null;
  private restoredScrollKey: string | null = null;
  private scrollCapturedBeforeLeave = false;
  private scrollFrame: number | null = null;
  private columns = 0;
  private imageObserver: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private layoutTimer: number | null = null;
  private awaitingIndex = false;
  /** Immediate truth after processFrontMatter, while metadataCache catches up. */
  private pinnedOverride: string[] | null = null;
  private readonly postPinOverrides = new Map<string, boolean>();
  private readonly postFavoriteOverrides = new Map<string, boolean>();
  private pendingReturnPoint: GalleryReturnPoint | null = null;
  private accountQuery = "";
  private postQuery = "";
  private authorDeletePromptOpen = false;
  private authorDeleteRunning = false;
  private postDeleteRunning = false;

  constructor(leaf: WorkspaceLeaf, host: GalleryHost) { super(leaf); this.host = host; }

  getViewType(): string { return VIEW_TYPE_XMC_GALLERY; }
  getIcon(): string { return "images"; }
  getDisplayText(): string {
    if (this.viewState.mode === "author" && this.viewState.folder) return `X Media: ${this.viewState.folder}`;
    if (this.viewState.mode === "favorites") return "X Media: お気に入り";
    return this.viewState.mode === "allPosts" ? "X Media: 全保存ノート検索" : "X Media Archive";
  }

  getState(): Record<string, unknown> { return { ...this.viewState }; }

  async setState(state: unknown, result: { history: boolean }): Promise<void> {
    this.viewState = normalizeXmcViewState(state);
    if (this.columnsEl) this.render();
    await super.setState(this.getState(), result);
  }

  async onOpen(): Promise<void> {
    // A throw here aborts leaf.open and leaves an empty pane with nothing to
    // read, so the failure is shown where the cards would have been.
    try { this.build(); }
    catch (error) {
      console.error("[XMediaArchive] gallery failed to open", error);
      this.contentEl.createDiv({ cls: "xmc-gallery-empty", text: `ギャラリーを開けませんでした: ${(error as Error).message}` });
    }
  }

  private build(): void {
    const root = this.contentEl.createDiv({ cls: "xmc-gallery-root" });
    this.barEl = root.createDiv({ cls: "xmc-gallery-header" });
    this.backButtonEl = this.barEl.createEl("button", { cls: "xmc-gallery-back", attr: { "aria-label": "アカウント一覧へ戻る" } });
    setIcon(this.backButtonEl, "chevron-left");
    this.backButtonEl.addEventListener("click", () => { this.goBack(); });
    this.barTitleEl = this.barEl.createDiv({ cls: "xmc-gallery-title" });
    this.barGlobalSearchButtonEl = this.barEl.createEl("button", {
      cls: "xmc-gallery-global-search-toggle",
      attr: { "aria-label": "全保存ノートを検索", title: "全保存ノートを検索", "aria-pressed": "false" },
    });
    setIcon(this.barGlobalSearchButtonEl, "search");
    this.barGlobalSearchButtonEl.addEventListener("click", () => { this.toggleAllPostsView(); });
    this.barFavoriteButtonEl = this.barEl.createEl("button", {
      cls: "xmc-gallery-favorites-toggle", attr: { "aria-label": "お気に入りを開く", "aria-pressed": "false" },
    });
    setIcon(this.barFavoriteButtonEl, "star");
    this.barFavoriteButtonEl.addEventListener("click", () => { this.toggleFavoritesView(); });
    const sort = this.barEl.createEl("button", { cls: "xmc-gallery-sort", attr: { "aria-label": "並び替え" } });
    setIcon(sort, "arrow-up-down");
    sort.addEventListener("click", (event) => this.showSortMenu(event));
    const refresh = this.barEl.createEl("button", { cls: "xmc-gallery-refresh", attr: { "aria-label": "再読み込み" } });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => { this.render(); });
    const importPending = this.barEl.createEl("button", {
      cls: "xmc-gallery-import-pending",
      attr: { "aria-label": "保留中のX Mediaジョブをインポート", title: "Import pending X Media jobs" },
    });
    setIcon(importPending, "download");
    importPending.addEventListener("click", () => { void this.host.importPending(false); });

    const search = root.createDiv({ cls: "xmc-gallery-search" });
    const searchIcon = search.createSpan({ cls: "xmc-gallery-search-icon" });
    setIcon(searchIcon, "search");
    this.searchInputEl = search.createEl("input", {
      type: "search",
      cls: "xmc-gallery-search-input",
      attr: { "aria-label": "ノートを検索", autocomplete: "off", spellcheck: "false" },
    });
    this.searchInputEl.addEventListener("input", () => this.updateSearch(this.searchInputEl.value));
    this.searchInputEl.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.searchInputEl.value !== "") {
        event.stopPropagation();
        this.updateSearch("");
      }
    });
    this.searchClearEl = search.createEl("button", {
      cls: "xmc-gallery-search-clear", attr: { "aria-label": "検索をクリア" },
    });
    setIcon(this.searchClearEl, "x");
    this.searchClearEl.addEventListener("click", () => { this.updateSearch(""); this.searchInputEl.focus(); });

    this.scrollEl = root.createDiv({ cls: "xmc-gallery-scroll" });
    this.pinnedSectionEl = this.scrollEl.createDiv({ cls: "xmc-gallery-pinned-section" });
    this.pinnedSectionEl.createDiv({ cls: "xmc-gallery-section-label xmc-gallery-pinned-label" });
    this.pinnedColumnsEl = this.pinnedSectionEl.createDiv({ cls: "xmc-gallery-columns" });
    this.mainSectionEl = this.scrollEl.createDiv({ cls: "xmc-gallery-main-section" });
    this.mainSectionEl.createDiv({ cls: "xmc-gallery-section-label xmc-gallery-main-label" });
    this.columnsEl = this.mainSectionEl.createDiv({ cls: "xmc-gallery-columns" });
    this.sentinelEl = this.mainSectionEl.createDiv({ cls: "xmc-gallery-sentinel" });
    this.fewSectionEl = this.scrollEl.createDiv({ cls: "xmc-gallery-few-section" });
    this.fewSectionEl.createDiv({ cls: "xmc-gallery-section-label xmc-gallery-few-label" });
    this.fewColumnsEl = this.fewSectionEl.createDiv({ cls: "xmc-gallery-columns" });

    this.imageObserver = new IntersectionObserver((entries) => this.loadVisibleImages(entries), {
      root: this.scrollEl, rootMargin: IMAGE_MARGIN,
    });
    this.sentinelObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) this.fillViewport();
    }, { root: this.scrollEl, rootMargin: SENTINEL_MARGIN });
    this.sentinelObserver.observe(this.sentinelEl);
    this.registerDomEvent(this.scrollEl, "scroll", () => this.rememberScroll());
    this.resizeObserver = new ResizeObserver(() => this.scheduleLayout());
    this.resizeObserver.observe(this.scrollEl);

    this.registerDomEvent(this.scrollEl, "click", (event) => this.openTile(event));
    // Chromium starts middle-button auto-scroll on mousedown, before auxclick.
    // Handle post/profile cards here so preventDefault arrives in time.
    this.registerDomEvent(this.scrollEl, "mousedown", (event) => {
      if (event.button !== 1) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const tile = target.closest(".xmc-gallery-post, .xmc-gallery-profile");
      if (!(tile instanceof HTMLElement)) return;
      event.preventDefault();
      this.openTile(event);
    });
    this.registerDomEvent(this.scrollEl, "contextmenu", (event) => this.showTileMenu(event));
    // processFrontMatter writes before metadataCache publishes the new
    // frontmatter. Without this bridge an immediate render can read stale
    // pin/favorite state, so the user sees no change until navigating away.
    this.registerEvent(this.host.app.metadataCache.on("changed", (file) => {
      const pinsPath = `${this.host.settings.vaultRoot}/_accounts/_accounts.md`;
      if (file.path === pinsPath) {
        const cachedPins = frontmatterOf(this.host.app, file)?.pinned;
        if (this.pinnedOverride !== null && pinnedEntriesEqual(cachedPins, this.pinnedOverride)) {
          // Our optimistic render is already correct. Rendering again here can
          // invalidate the tile whose viewport position is being restored.
          this.pinnedOverride = null;
          return;
        }
        this.pinnedOverride = null;
        if (this.viewState.mode === "accounts") this.render();
        return;
      }

      const expectedPostPin = this.postPinOverrides.get(file.path);
      const expectedFavorite = this.postFavoriteOverrides.get(file.path);
      if (expectedPostPin === undefined && expectedFavorite === undefined) return;
      const frontmatter = frontmatterOf(this.host.app, file);
      let conflict = false;
      if (expectedPostPin !== undefined) {
        conflict ||= isPostPinned(frontmatter) !== expectedPostPin;
        this.postPinOverrides.delete(file.path);
      }
      if (expectedFavorite !== undefined) {
        conflict ||= isPostFavorite(frontmatter) !== expectedFavorite;
        this.postFavoriteOverrides.delete(file.path);
      }
      // A conflicting external edit wins once the cache publishes it.
      if (conflict && this.viewState.mode !== "accounts") this.render();
    }));

    this.render();
  }

  async onClose(): Promise<void> {
    // openTile captures while the masonry DOM is still attached. Once the leaf
    // has been replaced, detached tiles all report empty rectangles; sampling
    // them here would turn a valid deep position back into zero.
    if (!this.scrollCapturedBeforeLeave) this.rememberScrollImmediately();
    this.scrollKey = null;
    this.imageObserver?.disconnect(); this.imageObserver = null;
    this.sentinelObserver?.disconnect(); this.sentinelObserver = null;
    this.resizeObserver?.disconnect(); this.resizeObserver = null;
    if (this.scrollFrame !== null) window.cancelAnimationFrame(this.scrollFrame);
    if (this.layoutTimer !== null) window.clearTimeout(this.layoutTimer);
    this.tiles = [];
  }

  // -- rendering ------------------------------------------------------------

  /**
   * Never route this through `leaf.setViewState`: that calls back into
   * `setState`, which renders again. Navigation is the only thing that touches
   * leaf state, and it does so exactly once.
   */
  private render(): void {
    try { this.renderCards(); }
    catch (error) {
      // A view that fails silently is a blank pane with nothing to go on.
      console.error("[XMediaArchive] gallery render failed", error);
      this.columnsEl.empty();
      this.columnsEl.createDiv({ cls: "xmc-gallery-empty", text: `表示に失敗しました: ${(error as Error).message}` });
    }
  }

  private renderCards(): void {
    const root = this.host.settings.vaultRoot;
    const mode = this.viewState.mode;
    const folder = this.viewState.folder;
    this.columnsEl.empty();
    this.pinnedColumnsEl.empty();
    this.fewColumnsEl.empty();
    this.tiles = [];
    this.pinnedTiles = [];
    this.fewTiles = [];
    this.columnEls = [];
    this.columnHeights = [];
    this.columns = 0;
    this.backButtonEl.toggleClass("xmc-gallery-hidden", mode === "accounts");
    this.backButtonEl.setAttribute("aria-label", mode === "favorites" || mode === "allPosts" ? "前の一覧へ戻る" : "アカウント一覧へ戻る");
    this.barFavoriteButtonEl.toggleClass("is-active", mode === "favorites");
    this.barFavoriteButtonEl.setAttribute("aria-pressed", mode === "favorites" ? "true" : "false");
    this.barFavoriteButtonEl.setAttribute("aria-label", mode === "favorites" ? "お気に入りを閉じる" : "お気に入りを開く");
    this.barGlobalSearchButtonEl.toggleClass("is-active", mode === "allPosts");
    this.barGlobalSearchButtonEl.setAttribute("aria-pressed", mode === "allPosts" ? "true" : "false");
    this.barGlobalSearchButtonEl.setAttribute("aria-label", mode === "allPosts" ? "全保存ノート検索を閉じる" : "全保存ノートを検索");
    this.barGlobalSearchButtonEl.setAttribute("title", mode === "allPosts" ? "全保存ノート検索を閉じる" : "全保存ノートを検索");
    const query = mode === "accounts" ? this.accountQuery : this.postQuery;
    if (this.searchInputEl.value !== query) this.searchInputEl.value = query;
    this.searchInputEl.placeholder = mode === "accounts" ? "投稿者名・@screenNameを検索"
      : mode === "allPosts" ? "全投稿・プロフィールURLを検索"
      : "保存済み投稿ノートを検索";
    this.searchClearEl.toggleClass("is-hidden", query === "");

    // Pinned accounts, and accounts holding barely anything, each get a section
    // of their own rather than simply sorting to an end: in a masonry there are
    // no rows, so a position in the list is not something the eye can pick out
    // without a break to separate it.
    let total: number;
    let pinnedSources: CardSource[] = [];
    let fewSources: CardSource[] = [];
    if (mode === "author" && folder) {
      this.cards = this.postCards(root, folder);
      total = this.cards.length;
    } else if (mode === "favorites") {
      this.cards = this.favoriteCards(root);
      total = this.cards.length;
    } else if (mode === "allPosts") {
      this.cards = this.allPostCards(root);
      total = this.cards.length;
    } else {
      const groups = this.accountCards(root);
      this.cards = groups.main;
      pinnedSources = groups.pinned;
      fewSources = groups.few;
      total = groups.main.length + groups.pinned.length + groups.few.length;
    }
    this.pinnedTiles = pinnedSources.map((source) => this.tileFor(source));
    this.fewTiles = fewSources.map((source) => this.tileFor(source));
    this.pinnedSectionEl.toggleClass("xmc-gallery-hidden", this.pinnedTiles.length === 0);
    const pinnedLabel = this.pinnedSectionEl.querySelector(".xmc-gallery-pinned-label");
    if (pinnedLabel instanceof HTMLElement) pinnedLabel.setText(`ピン留め ・ ${this.pinnedTiles.length} 人`);
    this.fewSectionEl.toggleClass("xmc-gallery-hidden", this.fewTiles.length === 0);
    const grouped = mode === "accounts" && this.host.settings.fewPostsThreshold > 0;
    this.mainSectionEl.toggleClass("xmc-gallery-grouped", grouped);
    this.mainSectionEl.toggleClass("xmc-gallery-empty-group", grouped && this.cards.length === 0 && total > 0);
    const mainLabel = this.mainSectionEl.querySelector(".xmc-gallery-main-label");
    if (mainLabel instanceof HTMLElement) {
      mainLabel.setText(`投稿 ${this.host.settings.fewPostsThreshold + 1} 件以上 ・ ${this.cards.length} 人`);
    }
    const fewLabel = this.fewSectionEl.querySelector(".xmc-gallery-few-label");
    if (fewLabel instanceof HTMLElement) {
      fewLabel.setText(`投稿 ${this.host.settings.fewPostsThreshold} 件以下 ・ ${this.fewTiles.length} 人`);
    }
    this.barTitleEl.setText(mode === "author" && folder
      ? `${folder} ・ ${total} 投稿`
      : mode === "favorites" ? `お気に入り ・ ${total} 投稿`
      : mode === "allPosts" ? `全保存ノート検索 ・ ${total} 件` : `投稿者 ${total} 人`);

    // A newly created ItemView recalls once. Re-renders of the same live view
    // keep its current offset. This is deliberately independent of another
    // ItemView's onClose ordering: Obsidian may reopen history before closing
    // the note view that replaced this gallery.
    const key = xmcScrollKey(mode, folder);
    const restore = this.restoredScrollKey === key
      ? null
      : this.host.galleryScrollMemory.recall(key);
    this.restoredScrollKey = key;
    this.scrollKey = key;

    if (total === 0) { this.showEmptyNotice(root); this.layout(true); return; }
    this.layout(true);
    const returnPoint = this.pendingReturnPoint;
    this.pendingReturnPoint = null;
    if (returnPoint && this.restoreReturnPoint(returnPoint)) return;
    if (this.cards.length === 0) return;
    if (restore === null || restore <= 0) { this.fillViewport(); return; }
    this.restoreAnchor(restore);
  }

  /** Materialises pages until the remembered card exists, then jumps to it. */
  private restoreAnchor(anchor: number): void {
    while (this.tiles.length <= anchor && this.tiles.length < this.cards.length) this.renderPage();
    const tile = this.tiles[Math.min(anchor, this.tiles.length - 1)];
    if (!tile) return;
    window.requestAnimationFrame(() => {
      this.setTileViewportOffset(tile, 0);
      // Landing deep in the list leaves the sentinel far below the viewport,
      // where it cannot trigger the next page: everything under the anchor
      // would stay blank until the reader scrolled away and back.
      this.fillViewport();
    });
  }

  /**
   * Renders pages until there is a screenful below the viewport again. The
   * sentinel handles ordinary scrolling, but it cannot help when the content
   * ends above the fold -- after a jump, or in a pane taller than one page.
   */
  private fillViewport(): void {
    for (let guard = 0; guard < 60; guard++) {
      if (this.tiles.length >= this.cards.length) return;
      // Measured to the sentinel, not to the bottom of the document. Sections
      // that sit below it -- the accounts holding barely anything, rendered in
      // full -- would otherwise count as "already filled" and this list would
      // never materialise a single card.
      const filled = this.sentinelEl.offsetTop - this.scrollEl.scrollTop - this.scrollEl.clientHeight;
      if (filled > FILL_MARGIN) return;
      this.renderPage();
    }
  }

  private renderPage(): void {
    if (this.tiles.length >= this.cards.length) return;
    const end = Math.min(this.tiles.length + PAGE_SIZE, this.cards.length);
    for (let index = this.tiles.length; index < end; index++) {
      const source = this.cards[index];
      const tile = this.tileFor(source);
      this.tiles.push(tile);
      this.place(tile);
    }
  }

  /**
   * Records the topmost visible card by index rather than by pixel offset.
   * Images load as they are approached, so a remembered pixel offset refers to
   * a document height that does not exist yet on the way back.
   */
  private rememberScroll(): void {
    if (this.scrollKey === null || this.scrollFrame !== null) return;
    this.scrollFrame = window.requestAnimationFrame(() => {
      this.scrollFrame = null;
      this.rememberScrollImmediately();
      this.fillViewport();
    });
  }

  /** Records synchronously before this ItemView is replaced by a post note. */
  private rememberScrollImmediately(): void {
    if (this.scrollKey === null || !this.scrollEl) return;
    const top = this.scrollEl.getBoundingClientRect().top;
    const index = this.tiles.findIndex((tile) => tile.getBoundingClientRect().bottom > top);
    if (index < 0) return;
    this.host.galleryScrollMemory.save(this.scrollKey, index);
  }

  /**
   * Obsidian's metadata cache is empty until its initial index finishes, and
   * every card here is built from that cache. Rather than render an empty
   * archive, wait for the one event that says the cache is ready.
   */
  private showEmptyNotice(root: string): void {
    const accountsFolder = fileAt(this.host.app, `${root}/_accounts/_accounts.md`);
    const indexed = accountsFolder === null || hasIndexed(this.host.app, accountsFolder);
    const query = this.viewState.mode === "accounts" ? this.accountQuery : this.postQuery;
    const message = this.viewState.mode === "allPosts" && query === ""
      ? "検索語を入力すると、保存済み投稿とプロフィールを横断検索します。"
      : query !== ""
      ? `「${query}」に一致するノートはありません。`
      : indexed
      ? this.viewState.mode === "favorites"
        ? "お気に入りはありません。投稿カードを右クリックして追加できます。"
        : "表示できるカードがありません。"
      : "Obsidian の索引を待っています…";
    this.columnsEl.createDiv({ cls: "xmc-gallery-empty", text: message });
    if (query !== "" || indexed || this.awaitingIndex) return;
    this.awaitingIndex = true;
    this.registerEvent(this.host.app.metadataCache.on("resolved", () => {
      if (!this.awaitingIndex) return;
      this.awaitingIndex = false;
      this.render();
    }));
  }

  /** The pins the user set in `_accounts/_accounts.md`, shared with GridExplorer. */
  private pinnedAccounts(root: string): unknown {
    if (this.pinnedOverride !== null) return this.pinnedOverride;
    const note = fileAt(this.host.app, `${root}/_accounts/_accounts.md`);
    return note ? frontmatterOf(this.host.app, note)?.pinned : undefined;
  }

  private accountCards(root: string): { main: CardSource[]; pinned: CardSource[]; few: CardSource[] } {
    const found: AccountCard[] = [];
    for (const file of listAccountFiles(this.host.app, root)) {
      const card = accountCardFrom(file.path, frontmatterOf(this.host.app, file), root, file.stat.mtime);
      if (card && accountMatchesQuery(card, this.accountQuery)) found.push(card);
    }
    const pinnedList = this.pinnedAccounts(root);
    const wrap = (card: AccountCard, pinned: boolean): CardSource => ({ kind: "account", card, pinned });
    const sorted = sortAccounts(found, this.host.settings.accountSort);
    const groups = groupAccounts(sorted, pinnedList, this.host.settings.fewPostsThreshold);
    return {
      main: groups.main.map((card) => wrap(card, false)),
      pinned: groups.pinned.map((card) => wrap(card, true)),
      few: groups.few.map((card) => wrap(card, false)),
    };
  }

  private postCards(root: string, folder: string): CardSource[] {
    const files = listPostFiles(this.host.app, root, folder, (name) => isPostNote(name, folder));
    const newestFirst = this.host.settings.postSort !== "oldest";
    files.sort((a, b) => newestFirst ? comparePostsNewestFirst(a.name, b.name) : comparePostsNewestFirst(b.name, a.name));
    const posts = files.map((file) => this.postCard(file, root)).filter((card) => postMatchesQuery(card, this.postQuery));
    const cards: CardSource[] = pinnedPostsFirst(posts).map((card) => ({ kind: "post", card }));
    // The profile leads the folder, the way the pinned folder note does in
    // GridExplorer: it is what the reader wants when they arrive at an author.
    const profile = fileAt(this.host.app, `${root}/${folder}/_profile.md`);
    if (!profile || this.postQuery !== "") return cards;
    const account = fileAt(this.host.app, `${root}/_accounts/${folder}.md`);
    const cover = account ? frontmatterOf(this.host.app, account)?.cover_media : null;
    cards.unshift({ kind: "profile", path: profile.path, cover: typeof cover === "string" ? cover : null, label: folder });
    return cards;
  }

  private favoriteCards(root: string): CardSource[] {
    const files = listAllPostFiles(this.host.app, root, (file, folder) => {
      if (!isPostNote(file.name, folder)) return false;
      const override = this.postFavoriteOverrides.get(file.path);
      return override ?? isPostFavorite(frontmatterOf(this.host.app, file));
    });
    const newestFirst = this.host.settings.postSort !== "oldest";
    files.sort((a, b) => newestFirst ? comparePostsNewestFirst(a.name, b.name) : comparePostsNewestFirst(b.name, a.name));
    const found = files.map((file) => this.postCard(file, root)).filter((card) => postMatchesQuery(card, this.postQuery));
    return favoritePosts(found).map((card) => ({ kind: "post", card }));
  }

  private allPostCards(root: string): CardSource[] {
    // Opening this view must not materialise every saved card. It becomes a
    // result list only after the user supplies a query.
    if (this.postQuery.trim() === "") return [];
    const files = listAllPostFiles(this.host.app, root, (file, folder) => isPostNote(file.name, folder));
    const newestFirst = this.host.settings.postSort !== "oldest";
    files.sort((a, b) => newestFirst ? comparePostsNewestFirst(a.name, b.name) : comparePostsNewestFirst(b.name, a.name));
    const posts: CardSource[] = files.map((file) => this.postCard(file, root))
      .filter((card) => postMatchesQuery(card, this.postQuery))
      .map((card) => ({ kind: "post", card }));
    const profiles: CardSource[] = [];
    for (const accountFile of listAccountFiles(this.host.app, root)) {
      const account = accountCardFrom(accountFile.path, frontmatterOf(this.host.app, accountFile), root, accountFile.stat.mtime);
      if (!account) continue;
      const profileFile = fileAt(this.host.app, `${root}/${account.folder}/_profile.md`);
      if (!profileFile) continue;
      const card: ProfileSearchCard = profileSearchCardFrom(profileFile.path, frontmatterOf(this.host.app, profileFile), account.coverPath);
      if (!profileMatchesQuery(card, this.postQuery)) continue;
      profiles.push({
        kind: "profile", path: card.path, cover: card.coverPath, label: card.screenName,
        detail: profileMatchingUrl(card, this.postQuery) ?? card.displayName,
      });
    }
    return [...profiles, ...posts];
  }

  private postCard(file: TFile, root: string, frontmatter = frontmatterOf(this.host.app, file)): PostCard {
    const card = postCardFrom(file.path, resolvedEmbedPathsOf(this.host.app, file), frontmatter, root);
    const pinned = this.postPinOverrides.get(file.path);
    const favorite = this.postFavoriteOverrides.get(file.path);
    return {
      ...card,
      pinned: pinned ?? card.pinned,
      favorite: favorite ?? card.favorite,
    };
  }

  private tileFor(source: CardSource): HTMLElement {
    if (source.kind === "account") return this.accountTile(source.card, source.pinned);
    if (source.kind === "profile") return this.profileTile(source);
    return this.postTile(source.card);
  }

  private profileTile(source: { path: string; cover: string | null; label: string; detail?: string }): HTMLElement {
    const tile = this.tileShell(source.path, source.path, "profile");
    this.mediaBox(tile, source.cover, source.path, ACCOUNT_RATIO, 0);
    const caption = tile.createDiv({ cls: "xmc-gallery-caption" });
    caption.createDiv({ cls: "xmc-gallery-name", text: "プロフィール" });
    caption.createDiv({ cls: "xmc-gallery-handle", text: `@${source.label}` });
    if (source.detail) caption.createDiv({ cls: "xmc-gallery-summary", text: source.detail });
    return tile;
  }

  private accountTile(card: AccountCard, pinned: boolean): HTMLElement {
    const tile = this.tileShell(card.path, card.targetPath, "accounts");
    if (pinned) tile.addClass("xmc-gallery-pinned");
    this.mediaBox(tile, card.coverPath, card.path, ACCOUNT_RATIO, 0);
    const caption = tile.createDiv({ cls: "xmc-gallery-caption" });
    caption.createDiv({ cls: "xmc-gallery-name", text: card.displayName });
    caption.createDiv({ cls: "xmc-gallery-handle", text: `@${card.screenName}` });
    if (card.summary) caption.createDiv({ cls: "xmc-gallery-summary", text: card.summary });
    return tile;
  }

  private postTile(card: PostCard): HTMLElement {
    const tile = this.tileShell(card.path, card.path, "post");
    tile.dataset.author = card.authorFolder;
    if (card.pinned) {
      tile.addClass("xmc-gallery-post-pinned");
      const marker = tile.createDiv({ cls: "xmc-gallery-post-pin", attr: { "aria-label": "ピン留めした投稿" } });
      setIcon(marker, "pin");
    }
    if (card.favorite) {
      tile.addClass("xmc-gallery-post-favorite");
      const marker = tile.createDiv({ cls: "xmc-gallery-post-star", attr: { "aria-label": "お気に入りの投稿" } });
      setIcon(marker, "star");
    }
    if (card.firstEmbed) tile.dataset.cover = card.firstEmbed;
    if (card.mediaPaths.length > 0) tile.dataset.media = card.mediaPaths.join(MEDIA_SEPARATOR);
    this.mediaBox(tile, card.firstEmbed, card.path, POST_RATIO, card.extraImages);
    if (card.preview || this.viewState.mode === "favorites" || this.viewState.mode === "allPosts") {
      const caption = tile.createDiv({ cls: "xmc-gallery-caption" });
      if (card.preview) caption.createDiv({ cls: "xmc-gallery-text", text: card.preview });
      if (this.viewState.mode === "favorites" || this.viewState.mode === "allPosts") caption.createDiv({ cls: "xmc-gallery-handle", text: `@${card.authorScreenName}` });
    }
    return tile;
  }

  private tileShell(path: string, target: string, kind: string): HTMLElement {
    const tile = createDiv({ cls: `xmc-gallery-tile xmc-gallery-${kind}` });
    tile.dataset.path = path;
    tile.dataset.target = target;
    return tile;
  }

  /**
   * Reserves the tile's height from a remembered or default ratio before the
   * image exists, so the column geometry is right on the first frame and a
   * decoding image only ever shifts the cards below it in its own column.
   */
  private mediaBox(tile: HTMLElement, reference: string | null, sourcePath: string, fallbackRatio: number, extra: number): void {
    const media = tile.createDiv({ cls: "xmc-gallery-media" });
    const file = reference ? resolveMedia(this.host.app, reference, sourcePath) : null;
    media.style.setProperty("--xmc-ratio", String(file ? this.ratios.get(file.path) ?? fallbackRatio : fallbackRatio));
    if (extra > 0) media.createDiv({ cls: "xmc-gallery-badge", text: `+${extra}` });
    if (!file) { media.addClass("xmc-gallery-missing"); return; }

    const url = resourceUrlOf(this.host.app, file);
    if (VIDEO_EXTENSIONS.has(file.extension.toLowerCase())) {
      const video = media.createEl("video", { attr: { muted: "", playsinline: "", preload: "metadata" } });
      // The source is withheld until the tile approaches the viewport, and the
      // fragment asks for a frame rather than the blank first sample.
      video.dataset.pending = `${url}${VIDEO_FRAME}`;
      video.addEventListener("loadedmetadata", () => {
        this.ratios.set(file.path, video.videoWidth, video.videoHeight);
        media.style.setProperty("--xmc-ratio", String(clampRatio(video.videoWidth, video.videoHeight, RATIO_MIN, RATIO_MAX)));
      });
      video.addEventListener("error", () => { media.addClass("xmc-gallery-missing"); video.remove(); });
      media.createDiv({ cls: "xmc-gallery-play", text: "▶" });
      this.imageObserver?.observe(tile);
      return;
    }
    const image = media.createEl("img", { attr: { alt: "", decoding: "async", draggable: "false" } });
    // The source is withheld until the tile approaches the viewport: assigning
    // it up front would queue one request per archived image.
    image.dataset.pending = url;
    image.addEventListener("load", () => {
      this.ratios.set(file.path, image.naturalWidth, image.naturalHeight);
      media.style.setProperty("--xmc-ratio", String(clampRatio(image.naturalWidth, image.naturalHeight, RATIO_MIN, RATIO_MAX)));
    });
    image.addEventListener("error", () => { media.addClass("xmc-gallery-missing"); image.remove(); });
    this.imageObserver?.observe(tile);
  }

  private loadVisibleImages(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const tile = entry.target as HTMLElement;
      this.imageObserver?.unobserve(tile);
      const element = tile.querySelector("img, video");
      if (!(element instanceof HTMLImageElement) && !(element instanceof HTMLVideoElement)) continue;
      const pending = element.dataset.pending;
      if (!pending) continue;
      delete element.dataset.pending;
      element.src = pending;
    }
  }

  // -- layout ---------------------------------------------------------------

  private scheduleLayout(): void {
    if (this.layoutTimer !== null) window.clearTimeout(this.layoutTimer);
    this.layoutTimer = window.setTimeout(() => { this.layoutTimer = null; this.layout(false); }, 120);
  }

  /**
   * Only a change in column *count* needs a rebuild; the columns flex to fill
   * any width in between. Tiles are moved rather than recreated, so a resize
   * never re-requests or re-decodes an image.
   */
  private layout(force: boolean): void {
    const next = columnCountFor({
      // The grouped main section has horizontal padding and a 2px border. Use
      // the actual card container width so a breakpoint cannot squeeze in one
      // column too many only when the threshold split is enabled.
      width: this.columnsEl.clientWidth || this.scrollEl.clientWidth,
      targetColumn: TARGET_COLUMN, gap: COLUMN_GAP, maxColumns: MAX_COLUMNS,
    });
    if (!force && next === this.columns) return;
    const anchor = this.captureAnchor();
    this.columns = next;

    this.spread(this.pinnedColumnsEl, this.pinnedTiles, next);
    this.spread(this.fewColumnsEl, this.fewTiles, next);
    this.columnsEl.empty();
    this.columnEls = [];
    this.columnHeights = new Array(next).fill(0);
    for (let index = 0; index < next; index++) this.columnEls.push(this.columnsEl.createDiv({ cls: "xmc-gallery-column" }));
    // Tiles are moved, never rebuilt: an <img> keeps its decoded bitmap and its
    // observer registration, so changing the column count costs no reloading.
    for (const tile of this.tiles) this.place(tile);

    if (anchor) window.requestAnimationFrame(() => { this.setTileViewportOffset(anchor.tile, anchor.offset); });
  }

  /**
   * Appends one tile to the shortest column and books its height. The running
   * total is kept rather than measured per card so placing a page costs one
   * layout flush per tile instead of one per column per tile; an image that
   * later reports a different shape is left where it is, because moving a card
   * the reader is looking at would be worse than a slightly uneven column.
   */
  /** Lays a fixed set of tiles out in one pass; used for the pinned section. */
  private spread(container: HTMLElement, tiles: readonly HTMLElement[], count: number): void {
    container.empty();
    if (tiles.length === 0) return;
    const columns: HTMLElement[] = [];
    const heights = new Array(count).fill(0);
    for (let index = 0; index < count; index++) columns.push(container.createDiv({ cls: "xmc-gallery-column" }));
    for (const tile of tiles) {
      const target = shortestColumn(heights);
      columns[target].appendChild(tile);
      heights[target] += tile.offsetHeight + COLUMN_GAP;
    }
  }

  private place(tile: HTMLElement): void {
    if (this.columnEls.length === 0) return;
    const target = shortestColumn(this.columnHeights);
    this.columnEls[target].appendChild(tile);
    this.columnHeights[target] += tile.offsetHeight + COLUMN_GAP;
  }

  private captureAnchor(): { tile: HTMLElement; offset: number } | null {
    const top = this.scrollEl.getBoundingClientRect().top;
    for (const tile of this.tiles) {
      const box = tile.getBoundingClientRect();
      if (box.bottom > top) return { tile, offset: box.top - top };
    }
    return null;
  }

  /** Places a rendered tile at a viewport-relative offset without relying on
   * `offsetTop`, whose coordinate system changes inside masonry columns. */
  private setTileViewportOffset(tile: HTMLElement, offset: number): void {
    const current = tile.getBoundingClientRect().top - this.scrollEl.getBoundingClientRect().top;
    this.scrollEl.scrollTop = scrollTopForViewportOffset(this.scrollEl.scrollTop, current, offset);
  }

  /** Restores a card after navigation or an in-place reorder. Pinned-account
   * and few-post sections are already materialised; main cards are paged only
   * up to the target. */
  private restoreReturnPoint(point: GalleryReturnPoint): boolean {
    let tile = [...this.pinnedTiles, ...this.fewTiles].find((entry) => entry.dataset.path === point.path);
    if (!tile) {
      const index = this.cards.findIndex((source) => {
        const path = source.kind === "profile" ? source.path : source.card.path;
        return path === point.path;
      });
      if (index >= 0) {
        while (this.tiles.length <= index && this.tiles.length < this.cards.length) this.renderPage();
        tile = this.tiles[index];
      }
    }
    if (!tile) return false;
    window.requestAnimationFrame(() => {
      this.setTileViewportOffset(tile as HTMLElement, point.viewportOffset);
      this.fillViewport();
    });
    return true;
  }

  private returnPointForTile(tile: HTMLElement): GalleryReturnPoint | null {
    const path = tile.dataset.path;
    if (!path) return null;
    return {
      path,
      viewportOffset: tile.getBoundingClientRect().top - this.scrollEl.getBoundingClientRect().top,
    };
  }

  /** Finds a stable visible neighbour before a card is removed. This prevents
   * an unfavorite or delete in a masonry from jumping to the top. */
  private currentReturnPoint(excludePath: string | null = null): GalleryReturnPoint | null {
    const viewport = this.scrollEl.getBoundingClientRect();
    let best: { tile: HTMLElement; distance: number } | null = null;
    for (const tile of [...this.pinnedTiles, ...this.tiles, ...this.fewTiles]) {
      if (tile.dataset.path === excludePath) continue;
      const box = tile.getBoundingClientRect();
      if (box.bottom <= viewport.top || box.top >= viewport.bottom) continue;
      const distance = Math.abs(box.top - viewport.top);
      if (best === null || distance < best.distance) best = { tile, distance };
    }
    return best ? this.returnPointForTile(best.tile) : null;
  }

  // -- navigation -----------------------------------------------------------

  private toggleFavoritesView(): void {
    if (this.viewState.mode === "favorites") { this.goBack(); return; }
    this.history.push({ state: { ...this.viewState, anchor: 0 }, returnPoint: this.currentReturnPoint() });
    this.navigate({ mode: "favorites", folder: null, anchor: 0 });
  }

  private toggleAllPostsView(): void {
    if (this.viewState.mode === "allPosts") { this.goBack(); return; }
    this.history.push({ state: { ...this.viewState, anchor: 0 }, returnPoint: this.currentReturnPoint() });
    this.navigate({ mode: "allPosts", folder: null, anchor: 0 });
  }

  private openAuthorFromFavorite(tile: HTMLElement, folder: string): void {
    if (!folder) return;
    this.history.push({ state: { ...this.viewState, anchor: 0 }, returnPoint: this.returnPointForTile(tile) });
    this.navigate({ mode: "author", folder, anchor: 0 });
  }

  private openTile(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const tile = target.closest(".xmc-gallery-tile");
    if (!(tile instanceof HTMLElement)) return;
    event.preventDefault();
    const destination = tile.dataset.target;
    if (!destination) return;

    if (this.viewState.mode === "accounts" && tile.hasClass("xmc-gallery-accounts")) {
      const folder = destination.slice(destination.lastIndexOf("/") + 1);
      const viewportOffset = tile.getBoundingClientRect().top - this.scrollEl.getBoundingClientRect().top;
      this.history.push({
        state: { ...this.viewState, anchor: 0 },
        returnPoint: { path: tile.dataset.path ?? "", viewportOffset },
      });
      this.navigate({ mode: "author", folder, anchor: 0 });
      return;
    }
    const file: TFile | null = fileAt(this.host.app, destination);
    if (!file) { new Notice("ノートが見つかりません。"); return; }
    this.rememberScrollImmediately();
    this.scrollCapturedBeforeLeave = true;
    void this.host.openGalleryFile(file, event, this.leaf);
  }

  /**
   * The card menu. Everything here acts on files the user can see, and the one
   * destructive entry asks first and moves to the vault's trash rather than
   * deleting outright.
   */
  private showTileMenu(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const tile = target.closest(".xmc-gallery-tile");
    if (!(tile instanceof HTMLElement) || !tile.dataset.path) return;
    event.preventDefault();
    const notePath = tile.dataset.path;
    const file = fileAt(this.host.app, notePath);
    if (!file) return;
    const root = this.host.settings.vaultRoot;
    const menu = new Menu();

    if (tile.hasClass("xmc-gallery-accounts")) {
      const folder = tile.dataset.target?.slice((tile.dataset.target?.lastIndexOf("/") ?? -1) + 1) ?? "";
      const pinned = tile.hasClass("xmc-gallery-pinned");
      menu.addItem((item) => item
        .setTitle(pinned ? "ピン留めを解除" : "ピン留めする")
        .setIcon(pinned ? "pin-off" : "pin")
        .onClick(() => { void this.togglePin(root, folder, pinned); }));
    }

    if (tile.hasClass("xmc-gallery-post")) {
      const favorite = tile.hasClass("xmc-gallery-post-favorite");
      menu.addItem((item) => item
        .setTitle(favorite ? "お気に入りから外す" : "お気に入りに追加")
        .setIcon(favorite ? "star-off" : "star")
        .onClick(() => { void this.togglePostFavorite(file, favorite); }));

      if (this.viewState.mode === "author" && this.viewState.folder) {
        const pinned = tile.hasClass("xmc-gallery-post-pinned");
        menu.addItem((item) => item
          .setTitle(pinned ? "投稿のピン留めを解除" : "投稿をピン留め")
          .setIcon(pinned ? "pin-off" : "pin")
          .onClick(() => { void this.togglePostPin(file, pinned); }));
        const cover = tile.dataset.cover;
        if (cover) {
          menu.addItem((item) => item
            .setTitle("投稿者のサムネイルにする")
            .setIcon("image")
            .onClick(() => { void this.setCover(root, this.viewState.folder as string, cover); }));
        }
      } else if ((this.viewState.mode === "favorites" || this.viewState.mode === "allPosts") && tile.dataset.author) {
        menu.addItem((item) => item
          .setTitle("投稿者の投稿一覧を開く")
          .setIcon("user")
          .onClick(() => { this.openAuthorFromFavorite(tile, tile.dataset.author as string); }));
      }
    }

    menu.addItem((item) => item.setTitle("ノートを開く").setIcon("file").onClick(() => {
      void this.app.workspace.getLeaf("tab").openFile(file);
    }));
    menu.addSeparator();
    if (tile.hasClass("xmc-gallery-accounts")) {
      const folder = tile.dataset.target?.slice((tile.dataset.target?.lastIndexOf("/") ?? -1) + 1) ?? "";
      menu.addItem((item) => item.setTitle("投稿者を削除").setIcon("trash").onClick(() => {
        void this.confirmAuthorDelete(folder, notePath);
      }));
    } else {
      menu.addItem((item) => item.setTitle("削除").setIcon("trash").onClick(() => { this.confirmDelete(tile, notePath); }));
    }
    menu.showAtMouseEvent(event);
  }

  private showSortMenu(event: MouseEvent): void {
    const menu = new Menu();
    const settings = this.host.settings;
    if (this.viewState.mode !== "accounts") {
      for (const option of POST_SORTS) {
        menu.addItem((item) => item.setTitle(option.label).setChecked(settings.postSort === option.key)
          .onClick(() => { settings.postSort = option.key; void this.host.saveSettings(); this.render(); }));
      }
    } else {
      for (const option of ACCOUNT_SORTS) {
        menu.addItem((item) => item.setTitle(option.label).setChecked(settings.accountSort === option.key)
          .onClick(() => { settings.accountSort = option.key; void this.host.saveSettings(); this.render(); }));
      }
      menu.addSeparator();
      // An author saved once and an author saved a thousand times are not the
      // same kind of card, and mixing them makes the list worth less.
      for (const threshold of [0, 1, 3, 5, 10]) {
        const label = threshold === 0 ? "少数投稿を分けない" : `投稿 ${threshold} 件以下を分ける`;
        menu.addItem((item) => item.setTitle(label).setChecked(settings.fewPostsThreshold === threshold)
          .onClick(() => { settings.fewPostsThreshold = threshold; void this.host.saveSettings(); this.render(); }));
      }
    }
    menu.showAtMouseEvent(event);
  }

  private async togglePin(root: string, folder: string, pinned: boolean): Promise<void> {
    const note = fileAt(this.host.app, `${root}/_accounts/_accounts.md`);
    if (!note) { new Notice("_accounts.md がありません。"); return; }
    // Capture before awaiting the write. metadataCache may publish the change
    // before processFrontMatter's promise resumes and redraw the card first.
    const notePath = `${root}/_accounts/${folder}.md`;
    const visibleTile = [...this.pinnedTiles, ...this.tiles, ...this.fewTiles]
      .find((tile) => tile.dataset.path === notePath);
    const returnPoint: GalleryReturnPoint | null = visibleTile ? {
      path: notePath,
      viewportOffset: visibleTile.getBoundingClientRect().top - this.scrollEl.getBoundingClientRect().top,
    } : null;
    // processFrontMatter is the only safe way to edit frontmatter: it preserves
    // the rest of the note, including the folder colour GridExplorer keeps here.
    let written: string[] = [];
    try {
      await this.host.app.fileManager.processFrontMatter(note, (frontmatter) => {
        written = updatedPinnedEntries(frontmatter.pinned, folder, pinned);
        frontmatter.pinned = written;
      });
      this.pinnedOverride = written;
      this.pendingReturnPoint = returnPoint;
      this.render();
      new Notice(pinned ? `${folder} のピン留めを解除しました。` : `${folder} をピン留めしました。`);
    } catch (error) {
      console.error("[XMediaArchive] account pin update failed", error);
      this.pinnedOverride = null;
      new Notice(`${folder} のピン留めを変更できませんでした。`);
      this.render();
    }
  }

  private async togglePostPin(note: TFile, pinned: boolean): Promise<void> {
    const desired = !pinned;
    const visibleTile = this.tiles.find((tile) => tile.dataset.path === note.path);
    const returnPoint: GalleryReturnPoint | null = visibleTile ? {
      path: note.path,
      viewportOffset: visibleTile.getBoundingClientRect().top - this.scrollEl.getBoundingClientRect().top,
    } : null;
    // Install the expected value before writing so a fast metadataCache event
    // cannot race ahead of the optimistic render.
    this.postPinOverrides.set(note.path, desired);
    try {
      await this.host.app.fileManager.processFrontMatter(note, (frontmatter) => {
        if (desired) frontmatter.xmc_pinned = true;
        else delete frontmatter.xmc_pinned;
      });
      this.pendingReturnPoint = returnPoint;
      this.render();
      new Notice(desired ? "投稿をピン留めしました。" : "投稿のピン留めを解除しました。");
    } catch (error) {
      console.error("[XMediaArchive] post pin update failed", error);
      this.postPinOverrides.delete(note.path);
      new Notice("投稿のピン留めを変更できませんでした。");
      this.render();
    }
  }

  private async togglePostFavorite(note: TFile, favorite: boolean): Promise<void> {
    const desired = !favorite;
    const visibleTile = this.tiles.find((tile) => tile.dataset.path === note.path);
    const returnPoint = this.viewState.mode === "favorites" && !desired
      ? this.currentReturnPoint(note.path)
      : visibleTile ? this.returnPointForTile(visibleTile) : null;
    this.postFavoriteOverrides.set(note.path, desired);
    try {
      await this.host.app.fileManager.processFrontMatter(note, (frontmatter) => {
        if (desired) frontmatter.xmc_favorite = true;
        else delete frontmatter.xmc_favorite;
      });
      this.pendingReturnPoint = returnPoint;
      this.render();
      new Notice(desired ? "投稿をお気に入りに追加しました。" : "投稿をお気に入りから外しました。");
    } catch (error) {
      console.error("[XMediaArchive] post favorite update failed", error);
      this.postFavoriteOverrides.delete(note.path);
      new Notice("投稿のお気に入りを変更できませんでした。");
      this.render();
    }
  }

  private async setCover(root: string, folder: string, cover: string): Promise<void> {
    const note = fileAt(this.host.app, `${root}/_accounts/${folder}.md`);
    if (!note) { new Notice("投稿者カードがありません。"); return; }
    // The importer keeps an existing cover_media as long as the file is still
    // there, so a choice made here survives the next import.
    await this.host.app.fileManager.processFrontMatter(note, (frontmatter) => { frontmatter.cover_media = cover; });
    new Notice(`${folder} のサムネイルを変更しました。`);
  }

  private async prepareAuthorDelete(folder: string, accountPath: string): Promise<AuthorDeletePlan> {
    const app = this.host.app;
    const root = this.host.settings.vaultRoot.replace(/\/+$/, "");
    if (folder === "" || folder.includes("/") || folder.includes("\\") || accountPath !== `${root}/_accounts/${folder}.md`) {
      throw new Error("投稿者フォルダの指定が不正です。");
    }
    const accountFile = fileAt(app, accountPath);
    const authorFolder = folderEntry(app, `${root}/${folder}`);
    if (!accountFile || !authorFolder) throw new Error("投稿者カードまたは投稿フォルダが見つかりません。");

    if (authorFolder.children.some((child) => child instanceof TFolder)) {
      throw new Error("投稿者フォルダ内に管理対象外のサブフォルダがあります。安全のため削除を中止しました。");
    }
    const authorFiles = filesRecursively(authorFolder);
    if (authorFiles.some((file) => file.extension !== "md")) {
      throw new Error("投稿者フォルダ内に管理対象外のファイルがあります。安全のため削除を中止しました。");
    }
    const noteFiles = authorFiles;
    const mediaFolder = folderEntry(app, `${root}/_media/${folder}`);
    const mediaFiles = filesRecursively(mediaFolder);
    // A partial metadata index can miss a backlink and make shared media look
    // private. Requiring every target note and every media-bearing target note
    // to have completed link resolution avoids that without blocking forever
    // on unrelated empty Markdown files whose cache may legitimately be null.
    for (const note of noteFiles) {
      const cache = app.metadataCache.getFileCache(note);
      if (cache === null) throw new Error("対象投稿者の索引を作成中です。完了後にもう一度実行してください。");
      if ((cache.embeds?.length ?? 0) > 0 && !Object.prototype.hasOwnProperty.call(app.metadataCache.resolvedLinks, note.path)) {
        throw new Error("対象投稿者のリンク解決を実行中です。完了後にもう一度実行してください。");
      }
    }
    const internalSources = [...noteFiles.map((file) => file.path), accountFile.path];
    const mediaPlan = authorMediaDeletePlan(mediaFiles.map((file) => file.path), internalSources, app.metadataCache.resolvedLinks);
    const byPath = new Map(mediaFiles.map((file) => [file.path, file]));
    const removableMedia = mediaPlan.removable.map((path) => byPath.get(path)).filter((file): file is TFile => file instanceof TFile);
    const preservedMedia = mediaPlan.preserved.map((path) => byPath.get(path)).filter((file): file is TFile => file instanceof TFile);

    const receiptChanges: AuthorReceiptChange[] = [];
    const receiptFolder = folderEntry(app, `${root}/_system/receipts`);
    const authorPrefix = `${root}/${folder}/`.toLowerCase();
    const receiptFiles = filesRecursively(receiptFolder).filter((file) => file.extension === "json");
    const receiptContents: Array<{ file: TFile; original: string }> = [];
    // Obsidian's Vault reads are asynchronous. A small bounded batch removes
    // the serial I/O delay without flooding the adapter on a large archive.
    for (let offset = 0; offset < receiptFiles.length; offset += RECEIPT_READ_BATCH_SIZE) {
      receiptContents.push(...await Promise.all(receiptFiles.slice(offset, offset + RECEIPT_READ_BATCH_SIZE).map(async (file) => ({
        file, original: await app.vault.read(file),
      }))));
    }
    for (const { file: receiptFile, original } of receiptContents) {
      let parsed: unknown;
      try { parsed = JSON.parse(original); }
      catch (error) {
        if (original.toLowerCase().includes(authorPrefix)) throw new Error(`対象投稿者を含む可能性があるreceiptを解析できません: ${receiptFile.name}`);
        continue;
      }
      let rewrite;
      try { rewrite = receiptWithoutAuthor(parsed, root, folder); }
      catch (error) {
        if (original.toLowerCase().includes(authorPrefix)) throw new Error(`対象投稿者を含むreceiptの形式が不正です: ${receiptFile.name}`);
        continue;
      }
      if (!rewrite.changed) continue;
      receiptChanges.push({
        file: receiptFile, original, removedPosts: rewrite.removedPosts,
        next: JSON.stringify(rewrite.receipt, null, 2) + "\n",
      });
    }

    const frontmatter = frontmatterOf(app, accountFile);
    const displayName = typeof frontmatter?.author_display_name === "string" && frontmatter.author_display_name.trim() !== ""
      ? frontmatter.author_display_name.trim() : folder;
    const signature = JSON.stringify({
      account: accountFile.path,
      notes: noteFiles.map((file) => file.path).sort(),
      media: mediaFiles.map((file) => file.path).sort(),
      removable: removableMedia.map((file) => file.path).sort(),
      receipts: receiptChanges.map((change) => [change.file.path, change.original]),
    });
    return { folder, displayName, accountFile, authorFolder, noteFiles, mediaFolder, removableMedia, preservedMedia, receiptChanges, signature };
  }

  private async preparePostDelete(notePath: string): Promise<PostDeletePlan> {
    const app = this.host.app;
    const root = this.host.settings.vaultRoot.replace(/\/+$/, "");
    const note = fileAt(app, notePath);
    const slash = notePath.lastIndexOf("/");
    const folder = slash > 0 ? notePath.slice(notePath.lastIndexOf("/", slash - 1) + 1, slash) : "";
    if (!note || !folder || notePath.toLowerCase() !== `${root}/${folder}/${note.name}`.toLowerCase() || !isPostNote(note.name, folder)) {
      throw new Error("対象が投稿ノートではありません。削除を中止しました。");
    }
    const cache = app.metadataCache.getFileCache(note);
    if (cache === null) throw new Error("対象投稿の索引を作成中です。完了後にもう一度実行してください。");
    const frontmatter = frontmatterOf(app, note);
    const card = postCardFrom(note.path, resolvedEmbedPathsOf(app, note), frontmatter, root);
    const links = app.metadataCache.resolvedLinks;
    if (card.mediaPaths.length > 0 && !Object.prototype.hasOwnProperty.call(links, note.path)) {
      throw new Error("対象投稿のリンク解決を実行中です。完了後にもう一度実行してください。");
    }
    const mediaPlan = mediaDeletePlan(note.path, card.mediaPaths, links);
    const removableMedia = mediaPlan.removable.map((path) => fileAt(app, path)).filter((file): file is TFile => file instanceof TFile);
    const preservedMedia = mediaPlan.preserved.map((path) => fileAt(app, path)).filter((file): file is TFile => file instanceof TFile);
    if (removableMedia.length !== mediaPlan.removable.length || preservedMedia.length !== mediaPlan.preserved.length) {
      throw new Error("対象メディアの実体を確認できません。削除を中止しました。");
    }
    const noteOriginal = await app.vault.read(note);
    const accountFile = fileAt(app, `${root}/_accounts/${folder}.md`);
    if (!accountFile) throw new Error("投稿者カードが見つかりません。削除を中止しました。");
    const accountOriginal = await app.vault.read(accountFile);
    const mediaFolder = folderEntry(app, `${root}/_media/${folder}`);
    const removed = new Set(removableMedia.map((file) => file.path.toLowerCase()));
    const remainingMedia = filesRecursively(mediaFolder).filter((file) => !removed.has(file.path.toLowerCase()));
    const remainingNotes = listPostFiles(app, root, folder, (name) => isPostNote(name, folder) && name !== note.name);
    const accountFrontmatter = frontmatterOf(app, accountFile);
    const displayName = typeof accountFrontmatter?.author_display_name === "string" && accountFrontmatter.author_display_name.trim() !== ""
      ? accountFrontmatter.author_display_name.trim() : folder;
    const screenName = typeof accountFrontmatter?.author_screen_name === "string" && accountFrontmatter.author_screen_name.trim() !== ""
      ? accountFrontmatter.author_screen_name.trim() : folder;
    const currentCover = typeof accountFrontmatter?.cover_media === "string" ? accountFrontmatter.cover_media : null;
    const remainingPaths = remainingMedia.map((file) => file.path);
    const coverFile = currentCover ? fileAt(app, currentCover) : null;
    const coverPath = coverFile && !removed.has(coverFile.path.toLowerCase())
      ? coverFile.path
      : remainingMedia.find((file) => /\.(?:jpe?g|png|webp|gif)$/i.test(file.name))?.path ?? null;
    const accountNext = renderAccountAfterPostDelete(accountOriginal, root, folder, displayName, screenName, remainingNotes.length, remainingPaths, coverPath);

    const receiptChanges: PostDeletePlan["receiptChanges"] = [];
    const receiptFolder = folderEntry(app, `${root}/_system/receipts`);
    for (const receiptFile of filesRecursively(receiptFolder).filter((file) => file.extension === "json")) {
      const original = await app.vault.read(receiptFile);
      let parsed: unknown;
      try { parsed = JSON.parse(original); }
      catch { if (original.toLowerCase().includes(notePath.toLowerCase())) throw new Error(`対象投稿を含むreceiptを解析できません: ${receiptFile.name}`); else continue; }
      let rewrite;
      try { rewrite = receiptWithoutNote(parsed, notePath); }
      catch { if (original.toLowerCase().includes(notePath.toLowerCase())) throw new Error(`対象投稿を含むreceiptの形式が不正です: ${receiptFile.name}`); else continue; }
      if (rewrite.changed) receiptChanges.push({ file: receiptFile, original, next: JSON.stringify(rewrite.receipt, null, 2) + "\n", label: receiptFile.path });
    }
    const mediaSignature = (file: TFile) => [file.path, file.stat.size, file.stat.mtime];
    const signature = JSON.stringify({
      notePath: note.path,
      noteOriginal,
      media: [...removableMedia, ...preservedMedia].map(mediaSignature).sort(),
      removable: removableMedia.map((file) => file.path).sort(),
      preserved: preservedMedia.map((file) => file.path).sort(),
      linksResolved: Object.prototype.hasOwnProperty.call(links, note.path),
      receipts: receiptChanges.map((change) => [change.file.path, change.original]),
      accountOriginal,
      accountNext,
    });
    return {
      stagePath: `${root}/_system/delete-staging/${randomUUID()}`,
      note, notePath: note.path, noteOriginal, removableMedia, preservedMedia,
      receiptChanges, accountFile, accountOriginal, accountNext, signature,
    };
  }

  private async confirmAuthorDelete(folder: string, accountPath: string): Promise<void> {
    if (this.authorDeletePromptOpen || this.authorDeleteRunning) {
      new Notice("投稿者の削除確認または削除処理が進行中です。");
      return;
    }
    this.authorDeletePromptOpen = true;
    new AuthorDeleteModal(
      this.app,
      folder,
      () => this.prepareAuthorDelete(folder, accountPath),
      async (plan) => { await this.executeAuthorDelete(plan); },
      () => { this.authorDeletePromptOpen = false; },
    ).open();
  }

  private async ensureVaultFolder(path: string): Promise<void> {
    const parts = path.split("/").filter((part) => part !== "");
    let current = "";
    for (const part of parts) {
      current = current === "" ? part : `${current}/${part}`;
      const existing = this.host.app.vault.getAbstractFileByPath(current);
      if (!existing) await this.host.app.vault.createFolder(current);
      else if (!(existing instanceof TFolder)) throw new Error(`フォルダとして使用できないパスです: ${current}`);
    }
  }

  private async executeAuthorDelete(originalPlan: AuthorDeletePlan): Promise<void> {
    if (this.authorDeleteRunning) return;
    const acquired = await this.host.runAuthorDeletion(async () => {
      this.authorDeleteRunning = true;
      try { await this.executeAuthorDeleteLocked(originalPlan); }
      finally { this.authorDeleteRunning = false; }
    });
    if (!acquired) new Notice("インポートまたは別のVault更新が進行中です。完了後にもう一度実行してください。");
  }

  private async executeAuthorDeleteLocked(originalPlan: AuthorDeletePlan): Promise<void> {
    const app = this.host.app;
    const root = this.host.settings.vaultRoot.replace(/\/+$/, "");
    const stagePath = `${root}/_system/delete-staging/${randomUUID()}`;
    let latestPlan: AuthorDeletePlan | null = null;
    const toExecutorPlan = (plan: AuthorDeletePlan): ExecutorPlan<TAbstractFile, TFile> => {
      const media: Array<{ entry: TAbstractFile; originalPath: string; target: string }> = [];
      if (plan.mediaFolder && plan.preservedMedia.length === 0) {
        media.push({ entry: plan.mediaFolder, originalPath: plan.mediaFolder.path, target: `${stagePath}/media` });
      } else {
        for (const file of plan.removableMedia) {
          const relative = plan.mediaFolder && file.path.startsWith(`${plan.mediaFolder.path}/`)
            ? file.path.slice(plan.mediaFolder.path.length + 1) : file.name;
          media.push({ entry: file, originalPath: file.path, target: `${stagePath}/media/${relative}` });
        }
      }
      return {
        signature: plan.signature,
        stagePath,
        folder: plan.folder,
        counts: {
          noteCount: plan.noteFiles.length,
          movedMediaCount: plan.removableMedia.length,
          preservedMediaCount: plan.preservedMedia.length,
          receiptCount: plan.receiptChanges.length,
        },
        moves: {
          author: { entry: plan.authorFolder, originalPath: plan.authorFolder.path, target: `${stagePath}/author` },
          account: { entry: plan.accountFile, originalPath: plan.accountFile.path, target: `${stagePath}/account.md` },
          media,
        },
        receipts: plan.receiptChanges.map(({ file, original, next }) => ({ file, original, next })),
      };
    };

    const adapter: ExecutorAdapter<TAbstractFile, TFile> = {
      replan: async (original) => {
        const plan = await this.prepareAuthorDelete(original.folder, original.moves.account.entry.path);
        latestPlan = plan;
        return toExecutorPlan(plan);
      },
      ensureFolder: (path) => this.ensureVaultFolder(path),
      move: async (entry, target) => {
        const parent = target.slice(0, target.lastIndexOf("/"));
        if (parent) await this.ensureVaultFolder(parent);
        await app.vault.rename(entry, target);
      },
      replaceReceipt: (change) => app.vault.modify(change.file, change.next),
      capturePins: async () => {
        const file = fileAt(app, `${root}/_accounts/_accounts.md`);
        return file ? { file, original: await app.vault.read(file) } : null;
      },
      removePin: async (snapshot, folder) => {
        let written: string[] = [];
        await app.fileManager.processFrontMatter(snapshot.file, (frontmatter) => {
          written = updatedPinnedEntries(frontmatter.pinned, folder, true);
          frontmatter.pinned = written;
        });
        this.pinnedOverride = written;
      },
      restorePins: async (snapshot) => {
        await app.vault.modify(snapshot.file, snapshot.original);
        this.pinnedOverride = null;
      },
      trash: async (path) => {
        const staged = folderEntry(app, path);
        if (!staged) throw new Error("削除ステージを確認できません。");
        await app.fileManager.trashFile(staged);
      },
      deleteEmptyStage: async (path) => {
        const staging = folderEntry(app, path);
        if (staging && filesRecursively(staging).length === 0) await app.vault.delete(staging, true);
      },
      forget: (folder) => { this.host.galleryScrollMemory.forget(xmcScrollKey("author", folder)); },
      render: () => this.render(),
      logTiming: (outcome, details) => this.host.logDiagnostic("author-delete-timing", { ...details }),
    };

    const result = await executeAuthorDelete(toExecutorPlan(originalPlan), adapter);
    const plan = latestPlan ?? originalPlan;
    if (result.status === "completed") {
      const kept = plan.preservedMedia.length > 0 ? ` 外部参照中のメディア${plan.preservedMedia.length}件は残しました。` : "";
      new Notice(`${plan.displayName} の投稿者データをゴミ箱へ移動しました。${kept} 再DLでは「保存済みも再取得する」を有効にしてください。`, 10000);
      if (result.renderError) console.error("[XMediaArchive] gallery refresh after author deletion failed", result.renderError);
      return;
    }

    this.pinnedOverride = null;
    console.error("[XMediaArchive] author deletion failed", result.error, { rollbackFailures: result.rollbackFailures });
    const recovery = result.rollbackFailures.length > 0
      ? ` 一部を戻せませんでした。${result.stagePath}とゴミ箱を確認してください。`
      : " 変更は元に戻しました。";
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    new Notice(`投稿者を削除できませんでした: ${message}.${recovery}`, 12000);
    this.render();
  }

  private async confirmDelete(tile: HTMLElement, notePath: string): Promise<void> {
    try {
      const plan = await this.preparePostDelete(notePath);
      const detail = plan.removableMedia.length > 0 ? `ノート1件と専有メディア${plan.removableMedia.length}件` : "ノート1件";
      const preserved = plan.preservedMedia.length > 0 ? `\n共有または安全確認できないメディア${plan.preservedMedia.length}件は残します。` : "";
      new ConfirmModal(this.app, `${detail}をゴミ箱へ移動します。${preserved}`, async () => { await this.executePostDelete(plan); }).open();
    } catch (error) {
      console.error("[XMediaArchive] post deletion planning failed", error);
      new Notice(`投稿を削除できませんでした: ${(error as Error).message}`);
    }
  }

  private async executePostDelete(originalPlan: PostDeletePlan): Promise<void> {
    if (this.postDeleteRunning) return;
    const returnPoint = this.currentReturnPoint(originalPlan.notePath);
    const acquired = await this.host.runPostDeletion(async () => {
      this.postDeleteRunning = true;
      try {
        const toExecutorPlan = (plan: PostDeletePlan): ExecutorPostPlan<TAbstractFile, TFile> => ({
          signature: plan.signature, stagePath: plan.stagePath, notePath: plan.notePath,
          moves: [
            { entry: plan.note, originalPath: plan.note.path, target: `${plan.stagePath}/note.md` },
            ...plan.removableMedia.map((file) => ({ entry: file as TAbstractFile, originalPath: file.path, target: `${plan.stagePath}/media/${file.name}` })),
          ],
          replacements: [
            ...plan.receiptChanges,
            { file: plan.accountFile, original: plan.accountOriginal, next: plan.accountNext, label: plan.accountFile.path },
          ],
          counts: { movedMediaCount: plan.removableMedia.length, preservedMediaCount: plan.preservedMedia.length, receiptCount: plan.receiptChanges.length },
        });
        const result = await executePostDelete(toExecutorPlan(originalPlan), {
          replan: async (plan) => toExecutorPlan(await this.preparePostDelete(plan.notePath)),
          ensureFolder: (path) => this.ensureVaultFolder(path),
          move: async (entry, target) => { const parent = target.slice(0, target.lastIndexOf("/")); if (parent) await this.ensureVaultFolder(parent); await this.host.app.vault.rename(entry, target); },
          replace: (replacement) => this.host.app.vault.modify(replacement.file, replacement.next),
          trash: async (path) => { const staged = folderEntry(this.host.app, path); if (!staged) throw new Error("削除ステージを確認できません。"); await this.host.app.fileManager.trashFile(staged); },
          deleteEmptyStage: async (path) => { const stage = folderEntry(this.host.app, path); if (stage && filesRecursively(stage).length === 0) await this.host.app.vault.delete(stage, true); },
          forget: (path) => { this.postPinOverrides.delete(path); this.postFavoriteOverrides.delete(path); },
          render: () => { this.pendingReturnPoint = returnPoint; this.render(); },
        });
        if (result.status === "completed") {
          const kept = originalPlan.preservedMedia.length > 0 ? ` 共有メディア${originalPlan.preservedMedia.length}件は残しました。` : "";
          new Notice(`投稿をゴミ箱へ移動しました。${kept}`);
        } else {
          const recovery = result.rollbackFailures.length > 0 ? ` 一部を戻せませんでした。${result.stagePath}を確認してください。` : " 変更は元に戻しました。";
          new Notice(`投稿を削除できませんでした: ${(result.error as Error).message}.${recovery}`);
          this.pendingReturnPoint = returnPoint;
          this.render();
        }
      } finally { this.postDeleteRunning = false; }
    });
    if (!acquired) new Notice("インポートまたは別のVault更新が進行中です。完了後にもう一度実行してください。");
  }

  private updateSearch(value: string): void {
    const query = value.trimStart();
    if (this.viewState.mode === "accounts") this.accountQuery = query;
    else this.postQuery = query;
    this.searchInputEl.value = query;
    this.scrollEl.scrollTop = 0;
    this.render();
  }

  private goBack(): void {
    const previous = this.history.pop();
    this.pendingReturnPoint = previous?.returnPoint ?? null;
    this.navigate(previous?.state ?? { mode: "accounts", folder: null, anchor: 0 });
  }

  /** The one place leaf state is written, so the tab title follows the mode. */
  private navigate(state: XmcViewState): void {
    void this.leaf.setViewState({ type: VIEW_TYPE_XMC_GALLERY, active: true, state: { ...state } });
  }
}

class ConfirmModal extends Modal {
  private readonly message: string;
  private readonly run: () => Promise<void>;
  constructor(app: App, message: string, run: () => Promise<void>) { super(app); this.message = message; this.run = run; }
  onOpen(): void {
    this.contentEl.createEl("p", { text: this.message });
    const row = this.contentEl.createDiv({ cls: "xmc-gallery-confirm" });
    row.createEl("button", { text: "キャンセル" }).addEventListener("click", () => this.close());
    const confirm = row.createEl("button", { text: "削除", cls: "mod-warning" });
    confirm.addEventListener("click", () => { this.close(); void this.run(); });
  }
  onClose(): void { this.contentEl.empty(); }
}

class AuthorDeleteModal extends Modal {
  private readonly folder: string;
  private readonly load: () => Promise<AuthorDeletePlan>;
  private readonly run: (plan: AuthorDeletePlan) => Promise<void>;
  private readonly dismissed: () => void;
  private closed = false;
  constructor(
    app: App,
    folder: string,
    load: () => Promise<AuthorDeletePlan>,
    run: (plan: AuthorDeletePlan) => Promise<void>,
    dismissed: () => void,
  ) {
    super(app); this.folder = folder; this.load = load; this.run = run; this.dismissed = dismissed;
  }
  onOpen(): void {
    this.closed = false;
    this.setTitle("投稿者を削除");
    this.renderLoading();
    void this.loadPlan();
  }
  private renderLoading(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: `@${this.folder} の削除対象と共有メディアを安全確認しています…`,
      cls: "xmc-author-delete-lead",
    });
    const row = this.contentEl.createDiv({ cls: "xmc-gallery-confirm" });
    row.createEl("button", { text: "キャンセル" }).addEventListener("click", () => this.close());
  }
  private async loadPlan(): Promise<void> {
    try {
      const plan = await this.load();
      if (!this.closed) this.renderPlan(plan);
    } catch (error) {
      console.error("[XMediaArchive] author deletion planning failed", error);
      if (!this.closed) this.renderError((error as Error).message || "投稿者の削除計画を作成できませんでした。");
    }
  }
  private renderError(message: string): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: message, cls: "xmc-author-delete-warning" });
    const row = this.contentEl.createDiv({ cls: "xmc-gallery-confirm" });
    row.createEl("button", { text: "閉じる" }).addEventListener("click", () => this.close());
  }
  private renderPlan(plan: AuthorDeletePlan): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: `${plan.displayName}（@${plan.folder}）の保存済みデータを削除します。`,
      cls: "xmc-author-delete-lead",
    });
    const list = this.contentEl.createEl("ul", { cls: "xmc-author-delete-summary" });
    list.createEl("li", { text: `投稿・プロフィール等のノート: ${plan.noteFiles.length}件` });
    list.createEl("li", { text: `ゴミ箱へ移す専有メディア: ${plan.removableMedia.length}件` });
    list.createEl("li", { text: `更新するreceipt: ${plan.receiptChanges.length}件` });
    if (plan.preservedMedia.length > 0) {
      list.createEl("li", { text: `外部ノートが参照中のため残すメディア: ${plan.preservedMedia.length}件` });
    }
    this.contentEl.createEl("p", {
      text: "投稿者フォルダ、投稿者カード、対象receiptを整合させてゴミ箱へ移します。Chromeの保存済み台帳は変更しません。再DL時は一括DLの「保存済みも再取得する」を有効にしてください。",
      cls: "xmc-author-delete-warning",
    });
    const acknowledge = this.contentEl.createEl("label", { cls: "xmc-author-delete-ack" });
    const checkbox = acknowledge.createEl("input", { type: "checkbox" });
    acknowledge.createSpan({ text: "対象投稿者と再DL条件を確認しました" });
    const row = this.contentEl.createDiv({ cls: "xmc-gallery-confirm" });
    row.createEl("button", { text: "キャンセル" }).addEventListener("click", () => this.close());
    const confirm = row.createEl("button", { text: "投稿者を削除", cls: "mod-warning" });
    confirm.disabled = true;
    checkbox.addEventListener("change", () => { confirm.disabled = !checkbox.checked; });
    confirm.addEventListener("click", () => {
      if (!checkbox.checked) return;
      confirm.disabled = true;
      this.close();
      void this.run(plan);
    });
  }
  onClose(): void { this.closed = true; this.dismissed(); this.contentEl.empty(); }
}

export async function activateGalleryView(host: GalleryHost): Promise<void> {
  const workspace = host.app.workspace;
  // Reuse a view the user has already positioned. A new gallery belongs in a
  // central tab; notes opened from its cards can then sit beside or replace it
  // according to the user's normal workspace layout.
  const leaf = workspace.getLeavesOfType(VIEW_TYPE_XMC_GALLERY)[0]
    ?? workspace.getLeaf("tab");
  // Obsidian restores the saved layout before plugins load, so a leaf left over
  // from the last session holds a placeholder for a view type that did not
  // exist yet. Registering the type later does not rebuild it: the tab keeps
  // its remembered title and stays blank forever. Setting the state again is
  // what constructs the real view, so it is done unconditionally.
  await leaf.setViewState({
    type: VIEW_TYPE_XMC_GALLERY,
    active: true,
    state: { mode: "accounts", folder: null, anchor: 0 },
  });
  await workspace.revealLeaf(leaf);
}
