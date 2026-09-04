import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { ArchiveImporter } from "../src/importer.ts";
import { mediaFileName, noteFileName, profileFolderBase } from "../src/naming.ts";
import { markerLine, ownershipTail, renderOwnedMarkdown } from "../src/markdown-ownership.ts";
import { ABSOLUTE_PATH_BUDGET, COMPONENT_BUDGET, tempBasename } from "../src/path-safety.ts";
import { sampleJob } from "./fixtures.ts";

test("ownership marker keeps an existing CRLF tail byte-for-byte", () => {
  const generated = "---\nschemaVersion: 1\n---\n\nmanaged\n";
  const previous = `---\nschemaVersion: 1\nuser_tag:\n  - keep\n---\n\nold\n${markerLine().replace("\n", "\r\n")}user\r\ntext`;
  const result = renderOwnedMarkdown(generated, previous);
  assert.match(result, /user_tag:\n  - keep/);
  assert.equal(ownershipTail(result), "user\r\ntext");
});

test("unknown Unicode, quoted, and xmc properties remain outside the managed block", () => {
  const generated = "---\nschemaVersion: 1\ntweet_id: \"new\"\n---\n\nmanaged\n";
  const previous = "---\nschemaVersion: 1\ntweet_id: \"old\"\ntags:\n  - alpha\naliases: [\"old\", \"alias\"]\nflag: true\ncount: 3\nempty: null\nnested:\n  child:\n    - one\n日本語キー: 42\n\"quoted key\": true\nxmc_custom: keep\n---\n\nold\n<!--xmc:user-->\nmanual";
  const result = renderOwnedMarkdown(generated, previous);
  assert.match(result, /^tags:\n  - alpha$/m);
  assert.match(result, /^aliases: \["old", "alias"\]$/m);
  assert.match(result, /^flag: true$/m);
  assert.match(result, /^count: 3$/m);
  assert.match(result, /^empty: null$/m);
  assert.match(result, /^nested:\n  child:\n    - one$/m);
  assert.match(result, /^日本語キー: 42$/m);
  assert.match(result, /^\"quoted key\": true$/m);
  assert.match(result, /^xmc_custom: keep$/m);
  assert.match(result, /tweet_id: "new"/);
  assert.equal(ownershipTail(result), "manual");
});

test("malformed and duplicate markers fail closed", () => {
  assert.throws(() => ownershipTail("---\n---\n\n<!--xmc:user--> \n"));
  assert.throws(() => ownershipTail("<!--xmc:user-->\n<!--xmc:user-->\n"));
});

test("author and media names stay within component budget without raw identity suffixes", () => {
  const author = profileFolderBase("CON");
  assert.notEqual(author.toLowerCase(), "con");
  assert.ok(author.length <= COMPONENT_BUDGET);
  const media = mediaFileName("12345678901234567890", 1, "x".repeat(400), "jpeg");
  assert.ok(media.length <= COMPONENT_BUDGET);
  assert.match(media, /^12345678901234567890_01_.*-[0-9a-f]{12}\.jpeg$/);
  assert.match(tempBasename("write"), /^\.xmc-write-[0-9a-f-]{36}$/);
  assert.match(profileFolderBase("x".repeat(400)), /-[0-9a-f]{12}$/);
});

test("marker failure leaves registry, receipt, and staging untouched", async () => {
  const root = await mkdtemp(path.join(process.cwd(), "tmp-safety-"));
  try {
    const job = sampleJob(); const jobDirectory = path.join(root, "job"); const vault = path.join(root, "vault");
    const staging = path.join(jobDirectory, "staging", "dummy.bin");
    await mkdir(path.join(vault, "XMediaArchive", "dummy"), { recursive: true }); await mkdir(path.join(vault, "XMediaArchive", "_system"), { recursive: true }); await mkdir(path.dirname(staging), { recursive: true });
    await writeFile(path.join(vault, "XMediaArchive", "_system", "profiles.json"), JSON.stringify({ schemaVersion: 1, byId: { "42": { folder: "dummy", firstScreenName: "dummy", latestScreenName: "dummy", previousScreenNames: [] } }, pendingByScreen: {}, folderOwners: { dummy: "42" } }));
    await writeFile(staging, Buffer.from([1, 2, 3]));
    const note = path.join(vault, "XMediaArchive", "dummy", noteFileName(job.posts[0]));
    await writeFile(note, "---\nuser_custom: keep\n---\n\nold\n");
    const result = await new ArchiveImporter().import(job, jobDirectory, vault, "XMediaArchive");
    assert.equal(result.state, "failed"); assert.equal(result.retryable, true);
    await stat(staging); await stat(note);
    assert.equal((await readFile(path.join(vault, "XMediaArchive", "_system", "profiles.json"), "utf8")).includes('"42"'), true);
    await assert.rejects(stat(path.join(vault, "XMediaArchive", "_system", "receipts", `${job.jobId}.json`)));
    assert.ok(ABSOLUTE_PATH_BUDGET > COMPONENT_BUDGET);
    assert.equal(await readFile(note, "utf8"), "---\nuser_custom: keep\n---\n\nold\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
