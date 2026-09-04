import { sanitizeWindowsSegment, isValidJobId } from "./lib/archive_contract.js";
import { archiveJobFromPersistentJob, orphanedMediaKeys } from "./lib/archive_job_projection.js";
import { DownloadFilenameClaims } from "./lib/download_filename.js";
import { MediaLedger } from "./lib/ledger.js";
import { splitArchiveJobManifest } from "./lib/manifest_chunks.js";
import { assertSavePostRequest } from "./lib/save_request_validation.js";

const ROOT_DIRECTORY = "XMediaClone";
const SETTINGS_KEY = "xmcSettings";
const LEGACY_HISTORY_KEY = "xmcHistory";
const LEGACY_MIGRATION_KEY = "xmcLedgerLegacyMigratedAt";
const DEFAULT_SETTINGS = Object.freeze({
  integrationEnabled: true,
});
const MESSAGE_TYPES = new Set([
  "xmc:job:create", "xmc:save-post", "xmc:job:finalize", "xmc:job:finish-pending",
  "xmc:ledger:tweet-status", "xmc:ledger:stats", "xmc:ledger:export",
  "xmc:ledger:rebuild", "xmc:ledger:migrate-legacy",
  "xmc:settings:get", "xmc:settings:set",
]);

const filenameClaims = new DownloadFilenameClaims();
const FILENAME_CLAIMS_KEY = "xmcFilenameClaims";
const FILENAME_CLAIM_TTL_MS = 10 * 60 * 1000;
let filenameClaimQueue = Promise.resolve();
const ledger = new MediaLedger({ factory: globalThis.__XMC_LEDGER_FACTORY__ ?? null });
const terminalWaiters = new Map();
let settingsCache = null;
let settingsPromise = null;
let settingsGeneration = 0;

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  if (downloadItem?.byExtensionId !== chrome.runtime.id) {
    // Chrome requires every listener to call suggest exactly once. Never
    // rename or delay downloads owned by another extension.
    suggest();
    return false;
  }
  if (!chrome.storage?.session || isEphemeralClaimUrl(downloadItem.url)) {
    const filename = filenameClaims.claim(downloadItem, chrome.runtime.id);
    suggest(filename === null ? undefined : { filename, conflictAction: "uniquify" });
    return false;
  }
  consumePersistedFilenameClaim(downloadItem.url).then((filename) => {
    suggest(filename === null ? undefined : { filename, conflictAction: "uniquify" });
  }, () => suggest());
  return true;
});

if (chrome.downloads.onChanged?.addListener) {
  chrome.downloads.onChanged.addListener((delta) => {
    settleDownloadChange(delta).catch((error) => console.error("[xmc] download settlement failed", error));
  });
}

if (chrome.storage?.onChanged?.addListener) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes && Object.hasOwn(changes, SETTINGS_KEY)) invalidateSettingsCache();
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !MESSAGE_TYPES.has(message.type)) return false;
  const task = routeMessage(message);
  Promise.resolve(task)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});

async function routeMessage(message) {
  if (!message || typeof message !== "object") return null;
  if (message.type === "xmc:job:create") return createJob(message.mode);
  if (message.type === "xmc:save-post") return savePost(message.request);
  if (message.type === "xmc:job:finalize") return finalizeJob(message.jobId);
  if (message.type === "xmc:job:finish-pending") return finishPendingJobs(message.exceptJobId ?? null);
  if (message.type === "xmc:ledger:tweet-status") return tweetStatus(message.tweetId);
  if (message.type === "xmc:ledger:stats") return { ok: true, ...(await ledger.stats()) };
  if (message.type === "xmc:ledger:export") return { ok: true, ledger: await ledger.export() };
  if (message.type === "xmc:ledger:rebuild") return { ok: true, ...(await ledger.rebuildFromReceipts(message.receipts)) };
  if (message.type === "xmc:ledger:migrate-legacy") return migrateLegacyHistory();
  if (message.type === "xmc:settings:get") return { ok: true, settings: await readSettings() };
  if (message.type === "xmc:settings:set") return { ok: true, settings: await writeSettings(message.settings) };
  return null;
}

function newJobId() {
  const id = crypto.randomUUID();
  if (!isValidJobId(id)) throw new Error("browser generated an invalid job ID");
  return id;
}

async function createJob(mode) {
  if (mode !== "manual" && mode !== "bulk") throw new TypeError("mode must be manual or bulk");
  const jobId = newJobId();
  await ledger.createJob({ jobId, mode });
  return { ok: true, jobId };
}

function safeExtension(media) {
  const extension = typeof media.extension === "string" ? media.extension.replace(/^\.+/, "").toLowerCase() : "";
  if (/^[a-z0-9]{1,8}$/.test(extension)) return extension;
  if (media.type === "video" || media.type === "animated_gif") return "mp4";
  return "jpg";
}

