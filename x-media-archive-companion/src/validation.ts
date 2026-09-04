import type { ArchiveAuthor, ArchiveJob, ArchiveMedia, ArchivePost, ArchiveReplyTree, JobCompleteMarker, ManifestEnvelope } from "./types.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_SEGMENT = /^[^<>:"/\\|?*\u0000-\u001f]+$/;
const SAFE_EXTENSION = /^[A-Za-z0-9]{1,10}$/;
const RESERVED_WINDOWS_SEGMENT = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
export class ContractError extends Error { constructor(message: string) { super(message); this.name = "ContractError"; } }
const asObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractError(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const asString = (value: unknown, label: string): string => { if (typeof value !== "string") throw new ContractError(`${label} must be a string`); return value; };
const asNullableString = (value: unknown, label: string): string | null => value === null ? null : asString(value, label);
const asArray = (value: unknown, label: string): unknown[] => { if (!Array.isArray(value)) throw new ContractError(`${label} must be an array`); return value; };
export const isUuidV4 = (value: string): boolean => UUID_V4.test(value);

export function validateStagingRelativePath(value: unknown): string {
  const result = asString(value, "stagingRelativePath");
  if (!result || result.startsWith("/") || result.includes("\\") || result.includes("//")) throw new ContractError("stagingRelativePath must be a POSIX relative path");
  for (const part of result.split("/")) {
    const deviceBase = part.split(".", 1)[0];
    if (part === "." || part === ".." || !SAFE_SEGMENT.test(part) || RESERVED_WINDOWS_SEGMENT.test(deviceBase)) {
      throw new ContractError("stagingRelativePath contains an unsafe segment");
    }
  }
  return result;
}
export function validateVaultRelativePath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("//")) throw new ContractError("vault path must be relative POSIX path");
  for (const part of value.split("/")) if (part === "." || part === ".." || !SAFE_SEGMENT.test(part)) throw new ContractError("vault path contains an unsafe segment");
  return value;
}
function validateFollowers(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ContractError("author.followers must be a non-negative integer or null");
  return value as number;
}
function validateAuthor(value: unknown): ArchiveAuthor {
  const v = asObject(value, "author");
  return { id: asNullableString(v.id, "author.id"), screenName: asString(v.screenName, "author.screenName"), displayName: asNullableString(v.displayName, "author.displayName"), bio: asNullableString(v.bio, "author.bio"), urls: asArray(v.urls, "author.urls").map((url, index) => asString(url, `author.urls[${index}]`)),
    location: v.location === undefined ? null : asNullableString(v.location, "author.location"),
    followers: validateFollowers(v.followers) };
}
function validateMedia(value: unknown, index: number): ArchiveMedia {
  const v = asObject(value, `media[${index}]`);
  const ordinal = v.ordinal;
  if (!Number.isInteger(ordinal) || (ordinal as number) < 1) throw new ContractError("media.ordinal must be an integer of at least 1");
  const downloadState = asString(v.downloadState, "media.downloadState");
  if (!(["pending", "complete", "skipped", "failed", "missing"] as string[]).includes(downloadState)) throw new ContractError("media.downloadState is invalid");
  const extension = asNullableString(v.extension, "media.extension");
  if (extension !== null && !SAFE_EXTENSION.test(extension)) throw new ContractError("media.extension is unsafe");
  const stagingRelativePath = v.stagingRelativePath === null ? null : validateStagingRelativePath(v.stagingRelativePath);
  if (downloadState === "complete" && stagingRelativePath === null) throw new ContractError("complete media requires stagingRelativePath");
  const type = asString(v.type, "media.type");
  if (!["photo", "video", "animated_gif"].includes(type)) throw new ContractError("media.type is invalid");
  // Producer-supplied free text: bounded and stripped of line breaks, because
  // it is rendered into a note and appended to a diagnostic line.
  const error = v.error === undefined || v.error === null ? null : asString(v.error, "media.error").replace(/[\r\n\t]+/g, " ").slice(0, 256);
  return { mediaKey: asString(v.mediaKey, "media.mediaKey"), ordinal: ordinal as number, type, extension: extension?.toLowerCase() ?? null, stagingRelativePath, downloadState: downloadState as ArchiveMedia["downloadState"], ...(error ? { error } : {}) };
}
function validateReplyTree(value: unknown): ArchiveReplyTree {
  const v = asObject(value, "post.replyTree");
  const tweetId = (item: unknown, label: string, nullable = false): string | null => {
    if (nullable && item === null) return null;
    const result = asString(item, label);
    if (!/^\d{1,30}$/.test(result)) throw new ContractError(`${label} must be a tweet ID`);
    return result;
  };
  if (!Number.isSafeInteger(v.position) || (v.position as number) < 1) throw new ContractError("post.replyTree.position is invalid");
  if (!Number.isSafeInteger(v.size) || (v.size as number) < 2 || (v.size as number) > 50 || (v.position as number) > (v.size as number)) {
    throw new ContractError("post.replyTree.size is invalid");
  }
  if (typeof v.partial !== "boolean") throw new ContractError("post.replyTree.partial must be a boolean");
  return {
    rootTweetId: tweetId(v.rootTweetId, "post.replyTree.rootTweetId") as string,
    previousTweetId: tweetId(v.previousTweetId, "post.replyTree.previousTweetId", true),
    nextTweetId: tweetId(v.nextTweetId, "post.replyTree.nextTweetId", true),
    position: v.position as number,
    size: v.size as number,
    partial: v.partial,
  };
}
function validatePost(value: unknown, index: number): ArchivePost {
  const v = asObject(value, `posts[${index}]`);
  const tweetId = asString(v.tweetId, "tweetId");
  if (!/^\d{1,30}$/.test(tweetId)) throw new ContractError("tweetId must be decimal digits");
  const createdAt = asNullableString(v.createdAt, "post.createdAt");
  if (createdAt !== null && Number.isNaN(Date.parse(createdAt))) throw new ContractError("post.createdAt is invalid");
  const metadataStatus = v.metadataStatus === undefined ? undefined : asString(v.metadataStatus, "post.metadataStatus");
  if (metadataStatus !== undefined && metadataStatus !== "complete" && metadataStatus !== "incomplete") throw new ContractError("post.metadataStatus is invalid");
  const profileMetadataStatus = v.profileMetadataStatus === undefined ? undefined : asString(v.profileMetadataStatus, "post.profileMetadataStatus");
  if (profileMetadataStatus !== undefined && profileMetadataStatus !== "observed" && profileMetadataStatus !== "profile-pending") throw new ContractError("post.profileMetadataStatus is invalid");
  const optionalTweetId = (field: "replyToTweetId" | "replyToUserId" | "conversationId"): string | null | undefined => {
    if (v[field] === undefined) return undefined;
    const result = asNullableString(v[field], `post.${field}`);
    if (result !== null && !/^\d{1,30}$/.test(result)) throw new ContractError(`post.${field} must be a tweet ID or null`);
    return result;
  };
  const replyToTweetId = optionalTweetId("replyToTweetId");
  const replyToUserId = optionalTweetId("replyToUserId");
  const conversationId = optionalTweetId("conversationId");
  return { tweetId, tweetUrl: asString(v.tweetUrl, "tweetUrl"), text: asNullableString(v.text, "text"), createdAt,
    ...(replyToTweetId === undefined ? {} : { replyToTweetId }), ...(replyToUserId === undefined ? {} : { replyToUserId }), ...(conversationId === undefined ? {} : { conversationId }),
    ...(metadataStatus ? { metadataStatus: metadataStatus as ArchivePost["metadataStatus"] } : {}), ...(profileMetadataStatus ? { profileMetadataStatus: profileMetadataStatus as ArchivePost["profileMetadataStatus"] } : {}), author: validateAuthor(v.author), media: asArray(v.media, "media").map(validateMedia), ...(v.replyTree === undefined ? {} : { replyTree: validateReplyTree(v.replyTree) }) };
}
export function validateArchiveJob(value: unknown): ArchiveJob {
  const v = asObject(value, "archive job");
  if (v.schemaVersion !== 1) throw new ContractError("unsupported archive job schemaVersion");
  const jobId = asString(v.jobId, "jobId");
  if (!isUuidV4(jobId)) throw new ContractError("jobId must be UUIDv4");
  const createdAt = asString(v.createdAt, "job.createdAt");
  if (Number.isNaN(Date.parse(createdAt)) || v.state !== "complete") throw new ContractError("archive job must be complete with a valid createdAt");
  const mode = asString(v.mode, "job.mode");
  if (mode !== "manual" && mode !== "bulk") throw new ContractError("archive job mode is invalid");
  const posts = asArray(v.posts, "job.posts").map(validatePost);
  const postsById = new Map(posts.map((post) => [post.tweetId, post]));
  const sameAuthor = (left: ArchivePost, right: ArchivePost): boolean => {
    if (left.author.id !== null && right.author.id !== null) return left.author.id === right.author.id;
    return left.author.screenName.toLowerCase() === right.author.screenName.toLowerCase();
  };
  const treeGroups = new Map<string, ArchivePost[]>();
  for (const post of posts) {
    if (!post.replyTree) continue;
    for (const related of [post.replyTree.rootTweetId, post.replyTree.previousTweetId, post.replyTree.nextTweetId]) {
      const target = related === null ? null : postsById.get(related);
      if (related !== null && !target) throw new ContractError("post.replyTree references a post outside the job");
      if (target && !sameAuthor(target, post)) throw new ContractError("post.replyTree crosses authors");
    }
    const group = treeGroups.get(post.replyTree.rootTweetId) ?? [];
    group.push(post); treeGroups.set(post.replyTree.rootTweetId, group);
  }
  for (const [rootTweetId, group] of treeGroups) {
    const ordered = [...group].sort((left, right) => left.replyTree!.position - right.replyTree!.position);
    const size = ordered[0].replyTree!.size;
    const partial = ordered[0].replyTree!.partial;
    if (ordered.length !== size || ordered.some((post) => post.replyTree!.size !== size || post.replyTree!.partial !== partial)
      || ordered[0].tweetId !== rootTweetId || ordered[0].replyTree!.position !== 1
      || ordered.some((post, index) => post.replyTree!.position !== index + 1
        || post.replyTree!.previousTweetId !== (index > 0 ? ordered[index - 1].tweetId : null)
        || post.replyTree!.nextTweetId !== (index + 1 < ordered.length ? ordered[index + 1].tweetId : null))) {
      throw new ContractError("post.replyTree chain metadata is inconsistent");
    }
  }
  return { schemaVersion: 1, jobId, mode, createdAt, state: "complete", posts };
}
export function validateCompleteMarker(value: unknown): JobCompleteMarker {
  const v = asObject(value, "complete marker"); const jobId = asString(v.jobId, "complete.jobId");
  if (v.schemaVersion !== 1 || v.kind !== "archive-job-complete" || !isUuidV4(jobId) || !Number.isInteger(v.chunkCount) || (v.chunkCount as number) < 1) throw new ContractError("invalid complete marker");
  return { schemaVersion: 1, kind: "archive-job-complete", jobId, chunkCount: v.chunkCount as number };
}
export function validateEnvelope(value: unknown): ManifestEnvelope {
  const v = asObject(value, "manifest chunk"); const jobId = asString(v.jobId, "manifest.jobId");
  if (v.schemaVersion !== 1 || v.kind !== "archive-job-chunk" || v.encoding !== "base64-utf8-json" || !isUuidV4(jobId) || !Number.isInteger(v.chunkIndex) || (v.chunkIndex as number) < 0 || !Number.isInteger(v.chunkCount) || (v.chunkCount as number) < 1) throw new ContractError("invalid manifest chunk");
  return { schemaVersion: 1, kind: "archive-job-chunk", jobId, chunkIndex: v.chunkIndex as number, chunkCount: v.chunkCount as number, encoding: "base64-utf8-json", payload: asString(v.payload, "manifest.payload") };
}
