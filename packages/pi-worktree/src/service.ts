import { access, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  listGitWorktrees,
  LocalGitRunner,
  preflight,
  type GitRunner,
  type GitWorktree,
} from "./git.js";
import { withRepositoryLock } from "./lock.js";
import { deriveIdentity } from "./naming.js";
import { loadState, managedPoolRoot, saveState } from "./state.js";
import type {
  CleanupRequest,
  CreateRequest,
  ListRequest,
  PersistedStateV1,
  RemoveRequest,
  RepositoryContext,
  WorktreeDescriptorV1,
  WorktreeRecord,
  WorktreeStatus,
} from "./types.js";

const exists = async (path: string): Promise<boolean> =>
  access(path)
    .then(() => true)
    .catch(() => false);
const output = (value: Uint8Array): string =>
  Buffer.from(value).toString("utf8").trim().slice(-4096);
const expectedBranch = (record: WorktreeRecord): string =>
  `refs/heads/${record.branch}`;

export class WorktreeService {
  constructor(
    private readonly cwd: string,
    private readonly git: GitRunner = new LocalGitRunner(),
  ) {}

  async create(
    request: CreateRequest,
    signal?: AbortSignal,
  ): Promise<WorktreeDescriptorV1> {
    const repository = await preflight(
      this.git,
      this.cwd,
      request.baseRef ?? "HEAD",
      signal,
    );
    return withRepositoryLock(repository, "create", signal, async () => {
      const state = await loadState(repository);
      const identity = deriveIdentity({
        repositoryId: repository.repositoryId,
        baseCommit: repository.baseCommit,
        name: request.name,
      });
      const existing = state.records.find(
        (record) => record.id === identity.id,
      );
      if (existing) {
        if (
          existing.phase === "ready" &&
          (await this.ownedWorktree(repository, existing, signal))
        )
          return descriptor(existing);
        throw new Error(
          `Managed worktree requires recovery before it can be recreated: ${existing.id}`,
        );
      }
      if (request.dirtyPolicy === "snapshot")
        throw new Error("snapshot policy is not available in this release");
      if (
        (request.dirtyPolicy ?? "reject") === "reject" &&
        (await this.dirty(repository.cwd, signal))
      ) {
        throw new Error("Source worktree is dirty");
      }
      const pool = await this.pool(repository);
      const cwd = resolve(pool, identity.id);
      if (dirname(cwd) !== pool || (await exists(cwd)))
        throw new Error(
          "Managed worktree path already exists or escaped its pool",
        );
      const now = new Date().toISOString();
      const record: WorktreeRecord = {
        version: 1,
        id: identity.id,
        cwd,
        branch: identity.branch,
        baseCommit: repository.baseCommit,
        repositoryId: repository.repositoryId,
        name: request.name,
        phase: "creating",
        dirtyPolicy: request.dirtyPolicy ?? "reject",
        keepBranchOnRemove: request.keepBranchOnRemove ?? false,
        createdAt: now,
        updatedAt: now,
      };
      state.records.push(record);
      await saveState(repository, state);
      signal?.throwIfAborted();
      const result = await this.git.run(
        ["worktree", "add", "-b", record.branch, record.cwd, record.baseCommit],
        {
          cwd: repository.cwd,
          timeoutMs: 300_000,
          ...(signal ? { signal } : {}),
        },
      );
      if (result.code !== 0) {
        record.updatedAt = new Date().toISOString();
        await saveState(repository, state);
        throw new Error(
          `git worktree add failed; recovery record retained: ${output(result.stderr)}`,
        );
      }
      if (!(await this.ownedWorktree(repository, record, signal))) {
        throw new Error(
          `Created worktree failed ownership verification; recovery record retained: ${record.id}`,
        );
      }
      record.phase = "ready";
      record.updatedAt = new Date().toISOString();
      await saveState(repository, state);
      return descriptor(record);
    });
  }

