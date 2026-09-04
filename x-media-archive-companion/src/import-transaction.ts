import type { FileSystem } from "./fs.ts";
import { copyMediaForReceipt, exists, writeAtomic } from "./fs.ts";

function asBytes(value: Buffer | string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

/** Tracks writes and newly-created media until the durable receipt is verified. */
export class ImportTransaction {
  private readonly originals = new Map<string, Buffer | string | null>();
  private readonly current = new Map<string, Buffer>();
  private readonly createdMedia = new Set<string>();
  private committed = false;
  private rolledBack = false;
  private readonly fs: FileSystem;
  private readonly materialize: typeof copyMediaForReceipt;

  constructor(fs: FileSystem, materialize: typeof copyMediaForReceipt = copyMediaForReceipt) {
    this.fs = fs;
    this.materialize = materialize;
  }

  private async capture(file: string): Promise<void> {
    if (this.originals.has(file)) return;
    try {
      const original = await this.fs.readFile(file);
      this.originals.set(file, original);
      this.current.set(file, asBytes(original));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.originals.set(file, null);
    }
  }

  /** Deduplicate byte-identical text writes while retaining the original for rollback. */
  async write(file: string, data: string | Uint8Array): Promise<void> {
    if (this.committed) throw new Error("import transaction already committed");
    if (this.rolledBack) throw new Error("import transaction already rolled back");
    await this.capture(file);
    const bytes = asBytes(data);
    if (this.current.get(file)?.equals(bytes)) return;
    await writeAtomic(this.fs, file, data);
    this.current.set(file, bytes);
  }

  async copyMedia(source: string, target: string): Promise<void> {
    if (this.committed) throw new Error("import transaction already committed");
    if (this.rolledBack) throw new Error("import transaction already rolled back");
    const targetExisted = await exists(this.fs, target);
    await this.materialize(this.fs, source, target);
    if (!targetExisted) this.createdMedia.add(target);
  }

  /** Marks the durable receipt check as the commit point. */
  commit(): void {
    if (this.rolledBack) throw new Error("cannot commit a rolled-back import transaction");
    this.committed = true;
    this.originals.clear();
    this.current.clear();
    this.createdMedia.clear();
  }

  async rollback(): Promise<void> {
    if (this.committed || this.rolledBack) return;
    for (const file of [...this.createdMedia].reverse()) await this.fs.unlink(file).catch(() => undefined);
    for (const [file, original] of [...this.originals.entries()].reverse()) {
      if (original === null) await this.fs.unlink(file).catch(() => undefined);
      else await writeAtomic(this.fs, file, original);
    }
    this.rolledBack = true;
  }
}
