// tests/account.test.js
// T10-T16: lib/account.js (parseTwid, sanitizeScreenName, pickScreenNameFromTexts).
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTwid,
  sanitizeScreenName,
  pickScreenNameFromTexts,
  screenNameFromAvatarTestid,
} from "../lib/account.js";

test("T10: parseTwid encoded", () => {
  assert.equal(parseTwid("u%3D1234567890"), "id_1234567890");
});

test("T11: parseTwid decoded and quoted", () => {
  assert.equal(parseTwid("u=42"), "id_42");
  assert.equal(parseTwid('"u=42"'), "id_42");
});

test("T12: parseTwid invalid input", () => {
  assert.equal(parseTwid("garbage"), null);
  assert.equal(parseTwid(""), null);
  assert.equal(parseTwid(undefined), null);
  assert.equal(parseTwid(null), null);
});

test("T13: sanitizeScreenName valid", () => {
  assert.equal(sanitizeScreenName("@Valid_Name1"), "Valid_Name1");
});

test("T14: sanitizeScreenName strips invalid chars and clamps to 15", () => {
  // After stripping leading "@": "Foo-Bar!Baz_1234567" (19 chars, contains
  // invalid "-"/"!" so it fails the direct regex path).
  const input = "@Foo-Bar!Baz_1234567";
  const result = sanitizeScreenName(input);
  assert.equal(result, "FooBarBaz_12345");
  assert.ok(result.length <= 15);
  assert.ok(/^[A-Za-z0-9_]+$/.test(result));
});

test("T15: sanitizeScreenName empty results become null", () => {
  assert.equal(sanitizeScreenName("@@@"), null);
  assert.equal(sanitizeScreenName("   "), null);
  assert.equal(sanitizeScreenName(123), null);
});

test("T16: pickScreenNameFromTexts", () => {
  const texts = ["Home", "@foo_bar", "@toolongscreennamexxx"];
  assert.equal(pickScreenNameFromTexts(texts), "foo_bar");
});

test("T16b: screenNameFromAvatarTestid extracts display handle", () => {
  assert.equal(screenNameFromAvatarTestid("UserAvatar-Container-foo_bar"), "foo_bar");
  // Handles are ASCII, but sanitize is applied defensively.
  assert.equal(screenNameFromAvatarTestid("UserAvatar-Container-sample_user"), "sample_user");
  // Non-matching / invalid inputs -> null.
  assert.equal(screenNameFromAvatarTestid("SomethingElse"), null);
  assert.equal(screenNameFromAvatarTestid(null), null);
  assert.equal(screenNameFromAvatarTestid("UserAvatar-Container-"), null);
});
