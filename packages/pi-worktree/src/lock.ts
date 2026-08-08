import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { RepositoryContext } from "./types.js";

interface LockOwner {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  operation: string;
  startedAt: string;
  heartbeatAt: string;
}

const LEASE_MS = 60_000;
const HEARTBEAT_MS = 5_000;
const WAIT_MS = 30_000;

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function readOwner(lock: string): Promise<LockOwner | undefined> {
  try {
    return JSON.parse(
      await readFile(join(lock, "owner.json"), "utf8"),
    ) as LockOwner;
  } catch {
    return undefined;
  }
}

async function writeOwner(lock: string, owner: LockOwner): Promise<void> {
  const path = join(lock, "owner.json");
  const temp = join(lock, `owner.${owner.token}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(owner), { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function stale(lock: string): Promise<boolean> {
  const owner = await readOwner(lock);
  if (
    owner?.version === 1 &&
    owner.hostname === hostname() &&
    Number.isInteger(owner.pid)
  ) {
    if (processIsAlive(owner.pid)) return false;
    return true;
  }
  const timestamp = owner
    ? Date.parse(owner.heartbeatAt)
    : (await stat(lock)).mtimeMs;
  return !Number.isFinite(timestamp) || Date.now() - timestamp > LEASE_MS;
}

async function reclaim(lock: string): Promise<void> {
  try {
    if (!(await stale(lock))) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const abandoned = `${lock}.stale.${randomUUID()}`;
  try {
    await rename(lock, abandoned);
    await rm(abandoned, { recursive: true, force: true });
  } catch (error) {
    if (
      !["ENOENT", "EEXIST", "ENOTEMPTY"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  }
}

export async function withRepositoryLock<T>(
  repository: RepositoryContext,
  operation: string,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const root = join(repository.commonGitDir, "pi-worktree");
  const lock = join(root, "operation.lock");
  const token = randomUUID();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + WAIT_MS;
  let owner: LockOwner | undefined;
  for (;;) {
    signal?.throwIfAborted();
    try {
      await mkdir(lock, { mode: 0o700 });
      owner = {
        version: 1,
        token,
        pid: process.pid,
        hostname: hostname(),
        operation,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      };
      try {
        await writeOwner(lock, owner);
      } catch (error) {
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await reclaim(lock);
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for repository lock: ${operation}`);
      await delay(50, signal);
    }
  }
  let heartbeatWrite = Promise.resolve();
  const heartbeat = setInterval(() => {
    if (!owner) return;
    owner.heartbeatAt = new Date().toISOString();
    heartbeatWrite = heartbeatWrite
      .then(() => writeOwner(lock, owner!))
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    signal?.throwIfAborted();
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await heartbeatWrite;
    try {
      const current = await readOwner(lock);
      if (current?.token === token)
        await rm(lock, { recursive: true, force: true });
    } catch {
      // Never delete a lease whose ownership cannot be proven.
    }
  }
}
