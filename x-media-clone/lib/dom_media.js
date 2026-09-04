import { normalizePhotoUrl } from "./media.js";

const MEDIA_HOST = "pbs.twimg.com";
const MEDIA_PATH_PREFIX = "/media/";
const SCREEN_NAME_RE = /^[A-Za-z0-9_]{1,15}$/;

export function photoMediaFromImageSrc(src) {
  const parsed = parseUrl(src, "https://x.com/");
  if (!parsed) return null;
  if (parsed.hostname !== MEDIA_HOST || !parsed.pathname.startsWith(MEDIA_PATH_PREFIX)) {
    return null;
  }

  const normalized = normalizePhotoUrl(parsed.href);
  if (!normalized) return null;
  return { type: "photo", url: normalized.url, ext: normalized.ext };
}

export function statusIdFromHref(href, baseUrl = "https://x.com/") {
  const parts = statusPathParts(href, baseUrl);
  if (!parts) return null;
  return parts.statusId;
}

export function screenNameFromStatusHref(href, tweetId, baseUrl = "https://x.com/") {
  const parts = statusPathParts(href, baseUrl);
  if (!parts || parts.statusId !== String(tweetId)) return null;
  if (!SCREEN_NAME_RE.test(parts.screenName)) return null;
  return parts.screenName;
}

function statusPathParts(href, baseUrl) {
  const parsed = parseUrl(href, baseUrl);
  if (!parsed) return null;

  const parts = parsed.pathname.split("/").filter(Boolean);
  const statusIndex = parts.indexOf("status");
  if (statusIndex <= 0 || statusIndex + 1 >= parts.length) return null;

  const screenName = parts[statusIndex - 1];
  const statusId = parts[statusIndex + 1];
  if (!/^\d+$/.test(statusId)) return null;
  return { screenName, statusId };
}

function parseUrl(value, baseUrl) {
  if (typeof value !== "string" || value === "") return null;
  try {
    return new URL(value, baseUrl);
  } catch {
    return null;
  }
}
