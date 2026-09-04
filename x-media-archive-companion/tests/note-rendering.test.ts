import assert from "node:assert/strict";
import test from "node:test";
import { postMarkdown, profileMarkdown, replyTreeMarkdown, type PreparedPost } from "../src/note-rendering.ts";
import { sampleJob } from "./fixtures.ts";

const NOW = new Date("2025-01-02T03:04:05.000Z");

test("note rendering preserves the profile golden bytes without filesystem access", () => {
  const job = sampleJob();
  job.posts[0].author.displayName = 'Name: "Q"';
  job.posts[0].author.bio = 'Bio: "quoted"';
  job.posts[0].author.urls = ["https://example.invalid/a?x=1&y=2"];
  job.posts[0].author.location = 'Tokyo: "east"';
  job.posts[0].author.followers = 7;
  assert.equal(profileMarkdown(job.posts[0], {
    folder: "dummy", firstScreenName: "dummy", latestScreenName: "dummy", previousScreenNames: [],
  }, NOW, null), `---
schemaVersion: 1
author_id: "42"
first_screen_name: "dummy"
latest_screen_name: "dummy"
previous_screen_names:

display_name: "Name: \\"Q\\""
location: "Tokyo: \\"east\\""
followers: 7
profile_metadata_status: "observed"
urls:
  - "https://example.invalid/a?x=1&y=2"
first_archived_at: 2025-01-02T03:04:05.000Z
latest_archived_at: 2025-01-02T03:04:05.000Z
---

Bio: "quoted"
`);
});

test("post and reply-tree renderers are pure and byte-exact", () => {
  const job = sampleJob();
  const post = job.posts[0];
  const expectedPost = `---
schemaVersion: 1
created_at: "2025-01-02T03:04:05.000Z"
archived_at: 2025-01-02T03:04:05.000Z
archive_job_id: "123e4567-e89b-42d3-a456-426614174000"
archive_state: complete
metadata_status: "complete"
tweet_id: "1830000000000000000"
tweet_url: "https://x.example/status/1830000000000000000"
author_id: "42"
author_screen_name: "dummy"
author_display_name: "Dummy User"
---

> [!xmc-tweet]
> dummy post
>
> ![[XMediaArchive/_media/dummy/1830000000000000000_01_3_abc.bin]]
>
> Original URL: [https://x.example/status/1830000000000000000](https://x.example/status/1830000000000000000)
<!--xmc:user-->
`;
  assert.equal(postMarkdown(post, job, NOW.toISOString(), "complete", ["XMediaArchive/_media/dummy/1830000000000000000_01_3_abc.bin"], [], "XMediaArchive", "dummy", null), expectedPost);

  const root = { ...structuredClone(post), media: [], text: "root", conversationId: post.tweetId, replyTree: {
    rootTweetId: post.tweetId, previousTweetId: null, nextTweetId: "1830000000000000001", position: 1, size: 2, partial: false,
  }};
  const child = { ...structuredClone(post), media: [], tweetId: "1830000000000000001", tweetUrl: "https://x.example/status/1830000000000000001", text: "reply", createdAt: "2025-01-02T03:05:05.000Z", replyTree: {
    rootTweetId: post.tweetId, previousTweetId: post.tweetId, nextTweetId: null, position: 2, size: 2, partial: false,
  }};
  const prepared: PreparedPost[] = [
    { post: root, folder: "dummy", state: "complete", embeds: [], failures: [], media: [] },
    { post: child, folder: "dummy", state: "complete", embeds: [], failures: [], media: [] },
  ];
  assert.equal(replyTreeMarkdown(prepared, { ...job, mode: "bulk", posts: [root, child] }, NOW.toISOString(), "XMediaArchive", null), `---
schemaVersion: 1
created_at: "2025-01-02T03:04:05.000Z"
archived_at: 2025-01-02T03:04:05.000Z
archive_job_id: "123e4567-e89b-42d3-a456-426614174000"
archive_state: complete
metadata_status: "complete"
tweet_id: "1830000000000000000"
tweet_url: "https://x.example/status/1830000000000000000"
author_id: "42"
author_screen_name: "dummy"
author_display_name: "Dummy User"
xmc_thread_root_tweet_id: "1830000000000000000"
xmc_thread_previous_tweet_id: ""
xmc_thread_next_tweet_id: "1830000000000000001"
xmc_thread_position: 1
xmc_thread_size: 2
xmc_thread_partial: false
xmc_thread_tweet_ids:
  - "1830000000000000000"
  - "1830000000000000001"
---


# 返信ツリー

## 1/2

> [!xmc-tweet]
> root
>
> Original URL: [https://x.example/status/1830000000000000000](https://x.example/status/1830000000000000000)

---

## 2/2

> [!xmc-tweet]
> reply
>
> Original URL: [https://x.example/status/1830000000000000001](https://x.example/status/1830000000000000001)
<!--xmc:user-->
`);
});