  async list(
    request: ListRequest = {},
    signal?: AbortSignal,
  ): Promise<{ records: WorktreeDescriptorV1[]; nextCursor?: string }> {
    const repository = await preflight(this.git, this.cwd, "HEAD", signal);
    const state = await loadState(repository);
    const limit = Math.min(request.limit ?? 50, 100);
    const records = state.records
      .filter((record) => record.phase === "ready")
      .sort((a, b) => a.id.localeCompare(b.id));
    const cursorIndex = request.cursor
      ? records.findIndex((record) => record.id === request.cursor)
      : -1;
    if (request.cursor && cursorIndex < 0)
      throw new Error(`Unknown list cursor: ${request.cursor}`);
    const start = cursorIndex + 1;
    const page = records.slice(start, start + limit);
    return {
      records: page.map(descriptor),
      ...(start + page.length < records.length && page.length
        ? { nextCursor: page.at(-1)!.id }
        : {}),
    };
  }

  async status(id: string, signal?: AbortSignal): Promise<WorktreeStatus> {
    const repository = await preflight(this.git, this.cwd, "HEAD", signal);
    const record = (await loadState(repository)).records.find(
      (item) => item.id === id,
    );
    if (!record) throw new Error(`Unknown managed worktree: ${id}`);
    const pathExists = await exists(record.cwd);
    const entry = await this.worktreeEntry(repository, record, signal);
    if (!pathExists && !entry)
      return {
        descriptor: descriptor(record),
        health: "missing",
        dirty: 0,
        conflicts: 0,
      };
    if (
      !pathExists ||
      !entry ||
      !(await this.canonicalRecordPath(record)) ||
      entry.branch !== expectedBranch(record)
    ) {
      return {
        descriptor: descriptor(record),
        health: "inconsistent",
        dirty: 0,
        conflicts: 0,
      };
    }
    const porcelain = await this.git.run(["status", "--porcelain=v1"], {
      cwd: record.cwd,
      timeoutMs: 30_000,
      ...(signal ? { signal } : {}),
    });
    if (porcelain.code !== 0)
      return {
        descriptor: descriptor(record),
        health: "inconsistent",
        dirty: 0,
        conflicts: 0,
      };
    const lines = Buffer.from(porcelain.stdout)
      .toString("utf8")
      .split("\n")
      .filter(Boolean);
    const conflicts = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
    return {
      descriptor: descriptor(record),
      health: record.phase === "ready" ? "ready" : "inconsistent",
      dirty: lines.length,
      conflicts: lines.filter((line) => conflicts.has(line.slice(0, 2))).length,
    };
  }

  async remove(
    request: RemoveRequest,
    signal?: AbortSignal,
  ): Promise<{ removed: boolean }> {
    const repository = await preflight(this.git, this.cwd, "HEAD", signal);
    return withRepositoryLock(repository, "remove", signal, async () => {
      const state = await loadState(repository);
      await this.removeLocked(repository, state, request, signal);
      return { removed: true };
    });
  }

  async cleanup(
    request: CleanupRequest = {},
    signal?: AbortSignal,
  ): Promise<{ candidates: string[]; removed: string[] }> {
    const repository = await preflight(this.git, this.cwd, "HEAD", signal);
    const cutoff = Date.now() - (request.olderThanMs ?? 0);
    if (request.dryRun ?? true) {
      const state = await loadState(repository);
      return {
        candidates: cleanupCandidates(state, cutoff).map((record) => record.id),
        removed: [],
      };
    }
    return withRepositoryLock(repository, "cleanup", signal, async () => {
      const state = await loadState(repository);
      const candidates = cleanupCandidates(state, cutoff);
      const removed: string[] = [];
      for (const candidate of candidates) {
        signal?.throwIfAborted();
        const current = state.records.find(
          (record) => record.id === candidate.id,
        );
        if (
          !current ||
          current.createdAt !== candidate.createdAt ||
          !eligibleForCleanup(current, cutoff)
        )
          continue;
        try {
          await this.removeLocked(
            repository,
            state,
            { id: current.id },
            signal,
          );
          removed.push(current.id);
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          // Inconsistent or dirty records remain journaled for explicit recovery.
        }
      }
      return { candidates: candidates.map((record) => record.id), removed };
    });
  }

