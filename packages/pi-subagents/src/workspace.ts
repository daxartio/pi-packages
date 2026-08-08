import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { ExplicitTaskRequest, RunRequest, TaskRequest } from "./types.js";

export type WorkspaceApproval = {
  approved?: readonly string[];
  allow?: (cwd: string) => Promise<boolean>;
};

export async function authorizeWorkspace(
  parentCwd: string,
  requestedCwd: string | undefined,
  approval: WorkspaceApproval = {},
): Promise<string> {
  const parent = await realpath(parentCwd);
  const cwd = await realpath(requestedCwd ?? parent);
  const pathFromParent = relative(parent, cwd);
  if (
    pathFromParent === "" ||
    (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
  ) {
    return cwd;
  }
  if (approval.approved?.includes(cwd) || (await approval.allow?.(cwd)))
    return cwd;
  throw new Error("Sibling workspace requires explicit approval");
}

export async function authorizeRequestWorkspaces(
  request: RunRequest,
  parentCwd: string,
  approval: WorkspaceApproval = {},
): Promise<RunRequest> {
  const authorizeTask = async <T extends TaskRequest>(task: T): Promise<T> => ({
    ...task,
    cwd: await authorizeWorkspace(parentCwd, task.cwd, approval),
  });

  if (request.mode === "dynamic") {
    return { mode: "dynamic", task: await authorizeTask(request.task) };
  }
  if (request.mode === "single") {
    return { mode: "single", task: await authorizeTask(request.task) };
  }

  const tasks = await Promise.all(
    request.tasks.map((task) => authorizeTask<ExplicitTaskRequest>(task)),
  );
  return { mode: request.mode, tasks };
}