function stagingMediaPath(post, media) {
  const tweetId = sanitizeWindowsSegment(post.tweetId, "tweet");
  const key = sanitizeWindowsSegment(media.mediaKey, `media-${media.ordinal}`).slice(0, 72);
  return `media/${tweetId}-${String(media.ordinal).padStart(2, "0")}-${key}.${safeExtension(media)}`;
}

function downloadFilename(settings, jobId, post, media, stagingRelativePath) {
  if (settings.integrationEnabled) return `${ROOT_DIRECTORY}/_jobs/${jobId}/${stagingRelativePath}`;
  const author = sanitizeWindowsSegment(post.author.screenName, "unknown");
  return `${ROOT_DIRECTORY}/${author}/${sanitizeWindowsSegment(post.tweetId)}-${String(media.ordinal).padStart(2, "0")}.${safeExtension(media)}`;
}

async function savePost(rawRequest) {
  const request = assertSavePostRequest(rawRequest);
  let jobId = request.jobId;
  if (request.mode === "manual") {
    if (jobId !== null && jobId !== undefined) throw new TypeError("manual saves create their own job");
    jobId = (await createJob("manual")).jobId;
  } else if (!isValidJobId(jobId)) {
    throw new TypeError("bulk save requires a valid jobId");
  }

  const job = await ledger.getJobHeader(jobId);
  if (!job || job.mode !== request.mode) throw new Error("archive job is missing or has the wrong mode");
  const settings = await readSettings();
  const manifestMedia = [];
  const downloadIds = [];
  const recoveryJobIds = new Set();
  let anyReserved = false;
  let allComplete = true;

  for (const media of request.post.media) {
    if (!media || typeof media.mediaKey !== "string" || typeof media.sourceUrl !== "string") {
      throw new TypeError("save request media is invalid");
    }
    const stagingRelativePath = stagingMediaPath(request.post, media);
    await reconcileMediaRecord(media.mediaKey, settings);
    const reservation = await ledger.reserve({
      mediaKey: media.mediaKey,
      jobId,
      tweetId: request.post.tweetId,
      authorId: request.post.author.id,
      stagingRelativePath: settings.integrationEnabled ? stagingRelativePath : null,
    }, {
      retry: request.retryFailed === true,
      // A manual save is one deliberate click on one post, so it always
      // fetches: the ledger cannot see that the vault lost the file, and
      // refusing leaves the user with no way to get it back. Bulk keeps the
      // suppression, because there the saving is the whole point and a
      // thousand redundant downloads is not. Duplicates are not a risk either
      // way -- the consumer writes every post and every media to a path
      // derived from its ID, and skips a target whose bytes already match.
      force: request.forceRedownload === true || request.mode === "manual",
    });

    const publishedMedia = {
      mediaKey: media.mediaKey,
      ordinal: media.ordinal,
      type: media.type,
      extension: safeExtension(media),
      stagingRelativePath: null,
      downloadState: "missing",
    };

    if (!reservation.reserved) {
      const complete = reservation.reason === "complete";
      allComplete &&= complete;
      if ((reservation.reason === "pending" || reservation.reason === "staged") && reservation.record?.jobId) {
        recoveryJobIds.add(reservation.record.jobId);
      }
      publishedMedia.downloadState = complete ? "skipped" : "missing";
      await ledger.updateJobMediaDownload(jobId, media.mediaKey, {
        state: complete ? "skipped" : "missing",
        error: complete ? null : `existing ledger state: ${reservation.reason}`,
      });
      manifestMedia.push(publishedMedia);
      continue;
    }

    anyReserved = true;
    allComplete = false;
    publishedMedia.stagingRelativePath = settings.integrationEnabled ? stagingRelativePath : null;
    publishedMedia.downloadState = "pending";
    // Recorded before the download starts on purpose: if this worker is killed
    // once Chrome owns the download, markJobFinalizing must still see an
    // unsettled entry and refuse to close the job.
    await ledger.updateJobMediaDownload(jobId, media.mediaKey, { state: "pending" });
    const filename = downloadFilename(settings, jobId, request.post, media, stagingRelativePath);
    try {
      const downloadId = await startOwnedDownload({
        url: media.sourceUrl,
        filename,
      });
      downloadIds.push(downloadId);
      await ledger.update(media.mediaKey, { downloadId });
      await ledger.updateJobMediaDownload(jobId, media.mediaKey, { downloadId, state: "pending" });
      const terminal = await queryDownloadState(downloadId);
      if (terminal) {
        await settleDownloadChange({
          id: downloadId,
          state: { current: terminal.state },
          error: terminal.error ? { current: terminal.error } : undefined,
        });
      }
    } catch (error) {
      const message = errorMessage(error);
      publishedMedia.downloadState = "failed";
      await ledger.markFailed(media.mediaKey, message);
      await ledger.updateJobMediaDownload(jobId, media.mediaKey, { state: "failed", error: message });
    }
    manifestMedia.push(publishedMedia);
  }

  if (anyReserved || request.includePostWhenMediaSkipped === true) {
    await ledger.appendJobPost(jobId, {
      tweetId: request.post.tweetId,
      tweetUrl: request.post.tweetUrl,
      text: request.post.text,
      createdAt: request.post.createdAt,
      replyToTweetId: request.post.replyToTweetId ?? null,
      replyToUserId: request.post.replyToUserId ?? null,
      conversationId: request.post.conversationId ?? null,
      profileMetadataStatus: request.post.profileMetadataStatus,
      author: request.post.author,
      media: manifestMedia,
      ...(request.post.replyTree ? { replyTree: request.post.replyTree } : {}),
    });
  }

  if (request.mode === "manual") {
    if (anyReserved) {
      await finalizeJob(jobId);
      const terminal = await Promise.all(downloadIds.map(async (downloadId) => {
        const result = await waitForTerminalDownload(downloadId);
        await settleDownloadChange({
          id: downloadId,
          state: { current: result.state },
          error: result.error ? { current: result.error } : undefined,
        });
        return result;
      }));
      const current = await ledger.getJob(jobId);
      if (current && current.state !== "published") await finalizeJob(jobId);
      allComplete = (await tweetStatus(request.post.tweetId)).allComplete;
      if (terminal.some((result) => result.state !== "complete") || manifestMedia.some((media) => media.downloadState === "failed")) {
        return { ok: false, partial: true, jobId, downloadIds, error: "one or more media downloads failed" };
      }
    }
    else await closeEmptyJob(jobId);
  }
  const reopenedJobIds = await reopenRecoverableJobs(recoveryJobIds, settings);
  return {
    ok: true,
    jobId,
    downloadIds,
    allComplete,
    reopenedJobIds,
    skipped: manifestMedia.length - downloadIds.length,
  };
}

