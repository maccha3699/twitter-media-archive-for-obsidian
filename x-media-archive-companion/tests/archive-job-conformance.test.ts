import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateArchiveJob } from "../src/validation.ts";

const corpus = JSON.parse(readFileSync(new URL("../../test-fixtures/archive-job-v1-conformance.json", import.meta.url), "utf8")) as {
  corpusVersion: number;
  cases: Array<{ name: string; classification: string; expected: "accept" | "reject"; job: unknown }>;
};

function assertSyntheticCorpus(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com|twimg\.com)(?:\/|["?])/i);
  assert.doesNotMatch(serialized, /(?:cookie|token|authorization|api[_-]?key|secret)/i);
}

test("ArchiveJob v1 Companion corpus is synthetic and explicit", () => {
  assert.equal(corpus.corpusVersion, 1);
  assert.ok(corpus.cases.length >= 12);
  assertSyntheticCorpus(corpus);
  for (const item of corpus.cases) {
    assert.match(item.name, /^[a-z0-9-]+$/);
    assert.ok(item.classification);
    assert.ok(item.job && typeof item.job === "object");
  }
});

test("Companion consumer accepts and rejects every shared corpus case as declared", () => {
  for (const item of corpus.cases) {
    let accepted = true;
    try {
      validateArchiveJob(item.job);
    } catch {
      accepted = false;
    }
    assert.equal(accepted, item.expected === "accept", `${item.name} (${item.classification})`);
  }
});
