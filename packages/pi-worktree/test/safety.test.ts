import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalGitRunner } from "../src/git.js";
import { withRepositoryLock } from "../src/lock.js";
import { WorktreeService } from "../src/service.js";
import type { RepositoryContext } from "../src/types.js";
import { createRepository } from "./helpers.js";

test("canonical managed pool rejects a symlink escape", async () => {
  const { parent, root } = await createRepository();
  try {
    const outside = join(parent, "outside");
    await mkdir(outside);
    await symlink(outside, join(parent, ".pi-worktrees"));
    await assert.rejects(
      () => new WorktreeService(root).create({ name: "escape" }),
      /symlink escape/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("repository lock reclaims a dead owner and serializes competing holders", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktree-lock-"));
  try {
    const commonGitDir = join(root, ".git");
    const lock = join(commonGitDir, "pi-worktree", "operation.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({
        version: 1,
        token: "dead",
        pid: 2_147_483_647,
        hostname: hostname(),
        operation: "create",
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
    );
    const repository: RepositoryContext = {
      cwd: root,
      commonGitDir,
      repositoryId: crypto.randomUUID(),
      baseCommit: "0".repeat(40),
      primaryCwd: root,
    };
    let active = 0;
    let maximum = 0;
    const acquire = () =>
      withRepositoryLock(repository, "test", undefined, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });
    await Promise.all([acquire(), acquire()]);
    assert.equal(maximum, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository lock wait is abortable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktree-lock-"));
  try {
    const commonGitDir = join(root, ".git");
    await mkdir(commonGitDir);
    const repository: RepositoryContext = {
      cwd: root,
      commonGitDir,
      repositoryId: crypto.randomUUID(),
      baseCommit: "0".repeat(40),
      primaryCwd: root,
    };
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = withRepositoryLock(
      repository,
      "holder",
      undefined,
      async () => {
        entered();
        await gate;
      },
    );
    await acquired;
    const controller = new AbortController();
    const waiter = withRepositoryLock(
      repository,
      "waiter",
      controller.signal,
      async () => undefined,
    );
    controller.abort(new Error("cancelled lock wait"));
    await assert.rejects(() => waiter, /cancelled lock wait/u);
    release();
    await holder;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pre-aborted Git execution does not spawn a process", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    () => new LocalGitRunner().run(["status"], { signal: controller.signal }),
    /cancelled/u,
  );
});