async function closeEmptyJob(jobId) {
  await ledger.requestJobFinalize(jobId);
  await ledger.markJobPublished(jobId);
}

async function finalizeJob(jobId) {
  if (!isValidJobId(jobId)) throw new TypeError("jobId is invalid");
  const job = await ledger.requestJobFinalize(jobId);
  if (job.posts.length === 0) {
    // A job with nothing to publish is normal -- every media was already
    // archived and got skipped. A job that *downloaded* media and still has no
    // posts is the failure this check exists for, and it never reaches
    // publishJob to be caught there.
    const orphanedMedia = await reportOrphanedMedia(jobId, job);
    await ledger.markJobPublished(jobId);
    return { ok: true, jobId, empty: true, waiting: 0, orphanedMedia };
  }
  let settled = job;
  if (Object.values(job.media).some((media) => media.state === "pending")) {
    // Do not hand the job to a background timer and hope. Every download whose
    // completion event went missing is asked about here, while the user is
    // still watching, so the manifest does not depend on a later restart.
    await settlePendingDownloads(job);
    settled = (await ledger.getJob(jobId)) ?? job;
    if (settled.state === "published") return { ok: true, jobId, waiting: 0, orphanedMedia: 0 };
  }
  const waiting = Object.values(settled.media).filter((media) => media.state === "pending").length;
  const orphanedMedia = waiting === 0 ? await publishJob(jobId) : 0;
  return { ok: true, jobId, waiting, orphanedMedia };
}

async function settleDownloadChange(delta) {
  if (!delta || !Number.isSafeInteger(delta.id)) return;
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;
  const waiter = terminalWaiters.get(delta.id);
  if (waiter) {
    terminalWaiters.delete(delta.id);
  }

  const records = await ledger.findByDownloadId(delta.id);
  for (const record of records) {
    if (record.state !== "pending") continue;
    const terminalState = state === "complete" ? "complete" : "failed";
    if (terminalState === "complete" && record.stagingRelativePath) await ledger.markStaged(record.mediaKey);
    else if (terminalState === "complete") await ledger.markComplete(record.mediaKey, { receiptId: "standalone-download" });
    else await ledger.markFailed(record.mediaKey, delta.error?.current ?? "download interrupted");
    if (!record.jobId) continue;
    // The update returns the job it just wrote. Re-reading it here cost a
    // second full-document read and structuredClone per completed download.
    const job = await ledger.updateJobMediaDownload(record.jobId, record.mediaKey, {
      downloadId: delta.id,
      state: terminalState,
      error: terminalState === "failed" ? delta.error?.current ?? "download interrupted" : null,
    });
    if (job?.finalizeRequested) {
      const requested = await ledger.requestJobFinalize(record.jobId);
      if (requested.state === "finalizing") await publishJob(record.jobId);
    }
  }
  if (waiter) waiter({ state, error: delta.error?.current ?? null });
}

async function reportOrphanedMedia(jobId, job) {
  const orphaned = orphanedMediaKeys(job);
  if (orphaned.length === 0) return 0;
  console.error("[xmc] job closed without every downloaded media", jobId, orphaned.length);
  await ledger.recordJobError(jobId, `${orphaned.length} downloaded media were missing from the manifest`)
    .catch(() => undefined);
  return orphaned.length;
}

