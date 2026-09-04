import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryLedgerFactory, MemoryLedgerStore } from "../lib/ledger.js";

function createChromeMock(extensionId, {
  completeMediaSynchronously = false,
  withSessionStorage = false,
  deferLocalGet = false,
} = {}) {
  let messageListener = null;
  let filenameListener = null;
  let changedListener = null;
  let storageChangedListener = null;
  let nextId = 1;
  const downloads = [];
  const suggestions = [];
  const states = new Map();
  const exists = new Map();
  const storage = {};
  const sessionWrites = [];
  const openedTabs = [];
  const forgotten = new Set();
  const cancelled = [];
  const bytes = new Map();
  let localGetCalls = 0;
  const pendingLocalGets = [];

  const chrome = {
    runtime: {
      id: extensionId,
      lastError: null,
      onMessage: { addListener(listener) { messageListener = listener; } },
    },
    storage: {
      onChanged: { addListener(listener) { storageChangedListener = listener; } },
      local: {
        get(keys, callback) {
          localGetCalls += 1;
          const wanted = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(storage);
          const result = Object.fromEntries(wanted.filter((key) => key in storage).map((key) => [key, storage[key]]));
          if (deferLocalGet) pendingLocalGets.push(() => callback(result));
          else callback(result);
        },
        set(value, callback) { Object.assign(storage, value); callback?.(); },
      },
    },
    downloads: {
      onDeterminingFilename: { addListener(listener) { filenameListener = listener; } },
      onChanged: { addListener(listener) { changedListener = listener; } },
      async download(options) {
        const id = nextId++;
        downloads.push({ id, ...options });
        const isManifest = options.url.startsWith("data:");
        states.set(id, isManifest || completeMediaSynchronously ? "complete" : "in_progress");
        exists.set(id, true);
        filenameListener(
          { id, url: options.url, byExtensionId: extensionId },
          (suggestion) => suggestions.push(suggestion ?? null)
        );
        if (!isManifest && completeMediaSynchronously) {
          changedListener({ id, state: { current: "complete" } });
        }
        return id;
      },
      async search({ id }) {
        if (forgotten.has(id)) return [];
        const progress = bytes.get(id);
        if (progress?.growBy) progress.bytesReceived += progress.growBy;
        const { growBy, ...reported } = progress ?? {};
        return [{ id, state: states.get(id) ?? "in_progress", exists: exists.get(id) !== false, ...reported }];
      },
      async cancel(id) { cancelled.push(id); states.set(id, "interrupted"); },
    },
    tabs: { async create(options) { openedTabs.push(options); return { id: 50, ...options }; } },
  };
  if (withSessionStorage) {
    chrome.storage.session = {
      get(key, callback) { callback(key in storage ? { [key]: storage[key] } : {}); },
      set(value, callback) {
        sessionWrites.push(structuredClone(value));
        Object.assign(storage, value);
        callback?.();
      },
    };
  }

  return {
    chrome,
    downloads,
    suggestions,
    openedTabs,
    sessionWrites,
    cancelled,
    get localGetCalls() { return localGetCalls; },
    get filenameListener() { return filenameListener; },
    async message(message) {
      return new Promise((resolve) => {
        const asyncResult = messageListener(message, null, resolve);
        assert.equal(asyncResult, true);
      });
    },
    change(id, state, error = null) {
      states.set(id, state);
      changedListener({ id, state: { current: state }, error: error ? { current: error } : undefined });
    },
    remove(id) { exists.set(id, false); },
    forget(id) { forgotten.add(id); },
    setBytes(id, value) { bytes.set(id, value); },
    setLocal(key, value) {
      const oldValue = storage[key];
      storage[key] = value;
      storageChangedListener?.({ [key]: { oldValue, newValue: value } }, "local");
    },
    flushLocalGets() {
      for (const respond of pendingLocalGets.splice(0)) respond();
    },
  };
}

/** Leaves a job's only media stuck as an unsettled download, the way a killed
 * worker or a cleared download history does. Since schema v5 these entries live
 * in the jobMedia store rather than inside the job document. */
function strandMedia(database, jobId, { downloadId, updatedAt }) {
  const entry = [...database.jobMedia.values()].find((item) => item.jobId === jobId);
  database.jobMedia.set(entry.key, { ...entry, state: "pending", downloadId, updatedAt });
  return entry.mediaKey;
}

/** A job's posts in the order the ledger assembles them. Since schema v6 they
 * live one record per post in the jobPosts store, so that concurrent download
 * workers cannot overwrite each other's append. */
function persistedPosts(database, jobId) {
  return [...database.jobPosts.values()]
    .filter((entry) => entry.jobId === jobId)
    .sort((left, right) =>
      left.seq === right.seq ? left.tweetId.localeCompare(right.tweetId) : left.seq.localeCompare(right.seq))
    .map((entry) => entry.post);
}

