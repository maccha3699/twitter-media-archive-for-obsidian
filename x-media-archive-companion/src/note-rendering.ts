import type { ArchiveJob, ArchivePost, ReceiptMedia } from "./types.ts";
import { postAuthorNavigation } from "./post-navigation.ts";
import { noteTitleSource } from "./naming.ts";
import { mergeManagedFrontmatter, renderOwnedMarkdown } from "./markdown-ownership.ts";

export interface ProfileEntry {
  folder: string;
  firstScreenName: string;
  latestScreenName: string;
  previousScreenNames: string[];
}

export interface PreparedPost {
  post: ArchivePost;
  folder: string;
  state: "complete" | "partial";
  embeds: string[];
  failures: string[];
  media: ReceiptMedia[];
}

export const quote = (value: string | null): string => JSON.stringify(value ?? "");

/** Renders the managed account card while retaining user-owned properties. */
export function accountMarkdown(
  previous: string | null,
  root: string,
  folder: string,
  displayName: string,
  screenName: string,
  noteCount: number,
  mediaCount: number,
  coverPath: string | null,
): string {
  const summary = `投稿 ${noteCount} ・ メディア ${mediaCount}`;
  const generated = `---\nschemaVersion: 1\ngenerated_by: x-media-archive-companion\ntype: folder\nredirect: ${quote(`${root}/${folder}`)}\ntitle: ${quote(`${displayName} @${screenName}`)}\nsummary: ${quote(summary)}\nauthor_screen_name: ${quote(screenName)}\nauthor_display_name: ${quote(displayName)}\ncover_media: ${coverPath ? quote(coverPath) : "null"}\npost_count: ${noteCount}\nmedia_count: ${mediaCount}\n---\n\n${coverPath ? `![[${coverPath}]]\n\n` : ""}${summary}\n\nGridExplorerでこのカードを開くと投稿フォルダへ移動します。\n\n[[${root}/${folder}/_profile|プロフィール]]\n`;
  const keys = new Set(["schemaVersion", "generated_by", "type", "redirect", "title", "summary", "author_screen_name", "author_display_name", "cover_media", "post_count", "media_count"]);
  return previous ? mergeManagedFrontmatter(previous, generated, keys) : generated;
}

/** Recover only the user-authored bio from a previously rendered profile. */
export function previousProfileBody(previous: string | null): string | null {
  if (!previous) return null;
  const match = previous.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  let value = match?.[1]?.trim() ?? "";
  value = value.replace(/^#[^\n]*\r?\n?/, "");
  value = value.split(/^## /m)[0].trim();
  if (value === "_プロフィール未取得_") return null;
  return value || null;
}

export function previousProfileUrls(previous: string | null): string[] {
  if (!previous) return [];
  const block = previous.match(/^urls:\s*\r?\n((?:\s{2}-.*(?:\r?\n|$))*)/m)?.[1] ?? "";
  const values: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const raw = line.replace(/^\s{2}-\s*/, "").trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string" && parsed && !values.includes(parsed)) values.push(parsed);
    } catch { /* Only values emitted by this module are accepted. */ }
  }
  return values;
}

export function profileStringField(profile: string, key: string): string | null {
  const raw = profile.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" && parsed ? parsed : null;
  } catch { return null; }
}

export function profileMarkdown(post: ArchivePost, entry: ProfileEntry, now: Date, previous: string | null): string {
  const stamp = now.toISOString();
  const firstArchivedAt = previous?.match(/^first_archived_at:\s*(.+)$/m)?.[1]?.trim() ?? stamp;
  const bio = post.author.bio?.trim() || previousProfileBody(previous) || null;
  const urls = [...previousProfileUrls(previous)];
  for (const url of post.author.urls) if (url && !urls.includes(url)) urls.push(url);
  const location = post.author.location?.trim() || profileStringField(previous ?? "", "location") || null;
  const previousFollowers = previous?.match(/^followers:\s*(\d+)$/m)?.[1];
  const followers = Number.isSafeInteger(post.author.followers) && (post.author.followers as number) >= 0
    ? post.author.followers as number
    : previousFollowers !== undefined ? Number(previousFollowers) : null;
  const previousStatus = profileStringField(previous ?? "", "profile_metadata_status");
  const status = post.profileMetadataStatus === "observed" || previousStatus === "observed" || bio !== null || urls.length > 0 || location !== null ? "observed" : "profile-pending";
  const generated = `---\nschemaVersion: 1\nauthor_id: ${quote(post.author.id)}\nfirst_screen_name: ${quote(entry.firstScreenName)}\nlatest_screen_name: ${quote(entry.latestScreenName)}\nprevious_screen_names:\n${entry.previousScreenNames.map((name) => `  - ${quote(name)}`).join("\n")}\ndisplay_name: ${quote(post.author.displayName)}\nlocation: ${quote(location)}\nfollowers: ${followers ?? "null"}\nprofile_metadata_status: ${quote(status)}\nurls:\n${urls.map((url) => `  - ${quote(url)}`).join("\n")}\nfirst_archived_at: ${firstArchivedAt}\nlatest_archived_at: ${stamp}\n---\n\n${bio ?? ""}\n`;
  const keys = new Set(["schemaVersion", "author_id", "first_screen_name", "latest_screen_name", "previous_screen_names", "display_name", "location", "followers", "profile_metadata_status", "urls", "first_archived_at", "latest_archived_at"]);
  return previous ? mergeManagedFrontmatter(previous, generated, keys) : generated;
}