async function publishJob(jobId) {
  const job = await ledger.getJob(jobId);
  if (!job || job.state === "published") return 0;
  if (job.state !== "finalizing") throw new Error("job is not ready to publish");
  const orphaned = await reportOrphanedMedia(jobId, job);
  const settings = await readSettings();
  if (settings.integrationEnabled) {
    const manifest = splitArchiveJobManifest(archiveJobFromPersistentJob(job));
    const attemptId = `z-${String(Date.now()).padStart(13, "0")}-${newJobId()}`;
    const attemptRoot = `${ROOT_DIRECTORY}/_jobs/${jobId}/_manifest/${attemptId}`;
    for (const file of manifest.chunks) {
      await downloadTextFile(`${attemptRoot}/${file.name}`, file.contents);
    }
    await downloadTextFile(`${attemptRoot}/${manifest.complete.name}`, manifest.complete.contents);
  }
  // Writing the manifest yields to Chrome repeatedly, so the job may have been
  // finished by another path in the meantime. Marking it again would throw, and
  // that exception used to escape into the caller.
  const current = await ledger.getJob(jobId);
  if (current?.state === "finalizing") await ledger.markJobPublished(jobId);
  return orphaned;
}

async function startOwnedDownload({ url, filename }) {
  filenameClaims.add(url, filename);
  const persistClaim = !isEphemeralClaimUrl(url);
  if (persistClaim) await persistFilenameClaim(url, filename);
  try {
    return await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
  } catch (error) {
    filenameClaims.remove(url, filename);
    if (persistClaim) await removePersistedFilenameClaim(url, filename).catch(() => {});
    throw error;
  }
}

function sessionStorageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.session.get(key, (value) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(value || {});
    });
  });
}

function sessionStorageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.session.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function updatePersistedFilenameClaims(update) {
  if (!chrome.storage?.session) return Promise.resolve(update(null));
  const task = filenameClaimQueue.then(async () => {
    const stored = await sessionStorageGet(FILENAME_CLAIMS_KEY);
    const claims = stored[FILENAME_CLAIMS_KEY] && typeof stored[FILENAME_CLAIMS_KEY] === "object"
      ? stored[FILENAME_CLAIMS_KEY]
      : {};
    const cutoff = Date.now() - FILENAME_CLAIM_TTL_MS;
    for (const [url, entries] of Object.entries(claims)) {
      const fresh = Array.isArray(entries)
        ? entries.filter((entry) => entry && typeof entry.filename === "string" && Number.isFinite(entry.createdAt) && entry.createdAt >= cutoff)
        : [];
      if (fresh.length === 0) delete claims[url];
      else claims[url] = fresh;
    }
    const result = update(claims);
    await sessionStorageSet({ [FILENAME_CLAIMS_KEY]: claims });
    return result;
  });
  filenameClaimQueue = task.catch(() => {});
  return task;
}

function persistFilenameClaim(url, filename) {
  return updatePersistedFilenameClaims((claims) => {
    if (!claims) return null;
    const queue = Array.isArray(claims[url]) ? claims[url] : [];
    queue.push({ filename, createdAt: Date.now() });
    claims[url] = queue;
    return filename;
  });
}

function consumePersistedFilenameClaim(url) {
  return updatePersistedFilenameClaims((claims) => {
    if (!claims) return null;
    const queue = Array.isArray(claims[url]) ? claims[url] : [];
    const filename = queue.shift()?.filename ?? null;
    if (queue.length === 0) delete claims[url];
    else claims[url] = queue;
    if (filename !== null) filenameClaims.remove(url, filename);
    return filename;
  });
}

function removePersistedFilenameClaim(url, filename) {
  return updatePersistedFilenameClaims((claims) => {
    if (!claims) return null;
    const queue = Array.isArray(claims[url]) ? claims[url] : [];
    const index = queue.findIndex((entry) => entry?.filename === filename);
    if (index !== -1) queue.splice(index, 1);
    if (queue.length === 0) delete claims[url];
    else claims[url] = queue;
    return null;
  });
}

function isEphemeralClaimUrl(url) {
  return typeof url === "string" && url.startsWith("data:");
}

async function downloadTextFile(filename, contents) {
  const url = `data:application/json;base64,${utf8Base64(contents)}`;
  const downloadId = await startOwnedDownload({ url, filename });
  const result = await waitForTerminalDownload(downloadId);
  if (result.state !== "complete") throw new Error(result.error || `manifest download ${downloadId} failed`);
}

async function waitForTerminalDownload(downloadId) {
  if (!chrome.downloads.onChanged?.addListener) return { state: "complete", error: null };
  return new Promise((resolve) => {
    terminalWaiters.set(downloadId, resolve);
    queryDownloadState(downloadId).then((terminal) => {
      if (!terminal || !terminalWaiters.has(downloadId)) return;
      terminalWaiters.delete(downloadId);
      resolve(terminal);
    }, () => {});
  });
}

