import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { diskFs, exists, safeJoin, writeAtomic } from "../src/fs.ts";
import { mediaFileName, safeName } from "../src/naming.ts";
import type { Receipt, ReceiptMedia, ReceiptPost } from "../src/types.ts";

export interface MissingNoteReference { jobId: string; tweetId: string; kind: "note"; vaultPath: string; }
export interface MissingMediaReference { jobId: string; tweetId: string; kind: "media"; vaultPath: string; mediaKey: string; ordinal: number; }
export type MissingReference = MissingNoteReference | MissingMediaReference;
export interface LocatedReference { jobId: string; tweetId: string; mediaKey: string; ordinal: number; resolvedVaultPath: string; }
export interface AmbiguousReference { jobId: string; tweetId: string; mediaKey: string; ordinal: number; candidateCount: number; }
export interface AuditReport {
  schemaVersion: 1;
  kind: "xmedia-receipt-audit";
  createdAt: string;
  receiptCount: number;
  missing: MissingReference[];
  located: LocatedReference[];
  ambiguous: AmbiguousReference[];
  partialWithAllArtifacts: string[];
  repairedJobs: string[];
}

interface PostAudit { post: ReceiptPost; failures: MissingReference[]; missingMediaIndexes: number[]; noteMissing: boolean; allArtifactsPresent: boolean; }
interface DirectoryEntry { name: string; isFile(): boolean; }

