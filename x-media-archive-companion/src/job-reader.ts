import * as path from "node:path";
import { MAX_CHUNK_BYTES, type ArchiveJob } from "./types.ts";
import { ContractError, validateArchiveJob, validateCompleteMarker, validateEnvelope } from "./validation.ts";
import type { FileSystem } from "./fs.ts";

const CHUNK_NAME = /^manifest-(\d{4})\.json$/;
export const IMPORTED_MARKER = ".xmc-imported";
function parseJson(text: string, label: string): unknown { try { return JSON.parse(text); } catch { throw new ContractError(`${label} is not JSON`); } }
async function limitedText(fs: FileSystem, file: string): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_CHUNK_BYTES) throw new ContractError(`${path.basename(file)} exceeds ${MAX_CHUNK_BYTES} byte limit`);
  const data = await fs.readFile(file, "utf8");
  return typeof data === "string" ? data : data.toString("utf8");
}
async function hasFile(fs: FileSystem, file: string): Promise<boolean> { try { return (await fs.stat(file)).isFile(); } catch { return false; } }
function decodeBase64(value: string, label: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ContractError(`${label} payload is not canonical base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new ContractError(`${label} payload is not canonical base64`);
  return bytes;
}

/** Reads the exact XMC manifest_chunks.js representation, not a re-chunked object variant. */
async function manifestDirectories(fs: FileSystem, jobDirectory: string): Promise<string[]> {
  const candidates: string[] = [];
  const attemptsRoot = path.join(jobDirectory, "_manifest");
  try {
    const attempts = (await fs.readdir(attemptsRoot, { withFileTypes: true })).filter((entry): entry is { name: string; isDirectory(): boolean } => typeof entry !== "string" && entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    for (const attempt of attempts) {
      const candidate = path.join(attemptsRoot, attempt);
      if (await hasFile(fs, path.join(candidate, "complete.json"))) candidates.push(candidate);
    }
  } catch { /* A direct legacy manifest remains supported. */ }
  if (await hasFile(fs, path.join(jobDirectory, "complete.json"))) candidates.push(jobDirectory);
  return candidates;
}
async function readManifestDirectory(fs: FileSystem, manifestDirectory: string): Promise<ArchiveJob> {
  const complete = validateCompleteMarker(parseJson(await limitedText(fs, path.join(manifestDirectory, "complete.json")), "complete.json"));
  const names = (await fs.readdir(manifestDirectory)).filter((name): name is string => typeof name === "string" && CHUNK_NAME.test(name)).sort();
  if (names.length !== complete.chunkCount) throw new ContractError("manifest chunk count does not match complete marker");
  const bytes: Buffer[] = [];
  for (let index = 0; index < complete.chunkCount; index++) {
    const name = `manifest-${String(index + 1).padStart(4, "0")}.json`;
    if (names[index] !== name) throw new ContractError("manifest filenames must be contiguous from manifest-0001.json");
    const chunk = validateEnvelope(parseJson(await limitedText(fs, path.join(manifestDirectory, name)), name));
    if (chunk.jobId !== complete.jobId || chunk.chunkCount !== complete.chunkCount || chunk.chunkIndex !== index) throw new ContractError(`${name} index, count, or job ID does not match complete marker`);
    bytes.push(decodeBase64(chunk.payload, name));
  }
  const job = validateArchiveJob(parseJson(Buffer.concat(bytes).toString("utf8"), "reassembled archive job"));
  if (job.jobId !== complete.jobId) throw new ContractError("archive job ID does not match complete marker");
  return job;
}
export async function readCompletedJob(fs: FileSystem, jobDirectory: string): Promise<ArchiveJob> {
  const candidates = await manifestDirectories(fs, jobDirectory);
  if (candidates.length === 0) throw new ContractError("no completed manifest attempt exists");
  const failures: string[] = [];
  for (const candidate of candidates) {
    try { return await readManifestDirectory(fs, candidate); }
    catch (error) { failures.push(`${path.basename(candidate)}: ${(error as Error).message}`); }
  }
  throw new ContractError(`all completed manifest attempts are invalid: ${failures.join("; ")}`);
}
export async function listCompletedJobDirectories(fs: FileSystem, inbox: string): Promise<string[]> {
  const entries = await fs.readdir(inbox, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string" || !entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const jobDirectory = path.join(inbox, entry.name);
    if (await hasFile(fs, path.join(jobDirectory, IMPORTED_MARKER))) continue;
    if ((await manifestDirectories(fs, jobDirectory)).length > 0) result.push(entry.name);
  }
  return result.sort();
}
