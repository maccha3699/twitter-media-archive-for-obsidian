import assert from "node:assert/strict";
import test from "node:test";
import {
  executeAuthorDelete,
  type AuthorDeleteAdapter,
  type AuthorDeletePlan,
} from "../src/author-delete-executor.ts";

type Entry = { id: string };
type File = { name: string };

const basePlan = (signature = "fresh"): AuthorDeletePlan<Entry, File> => ({
  signature,
  stagePath: "XMediaArchive/_system/delete-staging/run-1",
  folder: "alice",
  counts: { noteCount: 2, movedMediaCount: 2, preservedMediaCount: 1, receiptCount: 2 },
  moves: {
    author: { entry: { id: "author" }, originalPath: "XMediaArchive/alice", target: "stage/author" },
    account: { entry: { id: "account" }, originalPath: "XMediaArchive/_accounts/alice.md", target: "stage/account.md" },
    media: [
      { entry: { id: "media-1" }, originalPath: "XMediaArchive/_media/alice/1.jpg", target: "stage/media/1.jpg" },
      { entry: { id: "media-2" }, originalPath: "XMediaArchive/_media/alice/2.jpg", target: "stage/media/2.jpg" },
    ],
  },
  receipts: [
    { file: { name: "job-a.json" }, original: "a", next: "a'" },
    { file: { name: "job-b.json" }, original: "b", next: "b'" },
  ],
});

class FakeAdapter implements AuthorDeleteAdapter<Entry, File> {
  readonly events: string[] = [];
  readonly failures = new Set<string>();
  readonly plan: AuthorDeletePlan<Entry, File>;
  readonly snapshot = { file: { name: "pins.md" }, original: "pins-before" };
  constructor(plan = basePlan()) { this.plan = plan; }
  private async step(name: string): Promise<void> {
    this.events.push(name);
    if (this.failures.has(name)) throw new Error(`${name} failed`);
  }
  async replan(): Promise<AuthorDeletePlan<Entry, File>> { await this.step("replan"); return this.plan; }
  async ensureFolder(): Promise<void> { await this.step("ensureFolder"); }
  async move(entry: Entry, target: string): Promise<void> {
    const name = target.startsWith("stage/") ? `move:${entry.id}:stage` : `move:${entry.id}:rollback`;
    await this.step(name);
  }
  async replaceReceipt(change: { file: File; original: string; next: string }): Promise<void> {
    await this.step(`receipt:${change.file.name}:${change.next}`);
  }
  async capturePins() { await this.step("capturePins"); return this.snapshot; }
  async removePin(): Promise<void> { await this.step("removePin"); }
  async restorePins(): Promise<void> { await this.step("restorePins"); }
  async trash(): Promise<void> { await this.step("trash"); }
  async deleteEmptyStage(): Promise<void> { await this.step("deleteEmptyStage"); }
  forget(): void { this.events.push("forget"); }
  render(): void { this.events.push("render"); }
  logTiming(outcome: "completed" | "failed"): void { this.events.push(`log:${outcome}`); }
}

test("successful execution has fixed stage/receipt/pin/trash/forget/render order and skips preserved media", async () => {
  const adapter = new FakeAdapter();
  const result = await executeAuthorDelete(basePlan(), adapter);
  assert.equal(result.status, "completed");
  assert.deepEqual(adapter.events.map((event) => event.split(":")[0]), [
    "replan", "ensureFolder", "move", "move", "move", "move", "receipt", "receipt",
    "capturePins", "removePin", "trash", "forget", "render", "log",
  ]);
  assert.equal(adapter.events.some((event) => event.includes("preserved")), false);
  assert.equal(adapter.events.at(-1), "log:completed");
});

test("stale plan is rejected before stage mutation", async () => {
  const adapter = new FakeAdapter({ ...basePlan("new-signature") });
  const result = await executeAuthorDelete(basePlan("old-signature"), adapter);
  assert.equal(result.status, "failed");
  assert.match(String(result.error), /対象内容が変わりました/);
  assert.deepEqual(adapter.events, ["replan", "log:failed"]);
});

test("every pre-trash failure rolls back only successful mutations in reverse order", async (t) => {
  const points = [
    "ensureFolder", "move:author:stage", "move:account:stage", "move:media-1:stage", "move:media-2:stage",
    "receipt:job-a.json:a'", "receipt:job-b.json:b'", "capturePins", "removePin", "trash",
  ];
  const operationOrder = [
    "ensureFolder", "move:author:stage", "move:account:stage", "move:media-1:stage", "move:media-2:stage",
    "receipt:job-a.json:a'", "receipt:job-b.json:b'", "capturePins", "removePin", "trash",
  ];
  for (const point of points) {
    await t.test(`failure at ${point}`, async () => {
      const adapter = new FakeAdapter();
      adapter.failures.add(point);
      const result = await executeAuthorDelete(basePlan(), adapter);
      assert.equal(result.status, "failed");
      assert.equal(adapter.events.includes("log:completed"), false);
      assert.equal(adapter.events.includes("deleteEmptyStage"), true);
      const failedAt = adapter.events.indexOf(point);
      const cleanupOrLog = adapter.events.indexOf("deleteEmptyStage") >= 0
        ? adapter.events.indexOf("deleteEmptyStage") : adapter.events.indexOf("log:failed");
      const rollback = adapter.events.slice(failedAt + 1, cleanupOrLog);
      const pointIndex = operationOrder.indexOf(point);
      const expected: string[] = [];
      if (pointIndex > operationOrder.indexOf("capturePins")) expected.push("restorePins");
      for (const receipt of [...basePlan().receipts].reverse()) {
        const operation = `receipt:${receipt.file.name}:${receipt.next}`;
        if (operationOrder.indexOf(operation) < pointIndex) expected.push(`receipt:${receipt.file.name}:${receipt.original}`);
      }
      for (const move of [...basePlan().moves.media].reverse().concat([basePlan().moves.account, basePlan().moves.author])) {
        const operation = `move:${move.entry.id}:stage`;
        if (operationOrder.indexOf(operation) < pointIndex) expected.push(`move:${move.entry.id}:rollback`);
      }
      assert.deepEqual(rollback, expected);
    });
  }
});

test("rollback failures use frozen labels and preserve primary failure", async () => {
  const adapter = new FakeAdapter();
  adapter.failures.add("trash");
  adapter.failures.add("restorePins");
  adapter.failures.add("move:account:rollback");
  const result = await executeAuthorDelete(basePlan(), adapter);
  assert.equal(result.status, "failed");
  assert.match(String(result.error), /trash failed/);
  assert.deepEqual(result.rollbackFailures, ["pins", "XMediaArchive/_accounts/alice.md"]);
});

test("trash success is commit point and render failure remains completed", async () => {
  const adapter = new FakeAdapter();
  adapter.render = async function () { this.events.push("render"); throw new Error("render failed"); };
  const result = await executeAuthorDelete(basePlan(), adapter);
  assert.equal(result.status, "completed");
  assert.match(String(result.renderError), /render failed/);
  assert.equal(adapter.events.includes("restorePins"), false);
  assert.equal(adapter.events.includes("deleteEmptyStage"), false);
  assert.equal(adapter.events.at(-1), "log:completed");
});
