// Pure, serializable author-folder registry.  Author IDs own identity; a
// lower-cased screen name is only a provisional identity until an ID appears.

import { sanitizeWindowsSegment } from "./archive_contract.js";

export const AUTHOR_REGISTRY_SCHEMA_VERSION = 1;

function cloneRegistry(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new TypeError("author registry must be an object");
  }
  if (registry.schemaVersion !== AUTHOR_REGISTRY_SCHEMA_VERSION || !registry.authors || typeof registry.authors !== "object" || Array.isArray(registry.authors)) {
    throw new TypeError("author registry has an unsupported schema");
  }
  return {
    schemaVersion: AUTHOR_REGISTRY_SCHEMA_VERSION,
    authors: Object.fromEntries(Object.entries(registry.authors).map(([key, value]) => [key, {
      ...value,
      screenNames: Array.isArray(value.screenNames) ? [...value.screenNames] : [],
    }])),
  };
}

export function createAuthorRegistry() {
  return { schemaVersion: AUTHOR_REGISTRY_SCHEMA_VERSION, authors: {} };
}

export function shortAuthorId(authorId) {
  return sanitizeWindowsSegment(String(authorId)).slice(0, 8) || "unknown";
}

function normalizedScreenName(screenName) {
  if (typeof screenName !== "string" || screenName.trim() === "") throw new TypeError("screenName must be a non-empty string");
  return screenName.trim().replace(/^@+/, "");
}

function authorKey(authorId, screenName) {
  return authorId === null || authorId === undefined || authorId === ""
    ? `screen:${screenName.toLowerCase()}`
    : `id:${String(authorId)}`;
}

function folderIsTaken(authors, folderName, exceptKey) {
  return Object.entries(authors).some(([key, record]) => key !== exceptKey && record.folderName === folderName);
}

function folderFor(authors, baseFolder, key, authorId) {
  if (!folderIsTaken(authors, baseFolder, key)) return baseFolder;
  const suffix = authorId === null || authorId === undefined || authorId === "" ? "unverified" : shortAuthorId(authorId);
  let candidate = `${baseFolder}--${suffix}`;
  let ordinal = 2;
  while (folderIsTaken(authors, candidate, key)) candidate = `${baseFolder}--${suffix}-${ordinal++}`;
  return candidate;
}

function appendScreenName(record, screenName) {
  const names = Array.isArray(record.screenNames) ? record.screenNames : [];
  if (!names.some((name) => name.toLowerCase() === screenName.toLowerCase())) names.push(screenName);
  return names;
}

/**
 * Resolve an author folder without mutating the supplied registry.
 *
 * @returns {{ registry: object, folderName: string, authorKey: string, existing: boolean }}
 */
export function resolveAuthorFolder(registry, { id = null, screenName }) {
  const next = cloneRegistry(registry);
  const handle = normalizedScreenName(screenName);
  const resolvedId = typeof id === "string" && id.trim() !== "" ? id : null;
  const key = authorKey(resolvedId, handle);
  const provisionalKey = authorKey(null, handle);
  let record = next.authors[key];
  let existing = Boolean(record);

  // When an ID arrives for a previously anonymous handle, make the stable ID
  // record own the established first-screen-name folder.
  if (resolvedId && !record && next.authors[provisionalKey]) {
    const provisional = next.authors[provisionalKey];
    delete next.authors[provisionalKey];
    record = { ...provisional, authorId: resolvedId, screenNames: appendScreenName(provisional, handle) };
    existing = true;
  }

  if (!record) {
    const baseFolder = sanitizeWindowsSegment(handle, "author");
    record = {
      authorId: resolvedId,
      firstScreenName: handle,
      folderName: folderFor(next.authors, baseFolder, key, resolvedId),
      screenNames: [handle],
    };
  } else {
    record = { ...record, authorId: resolvedId ?? record.authorId ?? null, screenNames: appendScreenName(record, handle) };
  }

  next.authors[key] = record;
  return { registry: next, folderName: record.folderName, authorKey: key, existing };
}
