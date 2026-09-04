import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_POST_AUTHOR_NAVIGATION, postAuthorNavigation } from "../src/post-navigation.ts";

test("generated posts hide both obsolete author links by default", () => {
  assert.deepEqual(DEFAULT_POST_AUTHOR_NAVIGATION, { profile: false, folder: false });
  assert.equal(postAuthorNavigation("XMediaArchive", "alice"), "");
});

test("profile and folder links remain independently reversible", () => {
  assert.equal(
    postAuthorNavigation("XMediaArchive", "alice", { profile: true, folder: false }),
    "[[XMediaArchive/alice/_profile|投稿者プロフィール]]",
  );
  assert.equal(
    postAuthorNavigation("XMediaArchive", "alice", { profile: false, folder: true }),
    "[[XMediaArchive/alice/alice|このユーザーの投稿フォルダ]]",
  );
  assert.equal(
    postAuthorNavigation("XMediaArchive", "alice", { profile: true, folder: true }),
    "[[XMediaArchive/alice/_profile|投稿者プロフィール]] · [[XMediaArchive/alice/alice|このユーザーの投稿フォルダ]]",
  );
});
