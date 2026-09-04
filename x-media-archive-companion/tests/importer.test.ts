import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { copyMediaForReceipt } from "../src/fs.ts";
import { ArchiveImporter } from "../src/importer.ts";
import { mediaFileName, noteFileName } from "../src/naming.ts";
import { sampleJob, tempDirectory } from "./fixtures.ts";

test("re-importing a tweet whose text extraction changed replaces its note instead of adding one", async (t) => {
  // This is the real regression: X's schema change started including the
  // trailing media t.co token, the generated file name changed with it, and
  // nine notes ended up duplicated in the live vault.
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const jobDir = path.join(root, "job"); const vault = path.join(root, "vault");
  const folder = path.join(vault, "Tweets", "XMedia", "dummy");
  const importer = new ArchiveImporter({ now: () => new Date("2025-01-02T03:04:05.000Z") });

  await fs.mkdir(path.join(jobDir, "staging"), { recursive: true });
  await fs.writeFile(path.join(jobDir, "staging", "dummy.bin"), Buffer.from([0, 1, 2]));
  assert.equal((await importer.import(sampleJob(), jobDir, vault, "Tweets/XMedia")).state, "complete");
  const before = (await fs.readdir(folder)).filter((name) => name.includes("1830000000000000000"));
  assert.equal(before.length, 1);

  // A re-download arrives as a new job, so this is not the already-complete path.
  // The drift has to be something the t.co rule does not already normalise
  // away, or this would pass without the tweetId lookup doing anything.
  const drifted = sampleJob();
  drifted.jobId = "123e4567-e89b-42d3-a456-426614174001";
  drifted.posts[0].text = "dummy post, extracted differently this time";
  assert.notEqual(noteFileName(drifted.posts[0]), before[0], "the drift this guards against must be real");
  await fs.writeFile(path.join(jobDir, "staging", "dummy.bin"), Buffer.from([0, 1, 2]));
  const second = await importer.import(drifted, jobDir, vault, "Tweets/XMedia");
  assert.equal(second.state, "complete");

  const after = (await fs.readdir(folder)).filter((name) => name.includes("1830000000000000000"));
  assert.deepEqual(after, before, "the renamed body must land in the note that already holds this tweet");
  assert.equal(second.notes[0], `Tweets/XMedia/dummy/${before[0]}`, "the receipt points at the reused note");
  assert.match(await fs.readFile(path.join(folder, before[0]), "utf8"), /dummy post/);
});

