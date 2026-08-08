import assert from "node:assert/strict";
import test from "node:test";
import { deriveIdentity, slugify } from "../src/naming.js";
test("worktree identity is deterministic and safe", () => {
  const value = deriveIdentity({
    repositoryId: "repo",
    baseCommit: "commit",
    name: "Feature: Login",
  });
  assert.match(value.id, /^feature-login-[a-f0-9]{12}$/u);
  assert.equal(value.branch, `pi-worktree/${value.id}`);
  assert.throws(() => slugify("---"));
});
