// tests/filename.test.js
// T17-T20: lib/filename.js (buildFilename, sanitizePathSegment via buildFilename).
import test from "node:test";
import assert from "node:assert/strict";
import { buildFilename, sanitizePathSegment } from "../lib/filename.js";

test("T17: full path with account folder", () => {
  const result = buildFilename({
    accountFolder: "mainacct",
    authorScreenName: "alice",
    tweetId: "1900000000000000001",
    serial: 1,
    ext: "jpg",
  });
  assert.equal(result, "x_media_downloader/mainacct/alice-1900000000000000001-01.jpg");
});

test("T18: no account folder (null -> no intermediate segment)", () => {
  const result = buildFilename({
    accountFolder: null,
    authorScreenName: "alice",
    tweetId: "1900000000000000001",
    serial: 1,
    ext: "jpg",
  });
  assert.equal(result, "x_media_downloader/alice-1900000000000000001-01.jpg");
});

test("T19: segment sanitize (invalid chars, reserved name, ext cleanup)", () => {
  const result = buildFilename({
    accountFolder: "CON",
    authorScreenName: "a<b>:c",
    tweetId: "1900000000000000009",
    serial: 1,
    ext: "JPG?",
  });
  assert.equal(result, "x_media_downloader/_CON/a_b__c-1900000000000000009-01.jpg");
  assert.equal(sanitizePathSegment("a<b>:c"), "a_b__c");
  assert.equal(sanitizePathSegment("CON"), "_CON");
});

test("T20: serial zero-padding", () => {
  const base = {
    accountFolder: null,
    authorScreenName: "alice",
    tweetId: "1900000000000000001",
    ext: "jpg",
  };
  assert.ok(buildFilename({ ...base, serial: 1 }).endsWith("-01.jpg"));
  assert.ok(buildFilename({ ...base, serial: 10 }).endsWith("-10.jpg"));
  assert.ok(buildFilename({ ...base, serial: 100 }).endsWith("-100.jpg"));
});