test("a lost media commits its post as partial and a retry completes it", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const job = sampleJob(); const jobDir = path.join(root, "job"); const vault = path.join(root, "vault"); await fs.mkdir(path.join(jobDir, "staging"), { recursive: true });
  const importer = new ArchiveImporter({ now: () => new Date("2025-01-02T03:04:05.000Z") });
  const note = path.join(vault, "Tweets", "XMedia", "dummy", "2025-01-02_120405 - dummy post - 1830000000000000000.md");
  const profile = path.join(vault, "Tweets", "XMedia", "dummy", "_profile.md");
  const registry = path.join(vault, "Tweets", "XMedia", "_system", "profiles.json");
  const account = path.join(vault, "Tweets", "XMedia", "_accounts", "dummy.md");
  const index = path.join(vault, "Tweets", "XMedia", "dummy", "dummy.md");
  const receiptFile = path.join(vault, "Tweets", "XMedia", "_system", "receipts", `${job.jobId}.json`);
  const lost = await importer.import(job, jobDir, vault, "Tweets/XMedia");
  assert.equal(lost.state, "partial");
  assert.equal(lost.retryable, false, "a staged file that is gone will not come back");
  assert.equal(lost.notes.length, 1, "the post is archived even though its only media is gone");
  const partialNote = await fs.readFile(note, "utf8");
  assert.match(partialNote, /^archive_state: partial$/m);
  assert.equal(partialNote.match(/^> \[!xmc-tweet\]$/gm)?.length, 1, "an ordinary post has one accent wrapper");
  assert.match(partialNote, /^> dummy post$/m);
  assert.match(partialNote, /^> Original URL:/m);
  assert.match(partialNote, /Media pending repair/);
  assert.ok(partialNote.indexOf("Media pending repair") < partialNote.indexOf("Original URL:"), "Original URL is the last item in the tweet block");
  assert.doesNotMatch(partialNote, /!\[\[/, "a lost media is not embedded");
  await fs.stat(profile); await fs.stat(registry);
  const partialReceipt = await importer.getReceipt(vault, "Tweets/XMedia", job.jobId);
  assert.equal(partialReceipt?.state, "partial");
  assert.equal(partialReceipt?.posts[0].media[0].state, "partial");
  assert.equal(partialReceipt?.posts[0].media[0].vaultPath, null);
  assert.equal(await importer.receiptArtifactsPresent(vault, partialReceipt!), true, "a partial receipt is durable once what it claims exists");
  await fs.writeFile(path.join(jobDir, "staging", "dummy.bin"), Buffer.from([0, 1, 2]));
  assert.equal((await importer.import(job, jobDir, vault, "Tweets/XMedia")).state, "complete");
  assert.doesNotMatch(await fs.readFile(note, "utf8"), /Media pending repair/, "the repaired note drops the warning");
  await assert.rejects(fs.stat(path.join(jobDir, "staging", "dummy.bin")));
  await fs.stat(receiptFile);
  assert.match(await fs.readFile(note, "utf8"), /created_at: "2025-01-02T03:04:05.000Z"/);
  assert.match(await fs.readFile(profile, "utf8"), /first_screen_name: "dummy"/);
  const accountBody = await fs.readFile(account, "utf8");
  assert.match(accountBody, /^type: folder$/m);
  assert.match(accountBody, /^redirect: "Tweets\/XMedia\/dummy"$/m);
  const indexBody = await fs.readFile(index, "utf8");
  assert.match(indexBody, /^type: folder$/m);
  assert.match(indexBody, /^redirect: "Tweets\/XMedia\/_accounts"$/m);
  assert.match(indexBody, /アカウント一覧へ戻る/);
  assert.match(indexBody, /^sort: name-desc$/m, "the folder opens with the newest post first");
  assert.match(indexBody, /^cardLayout: vertical$/m, "and shows the image above the text, not beside it");
  assert.match(indexBody, /^pinned:\n {2}- "_profile\.md"\n {2}- "dummy\.md"$/m, "the profile and the way back stay at the head");
  const repairedNote = await fs.readFile(note, "utf8");
  assert.doesNotMatch(repairedNote, /投稿者プロフィール/);
  assert.doesNotMatch(repairedNote, /このユーザーの投稿フォルダ/);
  const accountsNotePath = path.join(vault, "Tweets", "XMedia", "_accounts", "_accounts.md");
  const accountsNote = await fs.readFile(accountsNotePath, "utf8");
  assert.match(accountsNote, /^cardLayout: vertical$/m, "the account list carries the same card shape");
  assert.match(accountsNote, /^sort: name-asc$/m);
  // GridExplorer keeps the user's pinned accounts and folder colour in this
  // same note, so it must be seeded once and never regenerated.
  await fs.writeFile(accountsNotePath, ["---", "pinned:", "  - dummy.md", "color: blue", "---", ""].join("\n"));
  const receipt = await importer.getReceipt(vault, "Tweets/XMedia", job.jobId);
  assert.equal(receipt?.posts[0].media[0].vaultPath, "Tweets/XMedia/_media/dummy/1830000000000000000_01_3_abc.bin");
  await fs.unlink(account); await fs.unlink(index);
  const orphanAccount = path.join(vault, "Tweets", "XMedia", "_accounts", "orphan.md");
  await fs.mkdir(path.dirname(orphanAccount), { recursive: true }); await fs.writeFile(orphanAccount, `---\nauthor_screen_name: "orphan"\nauthor_display_name: "Orphan User"\ncover_media: null\n---\n`);
  assert.equal(await importer.refreshExistingAccounts(vault, "Tweets/XMedia"), 2);
  assert.match(await fs.readFile(accountsNotePath, "utf8"), /^ {2}- dummy\.md$/m, "a refresh never touches the user's own pins");
  assert.match(await fs.readFile(account, "utf8"), /^redirect: "Tweets\/XMedia\/dummy"$/m);
  assert.match(await fs.readFile(orphanAccount, "utf8"), /^redirect: "Tweets\/XMedia\/orphan"$/m);
  assert.match(await fs.readFile(path.join(vault, "Tweets", "XMedia", "orphan", "orphan.md"), "utf8"), /^redirect: "Tweets\/XMedia\/_accounts"$/m);
  assert.match(await fs.readFile(path.join(vault, "Tweets", "XMedia", "orphan", "_profile.md"), "utf8"), /profile-pending/);
  await fs.writeFile(path.join(jobDir, "staging", "dummy.bin"), Buffer.from([0, 1, 2]));
  assert.equal((await importer.import(job, jobDir, vault, "Tweets/XMedia")).state, "already-complete");
  await assert.rejects(fs.stat(path.join(jobDir, "staging", "dummy.bin")));
});

test("a re-import preserves managed and unrelated post properties", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const jobDir = path.join(root, "job"); const vault = path.join(root, "vault");
  const staging = path.join(jobDir, "staging", "dummy.bin");
  await fs.mkdir(path.dirname(staging), { recursive: true }); await fs.writeFile(staging, Buffer.from([0, 1, 2]));
  const importer = new ArchiveImporter({ now: () => new Date("2025-01-02T03:04:05.000Z") });
  const first = sampleJob();
  assert.equal((await importer.import(first, jobDir, vault, "XMediaArchive")).state, "complete");
  const note = path.join(vault, "XMediaArchive", "dummy", "2025-01-02_120405 - dummy post - 1830000000000000000.md");
  const edited = (await fs.readFile(note, "utf8")).replace(
    /^---\n/,
    "---\nxmc_pinned: true\nxmc_favorite: true\nuser_custom: true\n",
  );
  await fs.writeFile(note, edited);

  const second = structuredClone(first);
  second.jobId = "223e4567-e89b-42d3-a456-426614174111";
  second.posts[0].media[0].downloadState = "skipped";
  second.posts[0].media[0].stagingRelativePath = null;
  assert.equal((await importer.import(second, path.join(root, "second-job"), vault, "XMediaArchive")).state, "complete");
  const after = await fs.readFile(note, "utf8");
  assert.match(after, /^xmc_pinned: true$/m);
  assert.match(after, /^xmc_favorite: true$/m, "Phase 3 can use the same durable mechanism");
  assert.match(after, /^user_custom: true$/m, "unmanaged properties remain untouched");
});

