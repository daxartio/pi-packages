import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.js";
import { RpcChildExecutor } from "./child-executor.js";
import { SubagentOrchestrator, type Planner } from "./orchestrator.js";
import { formatRunOutput } from "./output.js";
import { parseRequest, SubagentParams } from "./schema.js";
import type { DynamicPlanV1 } from "./types.js";
import { authorizeRequestWorkspaces } from "./workspace.js";

const planner: Planner = {
  async plan(task): Promise<DynamicPlanV1> {
    return {
      version: 1,
      summary: "Single bounded investigation",
      roles: [
        {
          label: "scout",
          roleBrief: "Inspect the objective and report evidence.",
        },
      ],
      nodes: [{ role: 0, task, dependsOn: [] }],
    };
  },
};
const executor = new RpcChildExecutor();

export default function register(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run a named isolated subagent, or omit agent for a bounded read-only workflow.",
    parameters: SubagentParams,
    async execute(_id, params, signal, _update, ctx) {
      try {
        const definitions = await discoverAgents({
          cwd: ctx.cwd,
          scope: "both",
          projectTrusted: ctx.isProjectTrusted(),
        });
        const request = await authorizeRequestWorkspaces(
          parseRequest(params),
          ctx.cwd,
        );
        const runtime = new SubagentOrchestrator(
          new Map(definitions.map((agent) => [agent.name, agent])),
          executor,
          planner,
          ctx.cwd,
        );
        const result = await runtime.run(request, signal);
        return {
          content: [{ type: "text", text: formatRunOutput(result.tasks) }],
          details: {
            runId: result.runId,
            state: result.state,
            tasks: result.tasks.map((task) => ({
              id: task.id,
              state: task.state,
              text: task.text,
              ...(task.error ? { error: task.error } : {}),
            })),
          },
        };
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
  });

  pi.registerCommand("subagents", {
    description: "List bundled subagent definitions.",
    handler: async (_args, ctx) => {
      const definitions = await discoverAgents({
        cwd: ctx.cwd,
        scope: "both",
        projectTrusted: ctx.isProjectTrusted(),
      });
      ctx.ui.notify(
        definitions
          .map((agent) => `${agent.name}: ${agent.description}`)
          .join("\n") || "No agents found",
        "info",
      );
    },
  });
}
