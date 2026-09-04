#!/usr/bin/env node
/**
 * Renames post notes whose file name still carries the media t.co token.
 *
 * The token used to reach the file name because only the rendered body dropped
 * it. Since the title is cut at 32 characters it also displaced the real text,
 * so 5,853 of 8,823 notes were named things like
 * "肉まんを食べたい女の子と慈悲捨て店員さん https t.c - <id>.md".
 * `noteFileName` no longer does that; this brings the existing names in line.
 *
 * The new name is derived from the old name, not from the note body: the body
 * is not a reliable source for notes imported before the display-side fix, and
 * deriving from the name keeps every change inspectable in the plan.
 *
 * Receipts record `notePath`, so a rename without updating them would leave the
 * audit pointing at files that no longer exist. Both move together or not at
 * all.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { diskFs, writeAtomic } from "../src/fs.ts";

const SYSTEM_FOLDERS = new Set(["_accounts", "_media", "_system"]);
const BATCH_SIZE = 16;

/**
 * `safeName` turns "https://t.co/Xc6MB5QtWa" into "https t.co Xc6MB5QtWa" and
 * then the title is cut at 32 characters, so what survives is any prefix of
 * that. Trailing dots and spaces are stripped by safeName, which is why "t." and
 * "t.co " never appear as endings.
 */
const TRAILING_TCO = /(?:^|\s+)https(\s+t(\.co?)?(\s+[A-Za-z0-9]+)?)?$/u;
const NOTE_NAME = /^(?<stamp>\d{4}-\d{2}-\d{2}_\d{6}) - (?<tree>ツリー - )?(?<title>.*) - (?<id>\d+)\.md$/u;

export interface RenameEntry {
  folder: string;
  from: string;
  to: string;
  tweetId: string;
  sha256: string;
}

export interface RenamePlan {
  schemaVersion: 1;
  kind: "xmc-note-name-cleanup-plan";
  archiveRoot: string;
  createdAt: string;
  summary: { postNotes: number; withToken: number; renames: number; skippedCollision: number; skippedUnparsed: number; receipts: number };
  entries: RenameEntry[];
  skipped: Array<{ folder: string; name: string; reason: string }>;
  receipts: Array<{ file: string; replacements: number }>;
}

/** The name this note should have, or null when nothing needs to change. */
export function cleanedNoteName(name: string): string | null {
  const match = NOTE_NAME.exec(name);
  if (!match?.groups) return null;
  const { stamp, tree, title, id } = match.groups as Record<string, string | undefined>;
  const stripped = (title ?? "").replace(TRAILING_TCO, "").replace(/[. ]+$/u, "");
  const nextTitle = stripped === "" ? "post" : stripped;
  if (nextTitle === title) return null;
  return `${stamp} - ${tree ?? ""}${nextTitle} - ${id}.md`;
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex").toUpperCase();
}

async function listAuthorFolders(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && !SYSTEM_FOLDERS.has(entry.name)).map((entry) => entry.name);
}

