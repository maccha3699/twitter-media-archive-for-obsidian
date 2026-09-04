import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DiagnosticLog } from "../src/diagnostics.ts";
import { StageTimer } from "../src/stage-timer.ts";

const executorSource = readFileSync(new URL("../src/author-delete-executor.ts", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

class MemoryAdapter {
  files = new Map<string, string>();
  directories = new Set<string>();
  async exists(path: string): Promise<boolean> { return this.files.has(path) || this.directories.has(path); }
  async read(path: string): Promise<string> { return this.files.get(path) ?? ""; }
  async write(path: string, data: string): Promise<void> { this.files.set(path, data); }
  async mkdir(path: string): Promise<void> { this.directories.add(path); }
}

function fakeClock(values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

test("each stage is measured from the end of the previous one, not from the start", () => {
  const timer = new StageTimer(fakeClock([0, 100, 130, 1130, 1140, 1140]));
  timer.finish("replan");
  timer.finish("stage-folder");
  timer.finish("stage-media");
  timer.finish("receipts");
  assert.deepEqual(timer.stages, [
    { stage: "replan", elapsedMs: 100 },
    { stage: "stage-folder", elapsedMs: 30 },
    { stage: "stage-media", elapsedMs: 1000 },
    { stage: "receipts", elapsedMs: 10 },
  ]);
  // The whole point is finding which stage dominates, so splits must not
  // accumulate into each other.
  assert.equal(timer.totalMs(), 1140);
});

test("a repeated stage name appends rather than overwriting an earlier measurement", () => {
  const timer = new StageTimer(fakeClock([0, 5, 9, 9]));
  timer.finish("stage-media");
  timer.finish("stage-media");
  assert.deepEqual(timer.stages.map((entry) => entry.elapsedMs), [5, 4]);
});

test("details carry the outcome and the counts that explain the timings", () => {
  const timer = new StageTimer(fakeClock([0, 40, 55, 55]));
  timer.finish("replan");
  timer.finish("stage-folder");
  assert.deepEqual(timer.details("completed", { noteCount: 282, movedMediaCount: 310, preservedMediaCount: 0, receiptCount: 75 }), {
    outcome: "completed",
    totalMs: 55,
    stageCount: 2,
    replanMs: 40,
    stageFolderMs: 15,
    noteCount: 282,
    movedMediaCount: 310,
    preservedMediaCount: 0,
    receiptCount: 75,
  });
});

test("repeated stages are summed into one flat key so the log stays depth-safe", () => {
  const timer = new StageTimer(fakeClock([0, 5, 9, 9]));
  timer.finish("stage-media");
  timer.finish("stage-media");
  const details = timer.details("completed");
  assert.equal(details.stageMediaMs, 9);
  assert.equal(details.stageCount, 2);
});

test("every timing value survives the diagnostic log intact", async () => {
  // Two filters can silently gut this line. SENSITIVE_KEY drops any key
  // containing `path` or `message` -- that is how failureCount was lost once
  // before -- and safeValue replaces anything past depth 3 with
  // "[depth-limited]", which is what a nested stages array hits.
  const adapter = new MemoryAdapter();
  const log = new DiagnosticLog(adapter, "XMediaArchive/_system");
  const timer = new StageTimer(fakeClock([0, 10, 20, 30, 40, 50, 60, 70, 70]));
  for (const stage of ["replan", "stage-folder", "stage-media", "receipts", "pins", "trash", "render"]) timer.finish(stage);
  await log.log({ event: "author-delete-timing", details: timer.details("completed", { noteCount: 282, movedMediaCount: 310, preservedMediaCount: 4, receiptCount: 75 }) });
  const output = adapter.files.get(log.relativePath) ?? "";
  assert.doesNotMatch(output, /depth-limited/, "a truncated line looks populated and proves nothing");
  assert.deepEqual(JSON.parse(output.trim()).details, {
    outcome: "completed", totalMs: 70, stageCount: 7,
    replanMs: 10, stageFolderMs: 10, stageMediaMs: 10, receiptsMs: 10, pinsMs: 10, trashMs: 10, renderMs: 10,
    noteCount: 282, movedMediaCount: 310, preservedMediaCount: 4, receiptCount: 75,
  });
});

test("the log line names no author, file, or vault location", async () => {
  const adapter = new MemoryAdapter();
  const log = new DiagnosticLog(adapter, "XMediaArchive/_system");
  const timer = new StageTimer(fakeClock([0, 10, 10]));
  timer.finish("replan");
  await log.log({ event: "author-delete-timing", details: timer.details("failed", { noteCount: 3 }) });
  const output = adapter.files.get(log.relativePath) ?? "";
  assert.doesNotMatch(output, /private_author|second_private_author|_media\/|\.md|C:\\/i);
});

test("author deletion times every stage and logs on both outcomes", () => {
  for (const stage of ["replan", "stage-folder", "stage-media", "receipts", "pins", "trash", "render"]) {
    assert.match(executorSource, new RegExp(`timer\\.finish\\("${stage}"\\)`), `${stage} must be measured`);
  }
  assert.match(executorSource, /logTiming\?\.\("completed", timer\.details\("completed"/);
  // A deletion that fails is when the wait is most confusing; it must not be
  // the one case that produces no timings.
  assert.match(executorSource, /timer\.finish\("failed"\)/);
  assert.match(executorSource, /timer\.details\("failed", \{ \.\.\.counts, rollbackFailureCount/);
  assert.match(mainSource, /logDiagnostic\(event: string, details\?: Record<string, unknown>\): void/);
});

test("nothing measurement does comes between a failure and undoing it", () => {
  // Rollback is the most safety-critical code here. If a synchronous throw in
  // details() or the host could land before the executor rollback, a failed
  // deletion would leave the author folder sitting in the staging directory.
  const rollbackAt = executorSource.indexOf("if (stagePrepared) await adapter.deleteEmptyStage");
  const logAt = executorSource.indexOf("adapter.logTiming?.(\"failed\"");
  assert.ok(rollbackAt > 0 && logAt > rollbackAt, "the timing line is written only after rollback has run");
});

test("measurement does not take over any step it measures", () => {
  // finish() only reads a clock. If the timer ever wrapped the work itself, a
  // throw inside it could change which errors reach the rollback path.
  const code = readFileSync(new URL("../src/stage-timer.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\bawait\b|\bPromise\b|\btry\b|\bcatch\b|\bthrow\b/);
  assert.doesNotMatch(executorSource, /timer\.(measure|wrap|run)\(/);
  // The executor's journal records only resolved adapter mutations.
  assert.match(executorSource, /await adapter\.restorePins/);
  assert.match(executorSource, /await adapter\.deleteEmptyStage/);
});
