import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  PersistedStateV1,
  RepositoryContext,
  WorktreeRecord,
} from "./types.js";

export const statePath = (repository: RepositoryContext): string =>
  join(repository.commonGitDir, "pi-worktree", "state-v1.json");
export const managedPoolRoot = (repository: RepositoryContext): string =>
  resolve(dirname(repository.primaryCwd), ".pi-worktrees");

const isRecord = (value: unknown): value is WorktreeRecord => {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<WorktreeRecord>;
  return (
    record.version === 1 &&
    typeof record.id === "string" &&
    typeof record.cwd === "string" &&
    typeof record.branch === "string" &&
    typeof record.baseCommit === "string" &&
    typeof record.repositoryId === "string" &&
    typeof record.name === "string" &&
    ["creating", "ready", "removing"].includes(record.phase ?? "") &&
    ["reject", "ignore", "snapshot"].includes(record.dirtyPolicy ?? "") &&
    typeof record.keepBranchOnRemove === "boolean" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
};

function validate(
  state: PersistedStateV1,
  repository: RepositoryContext,
): PersistedStateV1 {
  if (
    state.version !== 1 ||
    state.repositoryId !== repository.repositoryId ||
    !Array.isArray(state.records)
  ) {
    throw new Error("Invalid pi-worktree state");
  }
  const ids = new Set<string>();
  const pool = managedPoolRoot(repository);
  for (const record of state.records as unknown[]) {
    if (
      !isRecord(record) ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(record.id) ||
      ids.has(record.id) ||
      record.repositoryId !== repository.repositoryId ||
      record.branch !== `pi-worktree/${record.id}` ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(record.baseCommit) ||
      record.name.length < 1 ||
      record.name.length > 128 ||
      resolve(record.cwd) !== record.cwd ||
      dirname(record.cwd) !== pool ||
      basename(record.cwd) !== record.id ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      !Number.isFinite(Date.parse(record.updatedAt)) ||
      Date.parse(record.updatedAt) < Date.parse(record.createdAt)
    ) {
      throw new Error("Invalid or unsafe worktree record");
    }
    ids.add(record.id);
  }
  return state;
}

export async function loadState(
  repository: RepositoryContext,
): Promise<PersistedStateV1> {
  try {
    return validate(
      JSON.parse(
        await readFile(statePath(repository), "utf8"),
      ) as PersistedStateV1,
      repository,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, repositoryId: repository.repositoryId, records: [] };
    }
    throw error;
  }
}

export async function saveState(
  repository: RepositoryContext,
  state: PersistedStateV1,
): Promise<void> {
  validate(state, repository);
  const path = statePath(repository);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const sorted = {
    ...state,
    records: [...state.records].sort((a, b) => a.id.localeCompare(b.id)),
  };
  try {
    await writeFile(temp, `${JSON.stringify(sorted, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
