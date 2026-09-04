import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ARCHIVE_SCHEMA_VERSION,
  assertSafeStagingRelativePath,
  buildTokyoNoteFilename,
  createMediaKey,
  formatTokyoNoteTimestamp,
  isValidJobId,
  makeMediaKey,
  normalizeArchiveJob,
  sanitizeWindowsSegment,
  validateArchiveJob,
} from "../lib/archive_contract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "archive_job_v1.json"), "utf8"));

test("ArchiveJob v1 normalizes known fields while preserving unknown fields", () => {
  const job = normalizeArchiveJob(fixture);
  assert.equal(ARCHIVE_SCHEMA_VERSION, 1);
  assert.equal(job.producerHint, "fixture-unknown-field-is-preserved");
  assert.equal(job.posts[0].media[0].extension, "jpg");
  assert.equal(job.posts[0].media[1].mediaKey, "1955000000000000001:2:video");
  assert.equal(job.posts[0].createdAt, "2026-08-10T15:30:45.000Z");
  assert.equal(job.posts[0].media[0].error, null, "media with no recorded failure carries an explicit null");
});

test("a failed download carries its reason to the consumer as one bounded line", () => {
  const withError = { ...fixture, posts: [{ ...fixture.posts[0], media: [
    { ...fixture.posts[0].media[0], downloadState: "missing", stagingRelativePath: null, error: "SERVER_FAILED\n403 Forbidden\t" },
  ] }] };
  const media = normalizeArchiveJob(withError).posts[0].media[0];
  assert.equal(media.error, "SERVER_FAILED 403 Forbidden ");
  const long = { ...withError, posts: [{ ...withError.posts[0], media: [{ ...withError.posts[0].media[0], error: "x".repeat(400) }] }] };
  assert.equal(normalizeArchiveJob(long).posts[0].media[0].error.length, 256);
});

test("ArchiveJob v1 rejects unknown schemas and non-v4 UUID job IDs", () => {
  assert.equal(isValidJobId(fixture.jobId), true);
  assert.equal(isValidJobId("123e4567-e89b-12d3-a456-426614174000"), false);
  assert.equal(isValidJobId("not-a-uuid"), false);
  assert.throws(() => normalizeArchiveJob({ ...fixture, schemaVersion: 2 }), /unsupported schema version/);
  assert.throws(() => normalizeArchiveJob({ ...fixture, jobId: "123e4567-e89b-12d3-a456-426614174000" }), /canonical UUID v4/);
  assert.equal(validateArchiveJob({ ...fixture, schemaVersion: 99 }).ok, false);
});

test("media keys prefer X mediaKey and otherwise use tweetId:ordinal:type", () => {
  assert.equal(createMediaKey({ mediaKey: "3_abc", tweetId: "1", ordinal: 1, type: "photo" }), "3_abc");
  assert.equal(createMediaKey({ tweetId: "1", ordinal: 3, type: "animated_gif" }), "1:3:animated_gif");
  assert.equal(makeMediaKey({ type: "photo" }, "1", 2), "1:2:photo");
});

test("ArchiveJob requires completed jobs and rejects unsafe staging paths", () => {
  assert.equal(validateArchiveJob({ ...fixture, state: "pending" }).ok, false);
  assert.equal(validateArchiveJob({ ...fixture, posts: [{ ...fixture.posts[0], media: [{ ...fixture.posts[0].media[0], stagingRelativePath: "//server/share/file.jpg" }] }] }).ok, false);
});

test("staging paths reject absolute paths and traversal instead of rewriting them", () => {
  assert.equal(assertSafeStagingRelativePath("media/one.jpg"), "media/one.jpg");
  for (const candidate of ["../one.jpg", "media/../one.jpg", "C:/temp/one.jpg", "/tmp/one.jpg", "media\\one.jpg", "media/CON.jpg"]) {
    assert.throws(() => assertSafeStagingRelativePath(candidate));
  }
});

test("Windows segment sanitization and Tokyo note names are deterministic", () => {
  assert.equal(sanitizeWindowsSegment("CON"), "_CON");
  assert.equal(sanitizeWindowsSegment("bad<>name. "), "bad__name");
  assert.equal(formatTokyoNoteTimestamp("2026-08-10T15:30:45.000Z"), "2026-08-11_003045");
  assert.equal(
    buildTokyoNoteFilename({ createdAt: "2026-08-10T15:30:45.000Z", text: "a/b:c*?\n", tweetId: "1955" }),
    "2026-08-11_003045 - a_b_c__ - 1955.md"
  );
  assert.match(buildTokyoNoteFilename({ createdAt: fixture.posts[0].createdAt, text: "", tweetId: fixture.posts[0].tweetId }), / - post - 1955000000000000001\.md$/);
});
