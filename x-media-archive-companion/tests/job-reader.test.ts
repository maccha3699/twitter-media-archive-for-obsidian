import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { diskFs } from "../src/fs.ts";
import { IMPORTED_MARKER, listCompletedJobDirectories, readCompletedJob } from "../src/job-reader.ts";
import { ContractError } from "../src/validation.ts";
import type { ArchiveJob } from "../src/types.ts";
import { sampleJob, tempDirectory, writeJob } from "./fixtures.ts";

test("reads the checked-in producer-compatible fixture as byte-sliced chunks", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const job = JSON.parse(await fs.readFile(new URL("./fixtures/archive_job_v1.json", import.meta.url), "utf8")) as ArchiveJob;
  const jobDir = path.join(root, job.jobId); await writeJob(jobDir, job, 3);
  assert.deepEqual(await readCompletedJob(diskFs, jobDir), job);
});
test("uses the lexically last completed manifest attempt and ignores partial attempts", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const job = sampleJob(); const jobDir = path.join(root, job.jobId);
  await fs.mkdir(path.join(jobDir, "_manifest", "0001-partial"), { recursive: true });
  await fs.writeFile(path.join(jobDir, "_manifest", "0001-partial", "manifest-0001.json"), "{}");
  await writeJob(path.join(jobDir, "_manifest", "0002-complete"), job, 2);
  const corrupt = path.join(jobDir, "_manifest", "0004-corrupt-complete");
  await writeJob(corrupt, job, 1);
  await fs.writeFile(path.join(corrupt, "manifest-0001.json"), "{}");
  await fs.mkdir(path.join(jobDir, "_manifest", "0003-partial"), { recursive: true });
  assert.equal((await readCompletedJob(diskFs, jobDir)).jobId, job.jobId);
});
test("rejects chunks over 512 KiB and traversal in reassembled JSON", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const job = sampleJob(); const jobDir = path.join(root, job.jobId); await writeJob(jobDir, job);
  await fs.writeFile(path.join(jobDir, "manifest-0001.json"), "x".repeat(512 * 1024 + 1));
  await assert.rejects(readCompletedJob(diskFs, jobDir), ContractError);
  const unsafe = sampleJob(); unsafe.posts[0].media[0].stagingRelativePath = "../outside.bin"; const unsafeDir = path.join(root, "unsafe"); await writeJob(unsafeDir, unsafe);
  await assert.rejects(readCompletedJob(diskFs, unsafeDir), ContractError);
});
test("completed job listing skips durable imported markers", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const job = sampleJob(); const jobDir = path.join(root, job.jobId); await writeJob(jobDir, job);
  assert.deepEqual(await listCompletedJobDirectories(diskFs, root), [job.jobId]);
  await fs.writeFile(path.join(jobDir, IMPORTED_MARKER), "{}\n");
  assert.deepEqual(await listCompletedJobDirectories(diskFs, root), []);
});
