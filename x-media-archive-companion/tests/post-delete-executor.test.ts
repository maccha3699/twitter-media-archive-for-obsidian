import assert from "node:assert/strict";
import test from "node:test";
import { executePostDelete, type PostDeleteAdapter, type PostDeletePlan } from "../src/post-delete-executor.ts";

type Entry = { id: string };
type File = Entry;
const plan = (signature = "fresh"): PostDeletePlan<Entry, File> => ({
  signature, stagePath: "stage/run", notePath: "XMediaArchive/a/post.md",
  moves: [
    { entry: { id: "note" }, originalPath: "XMediaArchive/a/post.md", target: "stage/run/note.md" },
    { entry: { id: "media" }, originalPath: "XMediaArchive/_media/a/1.jpg", target: "stage/run/media/1.jpg" },
  ],
  replacements: [{ file: { id: "receipt" }, original: "old-receipt", next: "new-receipt", label: "receipt" }, { file: { id: "account" }, original: "old-account", next: "new-account", label: "account" }],
  counts: { movedMediaCount: 1, preservedMediaCount: 1, receiptCount: 1 },
});

class Fake implements PostDeleteAdapter<Entry, File> {
  events: string[] = [];
  failures = new Set<string>();
  async replan(input: PostDeletePlan<Entry, File>) { this.events.push("replan"); return input; }
  async ensureFolder(path: string) { this.events.push(`folder:${path}`); }
  async move(entry: Entry, target: string) { const kind = target.startsWith("stage/") ? "stage" : "rollback"; this.events.push(`move:${entry.id}:${kind}`); if (this.failures.has(`move:${entry.id}:${kind}`)) throw new Error(`move ${entry.id} failed`); }
  async replace(change: { file: File; original: string; next: string; label: string }) { this.events.push(`replace:${change.file.id}:${change.next}`); if (this.failures.has(`replace:${change.file.id}:${change.next}`)) throw new Error("replace failed"); }
  async trash(path: string) { this.events.push(`trash:${path}`); if (this.failures.has("trash")) throw new Error("trash failed"); }
  async deleteEmptyStage(path: string) { this.events.push(`cleanup:${path}`); }
  forget(path: string) { this.events.push(`forget:${path}`); }
  render() { this.events.push("render"); }
}

test("post deletion stages note/media, rewrites receipt/account, then trashes", async () => {
  const adapter = new Fake();
  const result = await executePostDelete(plan(), adapter);
  assert.equal(result.status, "completed");
  assert.deepEqual(adapter.events, [
    "replan", "folder:stage/run", "move:note:stage", "move:media:stage",
    "replace:receipt:new-receipt", "replace:account:new-account", "trash:stage/run",
    "forget:XMediaArchive/a/post.md", "render",
  ]);
});

test("stale confirmation stops before stage mutation", async () => {
  const adapter = new Fake();
  adapter.replan = async () => { adapter.events.push("replan"); return plan("changed"); };
  const result = await executePostDelete(plan("old"), adapter);
  assert.equal(result.status, "failed");
  assert.deepEqual(adapter.events, ["replan"]);
});

test("receipt/account failure rolls back text first, then paths", async () => {
  const adapter = new Fake();
  adapter.failures.add("replace:account:new-account");
  const result = await executePostDelete(plan(), adapter);
  assert.equal(result.status, "failed");
  assert.deepEqual(adapter.events.slice(-6), [
    "replace:receipt:new-receipt", "replace:account:new-account", "replace:receipt:old-receipt", "move:media:rollback", "move:note:rollback", "cleanup:stage/run",
  ]);
});

test("trash failure is rollbackable and render is never reached", async () => {
  const adapter = new Fake();
  adapter.failures.add("trash");
  const result = await executePostDelete(plan(), adapter);
  assert.equal(result.status, "failed");
  assert.equal(adapter.events.includes("render"), false);
  assert.equal(adapter.events.at(-1), "cleanup:stage/run");
});
