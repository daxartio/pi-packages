import { Type, type Static } from "typebox";
import type { ExplicitTaskRequest, RunRequest, TaskRequest } from "./types.js";

const AGENT_DESCRIPTION =
  "Name (or alias) of the agent to run. Available agents are listed in the tool description. Prefer the most specific agent: scout (read-only investigation), reviewer (code review), researcher (technical research), system-designer (architecture/design), dependency-updater (dependency changes). Use `default` for general code-changing tasks that no specialized agent covers.";
const TASK_DESCRIPTION =
  "Self-contained instruction for the subagent. It does not see this conversation, so include all required context and file paths.";
const CONTEXT_DESCRIPTION =
  "`fresh` starts an isolated session. `fork` is currently unsupported.";
const CWD_DESCRIPTION =
  "Working directory for the subagent. Must be inside the current workspace unless explicitly approved.";
const TaskParams = Type.Object({
  agent: Type.String({ minLength: 1, description: AGENT_DESCRIPTION }),
  task: Type.String({
    minLength: 1,
    maxLength: 32_768,
    description: TASK_DESCRIPTION,
  }),
  context: Type.Optional(
    Type.Union([Type.Literal("fresh"), Type.Literal("fork")], {
      description: CONTEXT_DESCRIPTION,
    }),
  ),
  cwd: Type.Optional(Type.String({ description: CWD_DESCRIPTION })),
});

export const SubagentParams = Type.Object(
  {
    agent: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        description: AGENT_DESCRIPTION,
      }),
    ),
    task: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 32_768,
        description: TASK_DESCRIPTION,
      }),
    ),
    context: Type.Optional(
      Type.Union([Type.Literal("fresh"), Type.Literal("fork")], {
        description: CONTEXT_DESCRIPTION,
      }),
    ),
    cwd: Type.Optional(
      Type.String({ minLength: 1, description: CWD_DESCRIPTION }),
    ),
    tasks: Type.Optional(
      Type.Array(TaskParams, {
        minItems: 1,
        maxItems: 8,
        description:
          "Run these agent tasks in parallel. Mutually exclusive with `chain`.",
      }),
    ),
    chain: Type.Optional(
      Type.Array(TaskParams, {
        minItems: 1,
        maxItems: 8,
        description:
          "Run these agent tasks sequentially. Use {previous} in a task to insert the previous task output. Mutually exclusive with `tasks`.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type SubagentInput = Static<typeof SubagentParams>;
export class InvalidRequestError extends Error {}
function task(input: SubagentInput): TaskRequest {
  if (!input.task) throw new InvalidRequestError("task is required");
  return {
    task: input.task,
    ...(input.context ? { context: input.context } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
  };
}
function explicit(input: SubagentInput): ExplicitTaskRequest {
  const value = task(input);
  if (!Object.hasOwn(input, "agent") || !input.agent?.trim())
    throw new InvalidRequestError("agent must be a non-empty string");
  return { ...value, agent: input.agent };
}
export function parseRequest(input: SubagentInput): RunRequest {
  if (input.tasks !== undefined && input.chain !== undefined)
    throw new InvalidRequestError("choose tasks or chain, not both");
  if (input.tasks !== undefined)
    return { mode: "parallel", tasks: input.tasks };
  if (input.chain !== undefined) return { mode: "chain", tasks: input.chain };
  return Object.hasOwn(input, "agent")
    ? { mode: "single", task: explicit(input) }
    : { mode: "dynamic", task: task(input) };
}
