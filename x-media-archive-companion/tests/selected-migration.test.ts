import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { applySelected, planSelected, verifySelected } from "../scripts/migrate-selected-images.ts";
import { tempDirectory } from "./fixtures.ts";

test("selected migration moves exactly ten opaque files and leaves every unselected file untouched", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "legacy"); const vault = path.join(root, "vault"); const staging = path.join(root, "staging");
  await fs.mkdir(source, { recursive: true });
  const selected = [];
  for (let index = 0; index < 10; index++) {
    const tweetId = String(1830000000000000000n + BigInt(index)); const sourcePath = path.join(source, `author${index}-${tweetId}-01.jpg`); const bytes = Buffer.from([index, index + 1, index + 2]);
    await fs.writeFile(sourcePath, bytes);
    selected.push({ sourcePath, size: bytes.length, authorScreenName: `author${index}`, tweetId, ordinal: 1, tweetUrl: `https://x.com/author${index}/status/${tweetId}` });
  }
  const sentinel = path.join(source, "not-selected.jpg"); await fs.writeFile(sentinel, Buffer.from([99, 98, 97]));
  const selection = path.join(root, "selection.json"); const plan = path.join(root, "plan.json");
  await fs.writeFile(selection, JSON.stringify({ schemaVersion: 1, kind: "xmedia-image-migration-sample", imageContentInspected: false, selected }));
  await planSelected(selection, plan, vault, "XMediaArchive", staging);
  assert.deepEqual(await fs.readFile(sentinel), Buffer.from([99, 98, 97]));
  assert.equal((await applySelected(plan)).moved, 10);
  assert.deepEqual(await verifySelected(plan), { ok: true, checked: 10, errors: [] });
  for (const entry of selected) await assert.rejects(fs.stat(entry.sourcePath));
  assert.deepEqual(await fs.readFile(sentinel), Buffer.from([99, 98, 97]));
  assert.match(await fs.readFile(path.join(vault, "XMediaArchive", "_accounts", "author0.md"), "utf8"), /^redirect: "XMediaArchive\/author0"$/m);
  assert.match(await fs.readFile(path.join(vault, "XMediaArchive", "author0", "author0.md"), "utf8"), /^redirect: "XMediaArchive\/_accounts"$/m);
});