function utf8Base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

async function queryDownloadState(downloadId) {
  const evidence = await queryDownloadEvidence(downloadId);
  if (evidence?.state === "complete") return { state: evidence.state, error: null, exists: evidence.exists };
  if (evidence?.state === "interrupted") return { state: evidence.state, error: evidence.error, exists: evidence.exists };
  return null;
}

async function queryDownloadEvidence(downloadId) {
  if (typeof chrome.downloads.search !== "function") return null;
  const items = await chrome.downloads.search({ id: downloadId });
  const item = items?.[0];
  if (!item) return null;
  return {
    state: item.state ?? "unknown",
    error: item.error ?? null,
    exists: item.exists === true ? true : item.exists === false ? false : null,
    // Chrome can leave a download it finished writing sitting at "in_progress"
    // -- these two are how to tell that apart from one that stopped half way.
    bytesReceived: Number.isFinite(item.bytesReceived) ? item.bytesReceived : null,
    totalBytes: Number.isFinite(item.totalBytes) ? item.totalBytes : null,
    paused: item.paused === true,
  };
}

/** True when Chrome has received every byte it expected, whatever it calls the
 * download's state. */
function downloadIsFullyReceived(evidence) {
  return evidence !== null
    && evidence.totalBytes !== null && evidence.totalBytes > 0
    && evidence.bytesReceived === evidence.totalBytes;
}

async function tweetStatus(tweetId) {
  if (typeof tweetId !== "string" || tweetId === "") throw new TypeError("tweetId is invalid");
  const settings = await readSettings();
  const original = await ledger.findByTweetId(tweetId);
  const records = [];
  for (const record of original) records.push(await reconcileMediaRecord(record.mediaKey, settings));
  return {
    ok: true,
    mediaCount: records.length,
    allComplete: records.length > 0 && records.every((record) => record.state === "complete"),
  };
}

async function reconcileMediaRecord(mediaKey, settings) {
  let record = await ledger.get(mediaKey);
  if (!record) return null;
  if (!["pending", "staged", "complete"].includes(record.state)) return record;

  const evidence = record.downloadId === null ? null : await queryDownloadEvidence(record.downloadId);
  if (record.state === "pending" && (evidence?.state === "complete" || evidence?.state === "interrupted")) {
    await settleDownloadChange({
      id: record.downloadId,
      state: { current: evidence.state },
      error: evidence.error ? { current: evidence.error } : undefined,
    });
    record = await ledger.get(mediaKey);
  }

  if (!settings.integrationEnabled) {
    if (record.state === "staged") record = await ledger.markComplete(mediaKey, { receiptId: "standalone-download" });
    return record;
  }

  // Records written by the pre-atomic implementation became complete as soon
  // as Chrome finished downloading. If their staging file still exists and no
  // receipt ever authorized completion, downgrade them once to retryable staged.
  if (record.state === "complete" && !record.receiptId && record.jobId && record.stagingRelativePath) {
    if (evidence?.state === "complete" && evidence.exists !== false) {
      record = await ledger.markStaged(mediaKey);
    } else if (evidence?.state === "interrupted") {
      record = await ledger.markFailed(mediaKey, evidence.error ?? "download interrupted");
    } else if (!evidence) {
      record = await ledger.markMissing(mediaKey, { error: "download evidence is unavailable" });
    } else if (evidence.exists === false) {
      record = await ledger.markComplete(mediaKey, { receiptId: `staging-removed:${record.jobId}` });
    }
  }

  if (record.state === "staged") {
    if (evidence?.state === "complete" && evidence.exists === false) {
      record = await ledger.markComplete(mediaKey, { receiptId: `staging-removed:${record.jobId}` });
    } else if (evidence?.state === "interrupted") {
      record = await ledger.markFailed(mediaKey, evidence.error ?? "download interrupted");
    } else if (!record.jobId || !(await ledger.getJob(record.jobId))) {
      record = await ledger.markFailed(mediaKey, "staged archive job is unavailable");
    }
  }
  return record;
}

