import { Type, type Static } from "typebox";
import type { ExplicitTaskRequest, RunRequest, TaskRequest } from "./types.js";

export const SubagentParams = Type.Object(
  {
    agent: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    task: Type.Optional(Type.String({ minLength: 1, maxLength: 32_768 })),
    context: Type.Optional(
      Type.Union([Type.Literal("fresh"), Type.Literal("fork")]),
    ),
    cwd: Type.Optional(Type.String({ minLength: 1 })),
    tasks: Type.Optional(
      Type.Array(
        Type.Object({
          agent: Type.String({ minLength: 1 }),
          task: Type.String({ minLength: 1, maxLength: 32_768 }),
          context: Type.Optional(
            Type.Union([Type.Literal("fresh"), Type.Literal("fork")]),
          ),
          cwd: Type.Optional(Type.String()),
        }),
        { minItems: 1, maxItems: 8 },
      ),
    ),
    chain: Type.Optional(
      Type.Array(
        Type.Object({
          agent: Type.String({ minLength: 1 }),
          task: Type.String({ minLength: 1, maxLength: 32_768 }),
          context: Type.Optional(
            Type.Union([Type.Literal("fresh"), Type.Literal("fork")]),
          ),
          cwd: Type.Optional(Type.String()),
        }),
        { minItems: 1, maxItems: 8 },
      ),
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