test("reply-tree posts become one ordered note without touching an existing individual post note", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault"); const importer = new ArchiveImporter({ now: () => new Date("2025-01-02T03:04:05.000Z") });
  const base = sampleJob();
  const rootPost = { ...structuredClone(base.posts[0]), text: "root", media: [], conversationId: "1830000000000000000" };
  const nextPost = { ...structuredClone(base.posts[0]), tweetId: "1830000000000000001", text: "next", createdAt: "2025-01-02T03:05:05.000Z", media: [],
    replyToTweetId: "1830000000000000000", replyToUserId: "42", conversationId: "1830000000000000000" };
  const existingIndividual = path.join(vault, "XMediaArchive", "dummy", "2025-01-02_120405 - root - 1830000000000000000.md");
  await fs.mkdir(path.dirname(existingIndividual), { recursive: true });
  await fs.writeFile(existingIndividual, "---\nuser_custom: keep\n---\n\nmanual body\n");
  const treeJob = { ...base, mode: "bulk", posts: [rootPost, nextPost] };
  const result = await importer.import(treeJob, path.join(root, "tree-job"), vault, "XMediaArchive");
  assert.equal(result.state, "complete");
  assert.equal(result.notes.length, 1);
  assert.equal(await fs.readFile(existingIndividual, "utf8"), "---\nuser_custom: keep\n---\n\nmanual body\n");
  const treeNote = path.join(vault, ...result.notes[0].split("/"));
  const body = await fs.readFile(treeNote, "utf8");
  assert.match(body, /^xmc_thread_root_tweet_id: "1830000000000000000"$/m);
  assert.match(body, /^xmc_thread_tweet_ids:\n  - "1830000000000000000"\n  - "1830000000000000001"$/m);
  assert.ok(body.indexOf("## 1/2") < body.indexOf("## 2/2"));
  assert.equal(body.match(/^> \[!xmc-tweet\]$/gm)?.length, 2, "each tree post has its own accent wrapper");
  assert.match(body, /^> root$/m);
  assert.match(body, /^> next$/m);
  assert.match(body, /root[\s\S]*next/);
  assert.doesNotMatch(body, /投稿者プロフィール/);
  assert.doesNotMatch(body, /このユーザーの投稿フォルダ/);
  const receipt = await importer.getReceipt(vault, "XMediaArchive", treeJob.jobId);
  assert.equal(new Set(receipt!.posts.map((post) => post.notePath)).size, 1);
});