export async function buildPlan(base: string, archiveRoot: string): Promise<RenamePlan> {
  const root = path.join(base, archiveRoot);
  const entries: RenameEntry[] = [];
  const skipped: RenamePlan["skipped"] = [];
  let postNotes = 0;
  let withToken = 0;

  for (const folder of await listAuthorFolders(root)) {
    const folderPath = path.join(root, folder);
    const names = (await fs.readdir(folderPath)).filter((name) => name.endsWith(".md"));
    const present = new Set(names);
    const claimed = new Set<string>();
    for (const name of names) {
      const parsed = NOTE_NAME.exec(name);
      if (!parsed) continue;
      postNotes += 1;
      const next = cleanedNoteName(name);
      if (next === null) continue;
      withToken += 1;
      // Never overwrite a note that is already there -- the eight known
      // duplicate pairs would land exactly here.
      if (present.has(next) || claimed.has(next)) {
        skipped.push({ folder, name, reason: `target already exists: ${next}` });
        continue;
      }
      claimed.add(next);
      entries.push({ folder, from: name, to: next, tweetId: parsed.groups!.id, sha256: await sha256(path.join(folderPath, name)) });
    }
  }

  // Every receipt that names one of these notes has to move with it.
  const receiptDir = path.join(root, "_system", "receipts");
  const byOldPath = new Map(entries.map((entry) => [`${archiveRoot}/${entry.folder}/${entry.from}`, `${archiveRoot}/${entry.folder}/${entry.to}`]));
  const receipts: RenamePlan["receipts"] = [];
  const receiptNames = await fs.readdir(receiptDir).catch(() => [] as string[]);
  for (let offset = 0; offset < receiptNames.length; offset += BATCH_SIZE) {
    const batch = receiptNames.slice(offset, offset + BATCH_SIZE).filter((name) => name.endsWith(".json"));
    await Promise.all(batch.map(async (name) => {
      const parsed = JSON.parse(await fs.readFile(path.join(receiptDir, name), "utf8")) as { posts?: Array<{ notePath?: string }> };
      const hits = (parsed.posts ?? []).filter((post) => typeof post.notePath === "string" && byOldPath.has(post.notePath)).length;
      if (hits > 0) receipts.push({ file: name, replacements: hits });
    }));
  }

  return {
    schemaVersion: 1, kind: "xmc-note-name-cleanup-plan", archiveRoot,
    createdAt: new Date().toISOString(),
    summary: {
      postNotes, withToken, renames: entries.length,
      skippedCollision: skipped.length, skippedUnparsed: 0, receipts: receipts.length,
    },
    entries, skipped, receipts,
  };
}

/** Applies the plan. Every rename is journalled so a failure reverses cleanly. */
export async function applyPlan(base: string, plan: RenamePlan, backupDir: string): Promise<{ renamed: number; receipts: number; receiptId: string }> {
  const root = path.join(base, plan.archiveRoot);
  const done: Array<{ from: string; to: string }> = [];
  const receiptBackups: Array<{ file: string; original: string }> = [];
  try {
    // Verify nothing drifted since the plan, and copy every original first.
    await fs.mkdir(backupDir, { recursive: true });
    for (const entry of plan.entries) {
      const source = path.join(root, entry.folder, entry.from);
      if (await sha256(source) !== entry.sha256) throw new Error(`changed since the plan: ${entry.folder}/${entry.from}`);
      const target = path.join(backupDir, "notes", entry.folder);
      await fs.mkdir(target, { recursive: true });
      await fs.copyFile(source, path.join(target, entry.from));
    }

    const receiptDir = path.join(root, "_system", "receipts");
    for (const receipt of plan.receipts) {
      const original = await fs.readFile(path.join(receiptDir, receipt.file), "utf8");
      receiptBackups.push({ file: receipt.file, original });
      await fs.mkdir(path.join(backupDir, "receipts"), { recursive: true });
      await fs.writeFile(path.join(backupDir, "receipts", receipt.file), original, "utf8");
    }

    for (const entry of plan.entries) {
      const from = path.join(root, entry.folder, entry.from);
      const to = path.join(root, entry.folder, entry.to);
      await fs.rename(from, to);
      done.push({ from, to });
    }

    const byOldPath = new Map(plan.entries.map((entry) => [`${plan.archiveRoot}/${entry.folder}/${entry.from}`, `${plan.archiveRoot}/${entry.folder}/${entry.to}`]));
    for (const receipt of receiptBackups) {
      const parsed = JSON.parse(receipt.original) as { posts?: Array<{ notePath?: string }> };
      for (const post of parsed.posts ?? []) {
        const next = typeof post.notePath === "string" ? byOldPath.get(post.notePath) : undefined;
        if (next) post.notePath = next;
      }
      await writeAtomic(diskFs, path.join(receiptDir, receipt.file), JSON.stringify(parsed, null, 2) + "\n");
    }

    const receiptId = randomUUID();
    await writeAtomic(diskFs, path.join(backupDir, `apply-receipt-${receiptId}.json`), JSON.stringify({
      schemaVersion: 1, kind: "xmc-note-name-cleanup-receipt", receiptId,
      appliedAt: new Date().toISOString(), renamed: plan.entries.length,
      receipts: receiptBackups.map((item) => item.file), entries: plan.entries,
    }, null, 2) + "\n");
    return { renamed: plan.entries.length, receipts: receiptBackups.length, receiptId };
  } catch (error) {
    for (const move of [...done].reverse()) await fs.rename(move.to, move.from).catch(() => undefined);
    const receiptDir = path.join(root, "_system", "receipts");
    for (const receipt of receiptBackups) await fs.writeFile(path.join(receiptDir, receipt.file), receipt.original, "utf8").catch(() => undefined);
    throw error;
  }
}