async function loadWorker(mock, label) {
  MemoryLedgerStore.databases.clear();
  globalThis.__XMC_LEDGER_FACTORY__ = createMemoryLedgerFactory();
  globalThis.chrome = mock.chrome;
  await import(`../sw.js?${label}=${Date.now()}-${Math.random()}`);
}

const post = {
  tweetId: "123",
  tweetUrl: "https://x.com/alice/status/123",
  text: "日本語の投稿本文",
  createdAt: "2026-08-11T00:00:00.000Z",
  profileMetadataStatus: "observed",
  author: { id: "42", screenName: "alice", displayName: "Alice", bio: "Support links", urls: ["https://example.invalid/fanbox"] },
  media: [{
    mediaKey: "3_photo",
    ordinal: 1,
    type: "photo",
    extension: "jpg",
    sourceUrl: "https://pbs.twimg.com/media/a.jpg",
  }],
};

test("settings reads are single-flight cached and external changes invalidate the cache", async () => {
  const mock = createChromeMock("xmc-settings-cache");
  await loadWorker(mock, "settings-cache");

  const first = await Promise.all(Array.from({ length: 20 }, () => mock.message({ type: "xmc:settings:get" })));
  assert.equal(mock.localGetCalls, 1);
  assert.ok(first.every((response) => response.settings.integrationEnabled === true));

  mock.setLocal("xmcSettings", { integrationEnabled: false });
  const second = await Promise.all(Array.from({ length: 20 }, () => mock.message({ type: "xmc:settings:get" })));
  assert.equal(mock.localGetCalls, 2);
  assert.ok(second.every((response) => response.settings.integrationEnabled === false));

  const written = await mock.message({ type: "xmc:settings:set", settings: { integrationEnabled: true } });
  assert.equal(written.settings.integrationEnabled, true);
  const afterWrite = await mock.message({ type: "xmc:settings:get" });
  assert.equal(afterWrite.settings.integrationEnabled, true);
  assert.equal(mock.localGetCalls, 2, "the successful write seeds the new cache generation");
});

test("a settings read invalidated in flight cannot overwrite the newer cache generation", async () => {
  const mock = createChromeMock("xmc-settings-generation", { deferLocalGet: true });
  await loadWorker(mock, "settings-generation");

  const stale = mock.message({ type: "xmc:settings:get" });
  assert.equal(mock.localGetCalls, 1);
  mock.setLocal("xmcSettings", { integrationEnabled: false });
  const fresh = mock.message({ type: "xmc:settings:get" });
  assert.equal(mock.localGetCalls, 2);
  mock.flushLocalGets();

  assert.equal((await stale).settings.integrationEnabled, true, "the original caller receives its original snapshot");
  assert.equal((await fresh).settings.integrationEnabled, false);
  const cached = mock.message({ type: "xmc:settings:get" });
  assert.equal(mock.localGetCalls, 2, "the stale promise did not evict the newer cached value");
  assert.equal((await cached).settings.integrationEnabled, false);
});

test("manual save stages once, settles through onChanged, and leaves import to an explicit Companion action", async () => {
  const mock = createChromeMock("xmc-test", { completeMediaSynchronously: true });
  await loadWorker(mock, "manual");

  const response = await mock.message({ type: "xmc:save-post", request: { mode: "manual", jobId: null, post } });
  assert.equal(response.ok, true);
  assert.equal(response.downloadIds.length, 1);
  assert.match(mock.downloads[0].filename, /^XMediaClone\/_jobs\/[0-9a-f-]+\/media\/123-01-3_photo\.jpg$/);
  assert.equal(mock.downloads[0].conflictAction, "uniquify");
  assert.deepEqual(mock.suggestions[0], { filename: mock.downloads[0].filename, conflictAction: "uniquify" });
  assert.equal(mock.openedTabs.length, 0);
  const savedPosts = persistedPosts(MemoryLedgerStore.databases.get("xmc-media-ledger"), response.jobId);
  assert.equal(savedPosts[0].profileMetadataStatus, "observed");
  assert.equal(savedPosts[0].author.bio, "Support links");
  assert.deepEqual(savedPosts[0].author.urls, ["https://example.invalid/fanbox"]);
  assert.equal(mock.downloads.filter((item) => item.url.startsWith("data:")).length >= 2, true);
  for (const item of mock.downloads.filter((entry) => entry.url.startsWith("data:"))) {
    const encoded = item.url.split(",", 2)[1];
    assert.doesNotThrow(() => JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
    assert.match(item.filename, /\/_manifest\/z-\d{13}-[0-9a-f-]+\/(manifest-\d{4}|complete)\.json$/);
  }

  const status = await mock.message({ type: "xmc:ledger:tweet-status", tweetId: "123" });
  assert.equal(status.allComplete, false);

  // Suppression is a bulk concern: a manual click always fetches (covered
  // separately), so the skip-and-reopen path is exercised through bulk.
  const bulkJob = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  const duplicate = await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: bulkJob.jobId, post } });
  assert.equal(duplicate.allComplete, false);
  assert.equal(duplicate.downloadIds.length, 0);
  assert.deepEqual(duplicate.reopenedJobIds, [response.jobId]);
  assert.equal(mock.openedTabs.length, 0);
  assert.equal(mock.downloads.filter((item) => item.url.startsWith("https://pbs")).length, 1);

  mock.remove(response.downloadIds[0]);
  const committed = await mock.message({ type: "xmc:ledger:tweet-status", tweetId: "123" });
  assert.equal(committed.allComplete, true);
  const archivedJob = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  const archivedDuplicate = await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: archivedJob.jobId, post } });
  assert.equal(archivedDuplicate.allComplete, true);
  assert.equal(archivedDuplicate.reopenedJobIds.length, 0);
  assert.equal(mock.downloads.filter((item) => item.url.startsWith("https://pbs")).length, 1);
});

