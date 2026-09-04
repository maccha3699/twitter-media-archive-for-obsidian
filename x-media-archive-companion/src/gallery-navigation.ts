import type { PaneType } from "obsidian";

export type RequestedPane = PaneType | boolean;

/**
 * Plain clicks navigate the gallery's own leaf, like an ordinary browser
 * page. Modified and middle clicks deliberately create Obsidian's requested
 * pane and leave the gallery in place.
 */
export function galleryNavigationLeaf<Leaf>(
  requestedPane: RequestedPane,
  galleryLeaf: Leaf,
  createLeaf: (pane: RequestedPane) => Leaf,
): Leaf {
  return requestedPane ? createLeaf(requestedPane) : galleryLeaf;
}