  private async removeLocked(
    repository: RepositoryContext,
    state: PersistedStateV1,
    request: RemoveRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    const record = state.records.find((item) => item.id === request.id);
    if (!record) throw new Error(`Unknown managed worktree: ${request.id}`);
    const pathExists = await exists(record.cwd);
    const entry = await this.worktreeEntry(repository, record, signal);
    if (pathExists && !(await this.canonicalRecordPath(record)))
      throw new Error("Managed worktree path failed ownership verification");
    if (pathExists && !entry)
      throw new Error(
        "Managed path is not registered as the recorded Git worktree",
      );
    if (entry && entry.branch !== expectedBranch(record))
      throw new Error("Managed worktree branch failed ownership verification");
    if (
      pathExists &&
      (await this.dirty(record.cwd, signal)) &&
      !request.force
    ) {
      throw new Error("Managed worktree is dirty; force is required");
    }
    record.phase = "removing";
    record.updatedAt = new Date().toISOString();
    await saveState(repository, state);
    signal?.throwIfAborted();
    if (entry) {
      const result = await this.git.run(
        [
          "worktree",
          "remove",
          ...(request.force ? ["--force"] : []),
          record.cwd,
        ],
        {
          cwd: repository.cwd,
          timeoutMs: 300_000,
          ...(signal ? { signal } : {}),
        },
      );
      if (result.code !== 0)
        throw new Error(
          `git worktree remove failed; recovery record retained: ${output(result.stderr)}`,
        );
      if (
        (await exists(record.cwd)) ||
        (await this.worktreeEntry(repository, record, signal))
      ) {
        throw new Error(
          "Git worktree removal was incomplete; recovery record retained",
        );
      }
    }
    if (
      !(request.keepBranch ?? record.keepBranchOnRemove) &&
      (await this.branchExists(repository, record.branch, signal))
    ) {
      const result = await this.git.run(["branch", "-D", record.branch], {
        cwd: repository.cwd,
        timeoutMs: 30_000,
        ...(signal ? { signal } : {}),
      });
      if (
        result.code !== 0 ||
        (await this.branchExists(repository, record.branch, signal))
      ) {
        throw new Error(
          `git branch deletion failed; recovery record retained: ${output(result.stderr)}`,
        );
      }
    }
    state.records = state.records.filter((item) => item.id !== record.id);
    await saveState(repository, state);
  }

  private async branchExists(
    repository: RepositoryContext,
    branch: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await this.git.run(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      {
        cwd: repository.cwd,
        timeoutMs: 30_000,
        ...(signal ? { signal } : {}),
      },
    );
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new Error(`git show-ref failed: ${output(result.stderr)}`);
  }

  private async dirty(cwd: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.git.run(["status", "--porcelain=v2", "-z"], {
      cwd,
      timeoutMs: 30_000,
      ...(signal ? { signal } : {}),
    });
    return result.code !== 0 || result.stdout.length > 0;
  }

  private async pool(repository: RepositoryContext): Promise<string> {
    const expected = managedPoolRoot(repository);
    await mkdir(expected, { recursive: true, mode: 0o700 });
    const canonical = await realpath(expected);
    if (canonical !== expected)
      throw new Error("Managed worktree pool contains a symlink escape");
    return canonical;
  }

  private async canonicalRecordPath(record: WorktreeRecord): Promise<boolean> {
    try {
      return (await realpath(record.cwd)) === record.cwd;
    } catch {
      return false;
    }
  }

  private async worktreeEntry(
    repository: RepositoryContext,
    record: WorktreeRecord,
    signal?: AbortSignal,
  ): Promise<GitWorktree | undefined> {
    const entries = await listGitWorktrees(this.git, repository, signal);
    return entries.find((entry) => resolve(entry.cwd) === record.cwd);
  }

  private async ownedWorktree(
    repository: RepositoryContext,
    record: WorktreeRecord,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (
      !(await exists(record.cwd)) ||
      !(await this.canonicalRecordPath(record))
    )
      return false;
    const entry = await this.worktreeEntry(repository, record, signal);
    return entry?.branch === expectedBranch(record);
  }
}

const eligibleForCleanup = (record: WorktreeRecord, cutoff: number): boolean =>
  record.phase !== "ready" || Date.parse(record.updatedAt) <= cutoff;

const cleanupCandidates = (
  state: PersistedStateV1,
  cutoff: number,
): WorktreeRecord[] =>
  state.records.filter((record) => eligibleForCleanup(record, cutoff));

function descriptor(record: WorktreeRecord): WorktreeDescriptorV1 {
  const { version, id, cwd, branch, baseCommit, repositoryId } = record;
  return { version, id, cwd, branch, baseCommit, repositoryId };
}