test("a completion event racing downloadId persistence is reconciled immediately", async () => {
  const mock = createChromeMock("xmc-race-test", { completeMediaSynchronously: true });
  await loadWorker(mock, "race");
  const response = await mock.message({ type: "xmc:save-post", request: { mode: "manual", jobId: null, retryFailed: true, post } });
  assert.equal(response.ok, true);
  const status = await mock.message({ type: "xmc:ledger:tweet-status", tweetId: "123" });
  assert.equal(status.allComplete, false);
  assert.equal(mock.openedTabs.length, 0);
});

test("pre-atomic false complete is downgraded to staged and reopens its existing job", async () => {
  const mock = createChromeMock("xmc-pre-atomic-test", { completeMediaSynchronously: true });
  await loadWorker(mock, "pre-atomic");
  const first = await mock.message({ type: "xmc:save-post", request: { mode: "manual", jobId: null, retryFailed: true, post } });
  const database = MemoryLedgerStore.databases.get("xmc-media-ledger");
  const record = database.records.get("3_photo");
  database.records.set("3_photo", { ...record, state: "complete", receiptId: null });

  const status = await mock.message({ type: "xmc:ledger:tweet-status", tweetId: "123" });
  assert.equal(status.allComplete, false);
  const exported = await mock.message({ type: "xmc:ledger:export" });
  assert.equal(exported.ledger.records[0].state, "staged");

  const job = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  const retry = await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: job.jobId, retryFailed: true, post } });
  assert.deepEqual(retry.reopenedJobIds, [first.jobId], "the staged job is reopened rather than re-fetched");
  assert.equal(mock.downloads.filter((item) => item.url.startsWith("https://pbs")).length, 1);
});

test("staged record with a missing job becomes retryable instead of blocking forever", async () => {
  const mock = createChromeMock("xmc-missing-job-test", { completeMediaSynchronously: true });
  await loadWorker(mock, "missing-job");
  const first = await mock.message({ type: "xmc:save-post", request: { mode: "manual", jobId: null, retryFailed: true, post } });
  const database = MemoryLedgerStore.databases.get("xmc-media-ledger");
  database.jobs.delete(first.jobId);

  const retry = await mock.message({ type: "xmc:save-post", request: { mode: "manual", jobId: null, retryFailed: true, post } });
  assert.equal(retry.ok, true);
  assert.notEqual(retry.jobId, first.jobId);
  assert.equal(retry.downloadIds.length, 1);
  assert.equal(mock.downloads.filter((item) => item.url.startsWith("https://pbs")).length, 2);
});

test("duplicate media keys and ordinals are rejected before download", async () => {
  const mock = createChromeMock("xmc-invalid-test");
  await loadWorker(mock, "invalid");
  const duplicate = { ...post, media: [post.media[0], { ...post.media[0], sourceUrl: "https://pbs.twimg.com/media/b.jpg" }] };
  const response = await mock.message({ type: "xmc:save-post", request: { mode: "manual", jobId: null, retryFailed: true, post: duplicate } });
  assert.equal(response.ok, false);
  assert.match(response.error, /unique/);
  assert.equal(mock.downloads.length, 0);
});

test("service worker synchronously leaves another extension's download untouched", async () => {
  const mock = createChromeMock("xmc-other-test");
  await loadWorker(mock, "foreign");
  let callCount = 0;
  let argumentCount = -1;
  mock.filenameListener(
    { url: "https://example.com/file.jpg", byExtensionId: "another-extension" },
    function () { callCount += 1; argumentCount = arguments.length; }
  );
  assert.equal(callCount, 1);
  assert.equal(argumentCount, 0);
});

