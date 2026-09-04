import { TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import { isArchiveAuthorFolder } from "./gallery-model.ts";

// The only module that touches the vault API, so gallery-model.ts can stay pure
// and testable. Nothing here reads a file: the metadata cache already holds the
// frontmatter and the embed list, and 40,000 note reads to draw a grid would be
// unaffordable even once.

function folderAt(app: App, path: string): TFolder | null {
  const entry = app.vault.getAbstractFileByPath(path);
  return entry instanceof TFolder ? entry : null;
}

function markdownChildren(folder: TFolder | null): TFile[] {
  if (!folder) return [];
  return folder.children.filter((child): child is TFile => child instanceof TFile && child.extension === "md");
}

export function listAccountFiles(app: App, root: string): TFile[] {
  return markdownChildren(folderAt(app, `${root}/_accounts`)).sort((a, b) => a.name.localeCompare(b.name));
}

export function listPostFiles(app: App, root: string, folder: string, keep: (name: string) => boolean): TFile[] {
  return markdownChildren(folderAt(app, `${root}/${folder}`)).filter((file) => keep(file.name));
}

/** Lists direct markdown children of direct author folders. System folders and
 * deeper nested content are excluded by construction. */
export function listAllPostFiles(app: App, root: string, keep: (file: TFile, folder: string) => boolean): TFile[] {
  const archive = folderAt(app, root);
  if (!archive) return [];
  const found: TFile[] = [];
  for (const child of archive.children) {
    if (!(child instanceof TFolder) || !isArchiveAuthorFolder(child.name)) continue;
    for (const file of markdownChildren(child)) if (keep(file, child.name)) found.push(file);
  }
  return found;
}

export function frontmatterOf(app: App, file: TFile): Record<string, unknown> | undefined {
  return app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
}

/**
 * The embedded images, in document order.  The importer writes one `![[...]]`
 * per media at the end of the body in ordinal order, so the first entry is the
 * post's first image and the length is its image count.  The navigation
 * wikilinks at the top are plain links, so they land in `links` and never here.
 */
export function embedLinksOf(app: App, file: TFile): string[] {
  return (app.metadataCache.getFileCache(file)?.embeds ?? []).map((embed) => embed.link);
}

/** Resolves every cached embed through Obsidian and returns only Vault paths. */
export function resolvedEmbedPathsOf(app: App, file: TFile): string[] {
  return embedLinksOf(app, file)
    .map((reference) => resolveMedia(app, reference, file.path))
    .filter((target): target is TFile => target instanceof TFile)
    .map((target) => target.path);
}

/** Resolves a media reference whether it arrived as a link or a bare path. */
export function resolveMedia(app: App, reference: string, sourcePath: string): TFile | null {
  const direct = app.vault.getAbstractFileByPath(reference);
  if (direct instanceof TFile) return direct;
  return app.metadataCache.getFirstLinkpathDest(reference, sourcePath);
}

export function resourceUrlOf(app: App, file: TFile): string {
  return app.vault.getResourcePath(file);
}

export function fileAt(app: App, path: string): TFile | null {
  const entry = app.vault.getAbstractFileByPath(path);
  return entry instanceof TFile ? entry : null;
}

export function hasIndexed(app: App, file: TFile): boolean {
  return app.metadataCache.getFileCache(file) !== null;
}
