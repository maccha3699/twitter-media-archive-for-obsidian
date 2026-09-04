import { Modal, Notice } from "obsidian";
import type { App } from "obsidian";

/** One shared, local-only image focus view used by gallery and post notes. */
export class XmcImageLightbox extends Modal {
  private readonly sourceUrl: string;
  private readonly sourceAlt: string;
  private readonly didClose: (modal: XmcImageLightbox) => void;
  private closed = false;
  private fullscreenRequestStarted = false;
  private readonly closeFromBackdrop = (event: MouseEvent): void => {
    const target = event.target;
    if (target === this.containerEl || target === this.contentEl
      || (target instanceof HTMLElement && target.hasClass("modal-bg"))) this.close();
  };
  private readonly closeWhenFullscreenEnds = (): void => {
    if (this.fullscreenRequestStarted && document.fullscreenElement !== this.containerEl && !this.closed) this.close();
  };

  constructor(app: App, sourceUrl: string, sourceAlt: string, didClose: (modal: XmcImageLightbox) => void) {
    super(app);
    this.sourceUrl = sourceUrl;
    this.sourceAlt = sourceAlt;
    this.didClose = didClose;
  }

  onOpen(): void {
    this.containerEl.addClass("xmc-image-lightbox-container");
    this.modalEl.addClass("xmc-image-lightbox");
    this.contentEl.empty();
    const image = this.contentEl.createEl("img", {
      cls: "xmc-lightbox-image",
      attr: { alt: this.sourceAlt || "拡大画像", draggable: "false", decoding: "async" },
    });
    image.src = this.sourceUrl;
    this.scope.register([], "Escape", () => { this.close(); return false; });
    this.containerEl.addEventListener("click", this.closeFromBackdrop);
    document.addEventListener("fullscreenchange", this.closeWhenFullscreenEnds);
  }

  /** Must be called synchronously from the image click so user activation survives. */
  async enterFullscreen(): Promise<void> {
    if (this.closed || this.fullscreenRequestStarted) return;
    this.fullscreenRequestStarted = true;
    try {
      await this.containerEl.requestFullscreen();
      // Plugin unload or another close may race the browser's fullscreen grant.
      if (this.closed && document.fullscreenElement === this.containerEl) await document.exitFullscreen();
    } catch {
      if (!this.closed) {
        new Notice("完全な全画面表示を開始できませんでした。");
        this.close();
      }
    }
  }

  onClose(): void {
    this.closed = true;
    document.removeEventListener("fullscreenchange", this.closeWhenFullscreenEnds);
    this.containerEl.removeEventListener("click", this.closeFromBackdrop);
    this.contentEl.empty();
    if (document.fullscreenElement === this.containerEl) void document.exitFullscreen().catch(() => undefined);
    this.didClose(this);
  }
}
