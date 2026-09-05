import { Keymap, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { homedir } from "node:os";
import * as path from "node:path";
import { DEFAULT_SETTINGS, type XmcSettings } from "./types.ts";
import { uriJobId } from "./uri.ts";
import { IMPORTED_MARKER, listCompletedJobDirectories, readCompletedJob } from "./job-reader.ts";
import { ArchiveImporter } from "./importer.ts";
import { diskFs } from "./fs.ts";
import { localVaultBasePath } from "./local-vault.ts";
import { DiagnosticLog, safeErrorDiagnostic, safeUriDiagnostic } from "./diagnostics.ts";
import { GridScrollMemory, gridScrollKey } from "./grid-scroll.ts";
import { galleryNavigationLeaf } from "./gallery-navigation.ts";
import { VIEW_TYPE_XMC_GALLERY, XmcGalleryView, activateGalleryView } from "./gallery-view.ts";
import {
  INLINE_PROPERTIES_CLASS, VIEW_TYPE_XMC_PROPERTIES, XmcPropertyView, renderPropertyDocument, revealPropertyView,
} from "./property-panel.ts";
import { isXmcPropertyNote, propertyDocument } from "./property-model.ts";
import { XmcImageLightbox } from "./image-lightbox.ts";
import { isPlainPrimaryActivation, localLightboxUrl } from "./lightbox-policy.ts";

function expandHome(value: string): string { return value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value; }

// Importing happens when the user asks for it. A background scan re-read every
// unmarked job directory forever, which is how a job that could never succeed
// came to retry every minute for hours; the back-off, the settled-job set and
// the silent-run mode all existed only to make that scan affordable.
// GridExplorer rebuilds its grid on every navigation and keeps no scroll state,
// so this samples often enough to feel instant without being a busy loop.
export const GRID_SCROLL_POLL_MS = 250;
export const LEGACY_VAULT_ROOT = "Tweets/XMedia";

export default class XMediaArchiveCompanion extends Plugin {
  settings: XmcSettings = DEFAULT_SETTINGS;
  private readonly importer = new ArchiveImporter();
  private diagnostics!: DiagnosticLog;
  private scanRunning = false;
  private archiveMutation: "import" | "author-delete" | "post-delete" | "account-refresh" | null = null;
  private readonly gridScroll = new GridScrollMemory();
  // Separate from GridExplorer's polling memory. This survives replacement of
  // an XMC gallery ItemView by a post note and restores it on browser-back.
  readonly galleryScrollMemory = new GridScrollMemory();
  private readonly propertyTimers = new Set<number>();
  private imageLightbox: XmcImageLightbox | null = null;

  private log(event: string, details?: Record<string, unknown>): void { void this.diagnostics.log({ event, details }); }

  /** `GalleryHost` entry point for the same log. The view holds no diagnostics
   * reference of its own, and a write failure there must never abort a Vault
   * mutation, so this stays fire-and-forget like `log`. */
  logDiagnostic(event: string, details?: Record<string, unknown>): void { this.log(event, details); }

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData() ?? {}) };
    const diagnosticRoot = /^(?!.*(?:^|\/)\.\.(?:\/|$))(?![A-Za-z]:)(?!\/)[^\\]+$/.test(this.settings.vaultRoot)
      ? this.settings.vaultRoot.replace(/\/+$/, "")
      : DEFAULT_SETTINGS.vaultRoot;
    this.diagnostics = new DiagnosticLog(this.app.vault.adapter, `${diagnosticRoot}/_system`);
    this.log("plugin-loaded", { version: this.manifest.version, usesDefaultInbox: this.settings.inboxPath === DEFAULT_SETTINGS.inboxPath, usesDefaultVaultRoot: this.settings.vaultRoot === DEFAULT_SETTINGS.vaultRoot });
    this.addSettingTab(new XmcSettingTab(this.app, this));
    this.registerView(VIEW_TYPE_XMC_GALLERY, (leaf) => new XmcGalleryView(leaf, this));
    this.registerView(VIEW_TYPE_XMC_PROPERTIES, (leaf) => new XmcPropertyView(leaf, this));
    this.registerEvent(this.app.workspace.on("file-open", (file) => { void this.followPropertyFile(file); }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf?.view.getViewType() === VIEW_TYPE_XMC_PROPERTIES) return;
      const file = leaf?.view.getViewType() === "markdown"
        ? (leaf.view as unknown as { file?: TFile | null }).file ?? null
        : null;
      void this.followPropertyFile(file, file !== null);
    }));
    this.registerEvent(this.app.workspace.on("layout-change", () => { this.scheduleInlineProperties(); }));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_XMC_PROPERTIES)) {
        const view = leaf.view as XmcPropertyView;
        if (view.getFilePath() === file.path) view.setFile(file);
      }
      this.scheduleInlineProperties();
    }));
    this.registerMarkdownPostProcessor((_element, context) => {
      if (context.sourcePath.startsWith(`${this.settings.vaultRoot.replace(/\/+$/, "")}/`)) this.scheduleInlineProperties();
    });
    this.registerDomEvent(document, "click", (event) => { this.openMarkdownImage(event); }, true);
    this.register(() => {
      this.imageLightbox?.close(); this.imageLightbox = null;
      this.clearInlineProperties();
      for (const timer of this.propertyTimers) window.clearTimeout(timer);
      this.propertyTimers.clear();
    });
    this.addRibbonIcon("images", "Twitter Media Archive を開く", () => { void activateGalleryView(this); });
    this.addCommand({ id: "open-gallery", name: "Open archive gallery", callback: () => { void activateGalleryView(this); } });
    this.addCommand({ id: "import-pending-jobs", name: "Import pending jobs", callback: () => this.importPending(false) });
    this.addCommand({ id: "reconcile-pending-jobs", name: "Reconcile pending jobs", callback: () => this.importPending(true) });
    this.addCommand({ id: "refresh-account-index", name: "Refresh account index", callback: async () => {
      if (!this.beginArchiveMutation("account-refresh")) { new Notice("Twitter Media archive update is already running."); return; }
      try { const count = await this.importer.refreshExistingAccounts(this.vaultBasePath(), this.settings.vaultRoot); new Notice(`Twitter Media account index: ${count} users refreshed.`); }
      catch (error) { const diagnostic = safeErrorDiagnostic(error); this.log("account-index-failed", diagnostic); new Notice(`Twitter Media account index failed (${diagnostic.category}).`); }
      finally { this.endArchiveMutation("account-refresh"); }
    } });
    this.registerObsidianProtocolHandler("x-media-archive-import", async (parameters) => {
      this.log("uri-received", safeUriDiagnostic(parameters));
      const jobId = uriJobId(parameters);
      if (!jobId) {
        this.log("uri-rejected", safeUriDiagnostic(parameters));
        new Notice(`Twitter Media Archive Companion rejected an invalid import URI. See ${this.diagnostics.relativePath}`);
        return;
      }
      this.log("uri-accepted", { jobId });
      if (!this.beginArchiveMutation("import")) { new Notice("Twitter Media archive update is already running."); return; }
      try { await this.importOne(jobId, false); }
      finally { this.endArchiveMutation("import"); }
    });
    this.registerInterval(window.setInterval(() => { this.syncGridScroll(); }, GRID_SCROLL_POLL_MS));
    const active = this.app.workspace.getActiveFile();
    if (active) void this.followPropertyFile(active);
  }

  private async followPropertyFile(file: TFile | null, reveal = true): Promise<void> {
    const frontmatter = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
    const supported = file ? isXmcPropertyNote(file.path, this.settings.vaultRoot, frontmatter) : false;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_XMC_PROPERTIES)) {
      (leaf.view as XmcPropertyView).setFile(supported ? file : null);
    }
    this.scheduleInlineProperties();
    if (file && supported && reveal) await revealPropertyView(this, file);
  }

  private scheduleInlineProperties(): void {
    for (const delay of [0, 120]) {
      const timer = window.setTimeout(() => { this.propertyTimers.delete(timer); this.syncInlineProperties(); }, delay);
      this.propertyTimers.add(timer);
    }
  }

  private syncInlineProperties(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as unknown as { file?: TFile | null; containerEl?: HTMLElement; getMode?: () => string };
      const container = view.containerEl; const file = view.file;
      if (!container) continue;
      const existing = container.querySelector<HTMLElement>(".xmc-inline-property-panel");
      const frontmatter = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
      const document = file ? propertyDocument(file.path, this.settings.vaultRoot, frontmatter) : null;
      container.classList.toggle(INLINE_PROPERTIES_CLASS, document !== null);
      if (!document) { existing?.remove(); continue; }
      const selector = view.getMode?.() === "source"
        ? ".markdown-source-view.mod-cm6 .cm-sizer"
        : ".markdown-preview-view .markdown-preview-sizer";
      const sizer = container.querySelector<HTMLElement>(selector);
      if (!sizer) { existing?.remove(); continue; }
      const panel = existing ?? createDiv({ cls: "xmc-inline-property-panel" });
      renderPropertyDocument(panel, document, false);
      const footer = sizer.querySelector(":scope > .mod-footer");
      if (panel.parentElement !== sizer || panel.nextElementSibling !== footer) sizer.insertBefore(panel, footer);
    }
  }

  private clearInlineProperties(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const container = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl;
      container?.classList.remove(INLINE_PROPERTIES_CLASS);
      container?.querySelectorAll(".xmc-inline-property-panel").forEach((element) => element.remove());
    }
  }

  /** Opens only images inside XMC post Markdown panes, never profiles or other notes. */
  private openMarkdownImage(event: MouseEvent): void {
    if (!isPlainPrimaryActivation(event)) return;
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    if (!image.closest(".markdown-preview-view, .markdown-source-view.mod-cm6")) return;

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as unknown as { file?: TFile | null; containerEl?: HTMLElement };
      if (!view.containerEl?.contains(image) || !view.file) continue;
      const frontmatter = this.app.metadataCache.getFileCache(view.file)?.frontmatter;
      if (propertyDocument(view.file.path, this.settings.vaultRoot, frontmatter)?.kind !== "post") return;
      const url = localLightboxUrl(image.currentSrc, image.src);
      if (!url) return;
      event.preventDefault();
      event.stopPropagation();
      this.openImageLightbox(url, image.alt);
      return;
    }
  }

  openImageLightbox(url: string, alt = ""): void {
    const localUrl = localLightboxUrl(url);
    if (!localUrl) return;
    this.imageLightbox?.close();
    const lightbox = new XmcImageLightbox(this.app, localUrl, alt, (closed) => {
      if (this.imageLightbox === closed) this.imageLightbox = null;
    });
    this.imageLightbox = lightbox;
    lightbox.open();
    void lightbox.enterFullscreen();
  }

  /**
   * Keeps each GridExplorer folder at the offset it was left at.  The plugin
   * exposes no API for this, so its view state is read defensively: any shape
   * that is not what we expect simply disables the feature for that tick.
   */
  private syncGridScroll(): void {
    try {
      const leaf = this.app.workspace.getLeavesOfType("grid-view")[0];
      const view = leaf?.view as unknown as { sourceMode?: unknown; sourcePath?: unknown; containerEl?: { querySelector(selector: string): Element | null } } | undefined;
      const container = view?.containerEl?.querySelector(".ge-grid-container");
      if (!(container instanceof HTMLElement)) { this.gridScroll.observe({ key: null, scrollTop: 0 }); return; }
      const restore = this.gridScroll.observe({ key: gridScrollKey(view?.sourceMode, view?.sourcePath), scrollTop: container.scrollTop });
      if (restore === null) return;
      container.scrollTop = restore;
      // The grid fills in lazily, so one frame later the target may finally exist.
      window.requestAnimationFrame(() => { container.scrollTop = restore; });
    } catch (error) {
      console.error("[XMediaArchive] grid scroll sync failed", error);
    }
  }

  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
  async openGalleryFile(file: TFile, event: MouseEvent, galleryLeaf: WorkspaceLeaf): Promise<void> {
    const target = galleryNavigationLeaf(
      Keymap.isModEvent(event),
      galleryLeaf,
      (pane) => this.app.workspace.getLeaf(pane),
    );
    try { await target.openFile(file); }
    catch {
      new Notice("ノートを開けませんでした。");
    }
  }
  private beginArchiveMutation(kind: "import" | "author-delete" | "post-delete" | "account-refresh"): boolean {
    if (this.archiveMutation !== null) return false;
    this.archiveMutation = kind;
    return true;
  }
  private endArchiveMutation(kind: "import" | "author-delete" | "post-delete" | "account-refresh"): void {
    if (this.archiveMutation === kind) this.archiveMutation = null;
  }
  async runAuthorDeletion(task: () => Promise<void>): Promise<boolean> {
    return this.runDeletion("author-delete", task);
  }
  async runPostDeletion(task: () => Promise<void>): Promise<boolean> {
    return this.runDeletion("post-delete", task);
  }
  private async runDeletion(kind: "author-delete" | "post-delete", task: () => Promise<void>): Promise<boolean> {
    if (!this.beginArchiveMutation(kind)) return false;
    try { await task(); return true; }
    finally { this.endArchiveMutation(kind); }
  }
  private vaultBasePath(): string {
    return localVaultBasePath(this.app.vault.adapter);
  }
  async importPending(reconcileOnly: boolean): Promise<void> {
    if (this.scanRunning) { new Notice("Twitter Media import is already running."); return; }
    if (!this.beginArchiveMutation("import")) { new Notice("Twitter Media archive update is already running."); return; }
    this.scanRunning = true;
    const inbox = expandHome(this.settings.inboxPath);
    let ids: string[];
    try { ids = await listCompletedJobDirectories(diskFs, inbox); }
    catch (error) {
      this.log("pending-list-failed", safeErrorDiagnostic(error));
      new Notice(`Cannot read Twitter Media inbox (${safeErrorDiagnostic(error).category}). See ${this.diagnostics.relativePath}`);
      this.scanRunning = false;
      this.endArchiveMutation("import");
      return;
    }
    let imported = 0; let partial = 0;
    try {
      for (const id of ids) {
        const result = await this.importOne(id, reconcileOnly);
        if (result === "complete") imported++;
        else if (result === "partial") partial++;
      }
    } finally {
      this.scanRunning = false;
      this.endArchiveMutation("import");
    }
    new Notice(`Twitter Media import: ${imported} complete, ${partial} need repair.`);
  }
  private async importOne(jobId: string, reconcileOnly: boolean): Promise<"complete" | "partial" | "skipped"> {
    const inbox = expandHome(this.settings.inboxPath);
    const jobDirectory = path.join(inbox, jobId); // jobId is UUIDv4, never caller-provided filesystem input.
    const trace = (event: string, details?: Record<string, unknown>): void => { this.log(event, details); };
    try {
      trace("import-start", { jobId, reconcileOnly, usesDefaultInbox: this.settings.inboxPath === DEFAULT_SETTINGS.inboxPath, usesDefaultVaultRoot: this.settings.vaultRoot === DEFAULT_SETTINGS.vaultRoot });
      const base = this.vaultBasePath();
      trace("vault-resolved", { jobId, baseLength: base.length });
      const oldReceipt = await this.importer.getReceipt(base, this.settings.vaultRoot, jobId);
      if (oldReceipt?.state === "complete" && await this.importer.receiptArtifactsPresent(base, oldReceipt)) { trace("import-skipped-complete", { jobId }); await this.markImported(jobDirectory, jobId); return "skipped"; }
      if (this.settings.vaultRoot !== LEGACY_VAULT_ROOT) {
        const legacyReceipt = await this.importer.getReceipt(base, LEGACY_VAULT_ROOT, jobId);
        if (legacyReceipt?.state === "complete" && await this.importer.receiptArtifactsPresent(base, legacyReceipt)) { trace("import-skipped-legacy-complete", { jobId }); await this.markImported(jobDirectory, jobId); return "skipped"; }
      }
      if (reconcileOnly && oldReceipt?.state !== "partial") { trace("import-skipped-reconcile", { jobId, receiptState: oldReceipt?.state ?? null }); return "skipped"; }
      const job = await readCompletedJob(diskFs, jobDirectory);
      trace("manifest-read", { jobId, posts: job.posts.length, media: job.posts.reduce((count, post) => count + post.media.length, 0) });
      if (job.jobId !== jobId) throw new Error("job folder and completed job ID differ");
      const outcome = await this.importer.import(job, jobDirectory, base, this.settings.vaultRoot);
      this.log("import-outcome", { jobId, state: outcome.state, notes: outcome.notes.length, retryable: outcome.retryable, failureCount: outcome.failures.length, failureCategories: [...new Set(outcome.failures.map((failure) => safeErrorDiagnostic(new Error(failure)).category))] });
      if (outcome.state === "failed" || (outcome.state === "partial" && outcome.retryable)) return "partial";
      // A partial job whose every loss is already settled in its own manifest
      // has given up everything it will ever give. Its notes exist and carry a
      // repair warning, so mark it rather than offering it again next time.
      if (outcome.state === "partial") {
        await this.markImported(jobDirectory, jobId);
        return "partial";
      }
      await this.markImported(jobDirectory, jobId);
      return outcome.state === "complete" ? "complete" : "skipped";
    } catch (error) {
      const diagnostic = safeErrorDiagnostic(error);
      this.log("import-failed", { jobId, ...diagnostic });
      new Notice(`Twitter Media job ${jobId} failed (${diagnostic.category}). See ${this.diagnostics.relativePath}`);
      return "partial";
    }
  }
  private async markImported(jobDirectory: string, jobId: string): Promise<void> {
    // A plain write, deliberately not writeAtomic. The marker is idempotent and
    // losing it only costs one redundant scan, whereas the temp-file-then-rename
    // dance gives on-access virus scanning in the Downloads folder a second file
    // to lock -- the likeliest reason this write failed inside Obsidian while
    // succeeding from a standalone process against the same directory.
    const target = path.join(jobDirectory, IMPORTED_MARKER);
    const body = JSON.stringify({ schemaVersion: 1, jobId, importedAt: new Date().toISOString() }) + "\n";
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await diskFs.writeFile(target, body);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    const diagnostic = safeErrorDiagnostic(lastError);
    // safeErrorDiagnostic drops the message by design. This console line never
    // reaches disk, so it may carry the raw error that identifies the cause.
    console.error("[XMediaArchive] imported marker write failed", { jobId, target, ...diagnostic }, lastError);
    this.log("import-marker-failed", { jobId, ...diagnostic });
  }
}

class XmcSettingTab extends PluginSettingTab {
  constructor(app: XMediaArchiveCompanion["app"], private readonly plugin: XMediaArchiveCompanion) { super(app, plugin); }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", { text: "Desktop-only local importer. It performs no network requests.", cls: "xmc-companion-setting-note" });
    new Setting(containerEl).setName("Job inbox").setDesc("Completed Twitter Media ArchiveJob folders. Default: ~/Downloads/XMediaClone/_jobs").addText((text) => text.setValue(this.plugin.settings.inboxPath).onChange(async (value) => { this.plugin.settings.inboxPath = value.trim() || DEFAULT_SETTINGS.inboxPath; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Vault root").setDesc("Vault-relative archive destination.").addText((text) => text.setValue(this.plugin.settings.vaultRoot).onChange(async (value) => { this.plugin.settings.vaultRoot = value.replace(/\\/g, "/").replace(/^\/+/, "") || DEFAULT_SETTINGS.vaultRoot; await this.plugin.saveSettings(); }));
  }
}
