// Column arithmetic for the archive gallery.
//
// Each card goes to whichever column is currently shortest.  That only ever
// appends, so a card already on screen never moves when the next page arrives,
// and it keeps the columns level instead of letting their heights drift apart
// over a few hundred cards.  Reading order survives too: while the columns are
// empty the shortest is the leftmost, so the opening cards fill left to right.
//
// Kept free of Obsidian and DOM types so it can be tested directly.

export interface MasonryMetrics {
  /** Usable width of the scroll container, in pixels. */
  width: number;
  /** Preferred column width. Columns flex around it rather than matching it. */
  targetColumn: number;
  gap: number;
  maxColumns: number;
}

export function columnCountFor({ width, targetColumn, gap, maxColumns }: MasonryMetrics): number {
  if (!Number.isFinite(width) || !Number.isFinite(targetColumn) || targetColumn <= 0) return 1;
  const spacing = Number.isFinite(gap) && gap > 0 ? gap : 0;
  // n columns occupy n*target + (n-1)*gap, so solve for n and floor it.
  const fitted = Math.floor((width + spacing) / (targetColumn + spacing));
  const ceiling = Number.isFinite(maxColumns) && maxColumns >= 1 ? Math.floor(maxColumns) : 1;
  return Math.min(Math.max(fitted, 1), ceiling);
}

/**
 * The column a card should join: the shortest one, and on a tie the leftmost,
 * so an empty grid fills left to right in reading order.
 */
export function shortestColumn(heights: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < heights.length; index++) {
    const height = heights[index];
    if (Number.isFinite(height) && height < heights[best]) best = index;
  }
  return best;
}

/**
 * The height-to-width ratio a tile should reserve, clamped so one panorama or
 * one tall strip cannot produce a tile taller than the viewport.  The excess is
 * cropped by `object-fit: cover`, which is preferable to a card the reader has
 * to scroll past.
 */
export function clampRatio(width: number, height: number, min: number, max: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return min;
  return Math.min(Math.max(height / width, min), max);
}
