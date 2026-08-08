import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RepositoryContext } from "./types.js";

export interface GitResult {
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface GitRunner {
  run(
    args: readonly string[],
    options?: {
      cwd?: string;
      stdin?: string | Uint8Array;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<GitResult>;
}

export interface GitWorktree {
  cwd: string;
  head?: string;
  branch?: string;
}

const killProcess = (pid: number | undefined, signal: NodeJS.Signals): void => {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    // The process has already exited.
  }
};

export class LocalGitRunner implements GitRunner {
  run(
    args: readonly string[],
    options: {
      cwd?: string;
      stdin?: string | Uint8Array;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<GitResult> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    return new Promise((resolveResult, reject) => {
      const child = spawn("git", args, {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let aborted = false;
      let timedOut = false;
      let settled = false;
      const terminate = (reason: "abort" | "timeout") => {
        if (reason === "abort") aborted = true;
        else timedOut = true;
        killProcess(child.pid, "SIGTERM");
        setTimeout(() => killProcess(child.pid, "SIGKILL"), 2_000).unref();
      };
      const onAbort = () => terminate("abort");
      const timer = options.timeoutMs
        ? setTimeout(() => terminate("timeout"), options.timeoutMs)
        : undefined;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (value: Buffer) => stdout.push(value));
      child.stderr.on("data", (value: Buffer) => stderr.push(value));
      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        if (aborted)
          reject(
            options.signal?.reason ??
              new DOMException("Operation aborted", "AbortError"),
          );
        else if (timedOut)
          reject(new Error(`git ${args[0] ?? "command"} timed out`));
        else
          resolveResult({
            code: code ?? -1,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
          });
      });
      child.stdin.end(options.stdin);
    });
  }
}

const text = (value: Uint8Array): string => Buffer.from(value).toString("utf8");

async function required(
  runner: GitRunner,
  cwd: string,
  signal: AbortSignal | undefined,
  ...args: string[]
): Promise<string> {
  const result = await runner.run(args, {
    cwd,
    timeoutMs: 30_000,
    ...(signal ? { signal } : {}),
  });
  if (result.code !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${text(result.stderr).slice(-4096)}`,
    );
  return text(result.stdout).trim();
}

async function stableRepositoryId(commonGitDir: string): Promise<string> {
  const root = join(commonGitDir, "pi-worktree");
  const path = join(root, "repository-id");
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, `${randomUUID()}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const id = (await readFile(path, "utf8")).trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      id,
    )
  ) {
    throw new Error("Invalid pi-worktree repository identity");
  }
  return id;
}

export async function preflight(
  git: GitRunner,
  cwd: string,
  baseRef = "HEAD",
  signal?: AbortSignal,
): Promise<RepositoryContext> {
  signal?.throwIfAborted();
  const top = await realpath(
    await required(git, cwd, signal, "rev-parse", "--show-toplevel"),
  );
  const common = await required(
    git,
    top,
    signal,
    "rev-parse",
    "--git-common-dir",
  );
  const commonGitDir = await realpath(resolve(top, common));
  const baseCommit = await required(
    git,
    top,
    signal,
    "rev-parse",
    "--verify",
    `${baseRef}^{commit}`,
  );
  const bare = await required(
    git,
    top,
    signal,
    "rev-parse",
    "--is-bare-repository",
  );
  if (bare === "true") throw new Error("Bare repositories are unsupported");
  const repositoryId = await stableRepositoryId(commonGitDir);
  return {
    cwd: top,
    commonGitDir,
    repositoryId,
    baseCommit,
    primaryCwd: dirname(commonGitDir),
  };
}

export async function listGitWorktrees(
  git: GitRunner,
  repository: RepositoryContext,
  signal?: AbortSignal,
): Promise<GitWorktree[]> {
  const result = await git.run(["worktree", "list", "--porcelain", "-z"], {
    cwd: repository.cwd,
    timeoutMs: 30_000,
    ...(signal ? { signal } : {}),
  });
  if (result.code !== 0)
    throw new Error(
      `git worktree list failed: ${text(result.stderr).slice(-4096)}`,
    );
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | undefined;
  for (const field of text(result.stdout).split("\0")) {
    if (!field) {
      if (current) worktrees.push(current);
      current = undefined;
    } else if (field.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { cwd: field.slice("worktree ".length) };
    } else if (current && field.startsWith("HEAD "))
      current.head = field.slice("HEAD ".length);
    else if (current && field.startsWith("branch "))
      current.branch = field.slice("branch ".length);
  }
  if (current) worktrees.push(current);
  return worktrees;
}
