import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { auditReceipts } from "../scripts/audit-receipts.ts";
import { tempDirectory } from "./fixtures.ts";
import { mediaFileName } from "../src/naming.ts";

test("receipt audit downgrades false-complete records without reading image contents", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true })); const archive = path.join(root, "XMediaArchive");
  const notePath = "XMediaArchive/alice/post.md"; const mediaPath = "XMediaArchive/_media/alice/missing.jpg"; const receiptDir = path.join(archive, "_system", "receipts");
  await fs.mkdir(path.join(archive, "alice"), { recursive: true }); await fs.mkdir(receiptDir, { recursive: true });
  await fs.writeFile(path.join(root, ...notePath.split("/")), "---\narchive_state: complete\n---\n");
  const receipt = { schemaVersion: 1, jobId: "123e4567-e89b-42d3-a456-426614174000", state: "complete", importedAt: new Date().toISOString(), posts: [{ tweetId: "1", state: "complete", notePath, media: [{ tweetId: "1", mediaKey: "m", ordinal: 1, state: "complete", vaultPath: mediaPath }] }] };
  const file = path.join(receiptDir, `${receipt.jobId}.json`); await fs.writeFile(file, JSON.stringify(receipt));
  const report = await auditReceipts(root, "XMediaArchive", true); assert.equal(report.missing.length, 1); assert.deepEqual(report.repairedJobs, [receipt.jobId]);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).state, "partial"); assert.match(await fs.readFile(path.join(root, ...notePath.split("/")), "utf8"), /archive_state: partial/);
});

const JOB_PREFIX = "123e4567-e89b-42d3-a456-4266141740";
function media(tweetId: string, mediaKey: string, ordinal: number, vaultPath: string | null) {
  return { tweetId, mediaKey, ordinal, state: "complete" as const, vaultPath };
}
async function fixture(root: string, vaultRoot: string, posts: unknown[], state: "complete" | "partial" = "complete", id = "01") {
  const archive = path.join(root, ...vaultRoot.split("/"));
  const receiptDir = path.join(archive, "_system", "receipts");
  await fs.mkdir(receiptDir, { recursive: true });
  const jobId = `${JOB_PREFIX}${id}`;
  const receipt = { schemaVersion: 1, jobId, state, importedAt: new Date().toISOString(), posts };
  const file = path.join(receiptDir, `${jobId}.json`);
  await fs.writeFile(file, JSON.stringify(receipt));
  return { archive, receipt, file, jobId };
}
async function writeNote(root: string, notePath: string, state = "complete") {
  await fs.mkdir(path.dirname(path.join(root, ...notePath.split("/"))), { recursive: true });
  await fs.writeFile(path.join(root, ...notePath.split("/")), `---\narchive_state: ${state}\n---\n`);
}
async function writeMedia(root: string, vaultRoot: string, folder: string, item: { tweetId: string; mediaKey: string; ordinal: number }, extension = "bin") {
  const filename = mediaFileName(item.tweetId, item.ordinal, item.mediaKey, extension);
  const file = path.join(root, ...`${vaultRoot}/_media/${folder}/${filename}`.split("/"));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, new Uint8Array([0, 1, 2]));
  return filename;
}

test("empty, null, and whitespace paths use a unique filename fallback without repair", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultRoot = "XMediaArchive"; const notePath = `${vaultRoot}/alice/post.md`; const tweetId = "100";
  await writeNote(root, notePath);
  const items = [media(tweetId, "empty", 1, ""), media(tweetId, "null", 2, null), media(tweetId, "space", 3, "  ")];
  await writeMedia(root, vaultRoot, "alice", { tweetId, mediaKey: "empty", ordinal: 1 });
  await writeMedia(root, vaultRoot, "alice", { tweetId, mediaKey: "null", ordinal: 2 }, "dat");
  await writeMedia(root, vaultRoot, "alice", { tweetId, mediaKey: "space", ordinal: 3 }, "bin");
  const { file, jobId } = await fixture(root, vaultRoot, [{ tweetId, state: "complete", notePath, media: items }]);
  const before = await fs.readFile(file, "utf8"); const report = await auditReceipts(root, vaultRoot, true);
  assert.equal(report.missing.length, 0); assert.equal(report.located.length, 3); assert.equal(report.ambiguous.length, 0); assert.deepEqual(report.repairedJobs, []); assert.deepEqual(report.located.map((item) => item.jobId), [jobId, jobId, jobId]);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("a missing empty-path media is reported by identity and repaired", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultRoot = "XMediaArchive"; const notePath = `${vaultRoot}/alice/post.md`; await writeNote(root, notePath);
  const item = media("101", "lost", 7, null); const { file, jobId } = await fixture(root, vaultRoot, [{ tweetId: "101", state: "complete", notePath, media: [item] }]);
  const report = await auditReceipts(root, vaultRoot, true); assert.equal(report.missing.length, 1); assert.equal(report.missing[0].kind, "media");
  assert.equal((report.missing[0] as { mediaKey: string }).mediaKey, "lost"); assert.equal((report.missing[0] as { ordinal: number }).ordinal, 7); assert.deepEqual(report.repairedJobs, [jobId]);
  const repaired = JSON.parse(await fs.readFile(file, "utf8")); assert.equal(repaired.state, "partial"); assert.equal(repaired.posts[0].state, "partial"); assert.equal(repaired.posts[0].media[0].state, "partial"); assert.equal(repaired.posts[0].media[0].error, "vault target missing"); assert.match(await fs.readFile(path.join(root, ...notePath.split("/")), "utf8"), /archive_state: partial/);
});

