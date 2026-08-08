import assert from "node:assert/strict";
import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { LocalGitRunner, type GitRunner } from "../src/git.js";
import { WorktreeService } from "../src/service.js";
import { createRepository, git } from "./helpers.js";

class FaultRunner implements GitRunner {
  failAdd = false;
  failBranchDelete = false;
  private readonly local = new LocalGitRunner();

  run(...args: Parameters<GitRunner["run"]>): ReturnType<GitRunner["run"]> {
    if (this.failAdd && args[0][0] === "worktree" && args[0][1] === "add") {
      return Promise.resolve({
        code: 1,
        stdout: new Uint8Array(),
        stderr: Buffer.from("injected add failure"),
      });
    }
    if (
      this.failBranchDelete &&
      args[0][0] === "branch" &&
      args[0][1] === "-D"
    ) {
      return Promise.resolve({
        code: 1,
        stdout: new Uint8Array(),
        stderr: Buffer.from("injected branch failure"),
      });
    }
    return this.local.run(...args);
  }
}

class DelayedRemoveRunner implements GitRunner {
  private readonly local = new LocalGitRunner();
  private releaseRemoval: () => void;
  readonly removalStarted: Promise<void>;
  private readonly removalReleased: Promise<void>;
  private markRemovalStarted: () => void;
  private delayed = false;

  constructor() {
    let start!: () => void;
    let release!: () => void;
    this.removalStarted = new Promise<void>((resolve) => {
      start = resolve;
    });
    this.removalReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.markRemovalStarted = start;
    this.releaseRemoval = release;
  }

  release(): void {
    this.releaseRemoval();
  }

  async run(
    ...args: Parameters<GitRunner["run"]>
  ): ReturnType<GitRunner["run"]> {
    if (!this.delayed && args[0][0] === "worktree" && args[0][1] === "remove") {
      this.delayed = true;
      this.markRemovalStarted();
      await this.removalReleased;
    }
    return this.local.run(...args);
  }
}

const persistedRecords = async (
  root: string,
): Promise<Array<{ id: string; phase: string }>> => {
  const state = JSON.parse(
    await readFile(join(root, ".git", "pi-worktree", "state-v1.json"), "utf8"),
  ) as {
    records: Array<{ id: string; phase: string }>;
  };
  return state.records.map(({ id, phase }) => ({ id, phase }));
};

test("create is idempotent, status is verified, and repository identity survives remote changes", async () => {
  const { parent, root } = await createRepository();
  try {
    const service = new WorktreeService(root);
    const first = await service.create({
      name: "feature",
      dirtyPolicy: "reject",
    });
    const second = await service.create({
      name: "feature",
      dirtyPolicy: "reject",
    });
    assert.deepEqual(second, first);
    assert.equal((await service.status(first.id)).health, "ready");
    await git(root, [
      "remote",
      "add",
      "origin",
      "https://example.com/first.git",
    ]);
    await git(root, [
      "remote",
      "set-url",
      "origin",
      "git@example.com:second.git",
    ]);
    assert.deepEqual((await service.list()).records, [first]);
    await rename(first.cwd, `${first.cwd}.moved`);
    assert.equal((await service.status(first.id)).health, "inconsistent");
    await rename(`${first.cwd}.moved`, first.cwd);
    await assert.rejects(
      () => service.remove({ id: "not-managed" }),
      /Unknown managed worktree/u,
    );
    assert.deepEqual(await service.remove({ id: first.id }), { removed: true });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("cleanup cannot delete a worktree recreated concurrently with the same deterministic ID", async () => {
  const { parent, root } = await createRepository();
  try {
    const runner = new DelayedRemoveRunner();
    const service = new WorktreeService(root, runner);
    const original = await service.create({ name: "race" });
    const cleanup = service.cleanup({ dryRun: false });
    await runner.removalStarted;
    const recreate = new WorktreeService(root).create({ name: "race" });
    runner.release();
    assert.deepEqual((await cleanup).removed, [original.id]);
    const fresh = await recreate;
    assert.equal(fresh.id, original.id);
    assert.equal((await service.status(fresh.id)).health, "ready");
    await service.remove({ id: fresh.id });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("failed create and branch deletion retain recoverable lifecycle records", async () => {
  const { parent, root } = await createRepository();
  try {
    const runner = new FaultRunner();
    const service = new WorktreeService(root, runner);
    runner.failAdd = true;
    await assert.rejects(
      () => service.create({ name: "failed-add" }),
      /recovery record retained/u,
    );
    assert.equal((await persistedRecords(root))[0]?.phase, "creating");
    runner.failAdd = false;
    assert.deepEqual(
      (await service.cleanup({ dryRun: false })).removed.length,
      1,
    );

    const created = await service.create({ name: "failed-delete" });
    runner.failBranchDelete = true;
    await assert.rejects(
      () => service.remove({ id: created.id }),
      /recovery record retained/u,
    );
    assert.deepEqual(await persistedRecords(root), [
      { id: created.id, phase: "removing" },
    ]);
    runner.failBranchDelete = false;
    assert.deepEqual(await service.remove({ id: created.id }), {
      removed: true,
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("tampered persisted ownership data fails closed", async () => {
  const { parent, root } = await createRepository();
  try {
    const service = new WorktreeService(root);
    const originalBranch = await git(root, ["branch", "--show-current"]);
    const created = await service.create({ name: "ownership" });
    const path = join(root, ".git", "pi-worktree", "state-v1.json");
    const state = JSON.parse(await readFile(path, "utf8")) as {
      records: Array<{ cwd: string }>;
    };
    state.records[0]!.cwd = root;
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(path, JSON.stringify(state)),
    );
    await assert.rejects(
      () => service.remove({ id: created.id, force: true }),
      /unsafe worktree record/u,
    );
    assert.equal(await git(root, ["branch", "--show-current"]), originalBranch);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
