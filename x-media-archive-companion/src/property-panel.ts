import { ItemView, TFile } from "obsidian";
import type { App, WorkspaceLeaf } from "obsidian";
import { propertyDocument } from "./property-model.ts";
import type { PropertyDocument } from "./property-model.ts";

export const VIEW_TYPE_XMC_PROPERTIES = "xmc-properties";
export const INLINE_PROPERTIES_CLASS = "xmc-has-inline-properties";

export function renderPropertyDocument(container: HTMLElement, document: PropertyDocument, includeFileLink: boolean): void {
  container.empty();
  container.classList.toggle("xmc-property-post", document.kind === "post");
  container.classList.toggle("xmc-property-profile", document.kind === "profile");
  const heading = container.createDiv({ cls: "xmc-property-heading" });
  heading.createEl("h3", { text: "プロパティ" });
  if (includeFileLink) {
    heading.createEl("a", { text: document.title, cls: "xmc-property-file internal-link", href: document.path, attr: { "data-href": document.path } });
  }
  const table = container.createDiv({ cls: "xmc-property-table" });
  for (const row of document.rows) {
    const item = table.createDiv({ cls: "xmc-property-row" });
    item.createDiv({ cls: "xmc-property-key", text: row.key });
    const value = item.createDiv({ cls: "xmc-property-value" });
    if (row.href) value.createEl("a", { text: row.text, href: row.href });
    else value.setText(row.text);
  }
}

export interface PropertyHost { app: App; settings: { vaultRoot: string }; }

export class XmcPropertyView extends ItemView {
  private readonly host: PropertyHost;
  private filePath: string | null = null;
  private panelEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, host: PropertyHost) { super(leaf); this.host = host; }
  getViewType(): string { return VIEW_TYPE_XMC_PROPERTIES; }
  getDisplayText(): string { return "XMC プロパティ"; }
  getIcon(): string { return "list-tree"; }
  getState(): Record<string, unknown> { return { path: this.filePath }; }
  async setState(state: unknown, result: { history: boolean }): Promise<void> {
    this.filePath = state && typeof state === "object" && typeof (state as { path?: unknown }).path === "string"
      ? (state as { path: string }).path : null;
    this.render(); await super.setState(this.getState(), result);
  }
  async onOpen(): Promise<void> { this.panelEl = this.contentEl.createDiv({ cls: "xmc-property-side-panel" }); this.render(); }
  setFile(file: TFile | null): void { this.filePath = file?.path ?? null; this.render(); }
  getFilePath(): string | null { return this.filePath; }
  private render(): void {
    if (!this.panelEl) return;
    const file = this.filePath ? this.host.app.vault.getAbstractFileByPath(this.filePath) : null;
    const frontmatter = file instanceof TFile ? this.host.app.metadataCache.getFileCache(file)?.frontmatter : null;
    const document = file instanceof TFile ? propertyDocument(file.path, this.host.settings.vaultRoot, frontmatter) : null;
    if (!document) { this.panelEl.empty(); return; }
    renderPropertyDocument(this.panelEl, document, true);
  }
}

export async function revealPropertyView(host: PropertyHost, file: TFile): Promise<void> {
  const workspace = host.app.workspace;
  let leaf = workspace.getLeavesOfType(VIEW_TYPE_XMC_PROPERTIES)[0] ?? workspace.getRightLeaf(false) ?? workspace.getRightLeaf(true);
  if (!leaf) return;
  await leaf.setViewState({ type: VIEW_TYPE_XMC_PROPERTIES, active: false, state: { path: file.path } });
  await workspace.revealLeaf(leaf);
}
