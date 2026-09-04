import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { archiveJobFromPersistentJob, orphanedMediaKeys } from "../lib/archive_job_projection.js";

const source = readFileSync(new URL("../lib/archive_job_projection.js", import.meta.url), "utf8");

test("ArchiveJob projection is runtime-independent", () => {
  assert.doesNotMatch(source, /\b(?:chrome|indexeddb|addlistener|fetch|xmlhttprequest)\b/i);
});

test("ArchiveJob projection carries ledger states and bounded failure details without mutation", () => {
  const job = {
    jobId: "123e4567-e89b-42d3-a456-426614174000",
    mode: "bulk",
    createdAt: "2026-08-20T00:00:00.000Z",
    posts: [{
      tweetId: "1900000000000000001",
      media: [
        { mediaKey: "complete", stagingRelativePath: "media/complete.jpg", downloadState: "pending" },
        { mediaKey: "failed", stagingRelativePath: "media/failed.jpg", downloadState: "pending" },
        { mediaKey: "missing", stagingRelativePath: "media/missing.jpg", downloadState: "pending" },
        { mediaKey: "fallback", stagingRelativePath: "media/fallback.jpg", downloadState: "skipped" },
      ],
      futurePostField: "preserved",
    }],
    media: {
      complete: { state: "complete", error: "stale ledger text" },
      failed: { state: "failed", error: "cdn unavailable" },
      missing: { state: "missing", error: "record was lost" },
      // A persistent job can retain a media entry without an explicit state.
      fallback: {},
    },
  };
  const before = structuredClone(job);
  const projected = archiveJobFromPersistentJob(job);
  assert.deepEqual(job, before);
  assert.equal(projected.schemaVersion, 1);
  assert.equal(projected.state, "complete");
  assert.equal(projected.posts[0].futurePostField, "preserved");
  assert.deepEqual(projected.posts[0].media.map((item) => ({ key: item.mediaKey, state: item.downloadState, path: item.stagingRelativePath, error: item.error })), [
    { key: "complete", state: "complete", path: "media/complete.jpg", error: null },
    { key: "failed", state: "failed", path: null, error: "cdn unavailable" },
    { key: "missing", state: "missing", path: null, error: "record was lost" },
    { key: "fallback", state: "skipped", path: null, error: null },
  ]);
});

test("orphan projection reports only complete unclaimed media", () => {
  const job = {
    posts: [
      { media: [{ mediaKey: "claimed" }, { mediaKey: "also-claimed" }] },
      { media: null },
      null,
    ],
    media: {
      claimed: { state: "complete" },
      "also-claimed": { state: "complete" },
      orphan: { state: "complete" },
      failed: { state: "failed" },
      pending: { state: "pending" },
    },
  };
  assert.deepEqual(orphanedMediaKeys(job), ["orphan"]);
});
