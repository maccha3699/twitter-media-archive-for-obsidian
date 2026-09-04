// Remembers the shape of each image the gallery has already shown.
//
// A tile reserves its height from this before its image exists, so revisiting a
// folder lays out correctly on the first frame instead of settling as images
// decode.  Only dimensions the browser already measured for the reader are
// recorded -- nothing here opens or reads an image file.
//
// Deliberately not persisted: an archive of 40,000 images would write a
// 40,000-entry map into the plugin's data file to save a few hundred
// milliseconds of settling.

export class AspectRatioCache {
  private readonly ratios = new Map<string, number>();
  private readonly limit: number;
  private readonly min: number;
  private readonly max: number;

  constructor(limit = 4000, min = 0.55, max = 1.6) {
    this.limit = limit; this.min = min; this.max = max;
  }

  get(path: string): number | null {
    const ratio = this.ratios.get(path);
    if (ratio === undefined) return null;
    // Refresh recency so a folder in active use is not evicted by one long scroll.
    this.ratios.delete(path);
    this.ratios.set(path, ratio);
    return ratio;
  }

  set(path: string, naturalWidth: number, naturalHeight: number): void {
    if (!Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight)) return;
    if (naturalWidth <= 0 || naturalHeight <= 0) return;
    const ratio = Math.min(Math.max(naturalHeight / naturalWidth, this.min), this.max);
    this.ratios.delete(path);
    this.ratios.set(path, ratio);
    while (this.ratios.size > this.limit) {
      const oldest = this.ratios.keys().next().value;
      if (oldest === undefined) break;
      this.ratios.delete(oldest);
    }
  }
}