test("large data manifest URLs never enter persistent filename claims", async () => {
  const mock = createChromeMock("xmc-session-test", { completeMediaSynchronously: true, withSessionStorage: true });
  await loadWorker(mock, "session-claims");
  const response = await mock.message({ type: "xmc:save-post", request: { mode: "manual", jobId: null, post } });
  assert.equal(response.ok, true);
  assert.equal(mock.sessionWrites.length > 0, true);
  for (const write of mock.sessionWrites) {
    const claims = write.xmcFilenameClaims ?? {};
    assert.equal(Object.keys(claims).some((url) => url.startsWith("data:")), false);
  }
  assert.equal(mock.suggestions.filter((suggestion) => suggestion?.filename?.includes("/_manifest/")).length >= 2, true);
});

test("a bulk job whose session never finalized is published by recovery", async () => {
  // The tab closed, or the finalize message was lost while the worker slept.
  // Every download settled, but nothing ever asked the job to close, so it sat
  // in Downloads with its media staged and the consumer never saw it exist.
  const mock = createChromeMock("xmc-abandoned", { completeMediaSynchronously: true });
  await loadWorker(mock, "abandoned");
  const created = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: created.jobId, post } });

  const jobs = MemoryLedgerStore.databases.get("xmc-media-ledger").jobs;
  const staged = jobs.get(created.jobId);
  assert.equal(staged.state, "downloading", "no finalize was ever requested");
  assert.equal(staged.finalizeRequested, false);
  assert.equal(mock.downloads.filter((item) => item.url.startsWith("data:")).length, 0, "nothing is published yet");

  // Backdate it past the abandonment threshold; an active session would have
  // touched it far more recently than this.
  jobs.set(created.jobId, { ...staged, updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  await import(`../sw.js?recover=${Date.now()}-${Math.random()}`);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(jobs.get(created.jobId).state, "published");
  const manifest = mock.downloads.filter((item) => item.url.startsWith("data:"));
  assert.ok(manifest.length >= 2, "the manifest chunks and complete marker are written");
  assert.match(manifest.at(-1).filename, /\/_manifest\/z-\d{13}-[0-9a-f-]+\/complete\.json$/);
});

test("a reserved download that never started stops holding its job open", async () => {
  const mock = createChromeMock("xmc-orphan", { completeMediaSynchronously: true });
  await loadWorker(mock, "orphan");
  const created = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: created.jobId, post } });

  // Chrome has no record of a download whose ID was never persisted, so no
  // event will ever settle it and the job can never reach its threshold.
  const database = MemoryLedgerStore.databases.get("xmc-media-ledger");
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const key = strandMedia(database, created.jobId, { downloadId: null, updatedAt: old });
  database.jobs.set(created.jobId, { ...database.jobs.get(created.jobId), finalizeRequested: true, state: "downloading", updatedAt: old });
  await import(`../sw.js?orphan-recover=${Date.now()}-${Math.random()}`);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const recovered = database.jobs.get(created.jobId);
  const media = [...database.jobMedia.values()].find((item) => item.jobId === created.jobId && item.mediaKey === key);
  assert.equal(recovered.state, "published", "the job closes instead of waiting forever");
  assert.equal(media.state, "failed");
  assert.match(media.error, /interrupted before it started/);
});

test("a pending download Chrome no longer knows about stops holding its job open", async () => {
  const mock = createChromeMock("xmc-forgotten", { completeMediaSynchronously: true });
  await loadWorker(mock, "forgotten");
  const created = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: created.jobId, post } });

  // search() answers for IDs it has never seen too, so drop the record the way
  // a cleared download history does.
  const database = MemoryLedgerStore.databases.get("xmc-media-ledger");
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const key = strandMedia(database, created.jobId, { downloadId: 9999, updatedAt: old });
  database.jobs.set(created.jobId, { ...database.jobs.get(created.jobId), finalizeRequested: true, state: "downloading", updatedAt: old });
  mock.forget(9999);
  await import(`../sw.js?forgotten-recover=${Date.now()}-${Math.random()}`);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const recovered = database.jobs.get(created.jobId);
  const media = [...database.jobMedia.values()].find((item) => item.jobId === created.jobId && item.mediaKey === key);
  assert.equal(recovered.state, "published");
  assert.equal(media.state, "failed");
  assert.match(media.error, /no record of it/);
});

