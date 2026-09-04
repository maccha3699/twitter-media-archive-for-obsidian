import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { ArchiveImporter } from "../src/importer.ts";
import { mediaFileName } from "../src/naming.ts";
import { sampleJob, tempDirectory } from "./fixtures.ts";

const NOW = new Date("2025-01-02T03:04:05.000Z");

async function read(vault: string, relative: string): Promise<string> {
  return fs.readFile(path.join(vault, ...relative.split("/")), "utf8");
}

async function stage(jobDirectory: string, name: string, bytes: Uint8Array): Promise<void> {
  const file = path.join(jobDirectory, "staging", name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}

test("ArchiveImporter golden: post, profile metadata, YAML quoting, and receipt bytes", async (t) => {
  const root = await tempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const jobDirectory = path.join(root, "job");
  const vault = path.join(root, "vault");
  const job = sampleJob();
  job.posts[0].text = 'YAML "quoted": value';
  job.posts[0].author.displayName = 'Name: "Q"';
  job.posts[0].author.bio = 'Bio: "quoted"';
  job.posts[0].author.urls = ["https://example.invalid/a?x=1&y=2"];
  job.posts[0].author.location = 'Tokyo: "east"';
  job.posts[0].author.followers = 7;
  await stage(jobDirectory, "dummy.bin", Buffer.from([0, 1, 2]));

  const importer = new ArchiveImporter({ now: () => NOW });
  const result = await importer.import(job, jobDirectory, vault, "XMediaArchive");
  assert.deepEqual(result, {
    jobId: "123e4567-e89b-42d3-a456-426614174000",
    state: "complete",
    notes: ["XMediaArchive/dummy/2025-01-02_120405 - YAML quoted value - 1830000000000000000.md"],
    failures: [],
    retryable: false,
  });

  assert.equal(await read(vault, result.notes[0]), `---
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
author_display_name: "Name: \\"Q\\""
---

> [!xmc-tweet]
> YAML "quoted": value
>
> ![[XMediaArchive/_media/dummy/1830000000000000000_01_3_abc.bin]]
>
> Original URL: [https://x.example/status/1830000000000000000](https://x.example/status/1830000000000000000)
<!--xmc:user-->
`);
  assert.equal(await read(vault, "XMediaArchive/dummy/_profile.md"), `---
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
  assert.equal(await read(vault, "XMediaArchive/_system/receipts/123e4567-e89b-42d3-a456-426614174000.json"), `{
  "schemaVersion": 1,
  "jobId": "123e4567-e89b-42d3-a456-426614174000",
  "state": "complete",
  "importedAt": "2025-01-02T03:04:05.000Z",
  "posts": [
    {
      "tweetId": "1830000000000000000",
      "state": "complete",
      "notePath": "XMediaArchive/dummy/2025-01-02_120405 - YAML quoted value - 1830000000000000000.md",
      "media": [
        {
          "tweetId": "1830000000000000000",
          "mediaKey": "3_abc",
          "ordinal": 1,
          "state": "complete",
          "vaultPath": "XMediaArchive/_media/dummy/1830000000000000000_01_3_abc.bin"
        }
      ]
    }
  ]
}
`);
  assert.deepEqual(await fs.readFile(path.join(vault, "XMediaArchive/_media/dummy/1830000000000000000_01_3_abc.bin")), Buffer.from([0, 1, 2]));
});

test("ArchiveImporter golden: direct replies become one ordered reply-tree note", async (t) => {
  const root = await tempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  const base = sampleJob();
  base.posts[0].media = [];
  const first = structuredClone(base.posts[0]);
  first.text = "root";
  first.conversationId = first.tweetId;
  const second = structuredClone(first);
  second.tweetId = "1830000000000000001";
  second.tweetUrl = "https://x.example/status/1830000000000000001";
  second.text = "reply";
  second.createdAt = "2025-01-02T03:05:05.000Z";
  second.replyToTweetId = first.tweetId;
  second.replyToUserId = "42";
  const job = { ...base, mode: "bulk", posts: [first, second] };
  const result = await new ArchiveImporter({ now: () => NOW }).import(job, path.join(root, "job"), vault, "XMediaArchive");
  assert.deepEqual(result, {
    jobId: "123e4567-e89b-42d3-a456-426614174000",
    state: "complete",
    notes: ["XMediaArchive/dummy/2025-01-02_120405 - ツリー - root - 1830000000000000000.md"],
    failures: [],
    retryable: false,
  });
  assert.equal(await read(vault, result.notes[0]), `---
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
  assert.equal(await read(vault, "XMediaArchive/_system/receipts/123e4567-e89b-42d3-a456-426614174000.json"), `{
  "schemaVersion": 1,
  "jobId": "123e4567-e89b-42d3-a456-426614174000",
  "state": "complete",
  "importedAt": "2025-01-02T03:04:05.000Z",
  "posts": [
    {
      "tweetId": "1830000000000000000",
      "state": "complete",
      "notePath": "XMediaArchive/dummy/2025-01-02_120405 - ツリー - root - 1830000000000000000.md",
      "media": []
    },
    {
      "tweetId": "1830000000000000001",
      "state": "complete",
      "notePath": "XMediaArchive/dummy/2025-01-02_120405 - ツリー - root - 1830000000000000000.md",
      "media": []
    }
  ]
}
`);
  assert.equal((await read(vault, result.notes[0])).includes("quote"), false, "ArchiveJob v1 has no quote-only output field");
});

test("ArchiveImporter golden: partial note and receipt retain the manifest loss", async (t) => {
  const root = await tempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  const job = sampleJob();
  job.posts[0].author.bio = null;
  job.posts[0].author.urls = [];
  job.posts[0].author.location = null;
  job.posts[0].author.followers = null;
  job.posts[0].media[0].downloadState = "missing";
  job.posts[0].media[0].stagingRelativePath = null;
  job.posts[0].media[0].error = 'network "lost"';
  const result = await new ArchiveImporter({ now: () => NOW }).import(job, path.join(root, "job"), vault, "XMediaArchive");
  assert.deepEqual(result, {
    jobId: "123e4567-e89b-42d3-a456-426614174000",
    state: "partial",
    notes: ["XMediaArchive/dummy/2025-01-02_120405 - dummy post - 1830000000000000000.md"],
    failures: ["1830000000000000000: 3_abc: download-failed — Xからの取得に失敗 (downloadState=missing) / network \"lost\""],
    retryable: false,
  });
  assert.equal(await read(vault, result.notes[0]), `---
schemaVersion: 1
created_at: "2025-01-02T03:04:05.000Z"
archived_at: 2025-01-02T03:04:05.000Z
archive_job_id: "123e4567-e89b-42d3-a456-426614174000"
archive_state: partial
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
> > [!warning] Media pending repair
> > 3_abc: download-failed — Xからの取得に失敗 (downloadState=missing) / network "lost"
>
> Original URL: [https://x.example/status/1830000000000000000](https://x.example/status/1830000000000000000)
<!--xmc:user-->
`);
  assert.equal(await read(vault, "XMediaArchive/_system/receipts/123e4567-e89b-42d3-a456-426614174000.json"), `{
  "schemaVersion": 1,
  "jobId": "123e4567-e89b-42d3-a456-426614174000",
  "state": "partial",
  "importedAt": "2025-01-02T03:04:05.000Z",
  "posts": [
    {
      "tweetId": "1830000000000000000",
      "state": "partial",
      "notePath": "XMediaArchive/dummy/2025-01-02_120405 - dummy post - 1830000000000000000.md",
      "media": [
        {
          "tweetId": "1830000000000000000",
          "mediaKey": "3_abc",
          "ordinal": 1,
          "state": "partial",
          "vaultPath": null,
          "error": "3_abc: download-failed — Xからの取得に失敗 (downloadState=missing) / network \\"lost\\""
        }
      ]
    }
  ]
}
`);
});

test("ArchiveImporter golden: tweet-id note reuse preserves pins/favorites and skipped media bytes", async (t) => {
  const root = await tempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const firstJobDirectory = path.join(root, "first-job");
  const secondJobDirectory = path.join(root, "second-job");
  const vault = path.join(root, "vault");
  const first = sampleJob();
  await stage(firstJobDirectory, "dummy.bin", Buffer.from([0, 1, 2]));
  const importer = new ArchiveImporter({ now: () => NOW });
  await importer.import(first, firstJobDirectory, vault, "XMediaArchive");
  const originalNote = path.join(vault, "XMediaArchive", "dummy", "2025-01-02_120405 - dummy post - 1830000000000000000.md");
  await fs.writeFile(originalNote, (await fs.readFile(originalNote, "utf8")).replace(/^---\n/, "---\nxmc_pinned: true\nxmc_favorite: true\n"));
  const media = path.join(vault, "XMediaArchive", "_media", "dummy", mediaFileName(first.posts[0].tweetId, 1, "3_abc", "bin"));
  await fs.writeFile(media, Buffer.from([9, 8, 7]));

  const second = structuredClone(first);
  second.jobId = "223e4567-e89b-42d3-a456-426614174111";
  second.posts[0].text = "changed body";
  second.posts[0].author.bio = null;
  second.posts[0].author.urls = [];
  second.posts[0].author.location = null;
  second.posts[0].author.followers = null;
  second.posts[0].media[0].downloadState = "skipped";
  second.posts[0].media[0].stagingRelativePath = null;
  const result = await importer.import(second, secondJobDirectory, vault, "XMediaArchive");
  assert.deepEqual(result, {
    jobId: "223e4567-e89b-42d3-a456-426614174111",
    state: "complete",
    notes: ["XMediaArchive/dummy/2025-01-02_120405 - dummy post - 1830000000000000000.md"],
    failures: [],
    retryable: false,
  });
  assert.equal(await read(vault, result.notes[0]), `---
schemaVersion: 1
created_at: "2025-01-02T03:04:05.000Z"
archived_at: 2025-01-02T03:04:05.000Z
archive_job_id: "223e4567-e89b-42d3-a456-426614174111"
archive_state: complete
metadata_status: "complete"
tweet_id: "1830000000000000000"
tweet_url: "https://x.example/status/1830000000000000000"
author_id: "42"
author_screen_name: "dummy"
author_display_name: "Dummy User"
xmc_pinned: true
xmc_favorite: true
---

> [!xmc-tweet]
> changed body
>
> ![[XMediaArchive/_media/dummy/1830000000000000000_01_3_abc.bin]]
>
> Original URL: [https://x.example/status/1830000000000000000](https://x.example/status/1830000000000000000)
<!--xmc:user-->
`);
  assert.equal(await read(vault, "XMediaArchive/dummy/_profile.md"), `---
schemaVersion: 1
author_id: "42"
first_screen_name: "dummy"
latest_screen_name: "dummy"
previous_screen_names:

display_name: "Dummy User"
location: "東京"
followers: 1234
profile_metadata_status: "observed"
urls:
  - "https://example.invalid"
first_archived_at: 2025-01-02T03:04:05.000Z
latest_archived_at: 2025-01-02T03:04:05.000Z
---

Dummy biography
`);
  assert.deepEqual(await fs.readFile(media), Buffer.from([9, 8, 7]), "a skipped existing target is never overwritten");
  assert.equal(await read(vault, "XMediaArchive/_system/receipts/223e4567-e89b-42d3-a456-426614174111.json"), `{
  "schemaVersion": 1,
  "jobId": "223e4567-e89b-42d3-a456-426614174111",
  "state": "complete",
  "importedAt": "2025-01-02T03:04:05.000Z",
  "posts": [
    {
      "tweetId": "1830000000000000000",
      "state": "complete",
      "notePath": "XMediaArchive/dummy/2025-01-02_120405 - dummy post - 1830000000000000000.md",
      "media": [
        {
          "tweetId": "1830000000000000000",
          "mediaKey": "3_abc",
          "ordinal": 1,
          "state": "complete",
          "vaultPath": "XMediaArchive/_media/dummy/1830000000000000000_01_3_abc.bin"
        }
      ]
    }
  ]
}
`);
});
