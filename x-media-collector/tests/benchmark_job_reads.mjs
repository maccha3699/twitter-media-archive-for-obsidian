import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { MediaLedger, MemoryLedgerStore } from "../lib/ledger.js";

function positiveInt(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return parsed;
}

const postCount = positiveInt(process.argv[2], 816, "post count");
const mediaCount = positiveInt(process.argv[3], 940, "media count");
const concurrency = positiveInt(process.argv[4], 20, "concurrency");

class CountingMemoryStore extends MemoryLedgerStore {
  constructor(name) {
    super(name);
    this.counts = { readJob: 0, readJobPosts: 0, readJobMedia: 0 };
  }

  resetCounts() {
    this.counts = { readJob: 0, readJobPosts: 0, readJobMedia: 0 };
  }

  async readJob(...args) {
    this.counts.readJob += 1;
    return super.readJob(...args);
  }

  async readJobPosts(...args) {
    this.counts.readJobPosts += 1;
    return super.readJobPosts(...args);
  }

  async readJobMedia(...args) {
    this.counts.readJobMedia += 1;
    return super.readJobMedia(...args);
  }
}

async function runConcurrent(count, workerCount, operation) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, workerCount) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= count) return;
      await operation(index);
    }
  }));
}

function rounded(value) {
  return Number(value.toFixed(1));
}

MemoryLedgerStore.databases.clear();
const dbName = `job-read-memory-${randomUUID()}`;
const store = new CountingMemoryStore(dbName);
const ledger = new MediaLedger({ factory: { open: async () => store }, dbName });
const jobId = randomUUID();

const seedStarted = performance.now();
await ledger.createJob({ jobId, mode: "bulk" });
await runConcurrent(postCount, concurrency, (index) => ledger.appendJobPost(jobId, {
  tweetId: `tweet-${String(index).padStart(6, "0")}`,
  text: `synthetic post ${index}`,
  media: [],
}));
await runConcurrent(mediaCount, concurrency, (index) => ledger.updateJobMediaDownload(
  jobId,
  `media-${String(index).padStart(6, "0")}`,
  { downloadId: index + 1, state: "complete" },
));
const seedMs = performance.now() - seedStarted;

store.resetCounts();
const fullStarted = performance.now();
await runConcurrent(postCount, concurrency, () => ledger.getJob(jobId));
const fullMs = performance.now() - fullStarted;
const fullCounts = { ...store.counts };

store.resetCounts();
const headerStarted = performance.now();
await runConcurrent(postCount, concurrency, () => ledger.getJobHeader(jobId));
const headerMs = performance.now() - headerStarted;
const headerCounts = { ...store.counts };

const snapshot = await ledger.getJob(jobId);
const valid = snapshot.posts.length === postCount
  && Object.keys(snapshot.media).length === mediaCount
  && fullCounts.readJobPosts === postCount
  && fullCounts.readJobMedia === postCount
  && headerCounts.readJob === postCount
  && headerCounts.readJobPosts === 0
  && headerCounts.readJobMedia === 0
  && headerMs < fullMs;

const result = {
  ok: valid,
  adapter: "memory",
  postCount,
  mediaCount,
  concurrency,
  seedMs: rounded(seedMs),
  fullJob: { elapsedMs: rounded(fullMs), ...fullCounts },
  header: { elapsedMs: rounded(headerMs), ...headerCounts },
  speedup: Number((fullMs / headerMs).toFixed(2)),
};

console.log(JSON.stringify(result));
if (!valid) process.exitCode = 1;
