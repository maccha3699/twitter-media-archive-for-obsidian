#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { diskFs, writeAtomic } from "../src/fs.ts";
import { caseFold, RESERVED_AUTHOR_FOLDERS, unsafeSegment } from "../src/path-safety.ts";

export const OWNERSHIP_MARKER = "<!--xmc:user-->";
const SYSTEM_FOLDERS = new Set(["_accounts", "_media", "_system"]);

export interface MigrationFinding { kind: string; relativePath?: string; reason: string; }
export interface MigrationAudit {
  findings: MigrationFinding[];
  summary: { findings: number; registryFindings: number; pathFindings: number; receiptFindings: number; accountFindings: number; receiptReferences: number; accountNotes: number; postNotes: number; markedNotes: number; candidates: number; };
}
export interface MigrationScan {
  schemaVersion: 1;
  kind: "xmc-public-distribution-migration-scan";
  archiveRoot: string;
  createdAt: string;
  audit: MigrationAudit;
  entries: MigrationScanEntry[];
}
export interface MigrationScanEntry {
  relativePath: string;
  size: number;
  sha256: string;
  reason: "add ownership marker";
}
export interface MigrationPlanEntry extends MigrationScanEntry { afterSize: number; afterSha256: string; }
export interface MigrationPlan {
  schemaVersion: 1;
  kind: "xmc-public-distribution-migration-plan";
  archiveRoot: string;
  createdAt: string;
  scanCreatedAt: string;
  baselineAudit: MigrationAudit;
  entries: MigrationPlanEntry[];
  manualReview: MigrationFinding[];
  planId: string;
}
export interface MigrationApplyResult { planId: string; updated: number; backupRoot: string; receiptPath: string; }
export interface MigrationVerifyResult { ok: boolean; checked: number; errors: string[]; audit: MigrationAudit; }