async function reopenRecoverableJobs(jobIds, settings) {
  if (!settings.integrationEnabled || jobIds.size === 0) return [];
  const reopened = [];
  for (const jobId of jobIds) {
    const job = await ledger.getJob(jobId);
    if (!job) continue;
    if (job.state === "published") {
      reopened.push(jobId);
      continue;
    }
    if (job.state === "finalizing") {
      await publishJob(jobId);
      reopened.push(jobId);
      continue;
    }
    if (job.finalizeRequested) {
      const requested = await ledger.requestJobFinalize(jobId);
      if (requested.state === "finalizing") {
        await publishJob(jobId);
        reopened.push(jobId);
      }
    }
  }
  return reopened;
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    if (!chrome.storage?.local) return resolve({});
    chrome.storage.local.get(keys, (value) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(value || {});
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    if (!chrome.storage?.local) return resolve();
    chrome.storage.local.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function invalidateSettingsCache() {
  settingsGeneration += 1;
  settingsCache = null;
  settingsPromise = null;
}

function readSettings() {
  if (settingsCache !== null) return Promise.resolve(settingsCache);
  if (settingsPromise !== null) return settingsPromise;

  const generation = settingsGeneration;
  const pending = storageGet(SETTINGS_KEY)
    .then((stored) => normalizeSettings(stored[SETTINGS_KEY]))
    .then((settings) => {
      if (generation === settingsGeneration && settingsPromise === pending) settingsCache = settings;
      return settings;
    })
    .finally(() => {
      if (settingsPromise === pending) settingsPromise = null;
    });
  settingsPromise = pending;
  return pending;
}

function normalizeSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    integrationEnabled: source.integrationEnabled !== false,
  };
}

async function writeSettings(value) {
  const settings = normalizeSettings(value);
  // Invalidate before and after the write. A read already in flight may have
  // sampled the old storage value; the second generation change prevents that
  // stale promise from repopulating the cache after this write completes.
  invalidateSettingsCache();
  await storageSet({ [SETTINGS_KEY]: settings });
  invalidateSettingsCache();
  settingsCache = settings;
  return settings;
}

async function migrateLegacyHistory() {
  const stored = await storageGet([LEGACY_HISTORY_KEY, LEGACY_MIGRATION_KEY]);
  if (stored[LEGACY_MIGRATION_KEY]) return { ok: true, imported: 0, alreadyMigrated: true };
  const result = await ledger.migrateLegacyHistory(stored[LEGACY_HISTORY_KEY] ?? []);
  await storageSet({ [LEGACY_MIGRATION_KEY]: new Date().toISOString() });
  return { ok: true, ...result, alreadyMigrated: false };
}

/**
 * How long a job must sit untouched before recovery treats it as abandoned.
 * An active session settles downloads continuously, so it never goes idle this
 * long; a session whose tab was closed never comes back.
 */
const ABANDONED_JOB_MS = 10 * 60 * 1000;

function idleSince(value, now) {
  const at = Date.parse(value ?? "");
  return Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY;
}

async function recoverPendingJobs() {
  const now = Date.now();
  for (const job of await ledger.listPendingJobs()) {
    // One unrecoverable job must not stop the others. A job stuck in a state
    // publish rejects used to throw out of this loop on every startup, so every
    // job behind it -- including a finished bulk of 912 media -- was never
    // reached, and nothing said so anywhere the user would look.
    try { await recoverJob(job, now); }
    catch (error) { console.error("[xmc] recovery skipped job", job.jobId, error); }
  }
}

/**
 * True unless Chrome positively reports every staged file as gone.
 *
 * Discarding a job destroys real bytes, so it must take real evidence. Chrome
 * having no record of a download is not that evidence: records expire and get
 * cleared while the files stay on disk, and treating silence as proof of
 * removal would throw away a finished sweep of hundreds of files. Only
 * `exists: false`, which Chrome reports for a download it knows was deleted,
 * counts against a job.
 */
async function jobStagingSurvives(job) {
  let removed = 0;
  for (const media of Object.values(job.media)) {
    if (media.downloadId === null) continue;
    const evidence = await queryDownloadEvidence(media.downloadId);
    if (evidence?.exists === false) { removed += 1; continue; }
    return true;
  }
  return removed === 0;
}

/**
 * Closes a job whose staged bytes are gone. Publishing its manifest would
 * describe files nothing can deliver, and the consumer would archive a post
 * per entry with every media missing. Its records go back to `missing` so the
 * post can simply be saved again -- left staged, the next save would read the
 * absent file as proof the importer had taken it and suppress the download for
 * good.
 */
async function discardUndeliverableJob(job) {
  for (const media of Object.values(job.media)) {
    await ledger.markMissing(media.mediaKey, { error: "staged bytes were removed before the job was published" }).catch(() => undefined);
  }
  const requested = await ledger.requestJobFinalize(job.jobId);
  if (requested.state === "finalizing") await ledger.markJobPublished(job.jobId);
}

/**
 * Finishes a job the user is asking about right now, rather than waiting for a
 * timer or the next service-worker start.
 *
 * The background recovery below only looks at jobs that have been idle for ten
 * minutes, and only runs when the worker happens to boot. In practice that has
 * never rescued anything: by the time it would qualify, the tab is gone and
 * nothing restarts the worker. So this path applies no idle gate at all.
 *
 * It also never discards. `jobStagingSurvives` asks Chrome whether it still
 * remembers the downloads, and Chrome forgetting them says nothing about
 * whether the files are on disk -- a job of 940 finished files can look
 * undeliverable. Companion opens the staged files itself and reports
 * `import-lost` for anything actually missing, so publishing optimistically
 * costs a retry while discarding throws away real bytes.
 *
 * @returns {"settled"|"downloading"} whether anything is still in flight
 */