test("media t.co suffix is omitted while external links remain and Original URL follows local media", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const jobDir = path.join(root, "job"); const vault = path.join(root, "vault");
  await fs.mkdir(path.join(jobDir, "staging"), { recursive: true });
  await fs.writeFile(path.join(jobDir, "staging", "dummy.bin"), Buffer.from([0, 1, 2]));
  const job = sampleJob();
  job.posts[0].text = "external https://example.invalid/page https://t.co/KeepEarlier https://t.co/MediaToken1";
  const importer = new ArchiveImporter({ now: () => new Date("2025-01-02T03:04:05.000Z") });
  const result = await importer.import(job, jobDir, vault, "XMediaArchive");
  const note = await fs.readFile(path.join(vault, ...result.notes[0].split("/")), "utf8");
  assert.match(note, /^> external https:\/\/example\.invalid\/page https:\/\/t\.co\/KeepEarlier$/m);
  assert.doesNotMatch(note, /MediaToken1/);
  assert.ok(note.indexOf("![[XMediaArchive/_media/") < note.indexOf("Original URL:"), "Original URL follows the media embed");

  const noMedia = sampleJob();
  noMedia.jobId = "223e4567-e89b-42d3-a456-426614174222";
  noMedia.posts[0].tweetId = "1830000000000000002";
  noMedia.posts[0].tweetUrl = "https://x.example/status/1830000000000000002";
  noMedia.posts[0].text = "external only https://t.co/KeepToken2";
  noMedia.posts[0].media = [];
  const noMediaResult = await importer.import(noMedia, path.join(root, "no-media-job"), vault, "XMediaArchive");
  const noMediaNote = await fs.readFile(path.join(vault, ...noMediaResult.notes[0].split("/")), "utf8");
  assert.match(noMediaNote, /^> external only https:\/\/t\.co\/KeepToken2$/m);
});

test("post setting text after the ownership marker remains user content", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const jobDir = path.join(root, "job"); const vault = path.join(root, "vault");
  const staging = path.join(jobDir, "staging", "dummy.bin");
  await fs.mkdir(path.dirname(staging), { recursive: true }); await fs.writeFile(staging, Buffer.from([0, 1, 2]));
  const importer = new ArchiveImporter({ now: () => new Date("2025-01-02T03:04:05.000Z") });
  const first = sampleJob();
  assert.equal((await importer.import(first, jobDir, vault, "XMediaArchive")).state, "complete");
  const note = path.join(vault, "XMediaArchive", "dummy", "2025-01-02_120405 - dummy post - 1830000000000000000.md");
  await fs.appendFile(note, "\nxmc_pinned: true\nxmc_favorite: true\n");

  const second = structuredClone(first);
  second.jobId = "323e4567-e89b-42d3-a456-426614174111";
  second.posts[0].media[0].downloadState = "skipped";
  second.posts[0].media[0].stagingRelativePath = null;
  assert.equal((await importer.import(second, path.join(root, "second-job"), vault, "XMediaArchive")).state, "complete");
  const after = await fs.readFile(note, "utf8");
  assert.match(after, /<!--xmc:user-->\n\nxmc_pinned: true\nxmc_favorite: true\n$/);
});

