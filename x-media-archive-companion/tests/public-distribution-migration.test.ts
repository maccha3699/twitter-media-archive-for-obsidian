import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { applyPublicDistribution, main, planPublicDistribution, scanPublicDistribution, verifyPublicDistribution, OWNERSHIP_MARKER } from "../scripts/public-distribution-migration.ts";
import { writeAtomic } from "../src/fs.ts";
import { tempDirectory } from "./fixtures.ts";

const note = (tweetId: string, body = "managed\n") => `---\nschemaVersion: 1\narchive_job_id: "123e4567-e89b-42d3-a456-426614174000"\ntweet_id: "${tweetId}"\ntweet_url: "https://x.example/status/${tweetId}"\nauthor_id: "42"\nauthor_screen_name: "alice"\n---\n\n${body}`;
async function fixture() {
  const base = await tempDirectory(); const archive = path.join(base, "XMediaArchive"); const folder = path.join(archive, "alice");
  await fs.mkdir(path.join(archive, "_system", "receipts"), { recursive: true }); await fs.mkdir(path.join(archive, "_accounts"), { recursive: true }); await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "post.md"), note("1"));
  await fs.writeFile(path.join(archive, "_accounts", "alice.md"), "---\npost_count: 1\nmedia_count: 0\n---\n");
  await fs.writeFile(path.join(archive, "_system", "profiles.json"), JSON.stringify({ schemaVersion: 1, byId: { "42": { folder: "alice", firstScreenName: "alice", latestScreenName: "alice", previousScreenNames: [] } }, pendingByScreen: {}, folderOwners: { alice: "42" } }));
  return { base, archive, file: path.join(folder, "post.md") };
}

test("scan and plan are read-only and distinguish exact marker from candidates", async (t) => {
  const { base, archive, file } = await fixture(); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const before = await fs.readFile(file); const scan = await scanPublicDistribution(archive);
  assert.equal(scan.entries.length, 1); assert.equal(scan.audit.summary.postNotes, 1); assert.deepEqual(await fs.readFile(file), before);
  const plan = await planPublicDistribution(archive, scan); assert.equal(plan.entries[0].reason, "add ownership marker"); assert.match(plan.planId, /^[0-9a-f]{64}$/); assert.deepEqual(await fs.readFile(file), before);
});

test("plan CLI consumes --scan without requiring an input --plan", async (t) => {
  const { base, archive } = await fixture(); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const scanFile = path.join(base, "scan.json"); const planFile = path.join(base, "plan.json");
  await fs.writeFile(scanFile, JSON.stringify(await scanPublicDistribution(archive)));
  await main(["plan", "--archive", archive, "--scan", scanFile, "--out", planFile]);
  assert.equal(JSON.parse(await fs.readFile(planFile, "utf8")).kind, "xmc-public-distribution-migration-plan");
});

test("apply requires exact confirmation, backs up, and independent verify passes", async (t) => {
  const { base, archive, file } = await fixture(); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const plan = await planPublicDistribution(archive, await scanPublicDistribution(archive)); const run = path.join(base, "migration_runs", "private", "run");
  await assert.rejects(applyPublicDistribution(plan, archive, { confirm: "wrong", backupRoot: path.join(run, "backup"), receiptPath: path.join(run, "receipt.json") }), /exact/);
  const result = await applyPublicDistribution(plan, archive, { confirm: plan.planId, backupRoot: path.join(run, "backup"), receiptPath: path.join(run, "receipt.json") });
  assert.equal(result.updated, 1); assert.equal((await fs.readFile(file, "utf8")).endsWith(`${OWNERSHIP_MARKER}\n`), true); assert.deepEqual(await fs.readFile(path.join(run, "backup", "notes", "alice", "post.md")), Buffer.from(note("1")));
  const verified = await verifyPublicDistribution(plan, archive); assert.deepEqual(verified.errors, []);
});

test("drift stops the whole apply before backup or writes", async (t) => {
  const { base, archive, file } = await fixture(); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const plan = await planPublicDistribution(archive, await scanPublicDistribution(archive)); await fs.writeFile(file, `${note("1")}edited\n`);
  const backup = path.join(base, "backup"); await assert.rejects(applyPublicDistribution(plan, archive, { confirm: plan.planId, backupRoot: backup, receiptPath: path.join(base, "receipt.json") }), /changed/);
  await assert.rejects(fs.stat(backup)); assert.match(await fs.readFile(file, "utf8"), /edited/);
});

test("unsafe registry is manual review and blocks apply", async (t) => {
  const { base, archive } = await fixture(); t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(archive, "_system", "profiles.json"), "not json"); const plan = await planPublicDistribution(archive, await scanPublicDistribution(archive));
  assert.equal(plan.manualReview.some((item) => item.kind === "registry"), true); await assert.rejects(applyPublicDistribution(plan, archive, { confirm: plan.planId, backupRoot: path.join(base, "backup"), receiptPath: path.join(base, "receipt.json") }), /manual review/);
});

test("apply failure rolls published notes back to their exact bytes", async (t) => {
  const { base, archive, file } = await fixture(); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const second = path.join(archive, "alice", "second.md"); await fs.writeFile(second, note("2", "second\n"));
  const beforeFirst = await fs.readFile(file); const beforeSecond = await fs.readFile(second);
  const plan = await planPublicDistribution(archive, await scanPublicDistribution(archive)); let writes = 0;
  await assert.rejects(applyPublicDistribution(plan, archive, {
    confirm: plan.planId, backupRoot: path.join(base, "backup"), receiptPath: path.join(base, "receipt.json"),
    write: async (fileSystem, target, data) => { writes += 1; if (writes === 2) throw new Error("injected publish failure"); await writeAtomic(fileSystem, target, data); },
  }), /injected publish failure/);
  assert.deepEqual(await fs.readFile(file), beforeFirst); assert.deepEqual(await fs.readFile(second), beforeSecond);
});