async function settlePendingDownloads(job, { abandonStalled = false } = {}) {
  // One sample decides for the whole job: if a run is alive, its downloads are
  // moving together, and if it is gone they are all equally stuck.
  let verdict = null;
  for (const media of Object.values(job.media)) {
    if (media.state !== "pending") continue;

    // The media ledger is the authority on whether the bytes arrived, and it
    // and the job entry can disagree: settleDownloadChange skips any record
    // that is no longer pending, and it is the only thing that writes the job
    // entry. A record that settled by some other route therefore leaves its
    // job entry pending with nothing in the system able to repair it -- which
    // is how eighteen downloads across four jobs stayed "unsettled" through
    // every retry, unchanged down to the count. Reconcile from the record
    // before asking Chrome anything.
    const record = await ledger.get(media.mediaKey).catch(() => null);
    if (record?.state === "complete" || record?.state === "staged") {
      await ledger.updateJobMediaDownload(job.jobId, media.mediaKey, {
        downloadId: record.downloadId, state: "complete",
      });
      continue;
    }
    if (record?.state === "failed" || record?.state === "missing") {
      await ledger.updateJobMediaDownload(job.jobId, media.mediaKey, {
        downloadId: record.downloadId, state: "failed", error: record.error ?? "download did not complete",
      });
      continue;
    }

    const evidence = media.downloadId === null ? null : await queryDownloadEvidence(media.downloadId);
    if (evidence?.state === "in_progress") {
      // A live run really is still fetching, and its own finalize must wait.
      if (!abandonStalled) return "downloading";
      if (downloadIsFullyReceived(evidence)) {
        // The bytes are all there; only the state never caught up. Keeping the
        // file costs nothing and Companion verifies it either way.
        await settleDownloadChange({ id: media.downloadId, state: { current: "complete" } });
        continue;
      }
      verdict ??= await classifyRunningDownload(media.downloadId, evidence);
      if (verdict === "running") return "downloading";
      if (verdict === "complete") {
        await settleDownloadChange({ id: media.downloadId, state: { current: "complete" } });
        continue;
      }
      await cancelDownload(media.downloadId);
      const reason = "download stopped part way and its run is no longer active";
      await ledger.markFailed(media.mediaKey, reason).catch(() => undefined);
      await ledger.updateJobMediaDownload(job.jobId, media.mediaKey, { state: "failed", error: reason }).catch(() => undefined);
      continue;
    }
    if (evidence?.state === "complete" || evidence?.state === "interrupted") {
      await settleDownloadChange({
        id: media.downloadId,
        state: { current: evidence.state },
        error: evidence.error ? { current: evidence.error } : undefined,
      });
      continue;
    }
    if (media.downloadId === null) {
      const reason = "download was interrupted before it started";
      await ledger.markFailed(media.mediaKey, reason).catch(() => undefined);
      await ledger.updateJobMediaDownload(job.jobId, media.mediaKey, { state: "failed", error: reason }).catch(() => undefined);
      continue;
    }
    // Chrome has no record left, but it did hand us an ID, so the download ran.
    // Settling it as complete lets the staged file reach Companion, which
    // verifies it for real.
    await settleDownloadChange({ id: media.downloadId, state: { current: "complete" } });
  }
  return "settled";
}

/** How long to watch a download before deciding it is not moving. */
const PROGRESS_SAMPLE_MS = 1500;

/**
 * Whether a download Chrome calls "in_progress" is actually doing anything.
 *
 * Timestamps cannot answer this. A job's `updatedAt` is rewritten by the
 * startup recovery every time the extension is reloaded, so "untouched for N
 * minutes" resets exactly when the user is trying to collect their jobs, and
 * the stalled download stays untouchable forever.
 *
 * Only observed progress counts as "running", and everything else is treated as
 * stopped. Waiting is not the cautious choice here: four jobs holding 2,439
 * posts were kept unpublished by eighteen downloads between them, and a media
 * written off as failed is re-fetchable in a way that a manifest nobody ever
 * writes is not.
 *
 * @returns {"complete"|"running"|"stalled"}
 */
async function classifyRunningDownload(downloadId, evidence) {
  if (downloadIsFullyReceived(evidence)) return "complete";
  if (evidence.paused || evidence.bytesReceived === null) return "stalled";
  await new Promise((resolve) => setTimeout(resolve, PROGRESS_SAMPLE_MS));
  const later = await queryDownloadEvidence(downloadId);
  if (later === null) return "stalled";
  if (downloadIsFullyReceived(later) || later.state === "complete") return "complete";
  if (later.state !== "in_progress" || later.bytesReceived === null) return "stalled";
  return later.bytesReceived > evidence.bytesReceived ? "running" : "stalled";
}

async function cancelDownload(downloadId) {
  if (typeof chrome.downloads.cancel !== "function") return;
  await chrome.downloads.cancel(downloadId).catch(() => undefined);
}