test("a note read failure aborts repair before receipt rewrite", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultRoot = "XMediaArchive"; const notePath = `${vaultRoot}/alice/not-a-file`; await fs.mkdir(path.join(root, ...notePath.split("/")), { recursive: true });
  const { file } = await fixture(root, vaultRoot, [{ tweetId: "101-read-failure", state: "complete", notePath, media: [media("101-read-failure", "lost", 1, "XMediaArchive/_media/alice/nope.bin")] }]);
  await assert.rejects(() => auditReceipts(root, vaultRoot, true)); assert.equal(JSON.parse(await fs.readFile(file, "utf8")).state, "complete");
});

test("partial receipt with all artifacts is classified without promotion", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultRoot = "XMediaArchive"; const notePath = `${vaultRoot}/alice/post.md`; const tweetId = "102"; await writeNote(root, notePath);
  const filename = await writeMedia(root, vaultRoot, "alice", { tweetId, mediaKey: "ok", ordinal: 1 }); const vaultPath = `${vaultRoot}/_media/alice/${filename}`;
  const { file, jobId } = await fixture(root, vaultRoot, [{ tweetId, state: "partial", notePath, media: [media(tweetId, "ok", 1, vaultPath)] }], "partial");
  const report = await auditReceipts(root, vaultRoot, true); assert.deepEqual(report.partialWithAllArtifacts, [jobId]); assert.equal(report.missing.length, 0); assert.deepEqual(report.repairedJobs, []); assert.equal(JSON.parse(await fs.readFile(file, "utf8")).state, "partial");
});

test("multiple fallback candidates are ambiguous and never repaired", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultRoot = "XMediaArchive"; const notePath = `${vaultRoot}/alice/post.md`; const tweetId = "103"; await writeNote(root, notePath);
  await writeMedia(root, vaultRoot, "alice", { tweetId, mediaKey: "same", ordinal: 1 }, "jpg"); await writeMedia(root, vaultRoot, "alice", { tweetId, mediaKey: "same", ordinal: 1 }, "bin");
  const { file } = await fixture(root, vaultRoot, [{ tweetId, state: "complete", notePath, media: [media(tweetId, "same", 1, "")] }]); const before = await fs.readFile(file, "utf8");
  const report = await auditReceipts(root, vaultRoot, true); assert.equal(report.missing.length, 0); assert.equal(report.located.length, 0); assert.equal(report.ambiguous.length, 1); assert.equal(report.ambiguous[0].candidateCount, 2); assert.deepEqual(report.repairedJobs, []); assert.equal(await fs.readFile(file, "utf8"), before);
});

test("repair follows post and media indexes for duplicate tweetIds and shared notes", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultRoot = "XMediaArchive"; const notePath = `${vaultRoot}/alice/shared.md`; const tweetId = "104"; await writeNote(root, notePath);
  const good = media(tweetId, "good", 2, `${vaultRoot}/_media/alice/good.bin`); await fs.mkdir(path.dirname(path.join(root, ...good.vaultPath!.split("/"))), { recursive: true }); await fs.writeFile(path.join(root, ...good.vaultPath!.split("/")), "dummy");
  const { file } = await fixture(root, vaultRoot, [{ tweetId, state: "complete", notePath, media: [media(tweetId, "lost", 1, "")] }, { tweetId, state: "complete", notePath, media: [good] }]);
  const report = await auditReceipts(root, vaultRoot, true); assert.equal(report.missing.length, 1); const repaired = JSON.parse(await fs.readFile(file, "utf8")); assert.equal(repaired.posts[0].state, "partial"); assert.equal(repaired.posts[0].media[0].state, "partial"); assert.equal(repaired.posts[1].state, "complete"); assert.equal(repaired.posts[1].media[0].state, "complete");
  const note = await fs.readFile(path.join(root, ...notePath.split("/")), "utf8"); assert.equal((note.match(/Receipt integrity audit found missing archive files/g) ?? []).length, 1);
});

