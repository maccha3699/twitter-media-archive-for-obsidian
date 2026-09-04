import { StageTimer } from "./stage-timer.ts";

/** A path mutation that can be undone before the staging directory is trashed. */
export interface AuthorDeleteMove<Entry> {
  entry: Entry;
  originalPath: string;
  target: string;
}

/** The before/after bytes for one receipt mutation. */
export interface AuthorDeleteReceiptChange<File> {
  file: File;
  original: string;
  next: string;
}

export interface AuthorDeleteCounts {
  noteCount: number;
  movedMediaCount: number;
  preservedMediaCount: number;
  receiptCount: number;
}

/**
 * Runtime-independent input to the author deletion executor.
 *
 * The view owns construction of this object (including the UUID-backed
 * staging path); the executor deliberately knows nothing about Obsidian.
 */
export interface AuthorDeletePlan<Entry, File> {
  signature: string;
  stagePath: string;
  folder: string;
  counts: AuthorDeleteCounts;
  moves: {
    author: AuthorDeleteMove<Entry>;
    account: AuthorDeleteMove<Entry>;
    media: readonly AuthorDeleteMove<Entry>[];
  };
  receipts: readonly AuthorDeleteReceiptChange<File>[];
}

export interface AuthorDeletePinsSnapshot<File> {
  file: File;
  original: string;
}

/**
 * Adapter boundary for the executor. Every mutating method is awaited exactly
 * once. A resolved Promise is the only evidence that the mutation succeeded,
 * so the executor can journal only completed operations.
 */
export interface AuthorDeleteAdapter<Entry, File> {
  replan(original: AuthorDeletePlan<Entry, File>): Promise<AuthorDeletePlan<Entry, File>>;
  ensureFolder(path: string): Promise<void>;
  move(entry: Entry, target: string): Promise<void>;
  replaceReceipt(change: AuthorDeleteReceiptChange<File>): Promise<void>;
  capturePins(): Promise<AuthorDeletePinsSnapshot<File> | null>;
  removePin(snapshot: AuthorDeletePinsSnapshot<File>, folder: string): Promise<void>;
  restorePins(snapshot: AuthorDeletePinsSnapshot<File>): Promise<void>;
  trash(stagePath: string): Promise<void>;
  /** Best-effort cleanup after rollback; failure never replaces the primary error. */
  deleteEmptyStage(stagePath: string): Promise<void>;
  /** Synchronous and non-throwing by contract. */
  forget(folder: string): void;
  render(): void | Promise<void>;
  /** Optional fire-and-forget diagnostic sink retained for the view adapter. */
  logTiming?(outcome: "completed" | "failed", details: Readonly<Record<string, unknown>>): void;
}

export interface AuthorDeleteCompleted<Entry, File> {
  status: "completed";
  plan: AuthorDeletePlan<Entry, File>;
  counts: AuthorDeleteCounts;
  renderError?: unknown;
}

export interface AuthorDeleteFailed {
  status: "failed";
  error: unknown;
  stagePath: string;
  rollbackFailures: string[];
  counts: AuthorDeleteCounts;
}

export type AuthorDeleteResult<Entry, File> = AuthorDeleteCompleted<Entry, File> | AuthorDeleteFailed;

interface ReceiptJournal<File> {
  change: AuthorDeleteReceiptChange<File>;
}

interface MoveJournal<Entry> {
  move: AuthorDeleteMove<Entry>;
}

function inverseReceipt<File>(change: AuthorDeleteReceiptChange<File>): AuthorDeleteReceiptChange<File> {
  return { ...change, original: change.next, next: change.original };
}

/**
 * Executes one confirmed author deletion. The trash operation is the commit
 * point: before it resolves, only successful mutations are rolled back in the
 * order pins -> receipts -> paths; after it resolves, no rollback is attempted.
 */
export async function executeAuthorDelete<Entry, File>(
  original: AuthorDeletePlan<Entry, File>,
  adapter: AuthorDeleteAdapter<Entry, File>,
): Promise<AuthorDeleteResult<Entry, File>> {
  const timer = new StageTimer();
  const rollbackFailures: string[] = [];
  const moves: MoveJournal<Entry>[] = [];
  const receipts: ReceiptJournal<File>[] = [];
  let pins: AuthorDeletePinsSnapshot<File> | null = null;
  let stageCommitted = false;
  let stagePrepared = false;
  let counts = original.counts;

  const failed = async (error: unknown, plan: AuthorDeletePlan<Entry, File> = original): Promise<AuthorDeleteFailed> => {
    if (!stageCommitted) {
      if (pins) {
        await adapter.restorePins(pins).catch(() => { rollbackFailures.push("pins"); });
      }
      for (const journal of [...receipts].reverse()) {
        await adapter.replaceReceipt(inverseReceipt(journal.change)).catch(() => {
          rollbackFailures.push(fileLabel(journal.change.file));
        });
      }
      for (const journal of [...moves].reverse()) {
        await adapter.move(journal.move.entry, journal.move.originalPath).catch(() => {
          rollbackFailures.push(journal.move.originalPath);
        });
      }
      if (stagePrepared) await adapter.deleteEmptyStage(plan.stagePath).catch(() => undefined);
    }
    timer.finish("rollback");
    const details = timer.details("failed", { ...counts, rollbackFailureCount: rollbackFailures.length });
    try { adapter.logTiming?.("failed", details); } catch { /* diagnostics are non-throwing */ }
    return { status: "failed", error, stagePath: plan.stagePath, rollbackFailures, counts };
  };

  let plan: AuthorDeletePlan<Entry, File> = original;
  try {
    plan = await adapter.replan(original);
    timer.finish("replan");
    if (plan.signature !== original.signature) {
      throw new Error("確認中に対象内容が変わりました。削除確認を開き直してください。");
    }
    counts = plan.counts;

    stagePrepared = true;
    await adapter.ensureFolder(plan.stagePath);
    for (const move of [plan.moves.author, plan.moves.account]) {
      await adapter.move(move.entry, move.target);
      moves.push({ move });
    }
    timer.finish("stage-folder");

    for (const move of plan.moves.media) {
      await adapter.move(move.entry, move.target);
      moves.push({ move });
    }
    timer.finish("stage-media");

    for (const change of plan.receipts) {
      await adapter.replaceReceipt(change);
      receipts.push({ change });
    }
    timer.finish("receipts");

    pins = await adapter.capturePins();
    if (pins) await adapter.removePin(pins, plan.folder);
    timer.finish("pins");

    await adapter.trash(plan.stagePath);
    stageCommitted = true;
    timer.finish("trash");

    // Both operations are intentionally after the commit point. The adapter's
    // forget contract is non-throwing; render errors are observable but do not
    // turn a successfully trashed deletion into a failure.
    try { adapter.forget(plan.folder); } catch { /* the adapter contract is non-throwing */ }
    let renderError: unknown;
    try { await adapter.render(); }
    catch (error) { renderError = error; }
    timer.finish("render");
    try { adapter.logTiming?.("completed", timer.details("completed", { ...counts })); } catch { /* diagnostics are non-throwing */ }
    return renderError === undefined
      ? { status: "completed", plan, counts }
      : { status: "completed", plan, counts, renderError };
  } catch (error) {
    timer.finish("failed");
    return failed(error, plan ?? original);
  }
}

function fileLabel(file: unknown): string {
  if (typeof file === "object" && file !== null && "name" in file && typeof file.name === "string") return file.name;
  return String(file);
}