function preservedPostProperties(previous: string | null): string {
  if (!previous) return "";
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(previous)?.[1];
  if (!frontmatter) return "";
  return (["xmc_pinned", "xmc_favorite"] as const)
    .filter((field) => new RegExp(`^${field}:\\s*true\\s*$`, "m").test(frontmatter))
    .map((field) => `${field}: true\n`)
    .join("");
}

function replyTreeProperties(post: ArchivePost): string {
  const tree = post.replyTree;
  if (!tree) return "";
  return `xmc_thread_root_tweet_id: ${quote(tree.rootTweetId)}\nxmc_thread_previous_tweet_id: ${quote(tree.previousTweetId)}\nxmc_thread_next_tweet_id: ${quote(tree.nextTweetId)}\nxmc_thread_position: ${tree.position}\nxmc_thread_size: ${tree.size}\nxmc_thread_partial: ${tree.partial}\n`;
}

function tweetCallout(content: string): string {
  const quoted = content.replace(/\r\n/g, "\n").split("\n")
    .map((line) => line === "" ? ">" : `> ${line}`)
    .join("\n");
  return `> [!xmc-tweet]\n${quoted}`;
}

function tweetBody(post: ArchivePost): string { return noteTitleSource(post); }

function tweetContent(post: ArchivePost, embeds: string[], failures: string[]): string {
  const parts = [tweetBody(post)];
  if (embeds.length > 0) parts.push(embeds.map((embed) => `![[${embed}]]`).join("\n"));
  if (failures.length > 0) parts.push(`> [!warning] Media pending repair\n> ${failures.join("; ")}`);
  parts.push(`Original URL: [${post.tweetUrl}](${post.tweetUrl})`);
  return parts.filter((part) => part !== "").join("\n\n");
}

export function postMarkdown(post: ArchivePost, job: ArchiveJob, archivedAt: string, state: "complete" | "partial", embeds: string[], failures: string[], root: string, folder: string, previous: string | null): string {
  const userProperties = preservedPostProperties(previous);
  const tweet = tweetContent(post, embeds, failures);
  const authorNavigation = postAuthorNavigation(root, folder);
  const generated = `---\nschemaVersion: 1\ncreated_at: ${quote(post.createdAt ?? dateFromSnowflakeIso(post.tweetId))}\narchived_at: ${archivedAt}\narchive_job_id: ${quote(job.jobId)}\narchive_state: ${state}\nmetadata_status: ${quote(post.metadataStatus ?? "complete")}\ntweet_id: ${quote(post.tweetId)}\ntweet_url: ${quote(post.tweetUrl)}\nauthor_id: ${quote(post.author.id)}\nauthor_screen_name: ${quote(post.author.screenName)}\nauthor_display_name: ${quote(post.author.displayName)}\n${userProperties}---\n\n${authorNavigation ? `${authorNavigation}\n\n` : ""}${post.metadataStatus === "incomplete" ? "> [!note] Legacy media migration\n> 投稿本文と完全なプロフィール情報は未取得です。元URLから確認できます。\n\n" : ""}${tweetCallout(tweet)}\n`;
  return renderOwnedMarkdown(generated, previous);
}

export function replyTreeMarkdown(items: PreparedPost[], job: ArchiveJob, archivedAt: string, root: string, previous: string | null): string {
  const ordered = [...items].sort((left, right) => left.post.replyTree!.position - right.post.replyTree!.position);
  const first = ordered[0];
  const post = first.post;
  const state = ordered.some((item) => item.state === "partial") ? "partial" : "complete";
  const userProperties = preservedPostProperties(previous);
  const tweetIds = ordered.map((item) => `  - ${quote(item.post.tweetId)}`).join("\n");
  const sections = ordered.map((item) => {
    const position = item.post.replyTree!.position;
    return `## ${position}/${ordered.length}\n\n${tweetCallout(tweetContent(item.post, item.embeds, item.failures))}`;
  }).join("\n\n---\n\n");
  const partial = post.replyTree!.partial
    ? "\n> [!warning] この返信ツリーは表示済み範囲のみの部分保存です。\n"
    : "";
  const authorNavigation = postAuthorNavigation(root, first.folder);
  const generated = `---\nschemaVersion: 1\ncreated_at: ${quote(post.createdAt ?? dateFromSnowflakeIso(post.tweetId))}\narchived_at: ${archivedAt}\narchive_job_id: ${quote(job.jobId)}\narchive_state: ${state}\nmetadata_status: ${quote(ordered.some((item) => item.post.metadataStatus === "incomplete") ? "incomplete" : "complete")}\ntweet_id: ${quote(post.tweetId)}\ntweet_url: ${quote(post.tweetUrl)}\nauthor_id: ${quote(post.author.id)}\nauthor_screen_name: ${quote(post.author.screenName)}\nauthor_display_name: ${quote(post.author.displayName)}\n${userProperties}${replyTreeProperties(post)}xmc_thread_tweet_ids:\n${tweetIds}\n---\n\n${authorNavigation ? `${authorNavigation}\n` : ""}${partial}\n# 返信ツリー\n\n${sections}\n`;
  return renderOwnedMarkdown(generated, previous);
}

function dateFromSnowflakeIso(tweetId: string): string {
  return new Date(Number((BigInt(tweetId) >> 22n) + 1288834974657n)).toISOString();
}
