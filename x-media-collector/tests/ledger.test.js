import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryLedgerFactory, MediaLedger, MemoryLedgerStore } from "../lib/ledger.js";

function clock() {
  let tick = 0;
  return () => `2026-08-11T00:00:${String(tick++).padStart(2, "0")}.000Z`;
}

function ledger(name = `ledger-${Math.random()}`) {
  return new MediaLedger({ factory: createMemoryLedgerFactory(), dbName: name, now: clock() });
}

const request = { mediaKey: "3_photo", tweetId: "1955", jobId: "123e4567-e89b-42d3-a456-426614174000", authorId: "42" };

test("reserve is atomic: concurrent callers allow only one pending record", async () => {
  const subject = ledger();
  const [left, right] = await Promise.all([subject.reserve(request), subject.reserve(request)]);
  assert.equal([left, right].filter((result) => result.reserved).length, 1);
  assert.equal([left, right].find((result) => !result.reserved).reason, "pending");
  assert.equal((await subject.get(request.mediaKey)).state, "pending");
});

test("complete, pending, and staged records skip before a new request; failures require explicit retry", async () => {
  const subject = ledger();
  await subject.reserve(request);
  assert.equal((await subject.reserve(request)).reason, "pending");
  await subject.markComplete(request.mediaKey, { downloadId: 77 });
  assert.equal((await subject.reserve(request)).reason, "complete");
  assert.deepEqual((await subject.findByDownloadId(77)).map((record) => record.mediaKey), [request.mediaKey]);

  const staged = { ...request, mediaKey: "3_staged" };
  await subject.reserve(staged);
  await subject.markStaged(staged.mediaKey, { downloadId: 78 });
  assert.equal((await subject.reserve(staged)).reason, "staged");
  assert.equal((await subject.get(staged.mediaKey)).receiptId, null);

  const failed = { ...request, mediaKey: "3_failed" };
  await subject.reserve(failed);
  await subject.markFailed(failed.mediaKey, "network down");
  assert.equal((await subject.reserve(failed)).reason, "retry-required");
  assert.equal((await subject.reserve(failed, { retry: true })).reserved, true);
});

test("a retry can reclaim an orphaned pending reservation without a download ID", async () => {
  const ledger = new MediaLedger({ factory: createMemoryLedgerFactory(), dbName: `orphan-${crypto.randomUUID()}` });
  const input = { mediaKey: "orphan", jobId: "job", tweetId: "1", authorId: null };
  assert.equal((await ledger.reserve(input)).reserved, true);
  assert.equal((await ledger.reserve(input)).reserved, false);
  const retry = await ledger.reserve(input, { retry: true });
  assert.equal(retry.reserved, true);
  assert.equal(retry.reason, "retried");
});

test("memory factory simulates restart persistence and ledger has no automatic expiry", async () => {
  const dbName = `restart-${Math.random()}`;
  const factory = createMemoryLedgerFactory();
  const first = new MediaLedger({ factory, dbName, now: clock() });
  await first.reserve(request);
  await first.markComplete(request.mediaKey);
  const second = new MediaLedger({ factory, dbName, now: clock() });
  assert.equal((await second.get(request.mediaKey)).state, "complete");
  const stats = await second.stats();
  assert.equal(stats.count, 1);
  assert.equal(stats.byState.complete, 1);
});

test("legacy history never suppresses a new request and export holds compact records only", async () => {
  const subject = ledger();
  assert.deepEqual(await subject.migrateLegacyHistory(["1955", { mediaKey: "3_known", tweetId: "1956" }]), { imported: 2 });
  assert.equal((await subject.get("legacy:1955")).state, "legacy-unverified");
  assert.equal((await subject.reserve({ ...request, mediaKey: "3_known" })).reason, "retry-required");
  const exported = await subject.export();
  assert.equal(exported.schemaVersion, 1);
  assert.ok(exported.records.every((record) => !Object.hasOwn(record, "text") && !Object.hasOwn(record, "mediaBytes")));
});

test("receipt rebuild replaces stale records using receipt metadata without file access", async () => {
  const subject = ledger();
  await subject.reserve({ ...request, mediaKey: "stale" });
  const result = await subject.rebuildFromReceipts([{
    jobId: request.jobId,
    receiptId: "receipt-1",
    posts: [{ tweetId: request.tweetId, authorId: request.authorId, media: [{ mediaKey: "3_rebuilt", downloadState: "complete", downloadId: 88 }] }],
  }]);
  assert.deepEqual(result, { rebuilt: 1 });
  assert.equal(await subject.get("stale"), null);
  assert.equal((await subject.get("3_rebuilt")).state, "complete");
});