test("a job recovery cannot finish does not block the jobs behind it", async () => {
  // A job left in a state publish rejects used to throw out of the recovery
  // loop on every startup, so every job behind it was never reached -- which
  // is how a finished bulk of 912 media stayed unpublished for hours.
  const mock = createChromeMock("xmc-blocked", { completeMediaSynchronously: true });
  await loadWorker(mock, "blocked");
  const stuck = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: stuck.jobId, post } });
  const later = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: later.jobId, post: { ...post, tweetId: "999", media: [{ ...post.media[0], mediaKey: "3_second" }] } } });

  const jobs = MemoryLedgerStore.databases.get("xmc-media-ledger").jobs;
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  // createdAt ordering decides which job recovery reaches first.
  jobs.set(stuck.jobId, { ...jobs.get(stuck.jobId), createdAt: "2000-01-01T00:00:00.000Z", updatedAt: old, media: {} , posts: [] });
  jobs.set(later.jobId, { ...jobs.get(later.jobId), updatedAt: old });
  // A job with no posts and no media is skipped, so force the throwing path.
  jobs.set(stuck.jobId, { ...jobs.get(stuck.jobId), state: "finalizing", posts: [post] });
  const failing = jobs.get(stuck.jobId);
  Object.defineProperty(failing, "mode", { value: "not-a-mode", enumerable: true });

  await import(`../sw.js?blocked-recover=${Date.now()}-${Math.random()}`);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(jobs.get(later.jobId).state, "published", "the job behind the broken one still recovers");
});

test("a job whose staged bytes are gone is discarded instead of published", async () => {
  // Deleting staging normally means the importer took it, but a job that was
  // never published was never offered to the importer. Publishing its manifest
  // would archive a post whose every media is missing, and leaving the record
  // staged would let the next save read the absent file as proof of success
  // and suppress the download for good.
  const mock = createChromeMock("xmc-undeliverable", { completeMediaSynchronously: true });
  await loadWorker(mock, "undeliverable");
  const created = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  const saved = await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: created.jobId, post } });

  const database = MemoryLedgerStore.databases.get("xmc-media-ledger");
  const job = database.jobs.get(created.jobId);
  database.jobs.set(created.jobId, { ...job, updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  mock.remove(saved.downloadIds[0]);

  await import(`../sw.js?undeliverable-recover=${Date.now()}-${Math.random()}`);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(database.jobs.get(created.jobId).state, "published", "the job is closed");
  assert.equal(mock.downloads.filter((item) => item.url.startsWith("data:")).length, 0, "no manifest describes files that are gone");
  assert.equal(database.records.get("3_photo").state, "missing", "so the post can simply be saved again");

  // buildSavePostRequest always sets retryFailed, which is what lets a missing
  // record be reserved again.
  const retry = await mock.message({ type: "xmc:save-post", request: { mode: "manual", jobId: null, retryFailed: true, post } });
  assert.equal(retry.downloadIds.length, 1, "the re-download is no longer suppressed");
});

test("a forced save re-fetches media the ledger counts as saved", async () => {
  // The vault lost a file the ledger still calls complete, and nothing tells
  // the ledger that. Without an explicit override those media are unreachable
  // forever -- which is how 1007 images became unrecoverable.
  const mock = createChromeMock("xmc-forced", { completeMediaSynchronously: true });
  await loadWorker(mock, "forced");
  const first = await mock.message({ type: "xmc:save-post", request: { mode: "manual", jobId: null, post } });
  assert.equal(first.downloadIds.length, 1);
  mock.remove(first.downloadIds[0]);
  const media = () => mock.downloads.filter((item) => item.url.startsWith("https://pbs")).length;
  assert.equal(media(), 1);

  const skipJob = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  const suppressed = await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: skipJob.jobId, retryFailed: true, post } });
  assert.equal(suppressed.downloadIds.length, 0, "bulk suppresses it as usual");
  assert.equal(media(), 1);

  const forcedJob = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  const forced = await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: forcedJob.jobId, retryFailed: true, forceRedownload: true, post } });
  assert.equal(forced.downloadIds.length, 1, "the override reaches the reservation");
  assert.equal(media(), 2);
});

test("a manual save always fetches, even for media the ledger calls complete", async () => {
  // The ledger cannot see that the vault lost a file, so refusing a deliberate
  // click leaves no way to get it back. Bulk keeps the suppression.
  const mock = createChromeMock("xmc-manual-force", { completeMediaSynchronously: true });
  await loadWorker(mock, "manual-force");
  const first = await mock.message({ type: "xmc:save-post", request: { mode: "manual", jobId: null, post } });
  assert.equal(first.downloadIds.length, 1);
  mock.remove(first.downloadIds[0]);
  const media = () => mock.downloads.filter((item) => item.url.startsWith("https://pbs")).length;
  assert.equal(media(), 1);

  const again = await mock.message({ type: "xmc:save-post", request: { mode: "manual", jobId: null, post } });
  assert.equal(again.downloadIds.length, 1, "the second click fetches too");
  assert.equal(media(), 2);

  const job = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  const bulk = await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: job.jobId, post } });
  assert.equal(bulk.downloadIds.length, 0, "bulk still skips what it has");
  assert.equal(media(), 2);
});

