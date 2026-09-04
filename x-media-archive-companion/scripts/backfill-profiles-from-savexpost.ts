// Fills empty `_profile.md` notes from the author records SaveXPost already
// wrote under `Tweets/Authors/`.  X only exposes a bio through profile-page
// GraphQL, so accounts archived before ProfileCache existed have no bio and no
// external links.  SaveXPost captured both, with URLs already expanded, so this
// recovers them without a single extra request to X.
//
// Only `_profile.md` bodies, `urls`, `display_name` and `profile_metadata_status`
// are touched.  Those are exactly the fields ArchiveImporter carries forward on
// the next import, so a later job merges with this data instead of losing it.
// No media is read.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export interface BackfillResult { scanned: number; matched: number; updated: number; skipped: string[]; }

interface AuthorRecord { screenName: string; displayName: string; bio: string; location: string; followers: number | null; }

function frontMatter(text: string): string { return text.split(/^---$/m)[1] ?? ""; }

/** SaveXPost writes `author_description` either inline or as a `|-` block. */
export function parseAuthorNote(text: string): AuthorRecord | null {
  const fm = frontMatter(text);
  const field = (key: string): string => fm.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1]?.trim() ?? "";
  const screenName = field("author_screen_name");
  if (!screenName) return null;
  let bio = field("author_description");
  // An inline description is emitted as a YAML double-quoted scalar whenever it
  // contains a colon, so the quotes are syntax and must not reach the note body.
  if (bio.length > 1 && bio.startsWith('"') && bio.endsWith('"')) {
    try { const parsed: unknown = JSON.parse(bio); if (typeof parsed === "string") bio = parsed; }
    catch { bio = bio.slice(1, -1); }
  }
  if (bio.startsWith("|")) {
    const lines = fm.split(/\r?\n/);
    const start = lines.findIndex((line) => line.startsWith("author_description:"));
    const block: string[] = [];
    for (let index = start + 1; index < lines.length; index++) {
      if (/^[a-z_]+:/.test(lines[index])) break;
      block.push(lines[index].replace(/^ {2}/, ""));
    }
    bio = block.join("\n");
  }
  // An absent field yields "", and Number("") is 0 -- which would silently
  // record every author without a follower count as having zero followers.
  const rawFollowers = field("author_followers");
  const followers = /^\d+$/.test(rawFollowers) ? Number(rawFollowers) : null;
  return { screenName, displayName: field("author"), bio: bio.trim(),
    location: field("author_location").replace(/^"|"$/g, ""), followers: Number.isSafeInteger(followers) ? followers : null };
}

/** Bio text carries plain expanded links; t.co shorteners are never resolved here. */
export function urlsFromBio(bio: string): string[] {
  const found: string[] = [];
  for (const match of bio.matchAll(/https?:\/\/[^\s、。）)\]]+/g)) {
    const url = match[0].replace(/[.,]+$/, "");
    if (!url.includes("//t.co/") && !found.includes(url)) found.push(url);
  }
  return found;
}

function quote(value: string | null): string { return JSON.stringify(value); }

