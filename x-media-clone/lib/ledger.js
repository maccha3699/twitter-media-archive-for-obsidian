// Durable, media-keyed ledger for X Media Clone.
//
// The browser implementation uses IndexedDB.  The memory store is deliberately
// exported only as a deterministic test/diagnostic adapter; both stores expose
// the same atomic reserve contract.  No record stores media bytes or post text.

export const LEDGER_SCHEMA_VERSION = 1;
// IndexedDB schema versions are independent from individual record versions.
// Version 4 deliberately re-runs schema repair for profiles that reached an
// earlier development version before the persistent jobs store was added.
// Version 5 adds the jobMedia store. Version 6 adds jobPosts for the same
// reason: a job document is one record, so read-modify-write on the array it
// held could not survive concurrent writers. The bulk engine runs one worker
// per "max concurrent downloads" and each appends its own post, so at the
// concurrencies people actually use the later write silently dropped the
// earlier one -- a measured run published 196 of the 560 posts it downloaded.
// Both stores now take one small put per item and never rewrite a sibling.
// Every upgrade step here is additive -- nothing drops or recreates `records`,
// so the suppression table that keeps a bulk run from re-fetching the whole
// archive survives the migration. Jobs written before v5/v6 keep their inline
// media map and posts array and are read back by merging; only new writes go
// to the separate stores.
export const LEDGER_DB_VERSION = 6;
/** IndexedDB has no composite keyPath here, so each pair is joined by a
 * character that cannot occur in a jobId (UUIDv4), a mediaKey, or a tweetId. */
function jobMediaKey(jobId, mediaKey) { return `${jobId}\u0000${mediaKey}`; }
function jobPostKey(jobId, tweetId) { return `${jobId}\u0000${tweetId}`; }
export const LEDGER_STATES = new Set(["pending", "staged", "complete", "failed", "missing", "legacy-unverified"]);
export const JOB_STATES = new Set(["collecting", "downloading", "finalizing", "published", "failed"]);
export const JOB_MEDIA_STATES = new Set(["pending", "complete", "skipped", "failed", "missing"]);

const RECORD_FIELDS = [
  "schemaVersion", "mediaKey", "jobId", "tweetId", "authorId", "state",
  "downloadId", "updatedAt", "createdAt", "error", "receiptId", "stagingRelativePath",
];

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function estimateRecordBytes(record) {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength;
}

