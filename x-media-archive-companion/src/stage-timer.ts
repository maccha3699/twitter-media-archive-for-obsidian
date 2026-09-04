export interface StageTiming { stage: string; elapsedMs: number; }

/** Wall-clock split times for a multi-step Vault mutation.
 *
 * B-10 asks how long author deletion spends after the confirmation check, and
 * the answer has to come from the real Vault: the slow parts depend on note and
 * media counts no fixture reproduces. This only reads a clock, so adding it
 * cannot change await ordering, rollback scope, or which errors propagate --
 * `finish` never throws and never runs the caller's work itself.
 *
 * Keys here are also the keys that reach the diagnostic log, where
 * `SENSITIVE_KEY` drops anything containing `path` or `message`. Stage names
 * must stay free of those words and of author or file names.
 */
export class StageTimer {
  private readonly now: () => number;
  private readonly recorded: StageTiming[] = [];
  private readonly startedAt: number;
  private mark: number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
    this.startedAt = this.now();
    this.mark = this.startedAt;
  }

  /** Closes the current segment and opens the next one. Repeating a stage name
   * appends a second entry rather than overwriting, so a caller that loops does
   * not silently lose measurements. */
  finish(stage: string): void {
    const at = this.now();
    this.recorded.push({ stage, elapsedMs: round(at - this.mark) });
    this.mark = at;
  }

  get stages(): readonly StageTiming[] { return this.recorded; }

  totalMs(): number { return round(this.now() - this.startedAt); }

  /** One flat `<stage>Ms` key per stage, because `safeValue` stops at depth 3:
   * a `stages: [{ stage, elapsedMs }]` array reaches the log as
   * `"[depth-limited]"` for every value, which looks like a populated line and
   * proves nothing. Repeated stages are summed, and the count says how many
   * segments produced each total. */
  details(outcome: "completed" | "failed", counts: Readonly<Record<string, number>> = {}): Record<string, unknown> {
    const totals: Record<string, number> = {};
    for (const entry of this.recorded) {
      const key = `${camelCase(entry.stage)}Ms`;
      totals[key] = round((totals[key] ?? 0) + entry.elapsedMs);
    }
    return { outcome, totalMs: this.totalMs(), stageCount: this.recorded.length, ...totals, ...counts };
  }
}

function camelCase(stage: string): string {
  return stage.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function round(value: number): number { return Math.round(value * 10) / 10; }
