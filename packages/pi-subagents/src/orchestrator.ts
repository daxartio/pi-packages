import { randomUUID } from "node:crypto";
import { validateDag } from "./dag.js";
import { TaskScheduler } from "./scheduler.js";
import type {
  AgentDefinition,
  ContextMode,
  DynamicPlanV1,
  ExplicitTaskRequest,
  RunRequest,
  RunResult,
  TaskRequest,
  TaskResult,
} from "./types.js";

export interface ChildExecutor {
  run(input: {
    runId: string;
    taskId: string;
    task: string;
    agent: AgentDefinition;
    cwd: string;
    context: ContextMode;
    signal?: AbortSignal;
  }): Promise<string>;
}

export interface Planner {
  plan(task: string, signal?: AbortSignal): Promise<DynamicPlanV1>;
}

export class SubagentOrchestrator {
  constructor(
    private readonly agents: Map<string, AgentDefinition>,
    private readonly executor: ChildExecutor,
    private readonly planner: Planner,
    private readonly defaultCwd: string,
    private readonly scheduler = new TaskScheduler(),
  ) {}

  async run(request: RunRequest, signal?: AbortSignal): Promise<RunResult> {
    const runId = randomUUID();
    if (request.mode === "dynamic")
      return this.runDynamic(runId, request.task, signal);

    if (request.mode === "single") {
      const result = await this.runExplicit(runId, "0", request.task, signal);
      return this.result(runId, [result]);
    }

    if (request.mode === "parallel") {
      const tasks = await Promise.all(
        request.tasks.map((task, index) =>
          this.runExplicit(runId, `${index}`, task, signal),
        ),
      );
      return this.result(runId, tasks);
    }

    const tasks: TaskResult[] = [];
    for (const [index, task] of request.tasks.entries()) {
      const expanded = {
        ...task,
        task: task.task.replaceAll("{previous}", tasks.at(-1)?.text ?? ""),
      };
      const result = await this.runExplicit(
        runId,
        `${index}`,
        expanded,
        signal,
      );
      tasks.push(result);
      if (result.state !== "completed") break;
    }
    return this.result(runId, tasks);
  }

  private async runDynamic(
    runId: string,
    objective: TaskRequest,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const plan = validateDag(await this.planner.plan(objective.task, signal));
    for (const role of plan.roles) {
      this.agents.set(role.id, {
        name: role.id,
        description: role.label,
        aliases: [],
        tools: ["read", "grep", "find", "ls"],
        systemPrompt: `Do not delegate. Untrusted role brief:\n${role.roleBrief}`,
        fallbackModels: [],
        defaultContext: "fresh",
        inheritProjectContext: false,
        inheritSkills: false,
        source: "dynamic",
        filePath: "<generated>",
      });
    }

    const results = new Map<number, Promise<TaskResult>>();
    for (const index of plan.order) {
      const node = plan.nodes[index]!;
      results.set(
        index,
        Promise.all(
          node.dependsOn.map((dependency) => results.get(dependency)!),
        ).then(async (dependencies) =>
          dependencies.every((value) => value.state === "completed")
            ? this.runOne(
                runId,
                node.id,
                node.roleId,
                node.task,
                objective.cwd,
                objective.context,
                signal,
              )
            : { id: node.id, state: "blocked", text: "Blocked by dependency" },
        ),
      );
    }

    const tasks = await Promise.all(
      plan.nodes.map((_, index) => results.get(index)!),
    );
    return this.result(runId, tasks);
  }

  private runExplicit(
    runId: string,
    taskId: string,
    request: ExplicitTaskRequest,
    signal?: AbortSignal,
  ): Promise<TaskResult> {
    return this.runOne(
      runId,
      taskId,
      request.agent,
      request.task,
      request.cwd,
      request.context,
      signal,
    );
  }

  private async runOne(
    runId: string,
    taskId: string,
    agentName: string,
    task: string,
    cwd: string | undefined,
    requestedContext: ContextMode | undefined,
    signal?: AbortSignal,
  ): Promise<TaskResult> {
    const agent = this.agents.get(agentName);
    if (!agent) {
      return {
        id: taskId,
        state: "failed",
        text: "",
        error: `Unknown agent: ${agentName}`,
      };
    }

    const context = requestedContext ?? agent.defaultContext;
    if (context === "fork") {
      return {
        id: taskId,
        state: "failed",
        text: "",
        error: "fork context is not supported for ephemeral child sessions",
      };
    }

    try {
      const text = await this.scheduler.run(runId, taskId, signal, () =>
        this.executor.run({
          runId,
          taskId,
          task,
          agent,
          cwd: cwd ?? this.defaultCwd,
          context,
          ...(signal ? { signal } : {}),
        }),
      );
      return { id: taskId, state: "completed", text };
    } catch (error) {
      return {
        id: taskId,
        state: signal?.aborted ? "cancelled" : "failed",
        text: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private result(runId: string, tasks: TaskResult[]): RunResult {
    return {
      runId,
      state: tasks.every((task) => task.state === "completed")
        ? "completed"
        : "failed",
      tasks,
    };
  }
}