test("a reply-tree job publishes archived and text-only posts without redundant media downloads", async () => {
  const mock = createChromeMock("xmc-reply-tree", { completeMediaSynchronously: true });
  await loadWorker(mock, "reply-tree");
  const first = await mock.message({ type: "xmc:save-post", request: { mode: "manual", jobId: null, post } });
  mock.remove(first.downloadIds[0]);
  await mock.message({ type: "xmc:ledger:tweet-status", tweetId: post.tweetId });
  const mediaDownloads = () => mock.downloads.filter((item) => item.url.startsWith("https://pbs")).length;

  const created = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  const root = { ...post, conversationId: "123", replyTree: { rootTweetId: "123", previousTweetId: null, nextTweetId: "124", position: 1, size: 2, partial: false } };
  const textOnly = {
    ...post, tweetId: "124", tweetUrl: "https://x.com/alice/status/124", text: "part two", media: [],
    replyTree: { rootTweetId: "123", previousTweetId: "123", nextTweetId: null, position: 2, size: 2, partial: false },
  };
  assert.equal((await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: created.jobId, includePostWhenMediaSkipped: true, post: root } })).ok, true);
  assert.equal((await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: created.jobId, includePostWhenMediaSkipped: true, post: textOnly } })).ok, true);
  assert.equal(mediaDownloads(), 1, "the already-archived root is not fetched again");
  assert.equal((await mock.message({ type: "xmc:job:finalize", jobId: created.jobId })).ok, true);
  const savedPosts = persistedPosts(MemoryLedgerStore.databases.get("xmc-media-ledger"), created.jobId);
  assert.deepEqual(savedPosts.map((item) => item.tweetId), ["123", "124"]);
  assert.equal(savedPosts[0].media[0].downloadState, "skipped");
  assert.equal(savedPosts[0].conversationId, "123");
  assert.deepEqual(savedPosts[1].media, []);
  assert.equal(savedPosts[1].replyTree.previousTweetId, "123");
});

/** The ArchiveJob a run actually published, decoded back out of the manifest
 * chunk downloads. Asserting here rather than on the ledger is the point: the
 * manifest is the only thing Companion ever reads, so a post that survives in
 * the ledger but never reaches a chunk is still a lost post. */
function publishedManifest(mock, jobId) {
  const chunks = mock.downloads
    .filter((item) => item.url.startsWith("data:") && item.filename.includes(`/_jobs/${jobId}/_manifest/`))
    .map((item) => JSON.parse(Buffer.from(item.url.split(",", 2)[1], "base64").toString("utf8")))
    .filter((record) => record.kind === "archive-job-chunk")
    .sort((left, right) => left.chunkIndex - right.chunkIndex);
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.from(chunks.map((chunk) => chunk.payload).join(""), "base64").toString("utf8"));
}

/* The bulk engine runs one download worker per "max concurrent downloads" and
 * people run it at 10-20. While a job's posts lived in one document that each
 * savePost read, mutated and wrote back, those workers overwrote each other:
 * a measured run downloaded 560 posts and published 196 of them, with the rest
 * left as orphaned files in staging and the job still reporting complete. */
test("a bulk job publishes every post its concurrent workers saved", async () => {
  const mock = createChromeMock("xmc-bulk-concurrent", { completeMediaSynchronously: true });
  await loadWorker(mock, "bulk-concurrent");
  const created = await mock.message({ type: "xmc:job:create", mode: "bulk" });

  const tweetIds = Array.from({ length: 20 }, (_, index) => String(2000 + index));
  const responses = await Promise.all(tweetIds.map((tweetId) => mock.message({
    type: "xmc:save-post",
    request: {
      mode: "bulk",
      jobId: created.jobId,
      post: {
        ...post,
        tweetId,
        tweetUrl: `https://x.com/alice/status/${tweetId}`,
        media: [{ ...post.media[0], mediaKey: `3_photo_${tweetId}` }],
      },
    },
  })));
  assert.deepEqual(responses.map((item) => item.ok), tweetIds.map(() => true));

  const finalized = await mock.message({ type: "xmc:job:finalize", jobId: created.jobId });
  assert.equal(finalized.ok, true);
  assert.equal(finalized.orphanedMedia, 0, "every downloaded media is accounted for by a post");

  const manifest = publishedManifest(mock, created.jobId);
  assert.deepEqual([...manifest.posts.map((item) => item.tweetId)].sort(), [...tweetIds].sort());
});

/* The guard that would have surfaced the loss above while it was happening. */
test("media downloaded without a post to carry it is reported at finalize", async () => {
  const mock = createChromeMock("xmc-orphan-guard", { completeMediaSynchronously: true });
  await loadWorker(mock, "orphan-guard");
  const created = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  assert.equal((await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: created.jobId, post } })).ok, true);

  // Drop the post the way a lost append did, leaving its completed media behind.
  const database = MemoryLedgerStore.databases.get("xmc-media-ledger");
  for (const entry of [...database.jobPosts.values()]) {
    if (entry.jobId === created.jobId) database.jobPosts.delete(entry.key);
  }

  const finalized = await mock.message({ type: "xmc:job:finalize", jobId: created.jobId });
  assert.equal(finalized.ok, true);
  assert.equal(finalized.orphanedMedia, 1);
  assert.match(database.jobs.get(created.jobId).error, /missing from the manifest/);
});

