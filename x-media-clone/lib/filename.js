// lib/filename.js
// Pure logic only: no chrome API / DOM API references (verified by grep during acceptance).
// Responsibilities: sanitize a single path segment, and assemble the final
// download filename/path for chrome.downloads.download.

const INVALID_CHARS_RE = /[<>:"/\\|?*\x00-\x1F]/g;
const TRAILING_DOT_SPACE_RE = /[.\s]+$/;
const RESERVED_NAMES_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * Sanitize a single filesystem path segment.
 * @param {unknown} s
 * @returns {string}
 */
export function sanitizePathSegment(s) {
  let value = String(s);
  value = value.replace(INVALID_CHARS_RE, "_");
  value = value.replace(TRAILING_DOT_SPACE_RE, "");
  if (value === "" || RESERVED_NAMES_RE.test(value)) {
    value = "_" + value;
  }
  return value;
}

/**
 * Build the download path/filename used with chrome.downloads.download.
 * @param {object} opts
 * @param {string} [opts.directory]
 * @param {string|null} [opts.accountFolder]
 * @param {string} opts.authorScreenName
 * @param {string} opts.tweetId
 * @param {number} opts.serial
 * @param {string} opts.ext
 * @returns {string}
 */
export function buildFilename({
  directory = "x_media_downloader",
  accountFolder,
  authorScreenName,
  tweetId,
  serial,
  ext,
}) {
  const dirSegment = sanitizePathSegment(directory);
  const author = sanitizePathSegment(authorScreenName);
  const id = sanitizePathSegment(String(tweetId));
  const serialStr = String(serial).padStart(2, "0");

  let extClean = String(ext).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (extClean === "") extClean = "bin";

  const baseName = `${author}-${id}-${serialStr}.${extClean}`;

  const segments = [dirSegment];
  if (accountFolder !== null && accountFolder !== undefined) {
    segments.push(sanitizePathSegment(accountFolder));
  }
  segments.push(baseName);

  return segments.join("/");
}
