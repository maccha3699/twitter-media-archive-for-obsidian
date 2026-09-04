import assert from "node:assert/strict";
import test from "node:test";
import { ContractError, validateArchiveJob, validateStagingRelativePath } from "../src/validation.ts";
import { uriJobId } from "../src/uri.ts";
import { sampleJob } from "./fixtures.ts";

test("accepts XMC ArchiveJob v1 and ignores unknown producer fields", () => {
  const job = sampleJob() as unknown as { futureField: boolean; jobId: string }; job.futureField = true;
  assert.equal(validateArchiveJob(job).jobId, job.jobId);
  const partialMetadata = sampleJob(); partialMetadata.posts[0].text = null;
  assert.equal(validateArchiveJob(partialMetadata).posts[0].text, null);
});
test("rejects traversal, non-v4 IDs, and invalid complete media", () => {
  assert.throws(() => validateStagingRelativePath("staging/../secret.bin"), ContractError);
  assert.throws(() => validateStagingRelativePath("C:\\secret.bin"), ContractError);
  const job = sampleJob(); job.jobId = "not-a-uuid";
  assert.throws(() => validateArchiveJob(job), ContractError);
  const noStaging = sampleJob(); noStaging.posts[0].media[0].stagingRelativePath = null;
  assert.throws(() => validateArchiveJob(noStaging), ContractError);
  assert.equal(uriJobId({ action: "x-media-archive-import", job: "123e4567-e89b-42d3-a456-426614174000", vault: "reserved" }), "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(uriJobId({ action: "other-action", job: "123e4567-e89b-42d3-a456-426614174000" }), null);
  assert.equal(uriJobId({ job: "123e4567-e89b-42d3-a456-426614174000", path: "C:/bad" }), null);
});

test("reply-tree navigation is bounded and cannot reference posts outside its job", () => {
  const job = sampleJob();
  const second = { ...structuredClone(job.posts[0]), tweetId: "1830000000000000001", tweetUrl: "https://x.example/status/1830000000000000001", media: [] };
  job.mode = "bulk";
  job.posts[0].replyTree = { rootTweetId: job.posts[0].tweetId, previousTweetId: null, nextTweetId: second.tweetId, position: 1, size: 2, partial: false };
  second.replyTree = { rootTweetId: job.posts[0].tweetId, previousTweetId: job.posts[0].tweetId, nextTweetId: null, position: 2, size: 2, partial: false };
  job.posts.push(second);
  assert.equal(validateArchiveJob(job).posts[1].replyTree?.position, 2);
  const outside = structuredClone(job);
  outside.posts[1].replyTree!.nextTweetId = "999";
  assert.throws(() => validateArchiveJob(outside), /outside the job/);
  const oversized = structuredClone(job);
  oversized.posts[0].replyTree!.size = 51;
  assert.throws(() => validateArchiveJob(oversized), /replyTree.size/);
});

test("direct reply IDs survive validation for offline bulk grouping", () => {
  const job = sampleJob();
  job.posts[0].replyToTweetId = "1829999999999999999";
  job.posts[0].replyToUserId = "42";
  job.posts[0].conversationId = "1829999999999999999";
  assert.equal(validateArchiveJob(job).posts[0].replyToTweetId, "1829999999999999999");
  job.posts[0].replyToTweetId = "bad";
  assert.throws(() => validateArchiveJob(job), /replyToTweetId/);
});