/** Puts a settled media back to how a run looks when Chrome's completion event
 * never reached the worker: the download really did finish, but both the ledger
 * record and the job entry still call it pending. `strandMedia` alone is not
 * enough -- it leaves the record's download ID untouched, so nothing would
 * match when the ID is asked about again. */
function unsettleMedia(database, jobId, downloadId) {
  const entry = [...database.jobMedia.values()].find((item) => item.jobId === jobId);
  database.jobMedia.set(entry.key, { ...entry, state: "pending", downloadId, updatedAt: new Date().toISOString() });
  const record = database.records.get(entry.mediaKey);
  database.records.set(entry.mediaKey, { ...record, state: "pending", downloadId });
  return entry.mediaKey;
}

/* Background recovery only looks at jobs idle for ten minutes and only runs
 * when the service worker happens to boot, so a run whose tab was closed sat
 * there with its media downloaded and no manifest at all. Opening the bulk
 * modal now asks for those jobs directly, with no timer and no restart. */
test("an unfinished job is published on demand, without waiting or restarting", async () => {
  const mock = createChromeMock("xmc-finish-pending", { completeMediaSynchronously: true });
  await loadWorker(mock, "finish-pending");
  const created = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  const saved = await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: created.jobId, post } });

  const database = MemoryLedgerStore.databases.get("xmc-media-ledger");
  const key = unsettleMedia(database, created.jobId, saved.downloadIds[0]);
  assert.notEqual(database.jobs.get(created.jobId).state, "published");

  const swept = await mock.message({ type: "xmc:job:finish-pending", exceptJobId: null });
  assert.equal(swept.ok, true);
  assert.deepEqual(swept.published.map((item) => item.jobId), [created.jobId]);
  assert.deepEqual(swept.stuck, []);

  assert.equal(database.jobs.get(created.jobId).state, "published");
  assert.equal([...database.jobMedia.values()].find((item) => item.mediaKey === key).state, "complete");
  assert.deepEqual(publishedManifest(mock, created.jobId).posts.map((item) => item.tweetId), ["123"]);
});

/* Chrome forgetting a download says nothing about whether the file is on disk,
 * and a job of hundreds of finished files must not be thrown away over it.
 * Companion opens the staged files itself and reports what is really missing. */
test("a job whose download records Chrome dropped is still published, not discarded", async () => {
  const mock = createChromeMock("xmc-finish-forgotten", { completeMediaSynchronously: true });
  await loadWorker(mock, "finish-forgotten");
  const created = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  const saved = await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: created.jobId, post } });

  const database = MemoryLedgerStore.databases.get("xmc-media-ledger");
  unsettleMedia(database, created.jobId, saved.downloadIds[0]);
  mock.forget(saved.downloadIds[0]);

  const swept = await mock.message({ type: "xmc:job:finish-pending", exceptJobId: null });
  assert.deepEqual(swept.published.map((item) => item.jobId), [created.jobId]);
  assert.equal(database.jobs.get(created.jobId).state, "published");
  assert.deepEqual(publishedManifest(mock, created.jobId).posts.map((item) => item.tweetId), ["123"]);
});

/* A download Chrome is still running must hold its own job open, and the run
 * the caller is in the middle of must not be closed under it either. */
test("a job that is still downloading is reported rather than published", async () => {
  const mock = createChromeMock("xmc-finish-running");
  await loadWorker(mock, "finish-running");
  const created = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  const saved = await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: created.jobId, post } });
  // Only observed progress keeps a job waiting, so this one has to be moving.
  mock.setBytes(saved.downloadIds[0], { bytesReceived: 1024, totalBytes: 999999, growBy: 2048 });

  const swept = await mock.message({ type: "xmc:job:finish-pending", exceptJobId: null });
  assert.deepEqual(swept.published, []);
  assert.deepEqual(swept.stuck.map((item) => item.reason), ["downloads are still running"]);
  assert.notEqual(MemoryLedgerStore.databases.get("xmc-media-ledger").jobs.get(created.jobId).state, "published");

  const skipped = await mock.message({ type: "xmc:job:finish-pending", exceptJobId: created.jobId });
  assert.deepEqual(skipped.published, []);
  assert.deepEqual(skipped.stuck, []);
});

/* Records expire and get cleared while the files stay on disk, so silence from
 * chrome.downloads must never be read as proof that staging is gone. A run of
 * hundreds of finished files was one such misread away from being discarded. */
