export const ARCHIVE_SCHEMA_VERSION = 1;
export const MAX_CHUNK_BYTES = 512 * 1024;

export type DownloadState = "pending" | "complete" | "skipped" | "failed" | "missing";

export interface ArchiveAuthor {
  id: string | null;
  screenName: string;
  displayName: string | null;
  bio: string | null;
  urls: string[];
  /** Free text X shows beside the bio; often a contact address, not a place. */
  location?: string | null;
  followers?: number | null;
}
export interface ArchiveMedia {
  mediaKey: string;
  ordinal: number;
  type: string;
  extension: string | null;
  stagingRelativePath: string | null;
  downloadState: DownloadState;
  /**
   * Why the producer could not download this item.  Without it a loss that was
   * already settled inside the extension arrives here as a bare "missing" and
   * its reason is unrecoverable, because it lives only in the extension's own
   * ledger.  Optional: v1 producers that predate the field simply omit it.
   */
  error?: string | null;
}
export interface ArchiveReplyTree {
  rootTweetId: string;
  previousTweetId: string | null;
  nextTweetId: string | null;
  position: number;
  size: number;
  /** True when a parent was unavailable, a branch was ambiguous, or the 50-post cap was reached. */
  partial: boolean;
}
export interface ArchivePost {
  tweetId: string;
  tweetUrl: string;
  text: string | null;
  createdAt: string | null;
  replyToTweetId?: string | null;
  replyToUserId?: string | null;
  conversationId?: string | null;
  metadataStatus?: "complete" | "incomplete";
  profileMetadataStatus?: "observed" | "profile-pending";
  author: ArchiveAuthor;
  media: ArchiveMedia[];
  replyTree?: ArchiveReplyTree;
}
/** The v1 producer may add fields; the reader intentionally ignores them. */
export interface ArchiveJob {
  schemaVersion: 1;
  jobId: string;
  mode: string;
  createdAt: string;
  state: "complete";
  posts: ArchivePost[];
}
export interface JobCompleteMarker {
  schemaVersion: 1;
  kind: "archive-job-complete";
  jobId: string;
  chunkCount: number;
}
export interface ManifestEnvelope {
  schemaVersion: 1;
  kind: "archive-job-chunk";
  jobId: string;
  chunkIndex: number;
  chunkCount: number;
  encoding: "base64-utf8-json";
  payload: string;
}
export interface ReceiptMedia {
  tweetId: string;
  mediaKey: string;
  ordinal: number;
  state: "complete" | "partial";
  vaultPath: string | null;
  error?: string;
}
export interface ReceiptPost { tweetId: string; state: "complete" | "partial"; notePath: string; media: ReceiptMedia[]; }
export interface Receipt {
  schemaVersion: 1;
  jobId: string;
  state: "complete" | "partial";
  importedAt: string;
  posts: ReceiptPost[];
}
export interface XmcSettings {
  inboxPath: string;
  vaultRoot: string;
  /** Gallery ordering, remembered between sessions. */
  accountSort: "name" | "posts" | "media" | "recent";
  postSort: "newest" | "oldest";
  /** Accounts at or below this many posts are listed apart; 0 keeps them together. */
  fewPostsThreshold: number;
}
export const DEFAULT_SETTINGS: XmcSettings = {
  inboxPath: "~/Downloads/XMediaClone/_jobs",
  vaultRoot: "XMediaArchive",
  accountSort: "name",
  postSort: "newest",
  fewPostsThreshold: 0,
};
