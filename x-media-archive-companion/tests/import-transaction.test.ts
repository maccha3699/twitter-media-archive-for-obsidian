import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { copyMediaForReceipt, diskFs } from "../src/fs.ts";
import { ImportTransaction } from "../src/import-transaction.ts";
import { tempDirectory } from "./fixtures.ts";

test("ImportTransaction deduplicates writes and rolls back text plus created media", async (t) => {
  const root = await tempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const text = path.join(root, "note.md");
  const source = path.join(root, "source.bin");
  const target = path.join(root, "media", "target.bin");
  await fs.writeFile(text, "before\n");
  await fs.writeFile(source, Buffer.from([1, 2, 3]));
  let renames = 0;
  const countingFs = { ...diskFs, async rename(from: string, to: string) { renames++; return diskFs.rename(from, to); } };
  const transaction = new ImportTransaction(countingFs, copyMediaForReceipt);
  await transaction.write(text, "after\n");
  const afterFirstWrite = renames;
  await transaction.write(text, "after\n");
  assert.equal(renames, afterFirstWrite, "identical bytes are not atomically rewritten");
  await transaction.copyMedia(source, target);
  await transaction.rollback();
  assert.equal(await fs.readFile(text, "utf8"), "before\n");
  await assert.rejects(fs.stat(target));
  assert.deepEqual(await fs.readFile(source), Buffer.from([1, 2, 3]), "rollback does not consume staging");
});

test("ImportTransaction commit is the durable-receipt point and blocks rollback", async (t) => {
  const root = await tempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const text = path.join(root, "note.md");
  const source = path.join(root, "source.bin");
  const target = path.join(root, "media", "target.bin");
  await fs.writeFile(text, "before\n");
  await fs.writeFile(source, Buffer.from([4, 5, 6]));
  const transaction = new ImportTransaction(diskFs);
  await transaction.write(text, "committed\n");
  await transaction.copyMedia(source, target);
  transaction.commit();
  await transaction.rollback();
  assert.equal(await fs.readFile(text, "utf8"), "committed\n");
  assert.deepEqual(await fs.readFile(target), Buffer.from([4, 5, 6]));
});

test("ImportTransaction failure leaves only successful mutations for reverse rollback", async (t) => {
  const root = await tempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const text = path.join(root, "note.md");
  const source = path.join(root, "source.bin");
  const firstTarget = path.join(root, "media", "first.bin");
  const secondTarget = path.join(root, "media", "second.bin");
  await fs.writeFile(text, "before\n");
  await fs.writeFile(source, Buffer.from([7, 8, 9]));
  let copies = 0;
  const failingMaterialize = async (fileSystem: typeof diskFs, from: string, to: string): Promise<"copied"> => {
    copies++;
    if (copies === 2) throw new Error("injected media failure");
    await copyMediaForReceipt(fileSystem, from, to);
    return "copied";
  };
  const transaction = new ImportTransaction(diskFs, failingMaterialize);
  await transaction.write(text, "changed\n");
  await transaction.copyMedia(source, firstTarget);
  await assert.rejects(transaction.copyMedia(source, secondTarget), /injected media failure/);
  await transaction.rollback();
  assert.equal(await fs.readFile(text, "utf8"), "before\n");
  await assert.rejects(fs.stat(firstTarget));
  await assert.rejects(fs.stat(secondTarget));
});