test("a complete receipt with a missing target is downgraded and never deletes the only staging copy", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const job = sampleJob(); const jobDir = path.join(root, "job"); const vault = path.join(root, "vault"); const staging = path.join(jobDir, "staging", "dummy.bin");
  await fs.mkdir(path.dirname(staging), { recursive: true }); await fs.writeFile(staging, Buffer.from([0, 1, 2]));
  const importer = new ArchiveImporter({ now: () => new Date("2025-01-02T03:04:05.000Z") });
  assert.equal((await importer.import(job, jobDir, vault, "Tweets/XMedia")).state, "complete");
  const receipt = await importer.getReceipt(vault, "Tweets/XMedia", job.jobId); assert.ok(receipt);
  const mediaPath = path.join(vault, ...receipt.posts[0].media[0].vaultPath!.split("/"));
  await fs.unlink(mediaPath); await fs.mkdir(path.dirname(staging), { recursive: true }); await fs.writeFile(staging, Buffer.from([0, 1, 2]));
  assert.equal((await importer.import(job, jobDir, vault, "Tweets/XMedia")).state, "complete");
  assert.equal(await importer.receiptArtifactsPresent(vault, (await importer.getReceipt(vault, "Tweets/XMedia", job.jobId))!), true);
  await assert.rejects(fs.stat(staging));
});

test("profile metadata is not erased by a later timeline post with empty bio and urls", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = sampleJob(); const jobDir = path.join(root, "job"); const vault = path.join(root, "vault");
  await fs.mkdir(path.join(jobDir, "staging"), { recursive: true }); await fs.writeFile(path.join(jobDir, "staging", "dummy.bin"), Buffer.from([0, 1, 2]));
  const importer = new ArchiveImporter(); assert.equal((await importer.import(first, jobDir, vault, "Tweets/XMedia")).state, "complete");
  const second = sampleJob(); second.jobId = "223e4567-e89b-42d3-a456-426614174000"; second.posts[0].tweetId = "1830000000000000001"; second.posts[0].author.bio = null; second.posts[0].author.urls = [];
  await fs.writeFile(path.join(jobDir, "staging", "dummy.bin"), Buffer.from([0, 1, 2]));
  assert.equal((await importer.import(second, jobDir, vault, "Tweets/XMedia")).state, "complete");
  const profile = await fs.readFile(path.join(vault, "Tweets", "XMedia", "dummy", "_profile.md"), "utf8");
  assert.match(profile, /Dummy biography/); assert.match(profile, /https:\/\/example\.invalid/);
});