function normalizePosix(value: string): string { return value.replace(/\\/g, "/"); }
function trimTrailingSeparators(value: string): string { return value.replace(/\/+$/u, ""); }
function splitRelative(value: string): string[] | null {
  const normalized = normalizePosix(value);
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part.trim().length === 0 || part === "." || part === "..")) return null;
  return parts;
}
function relativeRootParts(vaultRoot: string): string[] | null { return splitRelative(trimTrailingSeparators(normalizePosix(vaultRoot))); }
function noteFolder(root: readonly string[], notePath: string): string | null {
  const note = splitRelative(notePath);
  if (!root || !note || note.length !== root.length + 2) return null;
  for (let index = 0; index < root.length; index++) if (note[index] !== root[index]) return null;
  const folder = note[root.length];
  if (!folder || new Set(["_accounts", "_media", "_system"]).has(folder)) return null;
  return folder;
}
function normalizedRoot(root: readonly string[]): string { return root.join("/"); }
function mediaStem(media: Pick<ReceiptMedia, "tweetId" | "ordinal" | "mediaKey">): string {
  return mediaFileName(media.tweetId, media.ordinal, media.mediaKey, null).slice(0, -".bin".length);
}
function partialNote(text: string, missing: MissingReference[]): string {
  let updated = text.replace(/^archive_state:\s*complete\s*$/m, "archive_state: partial");
  if (!updated.includes("Receipt integrity audit found missing archive files")) {
    const labels = missing.map((item) => item.kind === "media" ? `${item.tweetId}/${item.ordinal}/${safeName(item.mediaKey, "media")}` : item.vaultPath);
    updated += `\n\n> [!warning] Archive repair required\n> Receipt integrity audit found missing archive files: ${labels.join(", ")}\n`;
  }
  return updated;
}
async function safeExists(relativePath: string, base: string): Promise<boolean> {
  if (!splitRelative(relativePath)) return false;
  try { return await exists(diskFs, safeJoin(base, relativePath)); } catch { return false; }
}
async function readNote(relativePath: string, base: string): Promise<string> {
  return fs.readFile(safeJoin(base, relativePath), "utf8");
}
async function listFallbackCandidates(base: string, rootParts: readonly string[], folder: string, media: ReceiptMedia, directoryCache: Map<string, Promise<string[]>>): Promise<string[]> {
  const root = normalizedRoot(rootParts); const directoryRelative = `${root}/_media/${folder}`;
  let namesPromise = directoryCache.get(directoryRelative);
  if (!namesPromise) {
    namesPromise = (async () => {
      try {
        const entries = await fs.readdir(safeJoin(base, directoryRelative), { withFileTypes: true }) as unknown as DirectoryEntry[];
        return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
      } catch { return []; }
    })();
    directoryCache.set(directoryRelative, namesPromise);
  }
  const prefix = `${mediaStem(media)}.`; const names = await namesPromise;
  return names.filter((name) => name.startsWith(prefix) && name.slice(prefix.length).length > 0);
}
async function receiptFiles(root: string): Promise<string[]> {
  try { return (await fs.readdir(root)).filter((name) => name.toLowerCase().endsWith(".json")).sort().map((name) => path.join(root, name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function readJson<T>(file: string): Promise<T> { return JSON.parse(await fs.readFile(file, "utf8")) as T; }

export async function auditReceipts(vaultBase: string, vaultRoot = "XMediaArchive", repair = false): Promise<AuditReport> {
  const rootParts = relativeRootParts(vaultRoot);
  if (!rootParts) throw new Error("vaultRoot must be a non-empty safe relative path");
  const base = path.resolve(vaultBase); const receiptRoot = path.join(base, ...rootParts, "_system", "receipts");
  const files = await receiptFiles(receiptRoot); const missing: MissingReference[] = []; const located: LocatedReference[] = []; const ambiguous: AmbiguousReference[] = [];
  const partialWithAllArtifacts: string[] = []; const repairedJobs: string[] = []; const directoryCache = new Map<string, Promise<string[]>>();
  for (const file of files) {
    const receipt = await readJson<Receipt>(file); const postAudits: PostAudit[] = [];
    const ambiguousBefore = ambiguous.length;
    for (const post of receipt.posts ?? []) {
      const failures: MissingReference[] = []; const missingMediaIndexes: number[] = []; let noteMissing = false;
      let allArtifactsPresent = await safeExists(post.notePath.replace(/\\/g, "/"), base);
      if (!allArtifactsPresent) { noteMissing = true; const failure: MissingNoteReference = { jobId: receipt.jobId, tweetId: post.tweetId, kind: "note", vaultPath: post.notePath }; failures.push(failure); missing.push(failure); }
      for (let mediaIndex = 0; mediaIndex < (post.media ?? []).length; mediaIndex++) {
        const media = post.media[mediaIndex]; const rawPath = media.vaultPath; const hasPath = typeof rawPath === "string" && rawPath.trim().length > 0;
        if (hasPath) {
          if (!await safeExists(rawPath!.replace(/\\/g, "/"), base)) { const failure: MissingMediaReference = { jobId: receipt.jobId, tweetId: post.tweetId, kind: "media", vaultPath: rawPath!, mediaKey: media.mediaKey, ordinal: media.ordinal }; failures.push(failure); missing.push(failure); missingMediaIndexes.push(mediaIndex); allArtifactsPresent = false; }
          continue;
        }
        const folder = noteFolder(rootParts, post.notePath); const candidates = folder ? await listFallbackCandidates(base, rootParts, folder, media, directoryCache) : [];
        if (candidates.length === 1) located.push({ jobId: receipt.jobId, tweetId: post.tweetId, mediaKey: media.mediaKey, ordinal: media.ordinal, resolvedVaultPath: `${normalizedRoot(rootParts)}/_media/${folder}/${candidates[0]}` });
        else if (candidates.length > 1) { ambiguous.push({ jobId: receipt.jobId, tweetId: post.tweetId, mediaKey: media.mediaKey, ordinal: media.ordinal, candidateCount: candidates.length }); allArtifactsPresent = false; }
        else { const failure: MissingMediaReference = { jobId: receipt.jobId, tweetId: post.tweetId, kind: "media", vaultPath: rawPath ?? "[missing-path]", mediaKey: media.mediaKey, ordinal: media.ordinal }; failures.push(failure); missing.push(failure); missingMediaIndexes.push(mediaIndex); allArtifactsPresent = false; }
      }
      postAudits.push({ post, failures, missingMediaIndexes, noteMissing, allArtifactsPresent });
    }
    const hasMissing = postAudits.some((audit) => audit.failures.length > 0); const hasAmbiguous = ambiguous.length > ambiguousBefore;
    if (receipt.state === "partial" && !hasMissing && !hasAmbiguous && postAudits.every((audit) => audit.allArtifactsPresent)) partialWithAllArtifacts.push(receipt.jobId);
    if (repair && hasMissing) {
      receipt.state = "partial";
      for (const audit of postAudits) {
        if (!audit.failures.length) continue; audit.post.state = "partial";
        for (const mediaIndex of audit.missingMediaIndexes) { const media = audit.post.media[mediaIndex]; media.state = "partial"; media.error = "vault target missing"; }
        if (!audit.noteMissing) { const notePath = audit.post.notePath.replace(/\\/g, "/"); const text = await readNote(notePath, base); await writeAtomic(diskFs, safeJoin(base, notePath), partialNote(text, audit.failures)); }
      }
      await writeAtomic(diskFs, file, JSON.stringify(receipt, null, 2) + "\n"); repairedJobs.push(receipt.jobId);
    }
  }
  return { schemaVersion: 1, kind: "xmedia-receipt-audit", createdAt: new Date().toISOString(), receiptCount: files.length, missing, located, ambiguous, partialWithAllArtifacts, repairedJobs };
}

function args(values: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let index = 0; index < values.length; index++) { const key = values[index]; if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`); if (key === "--repair") out.repair = true; else { const value = values[++index]; if (value === undefined || value.startsWith("--")) throw new Error(`${key} requires a value`); out[key.slice(2)] = value; } }
  return out;
}
async function main(): Promise<void> {
  const arg = args(process.argv.slice(2)); if (typeof arg["vault-base"] !== "string") throw new Error("--vault-base is required");
  const report = await auditReceipts(arg["vault-base"], typeof arg["vault-root"] === "string" ? arg["vault-root"] : "XMediaArchive", arg.repair === true);
  if (typeof arg.out === "string") await writeAtomic(diskFs, path.resolve(arg.out), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ receipts: report.receiptCount, missing: report.missing.length, located: report.located.length, ambiguous: report.ambiguous.length, partialWithAllArtifacts: report.partialWithAllArtifacts.length, repairedJobs: report.repairedJobs.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
