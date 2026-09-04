import assert from "node:assert/strict";
import test from "node:test";
import { StagedDeletionJournal } from "../src/staged-deletion.ts";

test("staged deletion rolls successful text and path mutations back in reverse order", async () => {
  const events: string[] = [];
  const journal = new StagedDeletionJournal<string, string>({
    async rename(entry, target) { events.push(`rename:${entry}:${target}`); },
    async write(file, data) { events.push(`write:${file}:${data}`); },
  });
  await journal.move("author", "XMediaArchive/alice", "stage/author");
  await journal.move("account", "XMediaArchive/_accounts/alice.md", "stage/account.md");
  await journal.replace("receipt", "old", "new", "receipt.json");
  assert.deepEqual(await journal.rollback(), []);
  assert.deepEqual(events.slice(-3), [
    "write:receipt:old",
    "rename:account:XMediaArchive/_accounts/alice.md",
    "rename:author:XMediaArchive/alice",
  ]);
});

test("a failed mutation is not recorded and rollback reports only failed restores", async () => {
  const events: string[] = [];
  const journal = new StagedDeletionJournal<string, string>({
    async rename(entry, target) {
      events.push(`rename:${entry}:${target}`);
      if (target === "stage/fail" || target === "original/one") throw new Error("blocked");
    },
    async write() {},
  });
  await journal.move("one", "original/one", "stage/one");
  await assert.rejects(journal.move("two", "original/two", "stage/fail"));
  assert.deepEqual(await journal.rollback(), ["original/one"]);
  assert.equal(events.some((event) => event === "rename:two:original/two"), false);
});