/** Rewrites the profile while preserving every field this script does not own. */
export function mergeProfile(previous: string, record: AuthorRecord, now: string): string | null {
  const fm = frontMatter(previous);
  const body = previous.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)?.[1]?.trim() ?? "";
  const existingUrls: string[] = [];
  const block = previous.match(/^urls:\s*\r?\n((?:\s{2}-.*(?:\r?\n|$))*)/m)?.[1] ?? "";
  for (const line of block.split(/\r?\n/)) {
    const raw = line.replace(/^\s{2}-\s*/, "").trim();
    if (!raw) continue;
    try { const parsed = JSON.parse(raw); if (typeof parsed === "string" && parsed) existingUrls.push(parsed); } catch { /* keep going */ }
  }
  const urls = [...existingUrls];
  for (const url of urlsFromBio(record.bio)) if (!urls.includes(url)) urls.push(url);
  // A short-lived version rendered this placeholder for bio-less profiles and
  // the next write folded it back in as if it were the bio.  Treat it as empty
  // so the real text can take its place.
  const bio = (body === "_プロフィール未取得_" ? "" : body) || record.bio;
  const displayName = fm.match(/^display_name: "(.+)"$/m)?.[1] ?? record.displayName ?? null;
  // Nothing to do only when every field this script owns is already present.
  // Checking the bio alone would skip profiles that predate location/followers.
  const locationSettled = !record.location || new RegExp(`^location: ${JSON.stringify(record.location).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(fm);
  const followersSettled = record.followers === null || new RegExp(`^followers: ${record.followers}$`, "m").test(fm);
  if (body === record.bio && urls.length === existingUrls.length && locationSettled && followersSettled
    && /profile_metadata_status: "observed"/.test(fm)) return null;

  const replaceField = (source: string, key: string, value: string): string =>
    new RegExp(`^${key}:.*$`, "m").test(source) ? source.replace(new RegExp(`^${key}:.*$`, "m"), `${key}: ${value}`) : `${source}\n${key}: ${value}`;
  let head = fm.replace(/^urls:\s*\r?\n(?:\s{2}-.*(?:\r?\n|$))*/m, "").replace(/\n{2,}/g, "\n").replace(/^\n|\n$/g, "");
  head = replaceField(head, "display_name", quote(displayName || null));
  if (record.location) head = replaceField(head, "location", quote(record.location));
  if (record.followers !== null) head = replaceField(head, "followers", String(record.followers));
  head = replaceField(head, "profile_metadata_status", quote(bio || urls.length ? "observed" : "profile-pending"));
  head = replaceField(head, "latest_archived_at", now);
  const urlBlock = `urls:\n${urls.map((url) => `  - ${quote(url)}`).join("\n")}`;
  const ordered = head.replace(/^(latest_archived_at:.*)$/m, `${urlBlock}\n$1`);
  return `---\n${ordered}\n---\n\n${bio}\n`;
}

export async function backfillProfiles(vaultBase: string, vaultRoot: string, authorsRoot: string, apply: boolean): Promise<BackfillResult> {
  if (!path.isAbsolute(vaultBase)) throw new Error("--vault-base must be absolute");
  const archive = path.join(vaultBase, vaultRoot);
  const authors = new Map<string, AuthorRecord>();
  for (const file of await fs.readdir(path.join(vaultBase, authorsRoot)).catch(() => [] as string[])) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    const record = parseAuthorNote(await fs.readFile(path.join(vaultBase, authorsRoot, file), "utf8"));
    if (record?.bio) authors.set(record.screenName, record);
  }
  const now = new Date().toISOString();
  const result: BackfillResult = { scanned: 0, matched: 0, updated: 0, skipped: [] };
  for (const entry of await fs.readdir(archive, { withFileTypes: true })) {
    if (!entry.isDirectory() || ["_media", "_system", "_accounts"].includes(entry.name)) continue;
    result.scanned++;
    const record = authors.get(entry.name);
    if (!record) { result.skipped.push(entry.name); continue; }
    result.matched++;
    const profileFile = path.join(archive, entry.name, "_profile.md");
    const previous = await fs.readFile(profileFile, "utf8").catch(() => null);
    if (previous === null) { result.skipped.push(`${entry.name} (no _profile.md)`); continue; }
    const merged = mergeProfile(previous, record, now);
    if (!merged) continue;
    if (apply) await fs.writeFile(profileFile, merged);
    result.updated++;
  }
  return result;
}

function args(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < values.length; index++) {
    if (values[index] === "--apply") { out["apply"] = "1"; continue; }
    if (!values[index].startsWith("--")) throw new Error(`unexpected argument: ${values[index]}`);
    out[values[index].slice(2)] = values[++index];
  }
  return out;
}

async function main(): Promise<void> {
  const arg = args(process.argv.slice(2));
  if (!arg["vault-base"]) throw new Error("--vault-base is required");
  const result = await backfillProfiles(arg["vault-base"], arg["vault-root"] ?? "XMediaArchive", arg["authors-root"] ?? "Tweets/Authors", arg["apply"] === "1");
  console.log(JSON.stringify({ ...result, skipped: result.skipped.length, applied: arg["apply"] === "1" }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