test("nested roots are supported and non-empty wrong paths do not fallback", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultRoot = "Outer/XMediaArchive"; const notePath = `${vaultRoot}/alice/post.md`; const tweetId = "105"; await writeNote(root, notePath);
  await writeMedia(root, vaultRoot, "alice", { tweetId, mediaKey: "wrong", ordinal: 1 });
  const { file } = await fixture(root, vaultRoot, [{ tweetId, state: "complete", notePath, media: [media(tweetId, "wrong", 1, `${vaultRoot}/_media/alice/not-the-file.bin`)] }]);
  const report = await auditReceipts(root, vaultRoot); assert.equal(report.missing.length, 1); assert.equal(report.located.length, 0); assert.equal(report.ambiguous.length, 0); assert.equal(JSON.parse(await fs.readFile(file, "utf8")).state, "complete");
});

test("vaultRoot must be a non-empty safe relative path", async () => {
  const root = await tempDirectory();
  try {
    for (const invalidRoot of ["../outside", "/absolute", "C:/absolute", "\\\\server\\share", "", "XMediaArchive/../outside", "XMediaArchive//child", "XMediaArchive/./child"]) {
      await assert.rejects(() => auditReceipts(root, invalidRoot), /vaultRoot must be a non-empty safe relative path/);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("invalid note paths cannot trigger a whole-vault fallback", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultRoot = "XMediaArchive"; await writeMedia(root, vaultRoot, "alice", { tweetId: "106", mediaKey: "bad", ordinal: 1 });
  const paths = [`${vaultRoot}/../alice/post.md`, `${vaultRoot}/alice/child/post.md`, "/outside/alice/post.md", `C:/outside/alice/post.md`, `\\\\server\\share\\post.md`];
  const posts = paths.map((notePath, index) => ({ tweetId: String(106 + index), state: "complete" as const, notePath, media: [media(String(106 + index), "bad", 1, null)] }));
  const report = await (async () => { await fixture(root, vaultRoot, posts); return auditReceipts(root, vaultRoot); })(); assert.equal(report.located.length, 0); assert.equal(report.missing.filter((item) => item.kind === "media").length, paths.length);
});

test("fallback ignores directory entries", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultRoot = "XMediaArchive"; const notePath = `${vaultRoot}/alice/post.md`; const tweetId = "111"; await writeNote(root, notePath);
  const folder = path.join(root, vaultRoot, "_media", "alice"); await fs.mkdir(path.join(folder, mediaFileName(tweetId, 1, "dir", "bin")), { recursive: true });
  const { file } = await fixture(root, vaultRoot, [{ tweetId, state: "complete", notePath, media: [media(tweetId, "dir", 1, null)] }]);
  const report = await auditReceipts(root, vaultRoot); assert.equal(report.located.length, 0); assert.equal(report.missing.length, 1); assert.equal(JSON.parse(await fs.readFile(file, "utf8")).state, "complete");
});

test("fallback ignores symlink entries when symlink creation is available", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultRoot = "XMediaArchive"; const notePath = `${vaultRoot}/alice/post.md`; const tweetId = "112"; await writeNote(root, notePath);
  const folder = path.join(root, vaultRoot, "_media", "alice"); await fs.mkdir(folder, { recursive: true });
  const target = path.join(root, "target.bin"); await fs.writeFile(target, "dummy");
  try { await fs.symlink(target, path.join(folder, mediaFileName(tweetId, 1, "link", "bin"))); } catch { t.skip("symlink creation is unavailable"); return; }
  const { file } = await fixture(root, vaultRoot, [{ tweetId, state: "complete", notePath, media: [media(tweetId, "link", 1, null)] }]);
  const report = await auditReceipts(root, vaultRoot); assert.equal(report.located.length, 0); assert.equal(report.missing.length, 1); assert.equal(JSON.parse(await fs.readFile(file, "utf8")).state, "complete");
});