test("Companion receipt states rebuild to suppressing complete or retryable failed records", async () => {
  const subject = ledger();
  await subject.rebuildFromReceipts([{ jobId: "receipt-job", posts: [{ tweetId: "22", media: [
    { mediaKey: "receipt-complete", state: "complete", vaultPath: "Tweets/XMedia/_media/a/1.jpg" },
    { mediaKey: "receipt-partial", state: "partial", error: "missing" },
  ] }] }]);
  assert.equal((await subject.get("receipt-complete")).state, "complete");
  assert.equal((await subject.get("receipt-partial")).state, "failed");
});

test("an empty Companion receipt tombstone clears stale media without rebuilding suppression", async () => {
  const subject = ledger();
  await subject.reserve({ ...request, mediaKey: "deleted-author-media" });
  await subject.markComplete("deleted-author-media");
  const result = await subject.rebuildFromReceipts([{
    jobId: "deleted-author-job", state: "complete", posts: [],
  }]);
  assert.deepEqual(result, { rebuilt: 0 });
  assert.equal(await subject.get("deleted-author-media"), null);
});

test("a failed store operation does not overwrite a previously completed record", async () => {
  const subject = ledger();
  await subject.reserve(request);
  await subject.markComplete(request.mediaKey);
  const store = await subject.store();
  const originalWrite = store.write.bind(store);
  store.write = async () => { throw new Error("simulated quota error"); };
  await assert.rejects(() => subject.markFailed(request.mediaKey, "should not persist"), /quota error/);
  store.write = originalWrite;
  assert.equal((await subject.get(request.mediaKey)).state, "complete");
});

test("persistent jobs survive restart and cannot finalize until every download settles", async () => {
  const dbName = `jobs-${Math.random()}`;
  const factory = createMemoryLedgerFactory();
  const first = new MediaLedger({ factory, dbName, now: clock() });
  await first.createJob({ jobId: request.jobId, mode: "bulk", createdAt: "2026-08-11T00:00:00.000Z" });
  await first.appendJobPost(request.jobId, { tweetId: request.tweetId, text: "manifest metadata" });
  await first.updateJobMediaDownload(request.jobId, request.mediaKey, { downloadId: 123, state: "pending" });

  const restarted = new MediaLedger({ factory, dbName, now: clock() });
  assert.equal((await restarted.getJob(request.jobId)).media[request.mediaKey].downloadId, 123);
  await assert.rejects(() => restarted.markJobFinalizing(request.jobId), /unsettled downloads/);
  await restarted.updateJobMediaDownload(request.jobId, request.mediaKey, { downloadId: 123, state: "complete" });
  assert.equal((await restarted.markJobFinalizing(request.jobId)).state, "finalizing");
  assert.equal((await restarted.listPendingJobs()).length, 1);
  await restarted.markJobPublished(request.jobId);
  assert.equal((await restarted.listPendingJobs()).length, 0);
});

test("finalize intent and tweet lookup survive pending downloads without a full scan", async () => {
  const name = `finalize-intent-${Math.random()}`;
  const factory = createMemoryLedgerFactory();
  const subject = new MediaLedger({ factory, dbName: name, now: clock() });
  await subject.createJob({ jobId: "job-intent", mode: "bulk" });
  await subject.appendJobPost("job-intent", { tweetId: "tweet-1" });
  await subject.reserve({ mediaKey: "media-intent", tweetId: "tweet-1", jobId: "job-intent" });
  await subject.updateJobMediaDownload("job-intent", "media-intent", { downloadId: 4, state: "pending" });

  const requested = await subject.requestJobFinalize("job-intent");
  assert.equal(requested.finalizeRequested, true);
  assert.equal(requested.state, "downloading");
  assert.deepEqual((await subject.findByTweetId("tweet-1")).map((record) => record.mediaKey), ["media-intent"]);

  const reopened = new MediaLedger({ factory, dbName: name, now: clock() });
  assert.equal((await reopened.getJob("job-intent")).finalizeRequested, true);
});

/* The bulk engine runs `maxConcurrent` download workers, each calling savePost,
 * each appending its post. When appendJobPost read the job document, appended to
 * its posts array, and wrote the whole document back across two transactions,
 * concurrent workers clobbered each other and posts vanished silently -- a real
 * run at concurrency 20 published 196 of 560 downloaded posts. */