export async function verifyPlan(base: string, plan: RenamePlan): Promise<{ ok: boolean; errors: string[]; checked: number }> {
  const root = path.join(base, plan.archiveRoot);
  const errors: string[] = [];
  for (const entry of plan.entries) {
    const target = path.join(root, entry.folder, entry.to);
    try {
      if (await sha256(target) !== entry.sha256) errors.push(`content changed: ${entry.folder}/${entry.to}`);
    } catch { errors.push(`missing: ${entry.folder}/${entry.to}`); }
    await fs.access(path.join(root, entry.folder, entry.from)).then(
      () => errors.push(`old name still present: ${entry.folder}/${entry.from}`),
      () => undefined,
    );
  }
  const receiptDir = path.join(root, "_system", "receipts");
  const stale = new Set(plan.entries.map((entry) => `${plan.archiveRoot}/${entry.folder}/${entry.from}`));
  for (const name of (await fs.readdir(receiptDir).catch(() => [] as string[])).filter((item) => item.endsWith(".json"))) {
    const parsed = JSON.parse(await fs.readFile(path.join(receiptDir, name), "utf8")) as { posts?: Array<{ notePath?: string }> };
    for (const post of parsed.posts ?? []) {
      if (typeof post.notePath === "string" && stale.has(post.notePath)) errors.push(`receipt still points at the old name: ${name}`);
    }
  }
  return { ok: errors.length === 0, errors: errors.slice(0, 40), checked: plan.entries.length };
}

function args(values: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let index = 0; index < values.length; index++) {
    const key = values[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    if (key === "--confirm") out.confirm = true; else out[key.slice(2)] = values[++index];
  }
  return out;
}

async function main(): Promise<void> {
  const arg = args(process.argv.slice(2));
  const command = typeof arg.command === "string" ? arg.command : "scan";
  if (typeof arg["vault-base"] !== "string") throw new Error("--vault-base is required");
  const base = path.resolve(arg["vault-base"]);
  const archiveRoot = typeof arg["vault-root"] === "string" ? arg["vault-root"] : "XMediaArchive";

  if (command === "scan" || command === "plan") {
    const plan = await buildPlan(base, archiveRoot);
    if (typeof arg.out === "string") await writeAtomic(diskFs, path.resolve(arg.out), JSON.stringify(plan, null, 2) + "\n");
    console.log(JSON.stringify(plan.summary));
    for (const item of plan.skipped.slice(0, 20)) console.log(`skipped ${item.folder}/${item.name}: ${item.reason}`);
    return;
  }
  if (command === "apply") {
    if (arg.confirm !== true) throw new Error("apply requires --confirm");
    if (typeof arg.plan !== "string") throw new Error("apply requires --plan");
    if (typeof arg.backup !== "string") throw new Error("apply requires --backup");
    const plan = JSON.parse(await fs.readFile(path.resolve(arg.plan), "utf8")) as RenamePlan;
    console.log(JSON.stringify(await applyPlan(base, plan, path.resolve(arg.backup))));
    return;
  }
  if (command === "verify") {
    if (typeof arg.plan !== "string") throw new Error("verify requires --plan");
    const plan = JSON.parse(await fs.readFile(path.resolve(arg.plan), "utf8")) as RenamePlan;
    const result = await verifyPlan(base, plan);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
}