function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function normalizeRoot(root: string): string { return path.resolve(root); }
function rootName(root: string): string { return path.basename(normalizeRoot(root)); }
function safeFile(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.includes("//") || relativePath.split("/").some((part) => part === "." || part === "..")) throw new Error("plan contains an unsafe relative path");
  const target = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(normalizeRoot(root), target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("plan path escapes archive root");
  return target;
}
function relativeFile(root: string, file: string): string {
  const relative = path.relative(normalizeRoot(root), file).split(path.sep).join("/");
  safeFile(root, relative);
  return relative;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function parseFrontmatter(text: string): Map<string, string> | null {
  const match = /^---(?:\r\n|\n)([\s\S]*?)(?:\r\n|\n)---(?:\r\n|\n|$)/u.exec(text);
  if (!match) return null;
  const values = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/u)) {
    const field = /^(?<key>[A-Za-z_][A-Za-z0-9_]*):(?:\s*(?<value>.*))?$/u.exec(line);
    if (!field?.groups) continue;
    values.set(field.groups.key, field.groups.value ?? "");
  }
  return values;
}
function scalar(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) { try { const parsed = JSON.parse(trimmed); return typeof parsed === "string" ? parsed : null; } catch { return null; } }
  return trimmed;
}
function isXmcPost(text: string): boolean {
  const fields = parseFrontmatter(text);
  if (!fields) return false;
  const tweetId = scalar(fields.get("tweet_id"));
  return /^\d{1,30}$/u.test(tweetId ?? "")
    && scalar(fields.get("archive_job_id")) !== null
    && scalar(fields.get("tweet_url")) !== null
    && scalar(fields.get("author_id")) !== null
    && scalar(fields.get("author_screen_name")) !== null
    && scalar(fields.get("schemaVersion")) === "1";
}
function markerState(text: string): "none" | "exact" | "abnormal" {
  const occurrences = text.match(new RegExp(OWNERSHIP_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gu"))?.length ?? 0;
  const exact = text.match(/^<!--xmc:user-->(?:\r\n|\n|$)/gmu)?.length ?? 0;
  if (occurrences === 0) return "none";
  return occurrences === 1 && exact === 1 ? "exact" : "abnormal";
}
function withMarker(bytes: Buffer): Buffer {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("note is not valid UTF-8");
  if (markerState(text) !== "none") throw new Error("note already contains an ownership marker");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return Buffer.from(`${text.endsWith("\n") ? text : `${text}${eol}`}${OWNERSHIP_MARKER}${eol}`, "utf8");
}
function finding(kind: string, reason: string, relativePath?: string): MigrationFinding { return relativePath ? { kind, relativePath, reason } : { kind, reason }; }
function isCaseDuplicate(names: string[]): boolean { return new Set(names.map(caseFold)).size !== names.length; }

async function entriesAt(directory: string): Promise<Dirent[]> {
  try { return await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function auditRegistry(archiveRoot: string, findings: MigrationFinding[]): Promise<void> {
  const file = path.join(archiveRoot, "_system", "profiles.json");
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; findings.push(finding("registry", "profiles.json could not be read")); return; }
  let value: any;
  try { value = JSON.parse(raw); } catch { findings.push(finding("registry", "profiles.json is not valid JSON")); return; }
  if (!value || value.schemaVersion !== 1 || !value.byId || !value.pendingByScreen || !value.folderOwners) { findings.push(finding("registry", "profiles.json has an invalid schema")); return; }
  const folders = new Map<string, string | null>();
  const check = (folder: unknown, owner: string | null, label: string, entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof (entry as any).firstScreenName !== "string"
      || typeof (entry as any).latestScreenName !== "string"
      || !Array.isArray((entry as any).previousScreenNames)
      || (entry as any).previousScreenNames.some((item: unknown) => typeof item !== "string")) {
      findings.push(finding("registry", `${label} has invalid fields`));
    }
    if (typeof folder !== "string" || unsafeSegment(folder) || RESERVED_AUTHOR_FOLDERS.has(caseFold(folder)) || folder.length > 200) { findings.push(finding("registry", `${label} has an unsafe folder`)); return; }
    const folded = caseFold(folder); if (folders.has(folded)) findings.push(finding("registry", "profiles.json has case-colliding folders")); else folders.set(folded, owner);
  };
  for (const [id, entry] of Object.entries(value.byId)) check((entry as any)?.folder, id, `profiles.byId.${id}`, entry);
  for (const [screen, entry] of Object.entries(value.pendingByScreen)) check((entry as any)?.folder, null, `profiles.pendingByScreen.${screen}`, entry);
  const owners = new Map<string, string | null>();
  for (const [folder, owner] of Object.entries(value.folderOwners)) {
    if (owner !== null && typeof owner !== "string") findings.push(finding("registry", "profiles.json folder owner is invalid"));
    const folded = caseFold(folder); if (owners.has(folded)) findings.push(finding("registry", "profiles.json has case-colliding folder owner keys")); else owners.set(folded, owner as string | null);
    if (!folders.has(folded) || folders.get(folded) !== owner) findings.push(finding("registry", "profiles.json folder owner mismatch"));
  }
  for (const [folder, owner] of folders) if (!owners.has(folder) || owners.get(folder) !== owner) findings.push(finding("registry", "profiles.json folder owner mismatch"));
}
async function auditDisk(archiveRoot: string, findings: MigrationFinding[]): Promise<string[]> {
  const rootEntries = await entriesAt(archiveRoot);
  const direct = rootEntries.filter((entry) => entry.isDirectory() && !SYSTEM_FOLDERS.has(caseFold(entry.name))).map((entry) => entry.name);
  if (isCaseDuplicate(direct)) findings.push(finding("path", "direct author folders have case-colliding names"));
  const systemNames = rootEntries.filter((entry) => SYSTEM_FOLDERS.has(caseFold(entry.name))).map((entry) => entry.name);
  if (isCaseDuplicate(systemNames)) findings.push(finding("path", "system folders have case-colliding names"));
  for (const entry of rootEntries) {
    const folded = caseFold(entry.name);
    if (SYSTEM_FOLDERS.has(folded) && !entry.isDirectory()) findings.push(finding("path", `${entry.name} must be a directory`));
    if (entry.isDirectory() && !SYSTEM_FOLDERS.has(folded) && (unsafeSegment(entry.name) || RESERVED_AUTHOR_FOLDERS.has(folded) || entry.name.length > 200)) findings.push(finding("path", "author folder is unsafe", entry.name));
  }
  for (const system of ["_media", "_accounts", "_system"]) {
    const dir = path.join(archiveRoot, system);
    for (const entry of await entriesAt(dir)) {
      if (system === "_media" && entry.isDirectory() && (unsafeSegment(entry.name) || entry.name.length > 200)) findings.push(finding("path", "media folder is unsafe", `${system}/${entry.name}`));
      if (system === "_accounts" && entry.isFile() && entry.name.toLowerCase().endsWith(".md") && !["_accounts.md", "_index.md"].includes(entry.name.toLowerCase())) {
        const stem = entry.name.slice(0, -3); if (unsafeSegment(stem) || stem.length > 200) findings.push(finding("path", "account note is unsafe", `${system}/${entry.name}`));
      }
    }
  }
  return direct;
}
async function auditReceipts(archiveRoot: string, findings: MigrationFinding[]): Promise<number> {
  const receiptDir = path.join(archiveRoot, "_system", "receipts"); let references = 0;
  for (const entry of await entriesAt(receiptDir)) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    const relativeReceipt = `_system/receipts/${entry.name}`; let value: any;
    try { value = JSON.parse(await fs.readFile(path.join(receiptDir, entry.name), "utf8")); }
    catch { findings.push(finding("receipt", "receipt is not valid JSON", relativeReceipt)); continue; }
    if (!value || !Array.isArray(value.posts)) { findings.push(finding("receipt", "receipt posts is invalid", relativeReceipt)); continue; }
    for (const post of value.posts) {
      references += 1; const notePath = post?.notePath;
      if (typeof notePath !== "string" || !notePath.startsWith(`${rootName(archiveRoot)}/`)) { findings.push(finding("path", "receipt notePath is unsafe", relativeReceipt)); continue; }
      const relative = notePath.slice(rootName(archiveRoot).length + 1);
      try { const target = safeFile(archiveRoot, relative); const info = await fs.lstat(target); if (!info.isFile()) throw new Error("not a file"); }
      catch { findings.push(finding("receipt", "receipt references a missing note", relative)); }
    }
  }
  return references;
}
async function auditAccounts(archiveRoot: string, folders: string[], findings: MigrationFinding[]): Promise<number> {
  const dir = path.join(archiveRoot, "_accounts"); let accountNotes = 0;
  for (const entry of await entriesAt(dir)) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md") || ["_accounts.md", "_index.md"].includes(entry.name.toLowerCase())) continue;
    accountNotes += 1; const relative = `_accounts/${entry.name}`; const text = await fs.readFile(path.join(dir, entry.name), "utf8");
    const fields = parseFrontmatter(text); const folder = entry.name.slice(0, -3); const noteDir = path.join(archiveRoot, folder);
    const actualPosts = (await entriesAt(noteDir)).filter((item) => item.isFile() && item.name.toLowerCase().endsWith(".md") && item.name !== `${folder}.md` && item.name.toLowerCase() !== "_profile.md").length;
    const mediaDir = path.join(archiveRoot, "_media", folder); const actualMedia = (await entriesAt(mediaDir)).filter((item) => item.isFile()).length;
    const postCount = scalar(fields?.get("post_count")); const mediaCount = scalar(fields?.get("media_count"));
    if (postCount === null || !/^\d+$/u.test(postCount) || Number(postCount) !== actualPosts) findings.push(finding("account", "account post_count does not match direct post notes", relative));
    if (mediaCount === null || !/^\d+$/u.test(mediaCount) || Number(mediaCount) !== actualMedia) findings.push(finding("account", "account media_count does not match media files", relative));
  }
  void folders;
  return accountNotes;
}