test("concurrent appends never lose a post", async () => {
  const subject = ledger();
  const jobId = "123e4567-e89b-42d3-a456-426614174001";
  await subject.createJob({ jobId, mode: "bulk" });

  const tweetIds = Array.from({ length: 20 }, (_, index) => `tweet-${index}`);
  await Promise.all(tweetIds.map((tweetId) => subject.appendJobPost(jobId, { tweetId, text: `post ${tweetId}` })));

  const posts = (await subject.getJob(jobId)).posts;
  assert.equal(posts.length, tweetIds.length);
  assert.deepEqual([...posts.map((post) => post.tweetId)].sort(), [...tweetIds].sort());
});

test("appending the same tweet twice keeps one post and the later metadata", async () => {
  const subject = ledger();
  const jobId = "123e4567-e89b-42d3-a456-426614174002";
  await subject.createJob({ jobId, mode: "bulk" });
  await subject.appendJobPost(jobId, { tweetId: "tweet-1", text: "first" });
  await subject.appendJobPost(jobId, { tweetId: "tweet-1", text: "second" });

  const posts = (await subject.getJob(jobId)).posts;
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, "second");
});

/* Jobs written before the jobPosts store carry their posts inside the document.
 * They must keep reading back, and must merge with anything appended after the
 * upgrade rather than being replaced by it. */
test("posts written before the store split still read back and merge with new appends", async () => {
  const dbName = `legacy-posts-${Math.random()}`;
  const factory = createMemoryLedgerFactory();
  const subject = new MediaLedger({ factory, dbName, now: clock() });
  const jobId = "123e4567-e89b-42d3-a456-426614174003";
  await subject.createJob({ jobId, mode: "bulk" });

  const store = await subject.store();
  const job = await store.readJob(jobId);
  await store.writeJob({ ...job, posts: [{ tweetId: "legacy-1", text: "inline" }] });

  assert.deepEqual((await subject.getJob(jobId)).posts.map((post) => post.tweetId), ["legacy-1"]);

  await subject.appendJobPost(jobId, { tweetId: "fresh-1", text: "split store" });
  assert.deepEqual((await subject.getJob(jobId)).posts.map((post) => post.tweetId), ["legacy-1", "fresh-1"]);
});

test("job header reads no child stores and excludes inline collections", async () => {
  const name = `job-header-${crypto.randomUUID()}`;
  const store = new MemoryLedgerStore(name);
  const calls = { posts: 0, media: 0 };
  const readJobPosts = store.readJobPosts.bind(store);
  const readJobMedia = store.readJobMedia.bind(store);
  store.readJobPosts = async (...args) => { calls.posts += 1; return readJobPosts(...args); };
  store.readJobMedia = async (...args) => { calls.media += 1; return readJobMedia(...args); };
  const subject = new MediaLedger({ factory: { open: async () => store }, dbName: name, now: clock() });
  const jobId = "123e4567-e89b-42d3-a456-426614174004";
  await subject.createJob({ jobId, mode: "bulk" });
  await subject.appendJobPost(jobId, { tweetId: "tweet-1", text: "post" });
  await subject.updateJobMediaDownload(jobId, "media-1", { state: "complete", downloadId: 7 });

  const header = await subject.getJobHeader(jobId);

  assert.deepEqual(Object.keys(header).sort(), [
    "createdAt", "finalizeRequested", "jobId", "mode", "schemaVersion", "state", "updatedAt",
  ]);
  assert.equal(header.jobId, jobId);
  assert.equal(header.mode, "bulk");
  assert.equal(header.state, "downloading");
  assert.deepEqual(calls, { posts: 0, media: 0 });
});

test("requesting finalization starts independent post and media reads together", async () => {
  const name = `parallel-finalize-${crypto.randomUUID()}`;
  const store = new MemoryLedgerStore(name);
  const subject = new MediaLedger({ factory: { open: async () => store }, dbName: name, now: clock() });
  const jobId = "123e4567-e89b-42d3-a456-426614174005";
  await subject.createJob({ jobId, mode: "bulk" });

  let postsStarted = false;
  let mediaStarted = false;
  let releaseReads;
  const gate = new Promise((resolve) => { releaseReads = resolve; });
  const readJobPosts = store.readJobPosts.bind(store);
  const readJobMedia = store.readJobMedia.bind(store);
  store.readJobPosts = async (...args) => { postsStarted = true; await gate; return readJobPosts(...args); };
  store.readJobMedia = async (...args) => { mediaStarted = true; await gate; return readJobMedia(...args); };

  const pending = subject.requestJobFinalize(jobId);
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(postsStarted, true);
    assert.equal(mediaStarted, true);
  } finally {
    releaseReads();
  }
  await pending;
});
