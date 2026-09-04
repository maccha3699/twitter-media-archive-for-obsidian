import { createHash, randomUUID as uuid } from "node:crypto";
import { createReadStream } from "node:fs";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { validateAbsoluteTarget, tempBasename } from "./path-safety.ts";

export interface FileStats { size: number; isFile(): boolean; isDirectory(): boolean; }
export interface FileSystem {
  readFile(file: string, encoding?: BufferEncoding): Promise<Buffer | string>;
  writeFile(file: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void>;
  mkdir(directory: string, options?: { recursive?: boolean }): Promise<unknown>;
  readdir(directory: string, options?: { withFileTypes?: boolean }): Promise<Array<string | { name: string; isDirectory(): boolean }>>;
  stat(file: string): Promise<FileStats>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
}
export const diskFs: FileSystem = nodeFs;
export const diskPath = path;

export function safeJoin(root: string, relativePosixPath: string): string {
  const target = path.resolve(root, ...relativePosixPath.split("/"));
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("unsafe path escapes its root");
  return target;
}
export async function exists(fs: FileSystem, file: string): Promise<boolean> {
  try { await fs.stat(file); return true; } catch { return false; }
}
/**
 * Windows refuses to rename over a file another process has open, and inside
 * Obsidian something usually does: its own indexer, a sync client, an
 * on-access virus scanner. The lock lasts milliseconds, so a few spaced
 * retries turn a failed import into a slightly slower one. Only the rename is
 * retried -- the bytes are already on disk by then.
 */
const LOCK_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export async function writeAtomic(fs: FileSystem, target: string, data: string | Uint8Array): Promise<void> {
  const tempId = uuid();
  validateAbsoluteTarget(target, "write", tempId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), tempBasename("write", tempId));
  await fs.writeFile(temp, data);
  for (let attempt = 0; ; attempt++) {
    try { return await fs.rename(temp, target); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 4 || !LOCK_CODES.has(code)) {
        await fs.unlink(temp).catch(() => undefined);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
export async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

export type MaterializeStatus = "moved" | "already-present";

/**
 * Publishes a staging file through a target-directory temporary name. A same-volume
 * rename is preferred. Cross-device operation copies, verifies size and SHA-256,
 * atomically publishes, then removes the source only after publication.
 */
export async function materializeMedia(fs: FileSystem, source: string, target: string, hash = sha256File): Promise<MaterializeStatus> {
  const tempId = uuid();
  validateAbsoluteTarget(target, "media", tempId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const sourceStat = await fs.stat(source);
  try {
    const targetStat = await fs.stat(target);
    if (targetStat.size === sourceStat.size && await hash(source) === await hash(target)) return "already-present";
    throw new Error(`destination collision with different content: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = path.join(path.dirname(target), tempBasename("media", tempId));
  let sourceMovedToTemp = false;
  try {
    try { await fs.rename(source, temp); sourceMovedToTemp = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await fs.copyFile(source, temp);
      if ((await fs.stat(temp)).size !== sourceStat.size || await hash(source) !== await hash(temp)) throw new Error("EXDEV temporary copy verification failed");
    }
    if ((await fs.stat(temp)).size !== sourceStat.size) throw new Error("temporary media publish has wrong size");
    try {
      await fs.rename(temp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      // Defensive fallback for an unusual target-directory device boundary.
      const bridgeId = uuid();
      validateAbsoluteTarget(target, "media-bridge", bridgeId);
      const bridge = path.join(path.dirname(target), tempBasename("media-bridge", bridgeId));
      await fs.copyFile(temp, bridge);
      if ((await fs.stat(bridge)).size !== sourceStat.size || await hash(temp) !== await hash(bridge)) throw new Error("EXDEV fallback copy verification failed");
      await fs.rename(bridge, target);
      await fs.unlink(temp);
    }
    if (!sourceMovedToTemp) await fs.unlink(source);
    return "moved";
  } catch (error) {
    if (sourceMovedToTemp) await fs.rename(temp, source).catch(() => undefined);
    else await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * Copies and verifies a medium but deliberately retains its staging source.
 * ArchiveImporter deletes sources only after its complete receipt is durable.
 */
export async function copyMediaForReceipt(fs: FileSystem, source: string, target: string, hash = sha256File): Promise<"copied" | "already-present"> {
  const tempId = uuid();
  validateAbsoluteTarget(target, "copy", tempId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const sourceStat = await fs.stat(source);
  try {
    const targetStat = await fs.stat(target);
    if (targetStat.size === sourceStat.size && await hash(source) === await hash(target)) return "already-present";
    throw new Error(`destination collision with different content: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = path.join(path.dirname(target), tempBasename("copy", tempId));
  try {
    await fs.copyFile(source, temp);
    if ((await fs.stat(temp)).size !== sourceStat.size || await hash(source) !== await hash(temp)) {
      throw new Error("temporary receipt copy verification failed");
    }
    await fs.rename(temp, target);
    return "copied";
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}
