import test from "node:test";
import assert from "node:assert/strict";
import {
  photoMediaFromImageSrc,
  screenNameFromStatusHref,
  statusIdFromHref,
} from "../lib/dom_media.js";

test("DOM photo media normalizes pbs media image src", () => {
  const item = photoMediaFromImageSrc(
    "https://pbs.twimg.com/media/DomPic?format=jpg&name=large"
  );
  assert.deepEqual(item, {
    type: "photo",
    url: "https://pbs.twimg.com/media/DomPic?format=jpg&name=orig",
    ext: "jpg",
  });
});

test("DOM photo media ignores non-media pbs images", () => {
  assert.equal(
    photoMediaFromImageSrc("https://pbs.twimg.com/profile_images/1/avatar.jpg"),
    null
  );
});

test("status id and screen_name extracted from status links", () => {
  const href = "https://x.com/alice_123/status/2074712617130639827/photo/1";
  assert.equal(statusIdFromHref(href), "2074712617130639827");
  assert.equal(
    screenNameFromStatusHref(href, "2074712617130639827"),
    "alice_123"
  );
});

test("screen_name extraction rejects different tweet id", () => {
  assert.equal(
    screenNameFromStatusHref("https://x.com/alice/status/111/photo/1", "222"),
    null
  );
});