/** @returns {"published"|"downloading"|"empty"} what happened to the job */
async function finishJobNow(job) {
  if (await settlePendingDownloads(job, { abandonStalled: true }) === "downloading") return "downloading";

  const current = await ledger.getJob(job.jobId);
  if (!current || current.state === "published") return "published";
  if (current.posts.length === 0) return "empty";
  const requested = await ledger.requestJobFinalize(current.jobId);
  if (requested.state !== "finalizing") return "downloading";
  await publishJob(current.jobId);
  return "published";
}

/**
 * Publishes every job that finished downloading but never got its manifest out,
 * so that opening the bulk modal is enough to collect them. `exceptJobId` is
 * the run the caller is in the middle of, which must not be closed under it.
 */
async function finishPendingJobs(exceptJobId) {
  const published = [];
  const stuck = [];
  for (const job of await ledger.listPendingJobs()) {
    if (job.jobId === exceptJobId) continue;
    let outcome;
    try { outcome = await finishJobNow(job); }
    catch (error) {
      console.error("[xmc] could not finish job", job.jobId, error);
      stuck.push({ jobId: job.jobId, reason: errorMessage(error) });
      continue;
    }
    if (outcome === "published") {
      if (job.posts.length === 0) continue;
      const closed = await ledger.getJob(job.jobId);
      published.push({
        jobId: job.jobId,
        posts: job.posts.length,
        // Media written off so the rest of the job could go out. These are not
        // suppressed by the ledger, so a forced re-run picks them back up.
        failedMedia: closed ? Object.values(closed.media).filter((item) => item.state === "failed").length : 0,
      });
      continue;
    }
    if (outcome !== "downloading") continue;
    // Say which job and how much of it is unaccounted for. "Still running" on
    // its own is indistinguishable from a bug, and this state has already been
    // mistaken for one twice.
    const after = await ledger.getJob(job.jobId);
    const media = after ? Object.values(after.media) : [];
    stuck.push({
      jobId: job.jobId,
      posts: job.posts.length,
      pending: media.filter((item) => item.state === "pending").length,
      media: media.length,
      reason: "downloads are still running",
    });
  }
  return { ok: true, published, stuck };
}

async function recoverJob(job, now) {
  for (const media of Object.values(job.media)) {
      if (media.state !== "pending") continue;
      const evidence = media.downloadId === null ? null : await queryDownloadEvidence(media.downloadId);
      if (evidence?.state === "complete" || evidence?.state === "interrupted") {
        await settleDownloadChange({
          id: media.downloadId,
          state: { current: evidence.state },
          error: evidence.error ? { current: evidence.error } : undefined,
        });
        continue;
      }
      // A download Chrome is still running will finish on its own.
      if (evidence?.state === "in_progress") continue;
      // Everything else can never settle: the ID was never persisted, or the
      // download record is gone from Chrome. No event will arrive, and one
      // such item holds the whole job below its finalize threshold forever.
      // Recording the failure lets the job close and carries the reason into
      // the manifest, so the archive shows it rather than lacking a file.
      if (idleSince(media.updatedAt, now) <= ABANDONED_JOB_MS) continue;
      const reason = media.downloadId === null
        ? "download was interrupted before it started"
        : "download never settled and Chrome has no record of it";
      await ledger.markFailed(media.mediaKey, reason).catch(() => undefined);
    await ledger.updateJobMediaDownload(job.jobId, media.mediaKey, { state: "failed", error: reason }).catch(() => undefined);
  }
  const current = await ledger.getJob(job.jobId);
  if (!current) return;
  const deliverable = await jobStagingSurvives(current);
  if (current.state === "finalizing") return deliverable ? publishJob(current.jobId) : discardUndeliverableJob(current);
  if (current.finalizeRequested) {
    if (!deliverable) return discardUndeliverableJob(current);
    const requested = await ledger.requestJobFinalize(current.jobId);
    if (requested.state === "finalizing") await publishJob(current.jobId);
    return;
  }
  // Nothing asked for this job to be finalized, which normally means the
  // session is still collecting. A job whose downloads have all settled and
  // which has been untouched since is not collecting -- the tab is gone, or
  // the finalize message was lost while this worker slept. Without this the
  // media stays staged in Downloads and the consumer never learns the job
  // exists at all.
  if (current.posts.length === 0) return;
  const settled = Object.values(current.media).every((media) => media.state !== "pending");
  if (settled && idleSince(current.updatedAt, now) > ABANDONED_JOB_MS) {
    if (!deliverable) return discardUndeliverableJob(current);
    const requested = await ledger.requestJobFinalize(current.jobId);
    if (requested.state === "finalizing") await publishJob(current.jobId);
  }
}

function errorMessage(error) {
  return error && typeof error.message === "string" ? error.message : String(error);
}

recoverPendingJobs().catch((error) => console.error("[xmc] recovery failed", error));
