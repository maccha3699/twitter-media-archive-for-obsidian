import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const gallerySource = readFileSync(new URL("../src/gallery-view.ts", import.meta.url), "utf8");
const executorSource = readFileSync(new URL("../src/author-delete-executor.ts", import.meta.url), "utf8");
const lightboxSource = readFileSync(new URL("../src/image-lightbox.ts", import.meta.url), "utf8");
const propertySource = readFileSync(new URL("../src/property-panel.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("gallery opens in a central tab and owns the pending-import button", () => {
  assert.match(gallerySource, /getLeaf\("tab"\)/);
  assert.doesNotMatch(gallerySource, /getLeftLeaf\(/);
  assert.match(gallerySource, /xmc-gallery-import-pending/);
  assert.match(gallerySource, /host\.importPending\(false\)/);
  assert.doesNotMatch(mainSource, /addRibbonIcon\("download"/);
});

test("post cards replace the gallery leaf while middle clicks follow Obsidian pane policy", () => {
  assert.match(mainSource, /galleryNavigationLeaf\(/);
  assert.match(mainSource, /openGalleryFile\(file: TFile, event: MouseEvent, galleryLeaf: WorkspaceLeaf\)/);
  assert.match(mainSource, /Keymap\.isModEvent\(event\)/);
  assert.match(gallerySource, /openGalleryFile\(file, event, this\.leaf\)/);
  assert.match(gallerySource, /"mousedown"[\s\S]*event\.button !== 1[\s\S]*event\.preventDefault\(\)[\s\S]*this\.openTile\(event\)/);
  assert.doesNotMatch(gallerySource, /"auxclick"/);
  assert.doesNotMatch(mainSource, /ReusableNoteLeaf/);
});

test("gallery scroll memory outlives the ItemView replaced by a post", () => {
  assert.match(mainSource, /readonly galleryScrollMemory = new GridScrollMemory\(\)/);
  assert.match(gallerySource, /host\.galleryScrollMemory\.recall\(key\)/);
  assert.match(gallerySource, /host\.galleryScrollMemory\.save\(this\.scrollKey/);
  assert.doesNotMatch(gallerySource, /host\.galleryScrollMemory\.observe/);
  assert.match(gallerySource, /rememberScrollImmediately\(\)[\s\S]*scrollCapturedBeforeLeave = true[\s\S]*openGalleryFile\(file, event, this\.leaf\)/);
  assert.match(gallerySource, /if \(!this\.scrollCapturedBeforeLeave\) this\.rememberScrollImmediately\(\)/);
  assert.match(gallerySource, /if \(index < 0\) return;[\s\S]*galleryScrollMemory\.save/);
  assert.doesNotMatch(gallerySource, /private readonly scroll = new GridScrollMemory/);
});

test("account deletion has a dedicated guarded path instead of post deletion", () => {
  assert.match(gallerySource, /setTitle\("投稿者を削除"\)/);
  assert.match(gallerySource, /runAuthorDeletion/);
  assert.match(executorSource, /確認中に対象内容が変わりました/);
  assert.match(gallerySource, /保存済みも再取得する/);
  assert.match(mainSource, /archiveMutation/);
  assert.match(gallerySource, /安全確認しています/);
  assert.match(gallerySource, /RECEIPT_READ_BATCH_SIZE = 16/);
});

test("property UI follows focus and Live Preview puts the shared table below the body", () => {
  assert.match(mainSource, /active-leaf-change/);
  assert.match(mainSource, /markdown-source-view\.mod-cm6 \.cm-sizer/);
  assert.match(styles, /xmc-has-inline-properties \.metadata-container \{ display: none !important; \}/);
  assert.match(styles, /markdown-source-view\.mod-cm6 \.cm-contentContainer \{ flex: 0 0 auto; \}/);
  assert.match(styles, /xmc-property-side-panel[\s\S]*user-select: text/);
  assert.doesNotMatch(propertySource, /XMediaArchiveの投稿またはプロフィールを開いてください/);
});

test("only post-note images enter OS fullscreen while every gallery click navigates", () => {
  assert.doesNotMatch(gallerySource, /openImageLightbox|xmcLightboxUrl|isPlainPrimaryActivation/);
  assert.match(gallerySource, /private openTile\(event: MouseEvent\)[\s\S]*openGalleryFile\(file, event, this\.leaf\)/);
  assert.match(mainSource, /registerDomEvent\(document, "click"[\s\S]*true\)/);
  assert.match(mainSource, /this\.imageLightbox\?\.close\(\); this\.imageLightbox = null/);
  assert.match(mainSource, /propertyDocument\(view\.file\.path[\s\S]*\.kind !== "post"/);
  assert.match(mainSource, /localLightboxUrl\(image\.currentSrc, image\.src\)/);
  assert.match(mainSource, /lightbox\.open\(\);[\s\S]*lightbox\.enterFullscreen\(\)/);
  assert.match(styles, /xmc-image-lightbox-container:fullscreen[\s\S]*width: 100vw[\s\S]*height: 100vh/);
  assert.match(styles, /xmc-lightbox-image[\s\S]*object-fit: contain/);
  assert.match(lightboxSource, /scope\.register\(\[\], "Escape"[\s\S]*this\.close\(\)/);
  assert.match(lightboxSource, /target === this\.containerEl \|\| target === this\.contentEl[\s\S]*hasClass\("modal-bg"\)[\s\S]*this\.close\(\)/);
  assert.doesNotMatch(lightboxSource, /createEl\("button"|setIcon/);
  assert.match(styles, /xmc-image-lightbox \.modal-close-button/);
  assert.match(lightboxSource, /containerEl\.requestFullscreen\(\)/);
  assert.match(lightboxSource, /document\.fullscreenElement !== this\.containerEl && !this\.closed\) this\.close\(\)/);
  assert.match(lightboxSource, /addEventListener\("fullscreenchange", this\.closeWhenFullscreenEnds\)/);
  assert.match(lightboxSource, /document\.fullscreenElement === this\.containerEl[\s\S]*document\.exitFullscreen\(\)/);
  assert.match(lightboxSource, /image\.src = this\.sourceUrl/);
});
