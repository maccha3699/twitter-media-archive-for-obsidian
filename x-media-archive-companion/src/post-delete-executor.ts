import { StagedDeletionJournal } from "./staged-deletion.ts";

export interface PostDeleteMove<Entry> { entry: Entry; originalPath: string; target: string; }
export interface PostDeleteReplacement<File> { file: File; original: string; next: string; label: string; }

export interface PostDeletePlan<Entry, File extends Entry> {
  signature: string;
  stagePath: string;
  notePath: string;
  moves: readonly PostDeleteMove<Entry>[];
  replacements: readonly PostDeleteReplacement<File>[];
  counts: { movedMediaCount: number; preservedMediaCount: number; receiptCount: number };
}

export interface PostDeleteAdapter<Entry, File extends Entry> {
  replan(original: PostDeletePlan<Entry, File>): Promise<PostDeletePlan<Entry, File>>;
  ensureFolder(path: string): Promise<void>;
  move(entry: Entry, target: string): Promise<void>;
  replace(replacement: PostDeleteReplacement<File>): Promise<void>;
  trash(stagePath: string): Promise<void>;
  deleteEmptyStage(stagePath: string): Promise<void>;
  forget(notePath: string): void;
  render(): void | Promise<void>;
}

export type PostDeleteResult<Entry, File extends Entry> =
  | { status: "completed"; plan: PostDeletePlan<Entry, File>; renderError?: unknown }
  | { status: "failed"; error: unknown; stagePath: string; rollbackFailures: string[] };

/** Runs the post delete in the same journal order as author deletion. */
export async function executePostDelete<Entry, File extends Entry>(
  original: PostDeletePlan<Entry, File>,
  adapter: PostDeleteAdapter<Entry, File>,
): Promise<PostDeleteResult<Entry, File>> {
  let plan = original;
  let prepared = false;
  let committed = false;
  const replacements = new Map<File, PostDeleteReplacement<File>>();
  const journal = new StagedDeletionJournal<Entry, File>({
    rename: (entry, target) => adapter.move(entry, target),
    write: (file, data) => {
      const replacement = replacements.get(file);
      if (!replacement) throw new Error("missing post deletion replacement journal entry");
      return adapter.replace({ file, original: replacement.next, next: data, label: `rollback:${replacement.label}` });
    },
  });
  const failed = async (error: unknown): Promise<PostDeleteResult<Entry, File>> => {
    if (!committed) {
      const rollbackFailures = await journal.rollback();
      if (prepared) await adapter.deleteEmptyStage(plan.stagePath).catch(() => undefined);
      return { status: "failed", error, stagePath: plan.stagePath, rollbackFailures };
    }
    return { status: "failed", error, stagePath: plan.stagePath, rollbackFailures: [] };
  };
  try {
    plan = await adapter.replan(original);
    if (plan.signature !== original.signature) throw new Error("確認中に対象内容が変わりました。削除確認を開き直してください。");
    prepared = true;
    await adapter.ensureFolder(plan.stagePath);
    for (const move of plan.moves) await journal.move(move.entry, move.originalPath, move.target);
    for (const replacement of plan.replacements) {
      await adapter.replace(replacement);
      replacements.set(replacement.file, replacement);
      journal.recordReplacement(replacement.file, replacement.original, replacement.next, replacement.label);
    }
    await adapter.trash(plan.stagePath);
    committed = true;
    try { adapter.forget(plan.notePath); } catch { /* view state is best effort */ }
    let renderError: unknown;
    try { await adapter.render(); } catch (error) { renderError = error; }
    return renderError === undefined ? { status: "completed", plan } : { status: "completed", plan, renderError };
  } catch (error) {
    return failed(error);
  }
}
