import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { applyPlan, buildPlan, cleanedNoteName, verifyPlan } from "../scripts/note-name-cleanup.ts";
import { noteFileName, replyTreeNoteFileName } from "../src/naming.ts";
import { tempDirectory } from "./fixtures.ts";

test("every truncation of the token is removed, and nothing else is", () => {
  const id = "2087048728498803112";
  // The title is cut at 32 characters, so the token survives as any prefix of
  // "https t.co <token>".
  for (const tail of ["https", "https t", "https t.c", "https t.co", "https t.co X", "https t.co Xc6MB5QtWa"]) {
    assert.equal(
      cleanedNoteName(`2026-08-11_142927 - 毎度のことながら。 ${tail} - ${id}.md`),
      `2026-08-11_142927 - 毎度のことながら。 - ${id}.md`,
      `failed for tail: ${tail}`,
    );
  }
  assert.equal(cleanedNoteName(`2026-08-11_142927 - ツリー - 本文 https t.co abc - ${id}.md`), `2026-08-11_142927 - ツリー - 本文 - ${id}.md`);
  // A note that was nothing but the token falls back to the same title a fresh
  // import would generate.
  assert.equal(cleanedNoteName(`2026-08-11_142927 - https t.co feS2MpcqnH - ${id}.md`), `2026-08-11_142927 - post - ${id}.md`);
});

test("names without the token, and text that merely looks like it, are left alone", () => {
  const id = "2087048728498803112";
  assert.equal(cleanedNoteName(`2026-08-11_142927 - 毎度のことながら。 - ${id}.md`), null);
  // Only a trailing token is X's attachment marker.
  assert.equal(cleanedNoteName(`2026-08-11_142927 - https t.co abc の続き - ${id}.md`), null);
  assert.equal(cleanedNoteName("_profile.md"), null);
  assert.equal(cleanedNoteName("dummy.md"), null);
});

test("the cleaned name matches what a fresh import would now generate", () => {
  // The rename and the generator must agree, or the next import of a renamed
  // note would create a second file under yet another name.
  const post = { createdAt: "2026-08-11T05:29:27.000Z", tweetId: "2087048728498803112", text: "毎度のことながら。 https://t.co/Xc6MB5QtWa", media: [{}] };
  const legacy = "2026-08-11_142927 - 毎度のことながら。 https t.co Xc6MB5QtW - 2087048728498803112.md";
  assert.equal(cleanedNoteName(legacy), noteFileName(post));
  const legacyTree = "2026-08-11_142927 - ツリー - 毎度のことながら。 https t.co Xc6MB5QtW - 2087048728498803112.md";
  assert.equal(cleanedNoteName(legacyTree), replyTreeNoteFileName(post));
});

test("scan, apply and verify move notes and receipts together", async (t) => {
  const base = await tempDirectory();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "XMediaArchive");
  const folder = path.join(root, "alice");
  const receipts = path.join(root, "_system", "receipts");
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(receipts, { recursive: true });

  const dirty = "2026-08-11_142927 - 毎度のことながら。 https t.co Xc6MB5QtW - 2087048728498803112.md";
  const clean = "2026-08-11_142927 - 毎度のことながら。 - 2087048728498803112.md";
  const untouched = "2026-08-11_142928 - ふつうの本文 - 2087048728498803113.md";
  await fs.writeFile(path.join(folder, dirty), "本文\n", "utf8");
  await fs.writeFile(path.join(folder, untouched), "本文\n", "utf8");
  await fs.writeFile(path.join(receipts, "job.json"), JSON.stringify({
    jobId: "job", state: "complete",
    posts: [
      { tweetId: "2087048728498803112", state: "complete", notePath: `XMediaArchive/alice/${dirty}`, media: [] },
      { tweetId: "2087048728498803113", state: "complete", notePath: `XMediaArchive/alice/${untouched}`, media: [] },
    ],
  }, null, 2), "utf8");

  const plan = await buildPlan(base, "XMediaArchive");
  assert.equal(plan.summary.renames, 1);
  assert.equal(plan.summary.receipts, 1);
  assert.equal(plan.entries[0].to, clean);

  const backup = path.join(base, "backup");
  const applied = await applyPlan(base, plan, backup);
  assert.equal(applied.renamed, 1);

  assert.deepEqual((await fs.readdir(folder)).sort(), [clean, untouched].sort());
  await fs.stat(path.join(backup, "notes", "alice", dirty));
  await fs.stat(path.join(backup, "receipts", "job.json"));
  const rewritten = JSON.parse(await fs.readFile(path.join(receipts, "job.json"), "utf8"));
  assert.equal(rewritten.posts[0].notePath, `XMediaArchive/alice/${clean}`);
  assert.equal(rewritten.posts[1].notePath, `XMediaArchive/alice/${untouched}`, "an untouched note keeps its receipt entry");

  const verified = await verifyPlan(base, plan);
  assert.deepEqual(verified.errors, []);
  assert.equal(verified.ok, true);
});

test("a name whose clean form already exists is skipped, not overwritten", async (t) => {
  // The eight known duplicate pairs land here: renaming one onto the other
  // would destroy a note.
  const base = await tempDirectory();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const folder = path.join(base, "XMediaArchive", "alice");
  await fs.mkdir(folder, { recursive: true });
  const dirty = "2026-07-19_204913 - SUMMER IS COMING https t.c - 2078809379718262854.md";
  const clean = "2026-07-19_204913 - SUMMER IS COMING - 2078809379718262854.md";
  await fs.writeFile(path.join(folder, dirty), "xmc\n", "utf8");
  await fs.writeFile(path.join(folder, clean), "savexpost\n", "utf8");

  const plan = await buildPlan(base, "XMediaArchive");
  assert.equal(plan.summary.renames, 0);
  assert.equal(plan.summary.skippedCollision, 1);
  assert.match(plan.skipped[0].reason, /already exists/);
  assert.equal(await fs.readFile(path.join(folder, clean), "utf8"), "savexpost\n", "the existing note is untouched");
});

test("a note changed after the plan aborts the whole run and puts everything back", async (t) => {
  const base = await tempDirectory();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const folder = path.join(base, "XMediaArchive", "alice");
  await fs.mkdir(path.join(base, "XMediaArchive", "_system", "receipts"), { recursive: true });
  await fs.mkdir(folder, { recursive: true });
  const first = "2026-08-11_142927 - あ https t.co abc - 2087048728498803112.md";
  const second = "2026-08-11_142928 - い https t.co def - 2087048728498803113.md";
  await fs.writeFile(path.join(folder, first), "one\n", "utf8");
  await fs.writeFile(path.join(folder, second), "two\n", "utf8");

  const plan = await buildPlan(base, "XMediaArchive");
  assert.equal(plan.summary.renames, 2);
  await fs.writeFile(path.join(folder, second), "edited after the plan\n", "utf8");

  await assert.rejects(applyPlan(base, plan, path.join(base, "backup")), /changed since the plan/);
  assert.deepEqual((await fs.readdir(folder)).sort(), [first, second].sort(), "no note is left renamed");
});
