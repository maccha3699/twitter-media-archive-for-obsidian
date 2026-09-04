// Pure serialization for ArchiveJob v1 manifests.  Chunks are independently
// valid JSON files, each capped by UTF-8 byte length, and a final marker makes
// partially written jobs detectable by the Companion.

import { normalizeArchiveJob } from "./archive_contract.js";

export const ARCHIVE_MANIFEST_CHUNK_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_MANIFEST_CHUNK_BYTES = 512 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteLength(value) {
  return encoder.encode(value).byteLength;
}

function bytesToBase64(bytes) {
  let binary = "";
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + stride, bytes.length)));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof value !== "string") throw new TypeError("chunk payload must be a base64 string");
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new TypeError("chunk payload is not valid base64");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function chunkRecord(jobId, chunkIndex, chunkCount, payload) {
  return {
    schemaVersion: ARCHIVE_MANIFEST_CHUNK_SCHEMA_VERSION,
    kind: "archive-job-chunk",
    jobId,
    chunkIndex,
    chunkCount,
    encoding: "base64-utf8-json",
    payload,
  };
}

function completeMarker(jobId, chunkCount) {
  return {
    schemaVersion: ARCHIVE_MANIFEST_CHUNK_SCHEMA_VERSION,
    kind: "archive-job-complete",
    jobId,
    chunkCount,
  };
}

function asRecord(value, label) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { throw new TypeError(`${label} is not valid JSON`); }
  }
  throw new TypeError(`${label} must be an object or JSON string`);
}

/** Split an ArchiveJob into <= maxBytes UTF-8 JSON chunk files plus its final marker. */
export function splitArchiveJobManifest(job, { maxBytes = DEFAULT_MAX_MANIFEST_CHUNK_BYTES } = {}) {
  const normalized = normalizeArchiveJob(job);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new RangeError("maxBytes must be a safe integer of at least 1024");
  const source = encoder.encode(JSON.stringify(normalized));
  let payloadBytes = Math.max(1, Math.floor((maxBytes - 512) * 0.75));
  let serializedChunks;

  // Account for base64 expansion and the JSON envelope.  The simple reduction
  // loop also covers extra digits in chunkCount for very large jobs.
  for (;;) {
    const count = Math.ceil(source.length / payloadBytes);
    serializedChunks = [];
    for (let index = 0; index < count; index += 1) {
      const payload = bytesToBase64(source.subarray(index * payloadBytes, Math.min(source.length, (index + 1) * payloadBytes)));
      serializedChunks.push(JSON.stringify(chunkRecord(normalized.jobId, index, count, payload)));
    }
    const marker = JSON.stringify(completeMarker(normalized.jobId, count));
    if (serializedChunks.every((chunk) => byteLength(chunk) <= maxBytes) && byteLength(marker) <= maxBytes) {
      const chunks = serializedChunks.map((contents, index) => ({
        name: `manifest-${String(index + 1).padStart(4, "0")}.json`,
        contents,
      }));
      const complete = { name: "complete.json", contents: marker };
      return { chunks, complete, files: [...chunks, complete] };
    }
    payloadBytes -= 256;
    if (payloadBytes < 1) throw new RangeError("maxBytes is too small for an ArchiveJob chunk envelope");
  }
}

/** Reassemble and validate a complete ArchiveJob manifest from chunk files. */
export function joinArchiveJobManifest(chunks, complete) {
  if (!Array.isArray(chunks) || chunks.length === 0) throw new TypeError("chunks must be a non-empty array");
  const marker = asRecord(complete?.contents ?? complete, "complete marker");
  if (marker.schemaVersion !== ARCHIVE_MANIFEST_CHUNK_SCHEMA_VERSION || marker.kind !== "archive-job-complete") {
    throw new TypeError("complete marker has an unsupported schema or kind");
  }
  if (!Number.isSafeInteger(marker.chunkCount) || marker.chunkCount !== chunks.length) throw new TypeError("complete marker chunk count does not match");

  const parsed = chunks.map((chunk, sourceIndex) => {
    const record = asRecord(chunk?.contents ?? chunk, `chunk ${sourceIndex}`);
    if (record.schemaVersion !== ARCHIVE_MANIFEST_CHUNK_SCHEMA_VERSION || record.kind !== "archive-job-chunk" || record.encoding !== "base64-utf8-json") {
      throw new TypeError(`chunk ${sourceIndex} has an unsupported schema, kind, or encoding`);
    }
    if (record.jobId !== marker.jobId || record.chunkCount !== marker.chunkCount || !Number.isSafeInteger(record.chunkIndex)) {
      throw new TypeError(`chunk ${sourceIndex} does not match the complete marker`);
    }
    return record;
  }).sort((left, right) => left.chunkIndex - right.chunkIndex);

  if (parsed.some((record, index) => record.chunkIndex !== index)) throw new TypeError("chunk indexes must be contiguous and unique");
  const total = parsed.reduce((sum, record) => sum + base64ToBytes(record.payload).length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const record of parsed) {
    const bytes = base64ToBytes(record.payload);
    joined.set(bytes, offset);
    offset += bytes.length;
  }
  let raw;
  try { raw = JSON.parse(decoder.decode(joined)); } catch { throw new TypeError("reassembled manifest is not valid JSON"); }
  const job = normalizeArchiveJob(raw);
  if (job.jobId !== marker.jobId) throw new TypeError("reassembled jobId does not match the complete marker");
  return job;
}