test("a job Chrome has simply forgotten is not treated as undeliverable", async () => {
  const mock = createChromeMock("xmc-forgotten-not-gone", { completeMediaSynchronously: true });
  await loadWorker(mock, "forgotten-not-gone");
  const created = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  const saved = await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: created.jobId, post } });

  const database = MemoryLedgerStore.databases.get("xmc-media-ledger");
  const job = database.jobs.get(created.jobId);
  database.jobs.set(created.jobId, { ...job, updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  mock.forget(saved.downloadIds[0]);

  await import(`../sw.js?forgotten-not-gone-recover=${Date.now()}-${Math.random()}`);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(database.jobs.get(created.jobId).state, "published");
  assert.notEqual(database.records.get("3_photo").state, "missing", "the staged bytes are not written off");
  assert.deepEqual(publishedManifest(mock, created.jobId).posts.map((item) => item.tweetId), ["123"]);
});

/* Chrome goes on calling a stalled or orphaned download "in_progress" forever.
 * Refusing to close a job over one of those left a finished sweep of 816 posts
 * with its files on disk and no manifest, and no operation the user could run
 * to get them out. A run nobody is driving does not get to wait indefinitely. */
test("a stalled download does not hold a finished job hostage", async () => {
  const mock = createChromeMock("xmc-stalled");
  await loadWorker(mock, "stalled");
  const created = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  const saved = await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: created.jobId, post } });

  // Nothing settled, and the byte counter has stopped moving between samples.
  mock.setBytes(saved.downloadIds[0], { bytesReceived: 1024, totalBytes: 4096 });

  const database = MemoryLedgerStore.databases.get("xmc-media-ledger");
  const swept = await mock.message({ type: "xmc:job:finish-pending", exceptJobId: null });
  assert.deepEqual(swept.published.map((item) => item.jobId), [created.jobId]);
  assert.deepEqual(mock.cancelled, saved.downloadIds, "the abandoned download is released");
  assert.equal(database.jobs.get(created.jobId).state, "published");

  const media = publishedManifest(mock, created.jobId).posts[0].media[0];
  assert.equal(media.downloadState, "failed");
  assert.match(media.error, /no longer active/);
  assert.notEqual(database.records.get("3_photo").state, "complete", "so it can simply be fetched again");
});

/* Chrome can leave a download it finished writing parked at "in_progress".
 * Cancelling those would throw away files that are complete on disk, so the
 * byte counts decide rather than the label. */
test("a stalled download that received every byte is kept, not cancelled", async () => {
  const mock = createChromeMock("xmc-stalled-complete");
  await loadWorker(mock, "stalled-complete");
  const created = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  const saved = await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: created.jobId, post } });
  mock.setBytes(saved.downloadIds[0], { bytesReceived: 4096, totalBytes: 4096 });

  const database = MemoryLedgerStore.databases.get("xmc-media-ledger");
  const job = database.jobs.get(created.jobId);
  database.jobs.set(created.jobId, { ...job, updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });

  const swept = await mock.message({ type: "xmc:job:finish-pending", exceptJobId: null });
  assert.deepEqual(swept.published.map((item) => item.jobId), [created.jobId]);
  assert.deepEqual(mock.cancelled, [], "a fully received download is never cancelled");
  assert.equal(publishedManifest(mock, created.jobId).posts[0].media[0].downloadState, "complete");
});

/* The media ledger and the job entry are two records that can disagree, and
 * only one thing ever wrote the second: settleDownloadChange, which returns
 * early for any record that is no longer pending. A media that settled by some
 * other route therefore left its job entry pending with nothing able to repair
 * it, and the job never published. Four jobs holding 2,439 posts sat behind
 * eighteen of these, unchanged through every attempt because none of them
 * reached the entry at all. */
test("a job entry left behind by an already-settled media is reconciled from the ledger", async () => {
  const mock = createChromeMock("xmc-desynced", { completeMediaSynchronously: true });
  await loadWorker(mock, "desynced");
  const created = await mock.message({ type: "xmc:job:create", mode: "bulk" });
  await mock.message({ type: "xmc:save-post", request: { mode: "bulk", jobId: created.jobId, post } });

  // The record settled; the job entry never heard about it.
  const database = MemoryLedgerStore.databases.get("xmc-media-ledger");
  const entry = [...database.jobMedia.values()].find((item) => item.jobId === created.jobId);
  database.jobMedia.set(entry.key, { ...entry, state: "pending" });
  database.jobs.set(created.jobId, { ...database.jobs.get(created.jobId), state: "downloading" });
  assert.equal(database.records.get("3_photo").state, "staged", "the media itself is accounted for");

  const swept = await mock.message({ type: "xmc:job:finish-pending", exceptJobId: null });
  assert.deepEqual(swept.stuck, []);
  assert.deepEqual(swept.published.map((item) => item.jobId), [created.jobId]);
  assert.equal(swept.published[0].failedMedia, 0, "nothing is written off to get there");
  assert.equal([...database.jobMedia.values()].find((item) => item.key === entry.key).state, "complete");
  assert.deepEqual(publishedManifest(mock, created.jobId).posts.map((item) => item.tweetId), ["123"]);
});
