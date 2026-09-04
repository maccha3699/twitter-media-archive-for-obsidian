// Remembers where you were in each GridExplorer folder.
//
// GridExplorer's grid_render() empties its container and rebuilds it on every
// navigation, and unlike its sidebar view it keeps no scroll state, so stepping
// into an author folder and back always lands at the top of the account list.
// This records the offset per folder and re-applies it when that folder is
// shown again.  The logic is kept free of Obsidian and DOM types so it can be
// tested directly; main.ts supplies the polling and the element access.

export interface GridScrollSample {
  /** Identifies the folder currently rendered, or null when no grid is open. */
  key: string | null;
  scrollTop: number;
}

/**
 * Converts a tile's current viewport-relative position into the scrollTop that
 * places it at the requested viewport offset. Unlike offsetTop, all inputs use
 * one coordinate system and therefore work inside nested masonry columns.
 */
export function scrollTopForViewportOffset(
  currentScrollTop: number,
  currentTileOffset: number,
  requestedTileOffset: number,
): number {
  const next = currentScrollTop + currentTileOffset - requestedTileOffset;
  return Number.isFinite(next) ? Math.max(0, next) : Math.max(0, currentScrollTop);
}

export class GridScrollMemory {
  private readonly positions = new Map<string, number>();
  private current: string | null = null;
  private readonly limit: number;

  // A parameter property would be terser, but node's type stripping rejects it.
  constructor(limit = 200) { this.limit = limit; }

  /**
   * Feeds one observation and reports the offset to restore, or null when the
   * caller should leave the view alone.  A restore is returned only on the tick
   * where the rendered folder changed: recording the incoming view first would
   * overwrite the remembered offset with the freshly rendered zero.
   */
  observe({ key, scrollTop }: GridScrollSample): number | null {
    if (key === null) { this.current = null; return null; }
    if (key === this.current) {
      this.remember(key, scrollTop);
      return null;
    }
    this.current = key;
    return this.positions.get(key) ?? 0;
  }

  /**
   * Stores a position for callers that already know exactly which view owns
   * the sample. Unlike observe(), this has no shared "current view" state, so
   * overlapping ItemView close/open lifecycles cannot overwrite each other.
   */
  save(key: string, scrollTop: number): void { this.remember(key, scrollTop); }

  /** Reads one keyed position without treating a freshly rendered zero as data. */
  recall(key: string): number {
    const position = this.positions.get(key);
    if (position === undefined) return 0;
    // A successful read is use, too: keep this key newer than inactive views.
    this.positions.delete(key);
    this.positions.set(key, position);
    return position;
  }

  /** Drops the memory of one folder, e.g. after it is deleted. */
  forget(key: string): void { this.positions.delete(key); }

  private remember(key: string, scrollTop: number): void {
    if (!Number.isFinite(scrollTop) || scrollTop < 0) return;
    this.positions.delete(key);
    this.positions.set(key, scrollTop);
    // Bounded so a long session cannot grow this without limit; the least
    // recently touched folder is the one worth losing.
    while (this.positions.size > this.limit) {
      const oldest = this.positions.keys().next().value;
      if (oldest === undefined) break;
      this.positions.delete(oldest);
    }
  }
}

/** Builds the memory key GridExplorer's view state maps to. */
export function gridScrollKey(sourceMode: unknown, sourcePath: unknown): string | null {
  if (typeof sourceMode !== "string" || sourceMode === "") return null;
  const path = typeof sourcePath === "string" ? sourcePath : "";
  return `${sourceMode}:${path}`;
}
