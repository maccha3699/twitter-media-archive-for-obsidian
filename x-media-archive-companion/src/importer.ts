import * as path from "node:path";
import type { ArchiveJob, ArchivePost, Receipt, ReceiptMedia, ReceiptPost } from "./types.ts";
import type { FileSystem } from "./fs.ts";
import { copyMediaForReceipt, diskFs, exists, safeJoin, writeAtomic } from "./fs.ts";
import { existingNoteName, mediaFileName, noteFileName, profileFolderBase, replyTreeNoteFileName } from "./naming.ts";
import { inferBulkReplyTrees } from "./reply-tree.ts";
import { validateVaultRelativePath } from "./validation.ts";
import { ImportTransaction } from "./import-transaction.ts";
import { accountMarkdown, postMarkdown, profileMarkdown, previousProfileBody, previousProfileUrls, profileStringField, quote, replyTreeMarkdown, type PreparedPost, type ProfileEntry } from "./note-rendering.ts";
import { mergeManagedFrontmatter, ownershipTail } from "./markdown-ownership.ts";
import { COMPONENT_BUDGET, RESERVED_AUTHOR_FOLDERS, caseFold, pathHash, validateAbsoluteTarget, unsafeSegment } from "./path-safety.ts";

interface ProfileRegistry { schemaVersion: 1; byId: Record<string, ProfileEntry>; pendingByScreen: Record<string, ProfileEntry>; folderOwners: Record<string, string | null>; }
/**
 * `partial` means the notes were written and some media could not be: the job
 * committed.  `failed` means nothing was committed and the vault was rolled
 * back.  `retryable` says whether another attempt could still change anything,
 * so a job whose only losses are recorded in its own manifest stops being
 * re-imported forever.
 */
export interface ImportSummary { jobId: string; state: "complete" | "partial" | "already-complete" | "failed"; notes: string[]; failures: string[]; retryable: boolean; }
export interface ImportOptions { fs?: FileSystem; now?: () => Date; materialize?: typeof copyMediaForReceipt; }

