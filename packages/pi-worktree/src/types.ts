export interface WorktreeDescriptorV1 {
  version: 1;
  id: string;
  cwd: string;
  branch: string;
  baseCommit: string;
  repositoryId: string;
}

export interface WorktreeRecord extends WorktreeDescriptorV1 {
  name: string;
  phase: "creating" | "ready" | "removing";
  dirtyPolicy: "reject" | "ignore" | "snapshot";
  keepBranchOnRemove: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedStateV1 {
  version: 1;
  repositoryId: string;
  records: WorktreeRecord[];
}

export interface RepositoryContext {
  cwd: string;
  commonGitDir: string;
  repositoryId: string;
  baseCommit: string;
  primaryCwd: string;
}

export interface CreateRequest {
  name: string;
  baseRef?: string;
  dirtyPolicy?: "reject" | "ignore" | "snapshot";
  keepBranchOnRemove?: boolean;
}

export interface ListRequest {
  cursor?: string;
  limit?: number;
}

export interface RemoveRequest {
  id: string;
  force?: boolean;
  keepBranch?: boolean;
}

export interface CleanupRequest {
  dryRun?: boolean;
  olderThanMs?: number;
}

export interface WorktreeStatus {
  descriptor: WorktreeDescriptorV1;
  health: "ready" | "missing" | "inconsistent";
  dirty: number;
  conflicts: number;
}