function normalizeNullableString(value, name) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string or null`);
  return value;
}

function normalizeDownloadId(value) {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isSafeInteger(value) && typeof value !== "string") throw new TypeError("downloadId must be a safe integer, string, or null");
  return value;
}

function normalizeRecord(input, now) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("ledger record must be an object");
  const state = input.state ?? "pending";
  if (!LEDGER_STATES.has(state)) throw new TypeError("ledger state is unsupported");
  const record = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    mediaKey: assertNonEmptyString(input.mediaKey, "mediaKey"),
    jobId: normalizeNullableString(input.jobId, "jobId"),
    tweetId: normalizeNullableString(input.tweetId, "tweetId"),
    authorId: normalizeNullableString(input.authorId, "authorId"),
    state,
    downloadId: normalizeDownloadId(input.downloadId),
    updatedAt: input.updatedAt ?? now(),
    createdAt: input.createdAt ?? now(),
    error: normalizeNullableString(input.error, "error"),
    receiptId: normalizeNullableString(input.receiptId, "receiptId"),
    stagingRelativePath: normalizeNullableString(input.stagingRelativePath, "stagingRelativePath"),
  };
  if (typeof record.updatedAt !== "string" || typeof record.createdAt !== "string") throw new TypeError("record timestamps must be strings");
  return record;
}

function mergeRecord(previous, patch, now) {
  return normalizeRecord({ ...previous, ...patch, createdAt: previous.createdAt, updatedAt: now() }, now);
}

/**
 * `force` is the user overriding the ledger. Suppression assumes the archive
 * still holds what the ledger says it holds, and nothing tells the ledger when
 * that stops being true -- a vault file deleted, a staging file lost. Without a
 * way to say "fetch it anyway" those media can never be recovered. An
 * in-flight download is still left alone: forcing there would only duplicate
 * work Chrome is already doing.
 */
function reservationResult(record, retry, force = false) {
  if (!record) return null;
  if (retry && record.state === "pending" && record.downloadId === null) return null;
  if (force && record.state !== "pending") return null;
  if (record.state === "complete" || record.state === "pending" || record.state === "staged") {
    return { reserved: false, reason: record.state, record: clone(record) };
  }
  if (!retry) return { reserved: false, reason: "retry-required", record: clone(record) };
  return null;
}

/** In-memory durable-store substitute for Node tests.  Factory instances retain data across opens. */
export class MemoryLedgerStore {
  static databases = new Map();

  constructor(name = "xmc-media-ledger") {
    this.name = name;
    if (!MemoryLedgerStore.databases.has(name)) {
      MemoryLedgerStore.databases.set(name, { records: new Map(), jobs: new Map(), jobMedia: new Map(), jobPosts: new Map(), queue: Promise.resolve() });
    }
    this.database = MemoryLedgerStore.databases.get(name);
  }

  async read(mediaKey) {
    return clone(this.database.records.get(mediaKey) ?? null);
  }

  async reserveAtomic(candidate, retry, force = false) {
    const run = this.database.queue.then(() => {
      const previous = this.database.records.get(candidate.mediaKey);
      const skipped = reservationResult(previous, retry, force);
      if (skipped) return skipped;
      const next = previous ? mergeRecord(previous, candidate, () => candidate.updatedAt) : clone(candidate);
      this.database.records.set(next.mediaKey, next);
      return { reserved: true, reason: previous ? "retried" : "new", record: clone(next) };
    });
    this.database.queue = run.catch(() => undefined);
    return run;
  }

  async write(record) {
    this.database.records.set(record.mediaKey, clone(record));
    return clone(record);
  }

  async byDownloadId(downloadId) {
    const result = [];
    for (const record of this.database.records.values()) if (record.downloadId === downloadId) result.push(clone(record));
    return result;
  }

  async byTweetId(tweetId) {
    const result = [];
    for (const record of this.database.records.values()) if (record.tweetId === tweetId) result.push(clone(record));
    return result;
  }

  async list() {
    return [...this.database.records.values()].map(clone);
  }

  async replaceAll(records) {
    const replacement = new Map(records.map((record) => [record.mediaKey, clone(record)]));
    this.database.records = replacement;
  }

  async readJob(jobId) { return clone(this.database.jobs.get(jobId) ?? null); }

  async writeJob(job) {
    this.database.jobs.set(job.jobId, clone(job));
    return clone(job);
  }

  async listJobs() { return [...this.database.jobs.values()].map(clone); }

  async readJobMedia(jobId) {
    const result = [];
    for (const entry of this.database.jobMedia.values()) if (entry.jobId === jobId) result.push(clone(entry));
    return result;
  }

  async writeJobMediaEntry(entry) {
    this.database.jobMedia.set(entry.key, clone(entry));
  }

  async readJobPosts(jobId) {
    const result = [];
    for (const entry of this.database.jobPosts.values()) if (entry.jobId === jobId) result.push(clone(entry));
    return result;
  }

  async writeJobPostEntry(entry) {
    this.database.jobPosts.set(entry.key, clone(entry));
  }
}

/** A factory that can be injected into MediaLedger in Node tests. */
export function createMemoryLedgerFactory() {
  return { open: async (name) => new MemoryLedgerStore(name) };
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

class IndexedDbLedgerStore {
  constructor(indexedDB, name) {
    if (!indexedDB) throw new Error("IndexedDB is unavailable; provide a ledger factory for this environment");
    this.indexedDB = indexedDB;
    this.name = name;
    this.dbPromise = null;
  }

  async database() {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = this.indexedDB.open(this.name, LEDGER_DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          let store;
          if (!db.objectStoreNames.contains("records")) store = db.createObjectStore("records", { keyPath: "mediaKey" });
          else store = request.transaction.objectStore("records");
          if (!store.indexNames.contains("downloadId")) store.createIndex("downloadId", "downloadId", { unique: false });
          if (!store.indexNames.contains("tweetId")) store.createIndex("tweetId", "tweetId", { unique: false });
          const jobs = db.objectStoreNames.contains("jobs")
            ? request.transaction.objectStore("jobs")
            : db.createObjectStore("jobs", { keyPath: "jobId" });
          if (!jobs.indexNames.contains("state")) jobs.createIndex("state", "state", { unique: false });
          const jobMedia = db.objectStoreNames.contains("jobMedia")
            ? request.transaction.objectStore("jobMedia")
            : db.createObjectStore("jobMedia", { keyPath: "key" });
          if (!jobMedia.indexNames.contains("jobId")) jobMedia.createIndex("jobId", "jobId", { unique: false });
          const jobPosts = db.objectStoreNames.contains("jobPosts")
            ? request.transaction.objectStore("jobPosts")
            : db.createObjectStore("jobPosts", { keyPath: "key" });
          if (!jobPosts.indexNames.contains("jobId")) jobPosts.createIndex("jobId", "jobId", { unique: false });
        };
        request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked; reload other X tabs and retry"));
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("records") || !db.objectStoreNames.contains("jobs")
            || !db.objectStoreNames.contains("jobMedia") || !db.objectStoreNames.contains("jobPosts")) {
            db.close();
            reject(new Error("IndexedDB schema repair did not create required stores"));
            return;
          }
          db.onversionchange = () => { this.dbPromise = null; db.close(); };
          db.onclose = () => { this.dbPromise = null; };
          resolve(db);
        };
        request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      });
      this.dbPromise.catch(() => { this.dbPromise = null; });
    }
    return this.dbPromise;
  }

  async read(mediaKey) {
    const db = await this.database();
    const tx = db.transaction("records", "readonly");
    return (await requestPromise(tx.objectStore("records").get(mediaKey))) ?? null;
  }

  async reserveAtomic(candidate, retry, force = false) {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      const store = tx.objectStore("records");
      let result;
      const getRequest = store.get(candidate.mediaKey);
      getRequest.onsuccess = () => {
        const previous = getRequest.result ?? null;
        const skipped = reservationResult(previous, retry, force);
        if (skipped) {
          result = skipped;
          return;
        }
        const next = previous ? mergeRecord(previous, candidate, () => candidate.updatedAt) : candidate;
        store.put(next);
        result = { reserved: true, reason: previous ? "retried" : "new", record: clone(next) };
      };
      getRequest.onerror = () => tx.abort();
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? getRequest.error ?? new Error("IndexedDB reservation failed"));
      tx.onerror = () => { /* onabort reports the terminal error */ };
    });
  }

  async write(record) {
    const db = await this.database();
    const tx = db.transaction("records", "readwrite");
    await requestPromise(tx.objectStore("records").put(record));
    return clone(record);
  }

  async byDownloadId(downloadId) {
    const db = await this.database();
    const tx = db.transaction("records", "readonly");
    return requestPromise(tx.objectStore("records").index("downloadId").getAll(downloadId));
  }

  async byTweetId(tweetId) {
    const db = await this.database();
    const tx = db.transaction("records", "readonly");
    return requestPromise(tx.objectStore("records").index("tweetId").getAll(tweetId));
  }

  async list() {
    const db = await this.database();
    const tx = db.transaction("records", "readonly");
    return requestPromise(tx.objectStore("records").getAll());
  }

  async replaceAll(records) {
    const db = await this.database();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      const store = tx.objectStore("records");
      const clear = store.clear();
      clear.onsuccess = () => { for (const record of records) store.put(record); };
      clear.onerror = () => tx.abort();
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error ?? clear.error ?? new Error("IndexedDB rebuild failed"));
    });
  }

  async readJob(jobId) {
    const db = await this.database();
    const tx = db.transaction("jobs", "readonly");
    return (await requestPromise(tx.objectStore("jobs").get(jobId))) ?? null;
  }

  async writeJob(job) {
    const db = await this.database();
    const tx = db.transaction("jobs", "readwrite");
    await requestPromise(tx.objectStore("jobs").put(job));
    return clone(job);
  }

  async listJobs() {
    const db = await this.database();
    const tx = db.transaction("jobs", "readonly");
    return requestPromise(tx.objectStore("jobs").getAll());
  }

  async readJobMedia(jobId) {
    const db = await this.database();
    const tx = db.transaction("jobMedia", "readonly");
    return requestPromise(tx.objectStore("jobMedia").index("jobId").getAll(jobId));
  }

  /** One small put, independent of how many posts the job already holds. */
  async writeJobMediaEntry(entry) {
    const db = await this.database();
    const tx = db.transaction("jobMedia", "readwrite");
    await requestPromise(tx.objectStore("jobMedia").put(entry));
  }

  async readJobPosts(jobId) {
    const db = await this.database();
    const tx = db.transaction("jobPosts", "readonly");
    return requestPromise(tx.objectStore("jobPosts").index("jobId").getAll(jobId));
  }

  /** One small put per post. Concurrent download workers each write their own
   * record, so none of them can overwrite a sibling's. */
  async writeJobPostEntry(entry) {
    const db = await this.database();
    const tx = db.transaction("jobPosts", "readwrite");
    await requestPromise(tx.objectStore("jobPosts").put(entry));
  }
}

function normalizeJob(input, now) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("job must be an object");
  const state = input.state ?? "collecting";
  if (!JOB_STATES.has(state)) throw new TypeError("job state is unsupported");
  const mode = input.mode;
  if (mode !== "manual" && mode !== "bulk") throw new TypeError("job mode must be manual or bulk");
  const media = input.media && typeof input.media === "object" && !Array.isArray(input.media) ? input.media : {};
  const normalizedMedia = {};
  for (const [mediaKey, item] of Object.entries(media)) {
    if (!item || typeof item !== "object" || !JOB_MEDIA_STATES.has(item.state ?? "pending")) throw new TypeError(`job media ${mediaKey} has an unsupported state`);
    normalizedMedia[mediaKey] = {
      mediaKey: assertNonEmptyString(mediaKey, "mediaKey"),
      downloadId: normalizeDownloadId(item.downloadId),
      state: item.state ?? "pending",
      error: normalizeNullableString(item.error, "error"),
      updatedAt: item.updatedAt ?? now(),
    };
  }
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    jobId: assertNonEmptyString(input.jobId, "jobId"),
    mode,
    state,
    createdAt: input.createdAt ?? now(),
    updatedAt: input.updatedAt ?? now(),
    // Not deep-cloned: every caller builds a fresh array from a job it already
    // owns, and both stores copy on write anyway (structuredClone in memory,
    // structured serialization in IndexedDB). Cloning here meant every append
    // and every state change re-cloned the entire post history, which is most
    // of what made a long bulk run slow down as it went.
    posts: Array.isArray(input.posts) ? input.posts : [],
    media: normalizedMedia,
    finalizeRequested: input.finalizeRequested === true,
    error: normalizeNullableString(input.error, "error"),
  };
}

/**
 * IndexedDB-backed media ledger.  Failed/missing/legacy records deliberately
 * do not suppress downloads: callers must pass { retry: true } to reserve them.
 */
export class MediaLedger {
  constructor({ dbName = "xmc-media-ledger", factory = null, indexedDB = globalThis.indexedDB, now = () => new Date().toISOString() } = {}) {
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.dbName = dbName;
    this.now = now;
    this.storePromise = factory ? Promise.resolve(factory.open(dbName)) : Promise.resolve(new IndexedDbLedgerStore(indexedDB, dbName));
  }

  async store() { return this.storePromise; }

  async get(mediaKey) {
    return (await this.store()).read(assertNonEmptyString(mediaKey, "mediaKey"));
  }

  async reserve(input, { retry = false, force = false } = {}) {
    const candidate = normalizeRecord({ ...input, state: "pending", updatedAt: this.now(), createdAt: input?.createdAt ?? this.now() }, this.now);
    return (await this.store()).reserveAtomic(candidate, retry, force);
  }

  async update(mediaKey, patch) {
    const key = assertNonEmptyString(mediaKey, "mediaKey");
    const store = await this.store();
    const previous = await store.read(key);
    if (!previous) throw new Error(`cannot update missing ledger record: ${key}`);
    return store.write(mergeRecord(previous, { ...patch, mediaKey: key }, this.now));
  }

  async markComplete(mediaKey, details = {}) {
    return this.update(mediaKey, { ...details, state: "complete", error: null });
  }

  async markStaged(mediaKey, details = {}) {
    return this.update(mediaKey, { ...details, state: "staged", error: null, receiptId: null });
  }

  async markFailed(mediaKey, error, details = {}) {
    return this.update(mediaKey, { ...details, state: "failed", error: typeof error === "string" ? error : String(error ?? "download failed") });
  }

  async markMissing(mediaKey, details = {}) {
    return this.update(mediaKey, { ...details, state: "missing" });
  }

  async findByDownloadId(downloadId) {
    return (await this.store()).byDownloadId(downloadId);
  }

  async findByTweetId(tweetId) {
    return (await this.store()).byTweetId(assertNonEmptyString(tweetId, "tweetId"));
  }

  async stats() {
    const records = await (await this.store()).list();
    const byState = Object.fromEntries([...LEDGER_STATES].map((state) => [state, 0]));
    let estimatedBytes = 0;
    for (const record of records) {
      byState[record.state] = (byState[record.state] ?? 0) + 1;
      estimatedBytes += estimateRecordBytes(record);
    }
    return { count: records.length, estimatedBytes, byState };
  }

  async export() {
    const records = await (await this.store()).list();
    records.sort((left, right) => left.mediaKey.localeCompare(right.mediaKey));
    return { schemaVersion: LEDGER_SCHEMA_VERSION, exportedAt: this.now(), records };
  }

  /** Replace this ledger from compact Vault receipt data; it never reads media files. */
  async rebuildFromReceipts(receipts) {
    if (!Array.isArray(receipts)) throw new TypeError("receipts must be an array");
    const byKey = new Map();
    for (const receipt of receipts) {
      const jobId = receipt?.jobId ?? receipt?.archiveJobId ?? null;
      const posts = Array.isArray(receipt?.posts) ? receipt.posts : [receipt];
      for (const post of posts) {
        const media = Array.isArray(post?.media) ? post.media : [];
        for (const item of media) {
          if (!item || typeof item.mediaKey !== "string" || item.mediaKey === "") continue;
          const receiptState = item.state ?? item.downloadState ?? "complete";
          const state = receiptState === "skipped" ? "complete" : receiptState === "partial" ? "failed" : receiptState;
          if (!LEDGER_STATES.has(state)) continue;
          byKey.set(item.mediaKey, normalizeRecord({
            mediaKey: item.mediaKey,
            jobId: item.jobId ?? jobId,
            tweetId: item.tweetId ?? post.tweetId ?? null,
            authorId: item.authorId ?? post.authorId ?? null,
            downloadId: item.downloadId ?? null,
            state,
            receiptId: receipt?.receiptId ?? receipt?.jobId ?? null,
            stagingRelativePath: item.stagingRelativePath ?? null,
            error: item.error ?? null,
            createdAt: item.createdAt ?? this.now(),
            updatedAt: this.now(),
          }, this.now));
        }
      }
    }
    await (await this.store()).replaceAll([...byKey.values()]);
    return { rebuilt: byKey.size };
  }

  /** Import old xmcHistory entries as non-suppressing, explicitly-unverified records. */
  async migrateLegacyHistory(history) {
    if (!Array.isArray(history)) throw new TypeError("xmcHistory must be an array");
    const store = await this.store();
    let imported = 0;
    for (const entry of history) {
      const source = typeof entry === "string" ? { tweetId: entry } : entry;
      if (!source || typeof source !== "object") continue;
      const legacyId = source.mediaKey ?? source.tweetId ?? source.id;
      if (typeof legacyId !== "string" || legacyId.trim() === "") continue;
      const mediaKey = source.mediaKey ?? `legacy:${legacyId}`;
      if (await store.read(mediaKey)) continue;
      await store.write(normalizeRecord({
        mediaKey,
        tweetId: source.tweetId ?? legacyId,
        jobId: null,
        state: "legacy-unverified",
        createdAt: this.now(),
        updatedAt: this.now(),
      }, this.now));
      imported += 1;
    }
    return { imported };
  }

  /** Create (or idempotently return) the persistent manifest job state. */
  async createJob({ jobId, mode, createdAt = this.now() }) {
    const store = await this.store();
    const current = await store.readJob(assertNonEmptyString(jobId, "jobId"));
    if (current) return current;
    return store.writeJob(normalizeJob({ jobId, mode, createdAt, state: "collecting", updatedAt: this.now() }, this.now));
  }

  /** Job documents written before schema v5 carry their media inline; newer
   * updates live in the jobMedia store. This is the merged map callers expect.
   *
   * Only ever used for reading. Writing it back into the document would
   * re-inline every entry and undo the split, so the write paths below keep
   * passing the document's own `media` through untouched.
   */
  async #mergedJobMedia(store, job) {
    const entries = await store.readJobMedia(job.jobId);
    if (entries.length === 0) return job.media;
    const media = { ...job.media };
    for (const entry of entries) {
      media[entry.mediaKey] = { mediaKey: entry.mediaKey, downloadId: entry.downloadId, state: entry.state, error: entry.error, updatedAt: entry.updatedAt };
    }
    return media;
  }

  /** The posts counterpart of #mergedJobMedia: documents written before v6
   * carry their posts inline, newer appends live in the jobPosts store. A
   * tweet present in both takes the stored copy, because that is the one a
   * retry rewrote. Never written back into the document -- doing so would
   * re-inline the posts and reopen the race the split exists to close. */
  async #mergedJobPosts(store, job) {
    const entries = await store.readJobPosts(job.jobId);
    if (entries.length === 0) return job.posts;
    const posts = new Map();
    for (const post of job.posts) {
      if (post && typeof post.tweetId === "string") posts.set(post.tweetId, post);
    }
    // Appends race by design, so their write order is not their arrival order.
    // Sorting by the recorded instant, then by tweetId to break the ties two
    // workers landing in the same millisecond produce, keeps a job's manifest
    // stable across reads.
    entries.sort((left, right) =>
      left.seq === right.seq ? left.tweetId.localeCompare(right.tweetId) : left.seq.localeCompare(right.seq));
    for (const entry of entries) posts.set(entry.tweetId, entry.post);
    return [...posts.values()];
  }

  async getJob(jobId) {
    const store = await this.store();
    const job = await store.readJob(assertNonEmptyString(jobId, "jobId"));
    if (!job) return null;
    return { ...job, posts: await this.#mergedJobPosts(store, job), media: await this.#mergedJobMedia(store, job) };
  }

  /** Read only the fixed-size job fields needed by hot-path guards.
   *
   * Jobs written before the jobPosts/jobMedia splits may still carry inline
   * children in the jobs record, so IndexedDB must deserialize that legacy
   * record. This projection still avoids both child-store scans and the post
   * sort, while newly-created v6 jobs have empty inline collections. */
  async getJobHeader(jobId) {
    const store = await this.store();
    const job = await store.readJob(assertNonEmptyString(jobId, "jobId"));
    if (!job) return null;
    return {
      jobId: job.jobId,
      mode: job.mode,
      state: job.state,
      finalizeRequested: job.finalizeRequested === true,
      schemaVersion: job.schemaVersion,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  /** One put into jobPosts, so two workers appending at once cannot drop each
   * other's post. The job document is only touched to leave "collecting",
   * which is the same trick updateJobMediaDownload uses to stay off the hot
   * path -- and is now safe to lose a race on, since it no longer carries the
   * posts. */
  async appendJobPost(jobId, post) {
    if (!post || typeof post !== "object" || Array.isArray(post)) throw new TypeError("post metadata must be an object");
    const tweetId = assertNonEmptyString(post.tweetId, "post.tweetId");
    const store = await this.store();
    const job = await store.readJob(assertNonEmptyString(jobId, "jobId"));
    if (!job) throw new Error(`cannot update missing job: ${jobId}`);
    if (job.state === "finalizing" || job.state === "published") throw new Error(`cannot append to ${job.state} job: ${jobId}`);
    const at = this.now();
    await store.writeJobPostEntry({
      key: jobPostKey(job.jobId, tweetId), jobId: job.jobId, tweetId, seq: at, post: clone(post), updatedAt: at,
    });
    if (job.state !== "downloading") return store.writeJob(normalizeJob({ ...job, state: "downloading", updatedAt: at }, this.now));
    return job;
  }

  /** Persist a download's terminal/pending state so a restarted MV3 worker can resume the job.
   *
   * This runs several times per media, so it must not scale with the job. It
   * used to read the whole job document, deep-clone every post through
   * normalizeJob, and write the document back -- which made a bulk run cost
   * O(media x posts) and put a 761-post archive at ~15 seconds of pure
   * bookkeeping. Now it writes one small record in the jobMedia store.
   */
  async updateJobMediaDownload(jobId, mediaKey, { downloadId = null, state = "pending", error = null } = {}) {
    if (!JOB_MEDIA_STATES.has(state)) throw new TypeError("job media state is unsupported");
    const store = await this.store();
    const job = await store.readJob(assertNonEmptyString(jobId, "jobId"));
    if (!job) throw new Error(`cannot update missing job: ${jobId}`);
    if (job.state === "finalizing" || job.state === "published") throw new Error(`cannot update ${job.state} job: ${jobId}`);
    const key = assertNonEmptyString(mediaKey, "mediaKey");
    await store.writeJobMediaEntry({
      key: jobMediaKey(job.jobId, key), jobId: job.jobId, mediaKey: key,
      downloadId: normalizeDownloadId(downloadId), state,
      error: normalizeNullableString(error, "error"), updatedAt: this.now(),
    });
    // The document only has to leave "collecting" once, so this stays off the
    // per-media path for every job that already has a post appended.
    if (job.state !== "downloading") return store.writeJob(normalizeJob({ ...job, state: "downloading", updatedAt: this.now() }, this.now));
    // Returns the job document, not the assembled media map: rebuilding that
    // here would put the per-media cost straight back. Use getJob for media.
    return job;
  }

  async markJobFinalizing(jobId) {
    const store = await this.store();
    const job = await store.readJob(assertNonEmptyString(jobId, "jobId"));
    if (!job) throw new Error(`cannot finalize missing job: ${jobId}`);
    // Must be the merged map: the unsettled downloads this guard exists to
    // catch are recorded in the jobMedia store, not in the document.
    const waiting = Object.values(await this.#mergedJobMedia(store, job)).filter((item) => item.state === "pending");
    if (waiting.length > 0) throw new Error(`cannot finalize job with ${waiting.length} unsettled downloads: ${jobId}`);
    return store.writeJob(normalizeJob({ ...job, state: "finalizing", updatedAt: this.now() }, this.now));
  }

  /** Persist the user's end-of-job intent even while downloads are pending. */
  async requestJobFinalize(jobId) {
    const store = await this.store();
    const job = await store.readJob(assertNonEmptyString(jobId, "jobId"));
    if (!job) throw new Error(`cannot finalize missing job: ${jobId}`);
    // Both are independent readonly queries. Bulk callers finish every
    // savePost request before requesting finalization, so starting them
    // together changes neither the accepted set nor the published snapshot.
    const [media, posts] = await Promise.all([
      this.#mergedJobMedia(store, job),
      this.#mergedJobPosts(store, job),
    ]);
    if (job.state === "published") return { ...job, media, posts };
    const waiting = Object.values(media).filter((item) => item.state === "pending");
    // The document keeps its own media; only the returned view is merged, so
    // callers can still count what is unsettled.
    const written = await store.writeJob(normalizeJob({
      ...job,
      finalizeRequested: true,
      state: waiting.length === 0 ? "finalizing" : "downloading",
      updatedAt: this.now(),
    }, this.now));
    return { ...written, media, posts };
  }

  /** Records a job-level defect without touching its lifecycle. A job that
   * lost posts is still worth publishing for the ones that survived, so the
   * reason is left on the record rather than used to block anything. */
  async recordJobError(jobId, error) {
    const store = await this.store();
    const job = await store.readJob(assertNonEmptyString(jobId, "jobId"));
    if (!job) return null;
    return store.writeJob(normalizeJob({ ...job, error, updatedAt: this.now() }, this.now));
  }

  async markJobPublished(jobId) {
    const store = await this.store();
    const job = await store.readJob(assertNonEmptyString(jobId, "jobId"));
    if (!job) throw new Error(`cannot publish missing job: ${jobId}`);
    if (job.state !== "finalizing") throw new Error(`job must be finalizing before publish: ${jobId}`);
    return store.writeJob(normalizeJob({ ...job, state: "published", updatedAt: this.now() }, this.now));
  }

  async listPendingJobs() {
    const store = await this.store();
    const jobs = (await store.listJobs())
      .filter((job) => job.state !== "published")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    // Startup recovery walks job.media to settle downloads Chrome forgot, so
    // these have to be the merged view or every v5 job looks like it has no
    // media at all and nothing is ever recovered.
    return Promise.all(jobs.map(async (job) => ({
      ...job,
      posts: await this.#mergedJobPosts(store, job),
      media: await this.#mergedJobMedia(store, job),
    })));
  }
}

export { RECORD_FIELDS };