function normalizedRoot(value: string): string { return validateVaultRelativePath(value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")); }
function receiptFile(base: string, root: string, jobId: string): string { return path.join(base, root, "_system", "receipts", `${jobId}.json`); }
function registryFile(base: string, root: string): string { return path.join(base, root, "_system", "profiles.json"); }
function noteDirectory(base: string, root: string, folder: string): string { return path.join(base, root, folder); }
function mediaDirectory(base: string, root: string, folder: string): string { return path.join(base, root, "_media", folder); }
function accountDirectory(base: string, root: string): string { return path.join(base, root, "_accounts"); }
async function readJson<T>(fs: FileSystem, file: string): Promise<T | null> {
  try { const raw = await fs.readFile(file, "utf8"); return JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function readText(fs: FileSystem, file: string): Promise<string | null> {
  try { const raw = await fs.readFile(file, "utf8"); return typeof raw === "string" ? raw : raw.toString("utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function blankRegistry(): ProfileRegistry { return { schemaVersion: 1, byId: {}, pendingByScreen: {}, folderOwners: {} }; }
function uniqueFolder(registry: ProfileRegistry, screenName: string, authorId: string | null, claims = new Set<string>()): string {
  const base = profileFolderBase(screenName); const owner = Object.entries(registry.folderOwners).find(([folder]) => caseFold(folder) === caseFold(base))?.[1];
  if ((owner === undefined && !claims.has(caseFold(base))) || owner === authorId) return base;
  const suffix = pathHash(authorId ?? screenName);
  const makeCandidate = (index: number): string => {
    const ending = `--${suffix}${index === 2 ? "" : `-${index}`}`;
    return `${base.slice(0, Math.max(1, COMPONENT_BUDGET - ending.length))}${ending}`;
  };
  let index = 2; let candidate = makeCandidate(index);
  while (claims.has(caseFold(candidate)) || Object.entries(registry.folderOwners).some(([folder, value]) => caseFold(folder) === caseFold(candidate) && value !== authorId)) candidate = makeCandidate(++index);
  return candidate;
}
function resolveProfile(registry: ProfileRegistry, post: ArchivePost, claims = new Set<string>()): ProfileEntry {
  const screen = profileFolderBase(post.author.screenName);
  const pendingKey = Object.keys(registry.pendingByScreen).find((key) => caseFold(key) === caseFold(screen));
  let entry: ProfileEntry | undefined;
  if (post.author.id) {
    entry = registry.byId[post.author.id];
    if (!entry && pendingKey) { entry = registry.pendingByScreen[pendingKey]; delete registry.pendingByScreen[pendingKey]; registry.folderOwners[entry.folder] = post.author.id; }
    if (!entry) { const folder = uniqueFolder(registry, screen, post.author.id, claims); entry = { folder, firstScreenName: screen, latestScreenName: screen, previousScreenNames: [] }; registry.folderOwners[folder] = post.author.id; }
    registry.byId[post.author.id] = entry;
  } else {
    entry = Object.values(registry.byId).find((candidate) =>
      [candidate.firstScreenName, candidate.latestScreenName, ...candidate.previousScreenNames]
        .some((name) => name.toLowerCase() === screen.toLowerCase()));
    entry ??= pendingKey ? registry.pendingByScreen[pendingKey] : undefined;
    if (!entry) { const folder = uniqueFolder(registry, screen, null, claims); entry = { folder, firstScreenName: screen, latestScreenName: screen, previousScreenNames: [] }; registry.pendingByScreen[screen] = entry; registry.folderOwners[folder] = null; }
  }
  if (entry.latestScreenName !== screen) { if (!entry.previousScreenNames.includes(entry.latestScreenName)) entry.previousScreenNames.push(entry.latestScreenName); entry.latestScreenName = screen; }
  return entry;
}

function validateProfileEntry(value: unknown, label: string): ProfileEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const entry = value as Record<string, unknown>;
  if (typeof entry.folder !== "string" || typeof entry.firstScreenName !== "string" || typeof entry.latestScreenName !== "string" || !Array.isArray(entry.previousScreenNames) || entry.previousScreenNames.some((item) => typeof item !== "string")) throw new Error(`${label} has invalid fields`);
  if (entry.folder.includes("/") || entry.folder.includes("\\") || unsafeSegment(entry.folder) || RESERVED_AUTHOR_FOLDERS.has(caseFold(entry.folder)) || entry.folder.length > COMPONENT_BUDGET) throw new Error(`${label} has unsafe folder`);
  return { folder: entry.folder, firstScreenName: entry.firstScreenName, latestScreenName: entry.latestScreenName, previousScreenNames: [...entry.previousScreenNames] as string[] };
}

function validateRegistryShape(value: ProfileRegistry): ProfileRegistry {
  if (!value || value.schemaVersion !== 1 || !value.byId || !value.pendingByScreen || !value.folderOwners) throw new Error("profiles.json has invalid schema");
  const folders = new Map<string, string | null>(); const ownerSpellings = new Set<string>();
  for (const [id, raw] of Object.entries(value.byId)) {
    if (!id || typeof id !== "string") throw new Error("profiles.json has invalid author id");
    const entry = validateProfileEntry(raw, `profiles.byId.${id}`); const folded = caseFold(entry.folder);
    if (folders.has(folded)) throw new Error("profiles.json has case-colliding folders");
    folders.set(folded, id);
  }
  for (const [screen, raw] of Object.entries(value.pendingByScreen)) {
    if (caseFold(screen) !== caseFold(profileFolderBase(screen))) throw new Error("profiles.json has invalid pending screen");
    const entry = validateProfileEntry(raw, `profiles.pendingByScreen.${screen}`); const folded = caseFold(entry.folder);
    if (folders.has(folded)) throw new Error("profiles.json has case-colliding folders");
    folders.set(folded, null);
  }
  for (const [folder, owner] of Object.entries(value.folderOwners)) {
    if (ownerSpellings.has(caseFold(folder))) throw new Error("profiles.json has case-colliding folder owner keys");
    ownerSpellings.add(caseFold(folder));
    if (folder.length > COMPONENT_BUDGET || unsafeSegment(folder) || RESERVED_AUTHOR_FOLDERS.has(caseFold(folder)) || (owner !== null && typeof owner !== "string")) throw new Error("profiles.json has unsafe folder owner");
    const existing = folders.get(caseFold(folder));
    if (existing === undefined || existing !== owner) throw new Error("profiles.json folder owner mismatch");
  }
  for (const [folder, owner] of folders) if (!Object.entries(value.folderOwners).some(([candidate, candidateOwner]) => caseFold(candidate) === folder && candidateOwner === owner)) throw new Error("profiles.json folder owner mismatch");
  return value;
}

async function readRegistry(fs: FileSystem, file: string): Promise<ProfileRegistry> {
  const value = await readJson<ProfileRegistry>(fs, file);
  return value === null ? blankRegistry() : validateRegistryShape(value);
}

async function diskClaims(fs: FileSystem, archiveRoot: string): Promise<Set<string>> {
  const claims = new Set<string>(); const spellings = new Map<string, string>();
  let rootEntries: Array<string | { name: string; isDirectory(): boolean }>;
  try { rootEntries = await fs.readdir(archiveRoot, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return claims; throw error; }
  const add = (name: string) => { const key = caseFold(name); if (spellings.has(key) && spellings.get(key) !== name) throw new Error("disk has case-colliding path claims"); spellings.set(key, name); claims.add(key); };
  for (const raw of rootEntries) {
    if (typeof raw === "string") continue;
    const name = raw.name; const folded = caseFold(name);
    if (["_accounts", "_media", "_system"].includes(folded)) { if (!raw.isDirectory()) throw new Error(`${name} must be a directory`); continue; }
    if (RESERVED_AUTHOR_FOLDERS.has(folded)) throw new Error("disk has unsafe reserved author folder");
    if (raw.isDirectory()) { if (unsafeSegment(name) || name.length > COMPONENT_BUDGET) throw new Error("disk has unsafe author folder"); add(name); }
  }
  for (const raw of await fs.readdir(path.join(archiveRoot, "_media"), { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as Array<string | { name: string; isDirectory(): boolean }>;
    throw error;
  })) if (typeof raw !== "string") { if (!raw.isDirectory()) throw new Error("_media claim is not a directory"); if (unsafeSegment(raw.name) || raw.name.length > COMPONENT_BUDGET) throw new Error("disk has unsafe media folder"); add(raw.name); }
  for (const raw of await fs.readdir(path.join(archiveRoot, "_accounts"), { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as Array<string | { name: string; isDirectory(): boolean }>;
    throw error;
  })) if (typeof raw !== "string" && raw.name.toLowerCase().endsWith(".md") && !["_accounts.md", "_index.md"].includes(raw.name.toLowerCase())) { const stem = raw.name.slice(0, -3); if (unsafeSegment(stem) || stem.length > COMPONENT_BUDGET) throw new Error("disk has unsafe account claim"); add(stem); }
  return claims;
}
/**
 * A single media item that could not be imported.  `permanent` separates the
 * losses that are already settled in the manifest -- the download failed before
 * Obsidian ever saw the job, or the staged bytes are gone -- from an I/O error
 * that a later attempt may well survive.  Only the latter earns a retry.
 */
class MediaImportError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) { super(message); this.name = "MediaImportError"; this.permanent = permanent; }
}

export class ArchiveImporter {
  private readonly fs: FileSystem; private readonly now: () => Date; private readonly materialize: typeof copyMediaForReceipt;
  constructor(options: ImportOptions = {}) { this.fs = options.fs ?? diskFs; this.now = options.now ?? (() => new Date()); this.materialize = options.materialize ?? copyMediaForReceipt; }
  async getReceipt(base: string, rootInput: string, jobId: string): Promise<Receipt | null> { return readJson<Receipt>(this.fs, receiptFile(base, normalizedRoot(rootInput), jobId)); }
  async receiptArtifactsPresent(base: string, receipt: Receipt): Promise<boolean> {
    for (const post of receipt.posts) {
      if (!await exists(this.fs, safeJoin(base, post.notePath.replace(/\\/g, "/")))) return false;
      for (const item of post.media) {
        // A partial receipt records the media it could not import; only what it
        // claims to have written has to be on disk. A complete receipt claiming
        // an incomplete item is a contradiction and stays a failure.
        if (item.state !== "complete") { if (receipt.state === "complete") return false; continue; }
        if (!item.vaultPath) return false;
        if (!await exists(this.fs, safeJoin(base, item.vaultPath.replace(/\\/g, "/")))) return false;
      }
    }
    return true;
  }
  async refreshExistingAccounts(base: string, rootInput: string): Promise<number> {
    const root = normalizedRoot(rootInput); const archiveRoot = path.join(base, root);
    const folders = new Set<string>();
    const addDirectories = async (directory: string, reserved = new Set<string>()): Promise<void> => {
      for (const entry of await this.fs.readdir(directory, { withFileTypes: true }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as Array<string | { name: string; isDirectory(): boolean }>;
        throw error;
      })) {
        if (typeof entry !== "string" && entry.isDirectory() && !reserved.has(entry.name)) folders.add(entry.name);
      }
    };
    await addDirectories(archiveRoot, new Set(["_accounts", "_media", "_system"])); await addDirectories(path.join(archiveRoot, "_media"));
    for (const entry of await this.fs.readdir(path.join(archiveRoot, "_accounts")).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as Array<string | { name: string; isDirectory(): boolean }>;
      throw error;
    })) {
      // `_kawaii_sticker` is a real screen name, so only the notes this plugin
      // writes into `_accounts` itself may be excluded by name.
      const reservedNotes = new Set(["_accounts.md", "_index.md"]);
      if (typeof entry === "string" && entry.toLowerCase().endsWith(".md") && !reservedNotes.has(entry.toLowerCase())) folders.add(entry.slice(0, -3));
    }
    await readRegistry(this.fs, registryFile(base, root));
    await diskClaims(this.fs, archiveRoot);
    for (const folder of folders) for (const target of [
      path.join(archiveRoot, folder, "_profile.md"), path.join(archiveRoot, folder, `${folder}.md`),
      path.join(archiveRoot, "_accounts", `${folder}.md`), path.join(archiveRoot, "_accounts", "_accounts.md"),
    ]) validateAbsoluteTarget(target, "preflight", "00000000-0000-4000-8000-000000000000");
    const transaction = new ImportTransaction(this.fs, this.materialize); let refreshed = 0;
    try {
      for (const folder of [...folders].sort((a, b) => a.localeCompare(b))) {
        const profileFile = path.join(archiveRoot, folder, "_profile.md"); const profile = await readText(this.fs, profileFile);
        const account = await readText(this.fs, path.join(archiveRoot, "_accounts", `${folder}.md`));
        const screenName = profileStringField(profile ?? "", "latest_screen_name") ?? profileStringField(account ?? "", "author_screen_name") ?? folder;
        const displayName = profileStringField(profile ?? "", "display_name") ?? profileStringField(account ?? "", "author_display_name");
        const authorId = profileStringField(profile ?? "", "author_id");
        const post: ArchivePost = { tweetId: "0", tweetUrl: "", text: null, createdAt: null, profileMetadataStatus: profileStringField(profile ?? "", "profile_metadata_status") === "observed" ? "observed" : "profile-pending", author: { id: authorId, screenName, displayName, bio: previousProfileBody(profile), urls: previousProfileUrls(profile), location: profileStringField(profile ?? "", "location"), followers: Number(profile?.match(/^followers:\s*(\d+)$/m)?.[1] ?? Number.NaN) || null }, media: [] };
        // Always re-render: profileMarkdown carries the existing bio, links and
        // first-archived stamp forward, so a refresh re-applies the current
        // layout to profiles written by an older version instead of leaving
        // them behind.
        await transaction.write(profileFile, profileMarkdown(post, { folder, firstScreenName: screenName, latestScreenName: screenName, previousScreenNames: [] }, new Date(), profile));
        await this.writeAccountNotes(transaction, base, root, folder, post);
        refreshed++;
      }
      transaction.commit();
      return refreshed;
    } catch (error) { await transaction.rollback(); throw error; }
  }
  async import(job: ArchiveJob, jobDirectory: string, base: string, rootInput: string): Promise<ImportSummary> {
    job = inferBulkReplyTrees(job);
    const root = normalizedRoot(rootInput); const previous = await this.getReceipt(base, root, job.jobId);
    let downgradeReceipt = false;
    if (previous?.state === "complete") {
      if (await this.receiptArtifactsPresent(base, previous)) {
        for (const post of job.posts) for (const item of post.media) {
          if (item.stagingRelativePath) await this.fs.unlink(safeJoin(jobDirectory, item.stagingRelativePath)).catch(() => undefined);
        }
        return { jobId: job.jobId, state: "already-complete", notes: previous.posts.map((post) => post.notePath), failures: [], retryable: false };
      }
      downgradeReceipt = true;
    }
    const importedAt = this.now().toISOString(); const receiptPosts: ReceiptPost[] = []; const notes: string[] = []; const stagingSources = new Set<string>();
    const prepared: PreparedPost[] = [];
    const affected = new Map<string, ArchivePost>();
    const jobFailures: string[] = []; let retryable = false;
    const transaction = new ImportTransaction(this.fs, this.materialize);
    let registry: ProfileRegistry; let claims: Set<string>;
    try { registry = await readRegistry(this.fs, registryFile(base, root)); claims = await diskClaims(this.fs, path.join(base, root)); }
    catch (error) { return { jobId: job.jobId, state: "failed", notes: [], failures: [(error as Error).message], retryable: true }; }
    const profiles = new Map<ArchivePost, ProfileEntry>();
    for (const post of job.posts) profiles.set(post, resolveProfile(registry, post, claims));
    const unitNames = new Map<string, { folder: string; name: string; file: string; previous: string | null }>();
    const folderNotes = new Map<string, string[]>();
    const notesIn = async (folder: string): Promise<string[]> => {
      const cached = folderNotes.get(folder); if (cached) return cached;
      const entries = (await this.fs.readdir(noteDirectory(base, root, folder), { withFileTypes: true }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as Array<string | { name: string; isDirectory(): boolean }>;
        throw error;
      }))
        .map((entry) => typeof entry === "string" ? entry : entry.name).filter((name) => name.toLowerCase().endsWith(".md"));
      folderNotes.set(folder, entries); return entries;
    };
    const byUnit = new Map<string, ArchivePost[]>();
    for (const post of job.posts) { const key = post.replyTree ? `tree:${post.replyTree.rootTweetId}` : `post:${post.tweetId}`; const unit = byUnit.get(key) ?? []; unit.push(post); byUnit.set(key, unit); }
    const preflightTargets = [registryFile(base, root), receiptFile(base, root, job.jobId)];
    for (const [key, unit] of byUnit) {
      const ordered = [...unit].sort((a, b) => (a.replyTree?.position ?? 1) - (b.replyTree?.position ?? 1));
      const first = ordered[0]; const folder = profiles.get(first)!.folder;
      const generated = first.replyTree ? replyTreeNoteFileName(first) : noteFileName(first);
      const name = existingNoteName(await notesIn(folder), first.tweetId, first.replyTree ? "tree" : "post", generated) ?? generated;
      const file = path.join(noteDirectory(base, root, folder), name); const prior = await readText(this.fs, file);
      if (prior !== null) {
        try { ownershipTail(prior); }
        catch (error) { return { jobId: job.jobId, state: "failed", notes: [], failures: [(error as Error).message], retryable: true }; }
      }
      unitNames.set(key, { folder, name, file, previous: prior }); preflightTargets.push(file);
    }
    for (const [post, profile] of profiles) {
      preflightTargets.push(path.join(noteDirectory(base, root, profile.folder), "_profile.md"));
      preflightTargets.push(path.join(accountDirectory(base, root), `${profile.folder}.md`));
      preflightTargets.push(path.join(noteDirectory(base, root, profile.folder), `${profile.folder}.md`));
      preflightTargets.push(path.join(accountDirectory(base, root), "_accounts.md"));
      for (const item of post.media) preflightTargets.push(path.join(mediaDirectory(base, root, profile.folder), mediaFileName(post.tweetId, item.ordinal, item.mediaKey, item.extension)));
    }
    try { for (const target of preflightTargets) validateAbsoluteTarget(target, "preflight", "00000000-0000-4000-8000-000000000000"); }
    catch (error) { return { jobId: job.jobId, state: "failed", notes: [], failures: [(error as Error).message], retryable: true }; }
    try {
      await transaction.write(registryFile(base, root), JSON.stringify(registry, null, 2) + "\n");
      if (downgradeReceipt && previous) await transaction.write(receiptFile(base, root, job.jobId), JSON.stringify({ ...previous, state: "partial" }, null, 2) + "\n");
      for (const post of job.posts) {
        const profile = profiles.get(post)!;
        const folder = profile.folder; const noteDir = noteDirectory(base, root, folder); const mediaDir = mediaDirectory(base, root, folder);
        const profileFile = path.join(noteDir, "_profile.md");
        await transaction.write(profileFile, profileMarkdown(post, profile, new Date(importedAt), await readText(this.fs, profileFile)));
        affected.set(folder, post);
        const media: ReceiptMedia[] = []; const embeds: string[] = []; const postFailures: string[] = [];
        for (const item of post.media) {
          const filename = mediaFileName(post.tweetId, item.ordinal, item.mediaKey, item.extension); const destination = path.join(mediaDir, filename); const vaultPath = `${root}/_media/${folder}/${filename}`;
          const imported: ReceiptMedia = { tweetId: post.tweetId, mediaKey: item.mediaKey, ordinal: item.ordinal, state: "complete", vaultPath };
          // Each media item settles on its own. A single loss used to abort and
          // roll back the whole job, which discarded hundreds of intact posts
          // for the sake of one image X never served.
          try {
            if (item.downloadState === "skipped" && item.stagingRelativePath === null) {
              if (!await exists(this.fs, destination)) throw new MediaImportError(`${item.mediaKey}: import-lost — 再取得不要と判断されたが Vault に実体がない`, true);
              embeds.push(vaultPath); media.push(imported);
              continue;
            }
            // The two ways media goes missing, kept apart in the words the note
            // itself shows: the manifest already recorded the download as lost,
            // versus a download the extension completed that never reached the
            // vault. Only the second one means something went wrong here.
            if (item.downloadState !== "complete" || item.stagingRelativePath === null) throw new MediaImportError(`${item.mediaKey}: download-failed — Xからの取得に失敗 (downloadState=${item.downloadState})${item.error ? ` / ${item.error}` : ""}`, true);
            const source = safeJoin(jobDirectory, item.stagingRelativePath);
            if (!await exists(this.fs, source)) {
              if (!await exists(this.fs, destination)) throw new MediaImportError(`${item.mediaKey}: import-lost — 取得済みだがステージングにもVaultにも実体がない`, true);
              embeds.push(vaultPath); media.push(imported);
              continue;
            }
            await transaction.copyMedia(source, destination); stagingSources.add(source); embeds.push(vaultPath);
            media.push(imported);
          } catch (error) {
            const message = (error as Error).message.slice(0, 256);
            // Anything that is not an already-settled loss -- a full disk, a
            // locked file -- may succeed later, so the job stays retryable.
            if (!(error instanceof MediaImportError) || !error.permanent) retryable = true;
            postFailures.push(message);
            media.push({ tweetId: post.tweetId, mediaKey: item.mediaKey, ordinal: item.ordinal, state: "partial", vaultPath: null, error: message });
          }
        }
        const postState = postFailures.length > 0 ? "partial" : "complete";
        prepared.push({ post, folder, state: postState, embeds, failures: postFailures, media });
        for (const failure of postFailures) jobFailures.push(`${post.tweetId}: ${failure}`);
      }
      const units = new Map<string, PreparedPost[]>();
      for (const item of prepared) {
        const key = item.post.replyTree ? `tree:${item.post.replyTree.rootTweetId}` : `post:${item.post.tweetId}`;
        const unit = units.get(key) ?? [];
        unit.push(item); units.set(key, unit);
      }
      // One listing per author folder, shared by every unit landing in it.
      const folderNotes = new Map<string, string[]>();
      const notesIn = async (folder: string): Promise<string[]> => {
        const cached = folderNotes.get(folder);
        if (cached) return cached;
        const entries = (await this.fs.readdir(noteDirectory(base, root, folder)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as Array<string | { name: string; isDirectory(): boolean }>;
          throw error;
        }))
          .map((entry) => typeof entry === "string" ? entry : entry.name)
          .filter((name) => name.endsWith(".md"));
        folderNotes.set(folder, entries);
        return entries;
      };
      for (const unit of units.values()) {
        const ordered = [...unit].sort((left, right) =>
          (left.post.replyTree?.position ?? 1) - (right.post.replyTree?.position ?? 1));
        const first = ordered[0];
        const kind = first.post.replyTree ? "tree" : "post";
        const generatedName = first.post.replyTree ? replyTreeNoteFileName(first.post) : noteFileName(first.post);
        // Reuse whatever this tweet is already stored as. The generated name
        // embeds the tweet text, so a change in text extraction would otherwise
        // write a second note beside the first instead of replacing it.
        // Both generators end the name with `first.post.tweetId`, so that is the
        // id to search by -- a partial tree whose root is missing is named after
        // its earliest present post, not after rootTweetId.
        const planned = unitNames.get(first.post.replyTree ? `tree:${first.post.replyTree.rootTweetId}` : `post:${first.post.tweetId}`)!;
        const noteName = planned.name;
        const notePath = `${root}/${first.folder}/${noteName}`;
        const noteFile = path.join(noteDirectory(base, root, first.folder), noteName);
        const previousNote = planned.previous;
        const markdown = first.post.replyTree
          ? replyTreeMarkdown(ordered, job, importedAt, root, previousNote)
          : postMarkdown(first.post, job, importedAt, first.state, first.embeds, first.failures, root, first.folder, previousNote);
        await transaction.write(noteFile, markdown);
        notes.push(notePath);
        for (const item of ordered) {
          receiptPosts.push({ tweetId: item.post.tweetId, state: item.state, notePath, media: item.media });
        }
      }
      for (const [folder, post] of affected) await this.writeAccountNotes(transaction, base, root, folder, post);
      const state = jobFailures.length > 0 ? "partial" : "complete";
      const receipt: Receipt = { schemaVersion: 1, jobId: job.jobId, state, importedAt, posts: receiptPosts };
      await transaction.write(receiptFile(base, root, job.jobId), JSON.stringify(receipt, null, 2) + "\n");
      if (!await this.receiptArtifactsPresent(base, receipt)) throw new Error("receipt artifacts were not durable after import");
      transaction.commit();
      for (const source of stagingSources) await this.fs.unlink(source).catch(() => undefined);
      return { jobId: job.jobId, state, notes, failures: jobFailures, retryable };
    } catch (error) {
      const message = (error as Error).message;
      try { await transaction.rollback(); }
      catch (rollbackError) { return { jobId: job.jobId, state: "failed", notes: [], failures: [message, `rollback: ${(rollbackError as Error).message}`], retryable: true }; }
      return { jobId: job.jobId, state: "failed", notes: [], failures: [message], retryable: true };
    }
  }
  private async writeAccountNotes(transaction: ImportTransaction, base: string, root: string, folder: string, post: ArchivePost): Promise<void> {
    const noteDir = noteDirectory(base, root, folder); const mediaDir = mediaDirectory(base, root, folder);
    const noteNames = (await this.fs.readdir(noteDir).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as Array<string | { name: string; isDirectory(): boolean }>;
      throw error;
    }))
      .filter((entry): entry is string => typeof entry === "string")
      // The folder note carries the back-navigation card, so it must not be
      // counted as one of the author's posts.
      .filter((name) => name.toLowerCase().endsWith(".md") && !name.startsWith("_") && name !== `${folder}.md`);
    const mediaNames = (await this.fs.readdir(mediaDir).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as Array<string | { name: string; isDirectory(): boolean }>;
      throw error;
    }))
      .filter((entry): entry is string => typeof entry === "string");
    const accountFile = path.join(accountDirectory(base, root), `${folder}.md`);
    const previous = await readText(this.fs, accountFile);
    const previousCoverRaw = previous?.match(/^cover_media:\s*(.+)$/m)?.[1]?.trim();
    let cover: string | null = null;
    if (previousCoverRaw && previousCoverRaw !== "null") {
      try { const parsed = JSON.parse(previousCoverRaw); if (typeof parsed === "string" && await exists(this.fs, safeJoin(base, parsed))) cover = parsed; }
      catch { /* Ignore malformed legacy cover metadata. */ }
    }
    if (!cover) {
      const candidate = mediaNames.filter((name) => /\.(?:jpe?g|png|webp|gif)$/i.test(name)).sort((a, b) => a.localeCompare(b))[0];
      if (candidate) cover = `${root}/_media/${folder}/${candidate}`;
    }
    const display = post.author.displayName?.trim() || post.author.screenName;
    // GridExplorer treats notes with type=folder and redirect=<vault path> as
    // native folder shortcuts.  A normal wikilink cannot target a TFolder:
    // Obsidian instead tries to create a note at that path and reports
    // "file already exists".  Keep both directions as GridExplorer shortcuts.
    const account = accountMarkdown(previous, root, folder, display, post.author.screenName, noteNames.length, mediaNames.length, cover);
    // The back-navigation card must be named after its own folder: GridExplorer
    // reads the `pinned` list only from `<folder>/<folder>.md`, so that name is
    // the one place a note can pin itself -- or the profile -- to the head of
    // the folder listing.
    // GridExplorer also takes this folder's sort order and card shape from the
    // same note. Post notes are named from their timestamp, so descending by
    // name puts the newest post at the top -- which is what the folder is read
    // for -- and a vertical card puts the image above the text instead of
    // beside it, which is what the folder is looked at for.
    const backNote = `${folder}.md`;
    const backGenerated = `---\nschemaVersion: 1\ngenerated_by: x-media-archive-companion\ntype: folder\nredirect: ${quote(`${root}/_accounts`)}\ntitle: ${quote("← アカウント一覧へ戻る")}\nsummary: ${quote(`${display} @${post.author.screenName} の投稿フォルダ`)}\nsort: name-desc\ncardLayout: vertical\npinned:\n  - ${quote("_profile.md")}\n  - ${quote(backNote)}\nauthor_screen_name: ${quote(post.author.screenName)}\n---\n\nGridExplorerでこのカードを開くとアカウント一覧へ戻ります。\n`;
    const backPrevious = await readText(this.fs, path.join(noteDir, backNote));
    const backKeys = new Set(["schemaVersion", "generated_by", "type", "redirect", "title", "summary", "sort", "cardLayout", "pinned", "author_screen_name"]);
    const back = backPrevious ? mergeManagedFrontmatter(backPrevious, backGenerated, backKeys) : backGenerated;
    await transaction.write(accountFile, account);
    await transaction.write(path.join(noteDir, backNote), back);
    // `_accounts` needs a folder note of its own to carry the same settings,
    // but that note is also where GridExplorer keeps the user's own pinned
    // accounts and folder colour. It is seeded once and never rewritten:
    // regenerating it would throw away pins this plugin knows nothing about.
    const accountsNote = path.join(accountDirectory(base, root), "_accounts.md");
    if (!await exists(this.fs, accountsNote)) {
      await transaction.write(accountsNote, `---\nschemaVersion: 1\ngenerated_by: x-media-archive-companion\nsort: name-asc\ncardLayout: vertical\ntitle: ${quote("投稿者一覧")}\n---\n\nこのフォルダのカードを開くと、その投稿者の投稿フォルダへ移動します。\n`);
    }
  }
}
