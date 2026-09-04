import test from "node:test";
import assert from "node:assert/strict";
import { DownloadFilenameClaims } from "../lib/download_filename.js";

test("claims the intended filename only for this extension", () => {
  const claims = new DownloadFilenameClaims();
  claims.add("https://pbs.twimg.com/media/a.jpg", "x_media_downloader/me/alice-1-01.jpg");

  assert.equal(
    claims.claim(
      { url: "https://pbs.twimg.com/media/a.jpg", byExtensionId: "other" },
      "xmc"
    ),
    null
  );
  assert.equal(
    claims.claim(
      { url: "https://pbs.twimg.com/media/a.jpg", byExtensionId: "xmc" },
      "xmc"
    ),
    "x_media_downloader/me/alice-1-01.jpg"
  );
});

test("queues repeated URLs in download order", () => {
  const claims = new DownloadFilenameClaims();
  const item = { url: "https://pbs.twimg.com/media/a.jpg", byExtensionId: "xmc" };
  claims.add(item.url, "first.jpg");
  claims.add(item.url, "second.jpg");

  assert.equal(claims.claim(item, "xmc"), "first.jpg");
  assert.equal(claims.claim(item, "xmc"), "second.jpg");
  assert.equal(claims.claim(item, "xmc"), null);
});

test("removes an unconsumed claim after download startup failure", () => {
  const claims = new DownloadFilenameClaims();
  const item = { url: "https://pbs.twimg.com/media/a.jpg", byExtensionId: "xmc" };
  claims.add(item.url, "failed.jpg");
  claims.add(item.url, "retry.jpg");

  claims.remove(item.url, "failed.jpg");
  assert.equal(claims.claim(item, "xmc"), "retry.jpg");
  assert.equal(claims.claim(item, "xmc"), null);
});
