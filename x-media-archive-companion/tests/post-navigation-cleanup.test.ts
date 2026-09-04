import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  applyPostNavigation, planPostNavigation, removeGeneratedPostNavigation, scanPostNavigation, verifyPostNavigation,
} from "../scripts/post-navigation-cleanup.ts";
import { tempDirectory } from "./fixtures.ts";

const frontmatter = (body: string) => `---\ntweet_id: "1"\nauthor_screen_name: "alice"\n---\n\n${body}\n`;
const execute = promisify(execFile);

test("cleanup only removes an exact generated first body line", () => {
  const navigation = "[[XMediaArchive/alice/_profile|投稿者プロフィール]] · [[XMediaArchive/alice/alice|このユーザーの投稿フォルダ]]";
  const changed = removeGeneratedPostNavigation(frontmatter(`${navigation}\n\n> [!xmc-tweet]\n> body`), "XMediaArchive", "alice");
  assert.equal(changed.changed, true); assert.equal(changed.profileLink, true); assert.equal(changed.folderLink, true);
  assert.equal(changed.output, frontmatter("> [!xmc-tweet]\n> body"));
  const bodyMention = frontmatter(`ordinary text\n\n${navigation}`);
  assert.equal(removeGeneratedPostNavigation(bodyMention, "XMediaArchive", "alice").changed, false);
  assert.equal(removeGeneratedPostNavigation(`---\ndisplay_name: Alice\n---\n\n${navigation}\n`, "XMediaArchive", "alice").isPost, false);
});

test("scan and plan are read-only; confirmed apply backs up, rewrites, and verifies", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, "XMediaArchive"); const author = path.join(archive, "alice"); await fs.mkdir(author, { recursive: true });
  const normal = path.join(author, "normal.md"); const tree = path.join(author, "tree.md"); const profile = path.join(author, "_profile.md");
  const normalOriginal = frontmatter("[[XMediaArchive/alice/_profile|投稿者プロフィール]] · [[XMediaArchive/alice/alice|このユーザーの投稿フォルダ]]\n\n> [!xmc-tweet]\n> normal");
  const treeOriginal = frontmatter("[[XMediaArchive/alice/alice|このユーザの投稿フォルダ]]\n\n# 返信ツリー\n\n## 1/2\n\n> tree");
  await fs.writeFile(normal, normalOriginal); await fs.writeFile(tree, treeOriginal);
  await fs.writeFile(profile, "---\ndisplay_name: Alice\n---\n\n[[XMediaArchive/alice/_profile|投稿者プロフィール]]\n");

  const scan = await scanPostNavigation(archive);
  assert.deepEqual(scan.summary, { markdownFiles: 3, postNotes: 2, candidates: 2, profileLinks: 1, folderLinks: 2, bothLinks: 1 });
  assert.equal(await fs.readFile(normal, "utf8"), normalOriginal, "scan is read-only");
  const plan = await planPostNavigation(archive, scan);
  assert.equal(await fs.readFile(tree, "utf8"), treeOriginal, "plan is read-only");
  const backupRoot = path.join(root, "run", "backup"); const receiptPath = path.join(root, "run", "receipt.json");
  await assert.rejects(() => applyPostNavigation(plan, archive, { backupRoot, receiptPath }), /--confirm/);

  await fs.writeFile(normal, `${normalOriginal}\nchanged after plan`);
  await assert.rejects(() => applyPostNavigation(plan, archive, { confirm: true, backupRoot, receiptPath }), /changed before apply/);
  await fs.writeFile(normal, normalOriginal);
  const result = await applyPostNavigation(plan, archive, { confirm: true, backupRoot, receiptPath });
  assert.equal(result.updated, 2);
  assert.equal(await fs.readFile(path.join(backupRoot, "alice", "normal.md"), "utf8"), normalOriginal);
  assert.equal(await fs.readFile(profile, "utf8"), "---\ndisplay_name: Alice\n---\n\n[[XMediaArchive/alice/_profile|投稿者プロフィール]]\n");
  const normalAfter = await fs.readFile(normal, "utf8"); const treeAfter = await fs.readFile(tree, "utf8");
  assert.doesNotMatch(normalAfter, /投稿者プロフィール|このユーザーの投稿フォルダ/);
  assert.match(normalAfter, /^> normal$/m);
  assert.doesNotMatch(treeAfter, /このユーザの投稿フォルダ/);
  assert.match(treeAfter, /^# 返信ツリー$/m);
  assert.deepEqual(await verifyPostNavigation(plan, archive), { ok: true, checked: 2, errors: [] });
});

test("CLI enforces scan, plan, confirmed apply, then verify", async (t) => {
  const root = await tempDirectory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, "XMediaArchive"); const author = path.join(archive, "alice"); await fs.mkdir(author, { recursive: true });
  const note = path.join(author, "post.md");
  await fs.writeFile(note, frontmatter("[[XMediaArchive/alice/_profile|投稿者プロフィール]]\n\n> post"));
  const run = path.join(root, "run"); const scan = path.join(run, "scan.json"); const plan = path.join(run, "plan.json");
  const script = fileURLToPath(new URL("../scripts/post-navigation-cleanup.ts", import.meta.url));
  const cli = (args: string[]) => execute(process.execPath, ["--experimental-strip-types", script, ...args]);
  await cli(["scan", "--archive", archive, "--out", scan]);
  await cli(["plan", "--archive", archive, "--scan", scan, "--out", plan]);
  await assert.rejects(() => cli(["apply", "--archive", archive, "--plan", plan]), /apply requires --confirm/);
  await cli(["apply", "--archive", archive, "--plan", plan, "--confirm"]);
  const verified = await cli(["verify", "--archive", archive, "--plan", plan]);
  assert.match(verified.stdout, /"ok":true/);
});
