import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeArchiveJob, validateArchiveJob } from "../lib/archive_contract.js";

const corpus = JSON.parse(readFileSync(new URL("../../test-fixtures/archive-job-v1-conformance.json", import.meta.url), "utf8"));

function assertSyntheticCorpus(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com|twimg\.com)(?:\/|["?])/i);
  assert.doesNotMatch(serialized, /(?:cookie|token|authorization|api[_-]?key|secret)/i);
}

test("ArchiveJob v1 corpus is synthetic and includes explicit classifications", () => {
  assert.equal(corpus.corpusVersion, 1);
  assert.ok(Array.isArray(corpus.cases));
  assertSyntheticCorpus(corpus);
  assert.ok(corpus.cases.length >= 12);
  for (const item of corpus.cases) {
    assert.match(item.name, /^[a-z0-9-]+$/);
    assert.ok(item.classification);
    assert.ok(item.expected === "accept" || item.expected === "reject");
    assert.ok(item.job && typeof item.job === "object");
  }
});

test("XMC producer contract accepts and rejects every shared corpus case as declared", () => {
  for (const item of corpus.cases) {
    const result = validateArchiveJob(item.job);
    assert.equal(result.ok, item.expected === "accept", `${item.name} (${item.classification}): ${result.errors.join("; ")}`);
    if (item.expected === "accept") {
      assert.doesNotThrow(() => normalizeArchiveJob(item.job), item.name);
    }
  }
});