export async function scanPublicDistribution(rawArchiveRoot: string): Promise<MigrationScan> {
  const archiveRoot = normalizeRoot(rawArchiveRoot); let info;
  try { info = await fs.stat(archiveRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("archive root does not exist"); throw error; }
  if (!info.isDirectory()) throw new Error("archive root is not a directory");
  const findings: MigrationFinding[] = [];
  const folders = await auditDisk(archiveRoot, findings); await auditRegistry(archiveRoot, findings);
  const receiptReferences = await auditReceipts(archiveRoot, findings); const accountNotes = await auditAccounts(archiveRoot, folders, findings);
  const entries: MigrationScanEntry[] = []; let postNotes = 0; let markedNotes = 0;
  for (const folder of folders.sort()) {
    const directory = path.join(archiveRoot, folder);
    for (const entry of (await entriesAt(directory)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md") || entry.name === `${folder}.md` || entry.name.toLowerCase() === "_profile.md") continue;
      const file = path.join(directory, entry.name); const bytes = await fs.readFile(file); const text = bytes.toString("utf8");
      if (!isXmcPost(text)) continue; postNotes += 1; const state = markerState(text);
      if (state === "exact") { markedNotes += 1; continue; }
      const relativePath = relativeFile(archiveRoot, file);
      if (state === "abnormal") findings.push(finding("marker", "ownership marker is malformed or duplicated", relativePath));
      else entries.push({ relativePath, size: bytes.length, sha256: sha256(bytes), reason: "add ownership marker" });
    }
  }
  const registryFindings = findings.filter((item) => item.kind === "registry").length;
  const pathFindings = findings.filter((item) => item.kind === "path").length;
  const receiptFindings = findings.filter((item) => item.kind === "receipt").length;
  const accountFindings = findings.filter((item) => item.kind === "account").length;
  const audit: MigrationAudit = { findings, summary: { findings: findings.length, registryFindings, pathFindings, receiptFindings, accountFindings, receiptReferences, accountNotes, postNotes, markedNotes, candidates: entries.length } };
  return { schemaVersion: 1, kind: "xmc-public-distribution-migration-scan", archiveRoot, createdAt: new Date().toISOString(), audit, entries };
}
function validateScan(scan: MigrationScan, archiveRoot: string): void {
  if (!scan || scan.schemaVersion !== 1 || scan.kind !== "xmc-public-distribution-migration-scan" || !Array.isArray(scan.entries) || !scan.audit) throw new Error("invalid migration scan");
  if (normalizeRoot(scan.archiveRoot) !== archiveRoot) throw new Error("scan archive root does not match");
}
function validatePlan(plan: MigrationPlan, archiveRoot: string): void {
  if (!plan || plan.schemaVersion !== 1 || plan.kind !== "xmc-public-distribution-migration-plan" || !Array.isArray(plan.entries) || !Array.isArray(plan.manualReview) || typeof plan.planId !== "string") throw new Error("invalid migration plan");
  if (normalizeRoot(plan.archiveRoot) !== archiveRoot) throw new Error("plan archive root does not match");
  const payload = { schemaVersion: plan.schemaVersion, kind: plan.kind, archiveRoot: plan.archiveRoot, scanCreatedAt: plan.scanCreatedAt, baselineAudit: plan.baselineAudit, entries: plan.entries, manualReview: plan.manualReview };
  if (sha256(canonical(payload)) !== plan.planId) throw new Error("planId does not match plan payload");
}
export async function planPublicDistribution(rawArchiveRoot: string, scan: MigrationScan): Promise<MigrationPlan> {
  const archiveRoot = normalizeRoot(rawArchiveRoot); validateScan(scan, archiveRoot);
  const entries: MigrationPlanEntry[] = [];
  for (const entry of scan.entries) {
    const file = safeFile(archiveRoot, entry.relativePath); const bytes = await fs.readFile(file);
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) throw new Error(`note changed after scan: ${entry.relativePath}`);
    const output = withMarker(bytes); entries.push({ ...entry, afterSize: output.length, afterSha256: sha256(output) });
  }
  const payload = { schemaVersion: 1 as const, kind: "xmc-public-distribution-migration-plan" as const, archiveRoot, scanCreatedAt: scan.createdAt, baselineAudit: scan.audit, entries, manualReview: scan.audit.findings.filter((item) => ["path", "registry"].includes(item.kind)) };
  return { ...payload, createdAt: new Date().toISOString(), planId: sha256(canonical(payload)) };
}
export interface ApplyOptions { confirm: string; backupRoot: string; receiptPath: string; write?: typeof writeAtomic; }
async function mustNotExist(file: string, label: string): Promise<void> { try { await fs.stat(file); throw new Error(`${label} already exists`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
export async function applyPublicDistribution(plan: MigrationPlan, rawArchiveRoot: string, options: ApplyOptions): Promise<MigrationApplyResult> {
  const archiveRoot = normalizeRoot(rawArchiveRoot); validatePlan(plan, archiveRoot);
  if (options.confirm !== plan.planId) throw new Error("apply requires an exact --confirm <planId>");
  if (plan.manualReview.length > 0) throw new Error("apply stopped: manual review findings are present");
  const backupRoot = path.resolve(options.backupRoot); const receiptPath = path.resolve(options.receiptPath); const write = options.write ?? writeAtomic; await mustNotExist(backupRoot, "backup root"); await mustNotExist(receiptPath, "apply receipt");
  const prepared: Array<{ entry: MigrationPlanEntry; file: string; before: Buffer; after: Buffer; backup: string }> = [];
  for (const entry of plan.entries) {
    const file = safeFile(archiveRoot, entry.relativePath); const before = await fs.readFile(file);
    if (before.length !== entry.size || sha256(before) !== entry.sha256) throw new Error(`planned note changed before apply: ${entry.relativePath}`);
    const after = withMarker(before); if (after.length !== entry.afterSize || sha256(after) !== entry.afterSha256) throw new Error(`planned transform changed before apply: ${entry.relativePath}`);
    prepared.push({ entry, file, before, after, backup: path.join(backupRoot, "notes", ...entry.relativePath.split("/")) });
  }
  await fs.mkdir(backupRoot, { recursive: true });
  for (const item of prepared) { await fs.mkdir(path.dirname(item.backup), { recursive: true }); await fs.writeFile(item.backup, item.before, { flag: "wx" }); if (sha256(await fs.readFile(item.backup)) !== item.entry.sha256) throw new Error(`backup verification failed: ${item.entry.relativePath}`); }
  const receipt = { schemaVersion: 1, kind: "xmc-public-distribution-migration-apply-receipt", appliedAt: new Date().toISOString(), archiveRoot, planId: plan.planId, updated: prepared.length, backupRoot, entries: prepared.map(({ entry }) => ({ relativePath: entry.relativePath, beforeSha256: entry.sha256, afterSha256: entry.afterSha256 })) };
  const written: typeof prepared = [];
  try {
    for (const item of prepared) { await write(diskFs, item.file, item.after); written.push(item); const published = await fs.readFile(item.file); if (published.length !== item.entry.afterSize || sha256(published) !== item.entry.afterSha256) throw new Error(`written note verification failed: ${item.entry.relativePath}`); }
    await fs.mkdir(path.dirname(receiptPath), { recursive: true }); await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    await fs.unlink(receiptPath).catch(() => undefined); const failures: string[] = [];
    for (const item of written.reverse()) try { await write(diskFs, item.file, item.before); } catch { failures.push(item.entry.relativePath); }
    if (failures.length > 0) throw new Error(`apply failed and rollback was incomplete: ${failures.length} notes`, { cause: error });
    throw error;
  }
  return { planId: plan.planId, updated: prepared.length, backupRoot, receiptPath };
}
function findingKey(item: MigrationFinding): string { return `${item.kind}|${item.relativePath ?? ""}|${item.reason}`; }
export async function verifyPublicDistribution(plan: MigrationPlan, rawArchiveRoot: string): Promise<MigrationVerifyResult> {
  const archiveRoot = normalizeRoot(rawArchiveRoot); validatePlan(plan, archiveRoot); const errors: string[] = []; const scan = await scanPublicDistribution(archiveRoot);
  const baseline = new Set(plan.baselineAudit.findings.map(findingKey));
  for (const item of scan.audit.findings) if (!baseline.has(findingKey(item))) errors.push(`new audit finding: ${item.relativePath ?? item.kind}`);
  for (const field of ["findings", "registryFindings", "pathFindings", "receiptFindings", "accountFindings"] as const) {
    const currentCount = scan.audit.summary[field];
    const baselineCount = (plan.baselineAudit.summary as Record<string, number>)[field];
    if (typeof baselineCount === "number" && currentCount > baselineCount) errors.push(`audit count increased: ${field}`);
  }
  const planned = new Set(plan.entries.map((entry) => entry.relativePath));
  for (const entry of plan.entries) {
    try { const bytes = await fs.readFile(safeFile(archiveRoot, entry.relativePath)); if (bytes.length !== entry.afterSize || sha256(bytes) !== entry.afterSha256 || markerState(bytes.toString("utf8")) !== "exact") errors.push(entry.relativePath); }
    catch { errors.push(entry.relativePath); }
  }
  for (const entry of scan.entries) if (!planned.has(entry.relativePath)) errors.push(`unplanned candidate: ${entry.relativePath}`);
  return { ok: errors.length === 0, checked: plan.entries.length, errors, audit: scan.audit };
}

function args(argv: string[]): Record<string, string | boolean | string[]> { const output: Record<string, string | boolean | string[]> = { _: [] }; for (let i = 0; i < argv.length; i += 1) { const value = argv[i]; if (!value.startsWith("--")) (output._ as string[]).push(value); else if (value === "--confirm") output.confirm = argv[++i] ?? ""; else output[value.slice(2)] = argv[++i] ?? ""; } return output; }
async function readJson<T>(file: string): Promise<T> { return JSON.parse(await fs.readFile(path.resolve(file), "utf8")) as T; }
async function writeJsonExclusive(file: string, value: unknown): Promise<void> { const target = path.resolve(file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); }
export async function main(argv: string[]): Promise<void> {
  const parsed = args(argv); const command = (parsed._ as string[])[0]; const archive = typeof parsed.archive === "string" ? parsed.archive : "";
  if (!command || !archive || !["scan", "plan", "apply", "verify"].includes(command)) throw new Error("usage: public-distribution-migration <scan|plan|apply|verify> --archive ABSOLUTE_XMediaArchive [options]");
  if (command === "scan") { if (typeof parsed.out !== "string") throw new Error("scan requires --out"); const scan = await scanPublicDistribution(archive); await writeJsonExclusive(parsed.out, scan); console.log(JSON.stringify(scan.audit.summary)); return; }
  if (command === "plan") { if (typeof parsed.out !== "string" || typeof parsed.scan !== "string") throw new Error("plan requires --scan and --out"); const result = await planPublicDistribution(archive, await readJson<MigrationScan>(parsed.scan)); await writeJsonExclusive(parsed.out, result); console.log(JSON.stringify({ candidates: result.entries.length, manualReview: result.manualReview.length, planId: result.planId })); return; }
  if (typeof parsed.plan !== "string") throw new Error(`${command} requires --plan`); const plan = await readJson<MigrationPlan>(parsed.plan);
  const run = typeof parsed.run === "string" ? path.resolve(parsed.run) : path.dirname(path.resolve(parsed.plan));
  if (command === "apply") { if (typeof parsed.confirm !== "string") throw new Error("apply requires --confirm <planId>"); const result = await applyPublicDistribution(plan, archive, { confirm: parsed.confirm, backupRoot: path.join(run, "backup"), receiptPath: path.join(run, `apply-receipt-${randomUUID()}.json`) }); console.log(JSON.stringify({ planId: result.planId, updated: result.updated })); return; }
  const result = await verifyPublicDistribution(plan, archive); console.log(JSON.stringify({ ok: result.ok, checked: result.checked, errors: result.errors.length })); if (!result.ok) process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
