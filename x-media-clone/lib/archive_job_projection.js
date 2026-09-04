// Pure projection from the persistent service-worker job shape to ArchiveJob
// v1. No browser, storage, listener, or network APIs belong in this boundary.

export function archiveJobFromPersistentJob(job) {
  return {
    schemaVersion: 1,
    jobId: job.jobId,
    mode: job.mode,
    createdAt: job.createdAt,
    state: "complete",
    posts: job.posts.map((post) => ({
      ...post,
      media: post.media.map((media) => {
        const current = job.media[media.mediaKey];
        const state = current?.state ?? media.downloadState ?? "missing";
        return {
          ...media,
          stagingRelativePath: state === "complete" ? media.stagingRelativePath : null,
          downloadState: state,
          // Why the download failed lives only in the ledger, which the
          // consumer cannot read. Without carrying it here, a lost item reaches
          // the archive as a bare "missing" and its cause is gone for good.
          error: state === "complete" ? null : current?.error ?? null,
        };
      }),
    })),
  };
}

/**
 * Return media settled complete by the ledger that no post in this job claims.
 * The caller reports these rather than suppressing the posts that did survive.
 */
export function orphanedMediaKeys(job) {
  const claimed = new Set(job.posts.flatMap((post) =>
    (Array.isArray(post?.media) ? post.media : []).map((media) => media.mediaKey)));
  return Object.entries(job.media)
    .filter(([mediaKey, media]) => media.state === "complete" && !claimed.has(mediaKey))
    .map(([mediaKey]) => mediaKey);
}
