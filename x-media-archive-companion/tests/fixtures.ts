import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ArchiveJob } from "../src/types.ts";

export const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
export function sampleJob(): ArchiveJob {
  return { schemaVersion: 1, jobId: JOB_ID, mode: "manual", createdAt: "2025-01-02T03:04:05.000Z", state: "complete", posts: [{ tweetId: "1830000000000000000", tweetUrl: "https://x.example/status/1830000000000000000", text: "dummy post", createdAt: "2025-01-02T03:04:05.000Z", author: { id: "42", screenName: "dummy", displayName: "Dummy User", bio: "Dummy biography", urls: ["https://example.invalid"], location: "東京", followers: 1234 }, media: [{ mediaKey: "3_abc", ordinal: 1, type: "photo", extension: "bin", stagingRelativePath: "staging/dummy.bin", downloadState: "complete" }] }] };
}
export async function tempDirectory(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), "xmc-companion-test-")); }
/** Emits the producer's byte-sliced archive-job-chunk envelopes. */
export async function writeJob(directory: string, job = sampleJob(), chunkCount = 1): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const source = Buffer.from(JSON.stringify(job), "utf8");
  for (let index = 0; index < chunkCount; index++) {
    const start = Math.floor(source.length * index / chunkCount); const end = Math.floor(source.length * (index + 1) / chunkCount);
    await fs.writeFile(path.join(directory, `manifest-${String(index + 1).padStart(4, "0")}.json`), JSON.stringify({ schemaVersion: 1, kind: "archive-job-chunk", jobId: job.jobId, chunkIndex: index, chunkCount, encoding: "base64-utf8-json", payload: source.subarray(start, end).toString("base64") }));
  }
  await fs.writeFile(path.join(directory, "complete.json"), JSON.stringify({ schemaVersion: 1, kind: "archive-job-complete", jobId: job.jobId, chunkCount }));
}
