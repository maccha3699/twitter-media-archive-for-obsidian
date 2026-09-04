import assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { diskFs, materializeMedia, type FileSystem } from "../src/fs.ts";
import { tempDirectory } from "./fixtures.ts";

test("moves dummy bytes atomically and recognizes only hash-equal targets", async (t) => {
  const root = await tempDirectory(); t.after(() => nodeFs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "staging.bin"), target = path.join(root, "vault", "target.bin");
  await nodeFs.writeFile(source, Buffer.from([1, 2, 3]));
  assert.equal(await materializeMedia(diskFs, source, target), "moved");
  assert.deepEqual(await nodeFs.readFile(target), Buffer.from([1, 2, 3]));
  await assert.rejects(nodeFs.stat(source));
  await nodeFs.writeFile(source, Buffer.from([1, 2, 3]));
  assert.equal(await materializeMedia(diskFs, source, target), "already-present");
  await nodeFs.writeFile(path.join(root, "same-size.bin"), Buffer.from([4, 5, 6]));
  await assert.rejects(materializeMedia(diskFs, path.join(root, "same-size.bin"), target), /different content/);
});
test("uses EXDEV fallback and surfaces ENOSPC", async (t) => {
  const root = await tempDirectory(); t.after(() => nodeFs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.bin"), target = path.join(root, "target.bin"); await nodeFs.writeFile(source, "dummy");
  let exdevOnce = true;
  const exdevFs: FileSystem = { ...diskFs, rename: async (from, to) => { if (exdevOnce && to.includes(".tmp-") && !to.includes(".tmp-exdev-")) { exdevOnce = false; throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); } await diskFs.rename(from, to); } };
  assert.equal(await materializeMedia(exdevFs, source, target), "moved");
  await nodeFs.writeFile(source, "dummy");
  const noSpaceFs: FileSystem = { ...diskFs, rename: async () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); }, copyFile: async () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); } };
  await assert.rejects(materializeMedia(noSpaceFs, source, path.join(root, "no-space.bin")), /no space/);
});
