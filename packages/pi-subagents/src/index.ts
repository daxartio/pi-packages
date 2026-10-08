import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents, formatAvailableAgents } from "./agents.js";
import { RpcChildExecutor } from "./child-executor.js";
import { ChildUIQueue } from "./child-ui-queue.js";
import { type Planner, SubagentOrchestrator } from "./orchestrator.js";
import { formatRunOutput } from "./output.js";
import { parseRequest, SubagentParams } from "./schema.js";
import { captureToolSources } from "./tool-inheritance.js";
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
const BASE_TOOL_DESCRIPTION =
  "Run a named isolated subagent, or omit agent for a bounded dynamic workflow. Prefer a named agent when one matches the task. Use exactly one form: top-level agent/task for a single agent, tasks for parallel agents, or chain for sequential agents. If forms are mixed, tasks takes precedence over chain, and either array overrides the top-level single-task fields; ignored forms are not executed. Providing only task starts dynamic planning. Agents do not pin a model; they inherit the orchestrator-selected model, and each agent description includes a recommended model tier. Child agents inherit the parent's active tools, including extensions and MCP, plus codemode/deferred tools. Set tools per task to narrow access. Tool-name restrictions are not a sandbox: bash and MCP gateways retain their own capabilities.";
const SECTION_KEY = "subagent_available_agents";

async function loadAvailableAgents(cwd: string): Promise<string> {
  try {
    return formatAvailableAgents(
      await discoverAgents({ cwd, scope: "both", projectTrusted: true }),
    );
  } catch {
    return "";
  }
}

export default async function register(pi: ExtensionAPI): Promise<void> {
  const agents = await loadAvailableAgents(process.cwd());
  const uiQueue = new ChildUIQueue();

  pi.on("before_agent_start", async (event) => {
    const current = await loadAvailableAgents(process.cwd());
    if (current) {
      event.systemPromptOptions.sections[SECTION_KEY] =
        `Available subagents for the subagent tool:\n${current}`;
    } else {
      delete event.systemPromptOptions.sections[SECTION_KEY];
    }
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: agents
      ? `${BASE_TOOL_DESCRIPTION}\n\nAvailable agents:\n${agents}`
      : BASE_TOOL_DESCRIPTION,
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
          new RpcChildExecutor(undefined, { ui: ctx.ui, uiQueue }),
          planner,
          ctx.cwd,
          undefined,
          pi.getActiveTools(),
          captureToolSources(pi.getAllTools(), ctx.cwd),
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
