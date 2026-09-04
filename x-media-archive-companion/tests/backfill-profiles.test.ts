import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { backfillProfiles, mergeProfile, parseAuthorNote, urlsFromBio } from "../scripts/backfill-profiles-from-savexpost.ts";
import { tempDirectory } from "./fixtures.ts";

test("SaveXPost author notes parse in both inline and block description styles", () => {
  const inline = parseAuthorNote(`---\nauthor: Inline Person\nauthor_screen_name: inline_one\nauthor_description: one line bio\nauthor_followers: 5\n---\n`);
  assert.deepEqual(inline, { screenName: "inline_one", displayName: "Inline Person", bio: "one line bio", location: "", followers: 5 });
  const block = parseAuthorNote(`---\nauthor: Block Person\nauthor_screen_name: block_one\nauthor_description: |-\n  first line\n  second line\nauthor_location: somewhere\n---\n`);
  assert.deepEqual(block, { screenName: "block_one", displayName: "Block Person", bio: "first line\nsecond line", location: "somewhere", followers: null });
  assert.equal(parseAuthorNote(`---\nauthor: No Screen Name\n---\n`), null);
});

test("bio links are collected already expanded and t.co shorteners are dropped", () => {
  assert.deepEqual(urlsFromBio("Booth https://x0.booth.pm/ Fanbox https://x0.fanbox.cc/ short https://t.co/abcd"),
    ["https://x0.booth.pm/", "https://x0.fanbox.cc/"]);
  assert.deepEqual(urlsFromBio("末尾の句読点 https://example.invalid/page. と続く"), ["https://example.invalid/page"]);
  assert.deepEqual(urlsFromBio("no links here"), []);
});

test("merging keeps unrelated fields, adds urls, and flips the pending status", () => {
  const previous = `---\nschemaVersion: 1\nauthor_id: "42"\nfirst_screen_name: "dummy"\nlatest_screen_name: "dummy"\nprevious_screen_names:\ndisplay_name: null\nprofile_metadata_status: "profile-pending"\nurls:\nfirst_archived_at: 2026-01-01T00:00:00.000Z\nlatest_archived_at: 2026-01-01T00:00:00.000Z\n---\n\n`;
  const merged = mergeProfile(previous, { screenName: "dummy", displayName: "Dummy", bio: "hello https://shop.invalid/x", location: "", followers: null }, "2026-02-02T00:00:00.000Z");
  assert.ok(merged);
  assert.match(merged, /^author_id: "42"$/m, "unrelated fields survive");
  assert.match(merged, /^first_archived_at: 2026-01-01T00:00:00\.000Z$/m, "first archive stamp is never rewritten");
  assert.match(merged, /^display_name: "Dummy"$/m);
  assert.match(merged, /^profile_metadata_status: "observed"$/m);
  assert.match(merged, /^urls:\n {2}- "https:\/\/shop\.invalid\/x"$/m);
  assert.match(merged, /\n---\n\nhello https:\/\/shop\.invalid\/x\n$/);
  // A second pass has nothing left to do.
  assert.equal(mergeProfile(merged, { screenName: "dummy", displayName: "Dummy", bio: "hello https://shop.invalid/x", location: "", followers: null }, "2026-03-03T00:00:00.000Z"), null);
});

test("an existing bio is never replaced by the SaveXPost copy", () => {
  const previous = `---\nschemaVersion: 1\nauthor_id: "9"\ndisplay_name: "Kept"\nprofile_metadata_status: "observed"\nurls:\nlatest_archived_at: 2026-01-01T00:00:00.000Z\n---\n\nobserved bio from graphql\n`;
  const merged = mergeProfile(previous, { screenName: "kept", displayName: "Other", bio: "older savexpost bio https://link.invalid/a", location: "mail@example.invalid", followers: 42 }, "2026-02-02T00:00:00.000Z");
  assert.ok(merged);
  assert.match(merged, /\n---\n\nobserved bio from graphql\n$/, "the richer observed bio wins");
  assert.match(merged, /^ {2}- "https:\/\/link\.invalid\/a"$/m, "but its links are still recovered");
});

test("backfill only rewrites archive folders that have a SaveXPost record", async () => {
  const vault = await tempDirectory();
  const archive = path.join(vault, "XMediaArchive");
  const authors = path.join(vault, "Tweets", "Authors");
  await fs.mkdir(authors, { recursive: true });
  await fs.writeFile(path.join(authors, "known.md"), `---\nauthor: Known\nauthor_screen_name: known\nauthor_description: bio https://known.invalid/\n---\n`);
  const empty = `---\nschemaVersion: 1\nauthor_id: null\ndisplay_name: null\nprofile_metadata_status: "profile-pending"\nurls:\nlatest_archived_at: 2026-01-01T00:00:00.000Z\n---\n\n`;
  for (const folder of ["known", "unknown"]) {
    await fs.mkdir(path.join(archive, folder), { recursive: true });
    await fs.writeFile(path.join(archive, folder, "_profile.md"), empty);
  }
  await fs.mkdir(path.join(archive, "_media"), { recursive: true });

  const dry = await backfillProfiles(vault, "XMediaArchive", "Tweets/Authors", false);
  assert.deepEqual({ scanned: dry.scanned, matched: dry.matched, updated: dry.updated }, { scanned: 2, matched: 1, updated: 1 });
  assert.equal(await fs.readFile(path.join(archive, "known", "_profile.md"), "utf8"), empty, "a dry run writes nothing");

  const applied = await backfillProfiles(vault, "XMediaArchive", "Tweets/Authors", true);
  assert.equal(applied.updated, 1);
  assert.match(await fs.readFile(path.join(archive, "known", "_profile.md"), "utf8"), /observed[\s\S]*known\.invalid[\s\S]*bio https/);
  assert.equal(await fs.readFile(path.join(archive, "unknown", "_profile.md"), "utf8"), empty, "folders without a record stay untouched");
  await fs.rm(vault, { recursive: true, force: true });
});

test("a quoted inline description loses its YAML quotes and the placeholder never survives", () => {
  const record = parseAuthorNote(['---', 'author: Quoted', 'author_screen_name: quoted',
    'author_description: "bio with: a colon https://shop.invalid/"', '---', ''].join("\n"));
  assert.equal(record?.bio, "bio with: a colon https://shop.invalid/", "YAML quoting is syntax, not bio text");

  const previous = ['---', 'schemaVersion: 1', 'display_name: null', 'profile_metadata_status: "profile-pending"',
    'urls:', 'latest_archived_at: 2026-01-01T00:00:00.000Z', '---', '', '_プロフィール未取得_', ''].join("\n");
  const merged = mergeProfile(previous, record!, "2026-02-02T00:00:00.000Z");
  assert.ok(merged);
  assert.match(merged, /\n---\n\nbio with: a colon https:\/\/shop\.invalid\/\n$/, "the placeholder is replaced, not kept");
  assert.match(merged, /^ {2}- "https:\/\/shop\.invalid\/"$/m);
});
