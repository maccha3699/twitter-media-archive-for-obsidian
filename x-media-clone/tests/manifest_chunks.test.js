import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DEFAULT_MAX_MANIFEST_CHUNK_BYTES, joinArchiveJobManifest, splitArchiveJobManifest } from "../lib/manifest_chunks.js";
import { normalizeArchiveJob } from "../lib/archive_contract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "archive_job_v1.json"), "utf8"));
const utf8Length = (value) => new TextEncoder().encode(value).byteLength;

test("manifest chunks stay within 512 KiB and round-trip UTF-8 data", () => {
  const job = structuredClone(fixture);
  job.posts[0].text = "猫".repeat(350000);
  const output = splitArchiveJobManifest(job);
  assert.ok(output.chunks.length > 1);
  assert.ok(output.files.at(-1).name === "complete.json");
  assert.ok(output.files.every((file) => utf8Length(file.contents) <= DEFAULT_MAX_MANIFEST_CHUNK_BYTES));
  assert.deepEqual(joinArchiveJobManifest(output.chunks, output.complete), normalizeArchiveJob(job));
});

test("manifest reassembly refuses missing, swapped, or duplicate chunks", () => {
  const output = splitArchiveJobManifest(fixture, { maxBytes: 1024 });
  assert.throws(() => joinArchiveJobManifest(output.chunks.slice(1), output.complete), /chunk count/);
  const duplicate = [...output.chunks];
  duplicate[1] = duplicate[0];
  assert.throws(() => joinArchiveJobManifest(duplicate, output.complete), /contiguous and unique/);
  const swappedMarker = JSON.parse(output.complete.contents);
  swappedMarker.jobId = "123e4567-e89b-42d3-a456-426614174001";
  assert.throws(() => joinArchiveJobManifest(output.chunks, swappedMarker), /does not match/);
});
