import { type ChildProcess, execFile } from "node:child_process";

async function descendantGroups(pid: number): Promise<number[]> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      "ps",
      ["-axo", "pid=,ppid="],
      { timeout: 2_000, maxBuffer: 4_000_000 },
      (error, stdout) => {
        error ? reject(error) : resolve(stdout);
      },
    );
  });
  const children = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/u).map(Number);
    if (!child || parent === undefined || !Number.isSafeInteger(parent))
      continue;
    const entries = children.get(parent) ?? [];
    entries.push(child);
    children.set(parent, entries);
  }
  const groups: number[] = [];
  const visited = new Set<number>();
  const visit = (parent: number) => {
    if (visited.has(parent)) return;
    visited.add(parent);
    for (const child of children.get(parent) ?? []) visit(child);
    groups.push(parent);
  };
  visit(pid);
  return groups;
}

export async function killChildTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  groups = new Set<number>(),
): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 2_000 },
        (error) => {
          if (!error || error.code === 128) resolve();
          else reject(error);
        },
      );
    });
    return;
  }
  let discoveryError: unknown;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      for (const pid of await descendantGroups(child.pid)) groups.add(pid);
    } catch (error) {
      discoveryError = error;
    }
  }
  groups.add(child.pid);
  for (const pid of groups) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      )
        throw error;
    }
  }
  if (discoveryError) throw discoveryError;
}
