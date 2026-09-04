import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ArchiveImporter } from "../src/importer.ts";
import { diskFs, exists, safeJoin, sha256File, writeAtomic } from "../src/fs.ts";
import type { ArchiveJob, Receipt } from "../src/types.ts";

interface SelectedImage {
  sourcePath: string;
  size: number;
  authorScreenName: string;
  tweetId: string;
  ordinal: number;
  tweetUrl: string;
}
interface Selection { schemaVersion: 1; kind: "xmedia-image-migration-sample"; imageContentInspected: false; selected: SelectedImage[]; }
interface MigrationPlan {
  schemaVersion: 1;
  kind: "xmedia-selected-image-plan";
  jobId: string;
  createdAt: string;
  selectionSha256: string;
  vaultBase: string;
  vaultRoot: string;
  stagingRoot: string;
  entries: Array<SelectedImage & { extension: string; stagingRelativePath: string }>;
}

function args(values: string[]): Record<string, string> & { _: string[] } {
  const out = { _: [] as string[] } as Record<string, string> & { _: string[] };
  for (let i = 0; i < values.length; i++) {
    if (!values[i].startsWith("--")) out._.push(values[i]);
    else out[values[i].slice(2)] = values[++i];
  }
  return out;
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function extensionOf(file: string): string {
  const extension = path.extname(file).slice(1).toLowerCase();
  if (!/^(?:jpg|jpeg|png|webp|gif)$/.test(extension)) throw new Error(`selected file is not a supported image: ${file}`);
  return extension;
}
function validateSelection(value: unknown): Selection {
  const selection = value as Selection;
  if (!selection || selection.schemaVersion !== 1 || selection.kind !== "xmedia-image-migration-sample" || selection.imageContentInspected !== false || !Array.isArray(selection.selected)) throw new Error("invalid selection manifest");
  if (selection.selected.length !== 10) throw new Error("this guarded migration requires exactly 10 selected images");
  const paths = new Set<string>();
  for (const entry of selection.selected) {
    if (!path.isAbsolute(entry.sourcePath) || paths.has(entry.sourcePath.toLowerCase())) throw new Error("selected source paths must be unique absolute paths");
    paths.add(entry.sourcePath.toLowerCase());
    if (!/^\d{15,22}$/.test(entry.tweetId) || !Number.isInteger(entry.ordinal) || entry.ordinal < 1) throw new Error("selected tweet metadata is invalid");
    if (entry.tweetUrl !== `https://x.com/${entry.authorScreenName}/status/${entry.tweetId}`) throw new Error("selected tweet URL does not match its author and tweet ID");
    extensionOf(entry.sourcePath);
  }
  return selection;
}
async function readJson<T>(file: string): Promise<T> { return JSON.parse(await fs.readFile(path.resolve(file), "utf8")) as T; }
async function durableJson(file: string, value: unknown): Promise<void> { await writeAtomic(diskFs, path.resolve(file), JSON.stringify(value, null, 2) + "\n"); }
function snowflakeDate(tweetId: string): string { return new Date(Number((BigInt(tweetId) >> 22n) + 1288834974657n)).toISOString(); }

export async function planSelected(selectionFile: string, outputFile: string, vaultBase: string, vaultRoot = "XMediaArchive", stagingRoot = path.join(process.env.USERPROFILE ?? "", "Downloads", "XMediaClone", "_legacy-migration")): Promise<MigrationPlan> {
  const selection = validateSelection(await readJson(selectionFile));
  const jobId = randomUUID();
  const entries: MigrationPlan["entries"] = [];
  for (const [index, entry] of selection.selected.entries()) {
    const stat = await fs.lstat(entry.sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size) throw new Error(`selected source changed: ${entry.sourcePath}`);
    const extension = extensionOf(entry.sourcePath);
    entries.push({ ...entry, extension, stagingRelativePath: `staging/${String(index + 1).padStart(2, "0")}.${extension}` });
  }
  const plan: MigrationPlan = { schemaVersion: 1, kind: "xmedia-selected-image-plan", jobId, createdAt: new Date().toISOString(), selectionSha256: digest(selection.selected), vaultBase: path.resolve(vaultBase), vaultRoot, stagingRoot: path.resolve(stagingRoot), entries };
  await fs.writeFile(path.resolve(outputFile), JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
  return plan;
}

function validatePlan(value: unknown): MigrationPlan {
  const plan = value as MigrationPlan;
  if (!plan || plan.schemaVersion !== 1 || plan.kind !== "xmedia-selected-image-plan" || plan.entries?.length !== 10 || !/^[0-9a-f-]{36}$/i.test(plan.jobId)) throw new Error("invalid selected-image plan");
  validateSelection({ schemaVersion: 1, kind: "xmedia-image-migration-sample", imageContentInspected: false, selected: plan.entries.map(({ extension: _extension, stagingRelativePath: _staging, ...entry }) => entry) });
  return plan;
}
function archiveJob(plan: MigrationPlan): ArchiveJob {
  return {
    schemaVersion: 1, jobId: plan.jobId, mode: "manual", createdAt: new Date().toISOString(), state: "complete",
    posts: plan.entries.map((entry) => ({
      tweetId: entry.tweetId, tweetUrl: entry.tweetUrl, text: null, createdAt: snowflakeDate(entry.tweetId), metadataStatus: "incomplete",
      author: { id: null, screenName: entry.authorScreenName, displayName: null, bio: null, urls: [] },
      media: [{ mediaKey: `legacy_${entry.tweetId}_${entry.ordinal}`, ordinal: entry.ordinal, type: "photo", extension: entry.extension, stagingRelativePath: entry.stagingRelativePath, downloadState: "complete" }]
    }))
  };
}
function receiptMedia(receipt: Receipt, entry: MigrationPlan["entries"][number]): string {
  const post = receipt.posts.find((candidate) => candidate.tweetId === entry.tweetId);
  const media = post?.media.find((candidate) => candidate.ordinal === entry.ordinal);
  if (!media?.vaultPath || media.state !== "complete") throw new Error(`receipt lacks selected media ${entry.tweetId}:${entry.ordinal}`);
  return media.vaultPath;
}

export async function applySelected(planFile: string): Promise<{ jobId: string; moved: number; receipt: string }> {
  const plan = validatePlan(await readJson(planFile)); const jobDirectory = path.join(plan.stagingRoot, plan.jobId);
  await fs.mkdir(path.join(jobDirectory, "staging"), { recursive: true });
  for (const entry of plan.entries) {
    const sourceStat = await fs.lstat(entry.sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== entry.size) throw new Error(`selected source changed before apply: ${entry.sourcePath}`);
    const staged = safeJoin(jobDirectory, entry.stagingRelativePath);
    if (!await exists(diskFs, staged)) await fs.copyFile(entry.sourcePath, staged, constants.COPYFILE_EXCL);
    if ((await fs.stat(staged)).size !== entry.size || await sha256File(entry.sourcePath) !== await sha256File(staged)) throw new Error(`staging verification failed: ${entry.sourcePath}`);
  }
  const importer = new ArchiveImporter(); const outcome = await importer.import(archiveJob(plan), jobDirectory, plan.vaultBase, plan.vaultRoot);
  // A migration verifies every byte before importing, so anything short of a
  // clean import means the plan itself is wrong and must not be recorded.
  if (outcome.state !== "complete") throw new Error(`archive import failed (${outcome.state}): ${outcome.failures.join("; ")}`);
  const receipt = await importer.getReceipt(plan.vaultBase, plan.vaultRoot, plan.jobId);
  if (!receipt || receipt.state !== "complete" || !await importer.receiptArtifactsPresent(plan.vaultBase, receipt)) throw new Error("archive receipt is not complete and durable");
  const migrationReceiptFile = path.join(plan.vaultBase, plan.vaultRoot, "_system", "migrations", `${plan.jobId}.json`);
  const migrationEntries = [];
  for (const entry of plan.entries) {
    const vaultPath = receiptMedia(receipt, entry); const target = safeJoin(plan.vaultBase, vaultPath);
    const [sourceHash, targetHash] = await Promise.all([sha256File(entry.sourcePath), sha256File(target)]);
    if (sourceHash !== targetHash || (await fs.stat(target)).size !== entry.size) throw new Error(`final target verification failed: ${entry.tweetId}:${entry.ordinal}`);
    migrationEntries.push({ sourcePath: entry.sourcePath, tweetId: entry.tweetId, ordinal: entry.ordinal, tweetUrl: entry.tweetUrl, vaultPath, size: entry.size, sha256: sourceHash, sourceDeleted: false });
  }
  const migrationReceipt = { schemaVersion: 1, kind: "xmedia-selected-image-migration-receipt", jobId: plan.jobId, state: "imported-source-retained", createdAt: new Date().toISOString(), entries: migrationEntries };
  await durableJson(migrationReceiptFile, migrationReceipt);
  for (const entry of migrationEntries) {
    await fs.unlink(entry.sourcePath); entry.sourceDeleted = true; await durableJson(migrationReceiptFile, migrationReceipt);
  }
  migrationReceipt.state = "complete"; (migrationReceipt as typeof migrationReceipt & { completedAt?: string }).completedAt = new Date().toISOString(); await durableJson(migrationReceiptFile, migrationReceipt);
  return { jobId: plan.jobId, moved: migrationEntries.length, receipt: migrationReceiptFile };
}

export async function verifySelected(planFile: string): Promise<{ ok: boolean; checked: number; errors: string[] }> {
  const plan = validatePlan(await readJson(planFile)); const file = path.join(plan.vaultBase, plan.vaultRoot, "_system", "migrations", `${plan.jobId}.json`); const receipt = await readJson<any>(file);
  const result = { ok: true, checked: 0, errors: [] as string[] };
  for (const entry of receipt.entries ?? []) {
    result.checked++;
    try {
      if (!entry.sourceDeleted || await exists(diskFs, entry.sourcePath)) throw new Error("source was not removed");
      const target = safeJoin(plan.vaultBase, entry.vaultPath);
      if (!await exists(diskFs, target) || (await fs.stat(target)).size !== entry.size || await sha256File(target) !== entry.sha256) throw new Error("target verification failed");
    } catch (error) { result.ok = false; result.errors.push(`${entry.tweetId}:${entry.ordinal}: ${(error as Error).message}`); }
  }
  if (result.checked !== 10) { result.ok = false; result.errors.push(`expected 10 receipt entries, got ${result.checked}`); }
  return result;
}

async function main(): Promise<void> {
  const arg = args(process.argv.slice(2)); const command = arg._[0];
  if (command === "plan") {
    if (!arg.selection || !arg.out || !arg["vault-base"]) throw new Error("plan requires --selection, --out, and --vault-base");
    console.log(JSON.stringify(await planSelected(arg.selection, arg.out, arg["vault-base"], arg["vault-root"], arg["staging-root"]))); return;
  }
  if (command === "apply") { if (!arg.plan) throw new Error("apply requires --plan"); console.log(JSON.stringify(await applySelected(arg.plan))); return; }
  if (command === "verify") { if (!arg.plan) throw new Error("verify requires --plan"); const result = await verifySelected(arg.plan); console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 2; return; }
  throw new Error("usage: migrate-selected-images.ts <plan|apply|verify> ...");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
