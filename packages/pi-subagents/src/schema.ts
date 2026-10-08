import { type Static, Type } from "typebox";
import { TOOL_NAME_PATTERN } from "./tools.js";
import type { ExplicitTaskRequest, RunRequest, TaskRequest } from "./types.js";

const ToolsParams = Type.Optional(
  Type.Array(Type.String({ minLength: 1, pattern: TOOL_NAME_PATTERN }), {
    uniqueItems: true,
    description:
      "Optional tool-name allowlist for this task, including extension and MCP tools. Omit to inherit the parent's active tools and codemode/deferred tools, subject to agent restrictions. Can only narrow permissions; [] disables all tools. Allowing bash or a gateway such as mcp grants that tool's own capabilities, not a sandbox.",
  }),
);

const AGENT_DESCRIPTION =
  "Name (or alias) of the agent to run. Available agents are listed in the tool description. Prefer the most specific agent: scout (read-only investigation), reviewer (code review), researcher (technical research), system-designer (architecture/design), dependency-updater (dependency changes). Use `default` for general code-changing tasks that no specialized agent covers.";
const TASK_DESCRIPTION =
  "Self-contained instruction for the subagent. It does not see this conversation, so include all required context and file paths.";
const CONTEXT_DESCRIPTION =
  "`fresh` starts an isolated session. `fork` is currently unsupported.";
const CWD_DESCRIPTION =
  "Working directory for the subagent. Must be inside the current workspace unless explicitly approved.";
const TaskParams = Type.Object({
  tools: ToolsParams,
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
    tools: ToolsParams,
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
          "Run these agent tasks in parallel. For parallel mode, provide only `tasks`, not `chain` or top-level `agent`/`task`. If both arrays are supplied, `tasks` takes precedence and `chain` is ignored.",
      }),
    ),
    chain: Type.Optional(
      Type.Array(TaskParams, {
        minItems: 1,
        maxItems: 8,
        description:
          "Run these agent tasks sequentially. Use {previous} in a task to insert the previous task output. For sequential mode, provide only `chain`, not `tasks` or top-level `agent`/`task`. Ignored when `tasks` is supplied.",
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
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
  };
}
function explicit(input: SubagentInput): ExplicitTaskRequest {
  const value = task(input);
  if (!Object.hasOwn(input, "agent") || !input.agent?.trim())
    throw new InvalidRequestError("agent must be a non-empty string");
  return { ...value, agent: input.agent };
}
export function parseRequest(input: SubagentInput): RunRequest {
  if (input.tasks !== undefined)
    return { mode: "parallel", tasks: input.tasks };
  if (input.chain !== undefined) return { mode: "chain", tasks: input.chain };
  return Object.hasOwn(input, "agent")
    ? { mode: "single", task: explicit(input) }
    : { mode: "dynamic", task: task(input) };
}