test("an I/O failure on one media keeps the others and leaves the job retryable", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const job = sampleJob();
  job.posts[0].media.push({ mediaKey: "3_def", ordinal: 2, type: "photo", extension: "bin", stagingRelativePath: "staging/second.bin", downloadState: "complete" });
  const jobDir = path.join(root, "job"); const vault = path.join(root, "vault"); const staging = path.join(jobDir, "staging");
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(path.join(staging, "dummy.bin"), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(staging, "second.bin"), Buffer.from([3, 4, 5]));
  let copies = 0;
  const importer = new ArchiveImporter({
    now: () => new Date("2025-01-02T03:04:05.000Z"),
    materialize: async (fileSystem, source, target) => {
      copies += 1;
      if (copies === 2) throw new Error("injected second media failure");
      return copyMediaForReceipt(fileSystem, source, target);
    }
  });
  const result = await importer.import(job, jobDir, vault, "Tweets/XMedia");
  assert.equal(result.state, "partial");
  assert.equal(result.retryable, true, "an injected copy failure is not a settled loss");
  assert.match(result.failures[0], /injected second media failure/);
  // The intact media is committed and its staged copy released; the failed one
  // keeps its staged bytes so the retry still has something to copy.
  const firstTarget = path.join(vault, "Tweets", "XMedia", "_media", "dummy", mediaFileName(job.posts[0].tweetId, 1, "3_abc", "bin"));
  assert.equal((await fs.readFile(firstTarget)).length, 3);
  await assert.rejects(fs.stat(path.join(staging, "dummy.bin")));
  assert.equal((await fs.readFile(path.join(staging, "second.bin"))).length, 3);
  await fs.stat(path.join(vault, "Tweets", "XMedia", "dummy", "_profile.md"));
  await fs.stat(path.join(vault, "Tweets", "XMedia", "_system", "profiles.json"));
  const receipt = JSON.parse(await fs.readFile(path.join(vault, "Tweets", "XMedia", "_system", "receipts", `${job.jobId}.json`), "utf8"));
  assert.equal(receipt.state, "partial");
  assert.deepEqual(receipt.posts[0].media.map((item: { state: string }) => item.state), ["complete", "partial"]);
});

test("a manifest that already recorded a failed download is not retried", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const job = sampleJob();
  job.posts[0].media[0].downloadState = "missing"; job.posts[0].media[0].stagingRelativePath = null;
  job.posts[0].media[0].error = "download interrupted by user";
  const vault = path.join(root, "vault");
  const result = await new ArchiveImporter().import(job, path.join(root, "job"), vault, "Tweets/XMedia");
  assert.equal(result.state, "partial");
  assert.equal(result.retryable, false, "the manifest is immutable, so this loss is settled");
  assert.match(result.failures[0], /download-failed/, "the note names the download as the point of loss");
  const note = await fs.readFile(path.join(vault, "Tweets", "XMedia", "dummy", "2025-01-02_120405 - dummy post - 1830000000000000000.md"), "utf8");
  assert.match(note, /Media pending repair/);
  assert.match(note, /download interrupted by user/, "the producer's reason reaches the note instead of dying in the extension");
});
test("skipped media embeds its deterministic existing target and unsafe vault root is rejected", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const job = sampleJob(); job.posts[0].media[0].downloadState = "skipped"; job.posts[0].media[0].stagingRelativePath = null;
  const vault = path.join(root, "vault"); const target = path.join(vault, "Tweets", "XMedia", "_media", "dummy", mediaFileName(job.posts[0].tweetId, 1, "3_abc", "bin"));
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.mkdir(path.join(vault, "Tweets", "XMedia", "_system"), { recursive: true });
  await fs.writeFile(path.join(vault, "Tweets", "XMedia", "_system", "profiles.json"), JSON.stringify({ schemaVersion: 1, byId: { "42": { folder: "dummy", firstScreenName: "dummy", latestScreenName: "dummy", previousScreenNames: [] } }, pendingByScreen: {}, folderOwners: { dummy: "42" } }));
  await fs.writeFile(target, "dummy");
  assert.equal((await new ArchiveImporter().import(job, path.join(root, "job"), vault, "Tweets/XMedia")).state, "complete");
  await assert.rejects(new ArchiveImporter().import(job, path.join(root, "job"), vault, "Tweets/../escape"));
});

