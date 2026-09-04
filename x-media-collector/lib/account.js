// lib/account.js
// Pure logic only: no chrome API / DOM API references (verified by grep during acceptance).
// Responsibilities: twid cookie value parsing, screen_name sanitization,
// and extracting a screen_name from an array of DOM text strings.

const SCREEN_NAME_RE = /^[A-Za-z0-9_]{1,15}$/;
const AT_SCREEN_NAME_RE = /^@([A-Za-z0-9_]{1,15})$/;
const AVATAR_TESTID_RE = /^UserAvatar-Container-(.+)$/;

/**
 * Parse a `twid` cookie value into "id_<digits>" form.
 * Accepts "u%3D<digits>" (URL-encoded), "u=<digits>", and either form
 * optionally wrapped in double quotes. "%3D" is replaced case-insensitively.
 * @param {unknown} value
 * @returns {string|null}
 */
export function parseTwid(value) {
  if (typeof value !== "string") return null;
  const replaced = value.replace(/%3D/gi, "=");
  const match = /^"?u=(\d+)"?$/.exec(replaced);
  if (!match) return null;
  return "id_" + match[1];
}

/**
 * Sanitize a screen_name string.
 * - non-string -> null
 * - trim, strip a single leading "@"
 * - if it matches [A-Za-z0-9_]{1,15}, return as-is
 * - otherwise strip all non [A-Za-z0-9_] characters and clamp to 15 chars
 * - if the result is empty, return null
 * @param {unknown} s
 * @returns {string|null}
 */
export function sanitizeScreenName(s) {
  if (typeof s !== "string") return null;
  let value = s.trim();
  if (value.startsWith("@")) value = value.slice(1);
  if (SCREEN_NAME_RE.test(value)) return value;
  const stripped = value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 15);
  return stripped.length > 0 ? stripped : null;
}

/**
 * Extract the display screen_name from an X avatar container testid of the
 * form "UserAvatar-Container-<screen_name>". This is the most reliable source
 * of the logged-in account's *display* handle (the "@name"), preferred over
 * text parsing and over the numeric twid cookie fallback.
 * The captured segment is passed through sanitizeScreenName.
 * @param {unknown} testid
 * @returns {string|null}
 */
export function screenNameFromAvatarTestid(testid) {
  if (typeof testid !== "string") return null;
  const match = AVATAR_TESTID_RE.exec(testid);
  if (!match) return null;
  return sanitizeScreenName(match[1]);
}

/**
 * Pick the first text in `texts` that looks like "@handle" and return the
 * handle portion (without "@").
 * @param {string[]} texts
 * @returns {string|null}
 */
export function pickScreenNameFromTexts(texts) {
  if (!Array.isArray(texts)) return null;
  for (const text of texts) {
    if (typeof text !== "string") continue;
    const match = AT_SCREEN_NAME_RE.exec(text);
    if (match) return match[1];
  }
  return null;
}
