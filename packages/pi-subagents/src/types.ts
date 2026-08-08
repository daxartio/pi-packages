export type TaskState =
  | "queued"
  | "starting"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";
export type BuiltinToolName =
  | "read"
  | "grep"
  | "find"
  | "ls"
  | "bash"
  | "edit"
  | "write";
export type ContextMode = "fresh" | "fork";

export interface TaskRequest {
  task: string;
  context?: ContextMode;
  cwd?: string;
}
export interface ExplicitTaskRequest extends TaskRequest {
  agent: string;
}
export type RunRequest =
  | { mode: "dynamic"; task: TaskRequest }
  | { mode: "single"; task: ExplicitTaskRequest }
  | { mode: "parallel"; tasks: ExplicitTaskRequest[] }
  | { mode: "chain"; tasks: ExplicitTaskRequest[] };

export interface AgentDefinition {
  name: string;
  description: string;
  model?: string;
  thinking?: string;
  tools: BuiltinToolName[];
  systemPrompt: string;
  aliases: string[];
  fallbackModels: string[];
  defaultContext: ContextMode;
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  source: "builtin" | "package" | "user" | "project" | "dynamic";
  filePath: string;
}
export interface DynamicPlanV1 {
  version: 1;
  summary: string;
  roles: Array<{ label: string; roleBrief: string }>;
  nodes: Array<{ role: number; task: string; dependsOn: number[] }>;
}
export interface ValidatedRole {
  id: `dynamic-role-${number}`;
  label: string;
  roleBrief: string;
}
export interface ValidatedNode {
  id: `dynamic-node-${number}`;
  roleId: `dynamic-role-${number}`;
  task: string;
  dependsOn: number[];
}
export interface ValidatedPlan {
  version: 1;
  summary: string;
  roles: ValidatedRole[];
  nodes: ValidatedNode[];
  order: number[];
}
export interface CapabilityCeiling {
  allowedAgents?: string[];
  allowedTools?: string[];
  denyExtensions?: boolean;
}
export interface SubagentLaunchContractV1 {
  version: 1;
  runId: string;
  taskId: string;
  agent: {
    name: string;
    source: AgentDefinition["source"];
    definitionDigest: string;
  };
  context: ContextMode;
  modelCandidates: string[];
  thinking?: string;
  effectiveTools: string[];
  extensionsDenied: boolean;
  roots: { cwd: string; sessionDir: string; artifactsDir: string };
  launchContractDigest: string;
}
export interface WorktreeDescriptorV1 {
  version: 1;
  id: string;
  cwd: string;
  branch: string;
  baseCommit: string;
  repositoryId: string;
}
export interface TaskResult {
  id: string;
  state: TaskState;
  text: string;
  error?: string;
}
export interface RunResult {
  runId: string;
  state: TaskState;
  tasks: TaskResult[];
}