test("the profile body stays the bare bio and never absorbs generated sections", async () => {
  const vault = await tempDirectory();
  const jobDir = path.join(vault, "job");
  await fs.mkdir(path.join(jobDir, "staging"), { recursive: true });
  await fs.writeFile(path.join(jobDir, "staging", "dummy.bin"), Buffer.from([7, 8, 9]));
  const job = sampleJob();
  job.posts[0].author.bio = "しがないWebでざいなー";
  job.posts[0].author.urls = ["https://shop.invalid/"];

  const importer = new ArchiveImporter();
  assert.equal((await importer.import(job, jobDir, vault, "XMediaArchive")).state, "complete");
  const profileFile = path.join(vault, "XMediaArchive", "dummy", "_profile.md");
  assert.match(await fs.readFile(profileFile, "utf8"), /---\n\nしがないWebでざいなー\n$/);

  // A profile left behind by the heading/link-list version must collapse back
  // to its bio rather than keeping those sections as prose.
  const stale = ['---', 'schemaVersion: 1', 'author_id: "42"', 'display_name: "Dummy User"',
    'profile_metadata_status: "observed"', 'urls:', '  - "https://shop.invalid/"',
    'latest_archived_at: 2026-01-01T00:00:00.000Z', '---', '', '# Dummy User (@dummy)', '',
    'しがないWebでざいなー', '', '## リンク', '- https://shop.invalid/', ''].join("\n");
  await fs.writeFile(profileFile, stale);
  const second = { ...job, jobId: "423e4567-e89b-42d3-a456-426614174333",
    posts: [{ ...job.posts[0], tweetId: "1830000000000000009", tweetUrl: "https://x.example/status/1830000000000000009",
      author: { ...job.posts[0].author, bio: null, urls: [] },
      media: [{ ...job.posts[0].media[0], mediaKey: "3_def", stagingRelativePath: "staging/two.bin" }] }] };
  await fs.writeFile(path.join(jobDir, "staging", "two.bin"), Buffer.from([10, 11, 12]));
  assert.equal((await importer.import(second, jobDir, vault, "XMediaArchive")).state, "complete");
  const after = await fs.readFile(profileFile, "utf8");
  assert.doesNotMatch(after, /^# Dummy User/m, "the heading is not kept as bio text");
  assert.doesNotMatch(after, /^## リンク/m, "the generated link list is not kept as bio text");
  assert.match(after, /---\n\nしがないWebでざいなー\n$/);
  assert.match(after, /^ {2}- "https:\/\/shop\.invalid\/"$/m, "the links survive in frontmatter");
  await fs.rm(vault, { recursive: true, force: true });
});

test("a job of many posts by one author writes its profile and registry once", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const jobDir = path.join(root, "job"); const vault = path.join(root, "vault");
  await fs.mkdir(path.join(jobDir, "staging"), { recursive: true });
  const base = sampleJob();
  const posts = [];
  for (let index = 0; index < 12; index++) {
    const name = `staging/media-${index}.bin`;
    await fs.writeFile(path.join(jobDir, name), Buffer.from([index]));
    posts.push({
      ...base.posts[0],
      tweetId: `183000000000000${String(index).padStart(4, "0")}`,
      media: [{ ...base.posts[0].media[0], mediaKey: `3_key${index}`, stagingRelativePath: name }],
    });
  }
  const job = { ...base, posts };

  // Every post resolves the same author, so the profile and the registry are
  // rendered once per post. Only the first render can differ from what is
  // already on disk; the rest are byte-identical and must not be rewritten.
  const published: string[] = [];
  const realFs = (await import("../src/fs.ts")).diskFs;
  const countingFs = { ...realFs, async rename(from: string, to: string) { published.push(to); return realFs.rename(from, to); } };
  const importer = new ArchiveImporter({ fs: countingFs, now: () => new Date("2025-01-02T03:04:05.000Z") });
  assert.equal((await importer.import(job, jobDir, vault, "XMediaArchive")).state, "complete");

  const profile = path.join(vault, "XMediaArchive", "dummy", "_profile.md");
  const registry = path.join(vault, "XMediaArchive", "_system", "profiles.json");
  await fs.stat(profile); await fs.stat(registry);
  const times = (file: string): number => published.filter((target) => target === file).length;
  assert.equal(times(profile), 1, "the profile is published once, not once per post");
  assert.equal(times(registry), 1, "and so is the screen-name registry");
});
