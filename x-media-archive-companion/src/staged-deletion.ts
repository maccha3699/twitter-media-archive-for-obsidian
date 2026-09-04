export interface StagedDeletionOperations<Entry, File extends Entry> {
  rename(entry: Entry, target: string): Promise<void>;
  write(file: File, data: string): Promise<void>;
}

interface Move<Entry> { entry: Entry; originalPath: string; }
interface Replacement<File> { file: File; original: string; next: string; label: string; }

/** Records only mutations that actually succeeded. Rollback restores text
 * before paths, both in reverse order, so a failure halfway through a staged
 * deletion never relies on a guessed list of completed operations. */
export class StagedDeletionJournal<Entry, File extends Entry> {
  private readonly operations: StagedDeletionOperations<Entry, File>;
  private readonly moves: Move<Entry>[] = [];
  private readonly replacements: Replacement<File>[] = [];

  constructor(operations: StagedDeletionOperations<Entry, File>) { this.operations = operations; }

  async move(entry: Entry, originalPath: string, target: string): Promise<void> {
    await this.operations.rename(entry, target);
    this.moves.push({ entry, originalPath });
  }

  async replace(file: File, original: string, next: string, label: string): Promise<void> {
    await this.operations.write(file, next);
    this.replacements.push({ file, original, next, label });
  }

  /** Records an already-applied text mutation for a caller with its own write API. */
  recordReplacement(file: File, original: string, next: string, label: string): void {
    this.replacements.push({ file, original, next, label });
  }

  async rollback(): Promise<string[]> {
    const failures: string[] = [];
    for (const replacement of [...this.replacements].reverse()) {
      await this.operations.write(replacement.file, replacement.original).catch(() => { failures.push(replacement.label); });
    }
    for (const move of [...this.moves].reverse()) {
      await this.operations.rename(move.entry, move.originalPath).catch(() => { failures.push(move.originalPath); });
    }
    return failures;
  }
}
