import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { resolvePiLauncher } from "./child-launch.js";
import { killChildTree } from "./child-process.js";
import type { ChildUI } from "./child-ui.js";
import { ChildUIQueue } from "./child-ui-queue.js";
import { DEFAULT_LIMITS } from "./config.js";
import type { ChildExecutor } from "./orchestrator.js";
import { boundedText } from "./output.js";
import { resolveChildTools } from "./tool-inheritance.js";

export interface RpcChildExecutorOptions {
  prefixArgs?: string[];
  startupTimeoutMs?: number;
  runTimeoutMs?: number;
  terminationGraceMs?: number;
  maxFrameBytes?: number;
  ui?: ChildUI;
  uiQueue?: ChildUIQueue;
}

interface AssistantMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}

export class RpcChildExecutor implements ChildExecutor {
  private readonly executable: string;
  readonly #prefixArgs: string[];
  readonly #startupTimeoutMs: number;
  readonly #runTimeoutMs: number;
  readonly #terminationGraceMs: number;
  readonly #maxFrameBytes: number;
  readonly #ui: ChildUI | undefined;
  readonly #uiQueue: ChildUIQueue;

  constructor(executable?: string, options: RpcChildExecutorOptions = {}) {
    const launcher = resolvePiLauncher({
      ...(executable !== undefined ? { executable } : {}),
      ...(options.prefixArgs !== undefined
        ? { prefixArgs: options.prefixArgs }
        : {}),
    });
    this.executable = launcher.executable;
    this.#prefixArgs = launcher.prefixArgs;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.#runTimeoutMs = options.runTimeoutMs ?? 300_000;
    this.#terminationGraceMs = options.terminationGraceMs ?? 2_000;
    this.#maxFrameBytes = options.maxFrameBytes ?? 1_000_000;
    this.#ui = options.ui;
    this.#uiQueue = options.uiQueue ?? new ChildUIQueue();
  }

  async run(input: Parameters<ChildExecutor["run"]>[0]): Promise<string> {
    const depth = Number(process.env.PI_SUBAGENTS_DEPTH ?? "0");
    if (
      !Number.isSafeInteger(depth) ||
      depth < 0 ||
      depth >= DEFAULT_LIMITS.maxDepth
    ) {
      throw new Error("Subagent nesting depth limit exceeded");
    }
    const inherited = resolveChildTools(
      input.tools,
      input.activeTools ?? input.tools,
      input.toolSources ?? [],
    );
    const directory = await mkdtemp(join(tmpdir(), "pi-subagents-tools-"));
    const manifestPath = join(directory, "tools.json");
    try {
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          taskId: input.taskId,
          tools: inherited.toolSources,
          activeTools: inherited.activeTools,
        }),
        { encoding: "utf8", mode: 0o600 },
      );
      return await this.runChild(
        input,
        inherited.extensionPaths,
        manifestPath,
        depth + 1,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private runChild(
    input: Parameters<ChildExecutor["run"]>[0],
    extensionPaths: string[],
    manifestPath: string,
    depth: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        ...this.#prefixArgs,
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        ...extensionPaths.flatMap((path) => ["--extension", path]),
        "--extension",
        fileURLToPath(new URL("./child-tool-guard.ts", import.meta.url)),
        "--no-skills",
        "--no-context-files",
        ...(input.tools.length
          ? ["--tools", input.tools.join(",")]
          : ["--no-tools"]),
      ];
      if (input.agent.model) args.push("--model", input.agent.model);
      if (input.agent.thinking) args.push("--thinking", input.agent.thinking);
      if (input.agent.systemPrompt.trim()) {
        args.push("--append-system-prompt", input.agent.systemPrompt);
      }

      const child = spawn(this.executable, args, {
        cwd: input.cwd,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          PI_SUBAGENTS_TOOL_MANIFEST: manifestPath,
          PI_SUBAGENTS_DEPTH: String(depth),
        },
      });
      const uiAbort = new AbortController();
      const decoder = new StringDecoder("utf8");
      const readinessDecoder = new StringDecoder("utf8");
      let buffer = "";
      let readinessBuffer = "";
      let stderr = "";
      let output = "";
      let promptSent = false;
      let promptAccepted = false;
      let finalStopReason: string | undefined;
      let finalErrorMessage: string | undefined;
      let finishing = false;
      let finished = false;
      let outcomeError: Error | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let runTimer: NodeJS.Timeout | undefined;
      let drainTimer: NodeJS.Timeout | undefined;
      let shutdown = Promise.resolve();
      const processGroups = new Set<number>();

      const clearTimers = () => {
        clearTimeout(startupTimer);
        if (runTimer) clearTimeout(runTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (drainTimer) clearTimeout(drainTimer);
      };

      const settle = (error?: Error) => {
        if (finished) return;
        finished = true;
        uiAbort.abort();
        clearTimers();
        input.signal?.removeEventListener("abort", abort);
        void shutdown
          .then(() => killChildTree(child, "SIGKILL", processGroups))
          .then(() => {
            const failure = error ?? outcomeError;
            failure ? reject(failure) : resolve(boundedText(output));
          }, reject);
      };

      const terminate = (error?: Error) => {
        if (finishing || finished) return;
        finishing = true;
        uiAbort.abort();
        outcomeError = error;
        clearTimeout(startupTimer);
        if (runTimer) clearTimeout(runTimer);
        const rememberError = (cause: unknown) => {
          outcomeError ??=
            cause instanceof Error ? cause : new Error(String(cause));
        };
        shutdown = killChildTree(child, "SIGTERM", processGroups).catch(
          rememberError,
        );
        forceKillTimer = setTimeout(() => {
          shutdown = shutdown
            .then(() => killChildTree(child, "SIGKILL", processGroups))
            .catch(rememberError);
          drainTimer = setTimeout(() => {
            for (const stream of child.stdio) stream?.destroy();
            child.unref();
            settle(outcomeError ?? new Error("Child termination timed out"));
          }, 1_000);
          drainTimer.unref();
        }, this.#terminationGraceMs);
        forceKillTimer.unref();
      };

      const writeCommand = (command: unknown) => {
        if (finishing || finished) return;
        if (child.stdin.destroyed || !child.stdin.writable) {
          terminate(new Error("Child RPC stdin is closed"));
          return;
        }
        child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
          if (error)
            terminate(new Error(`Child RPC write failed: ${error.message}`));
        });
      };

      const abort = () => {
        if (!child.stdin.destroyed && child.stdin.writable) {
          writeCommand({ type: "abort" });
        }
        terminate(new Error("Child run aborted"));
      };

      const handleLine = (value: string, readiness = false) => {
        if (!value || finishing || finished) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(value) as Record<string, unknown>;
        } catch {
          terminate(new Error("Invalid child RPC frame"));
          return;
        }

        if (event.type === "extension_ui_request" && !readiness) {
          void this.#uiQueue
            .run(event, this.#ui, uiAbort.signal)
            .then((response) => {
              if (
                response &&
                !finishing &&
                !finished &&
                !child.stdin.destroyed
              ) {
                writeCommand(response);
              }
            })
            .catch((error: unknown) =>
              terminate(
                error instanceof Error ? error : new Error(String(error)),
              ),
            );
          return;
        }

        if (
          readiness &&
          event.type === "subagent_tools_ready" &&
          event.taskId === input.taskId
        ) {
          if (promptSent) return;
          if (event.error) {
            terminate(
              new Error(
                `Child tool inheritance failed: ${String(event.error)}`,
              ),
            );
            return;
          }
          const tools = event.tools;
          if (
            !Array.isArray(tools) ||
            tools.length !== input.tools.length ||
            input.tools.some((tool) => !tools.includes(tool))
          ) {
            terminate(
              new Error("Child tool inheritance did not match requested tools"),
            );
            return;
          }
          promptSent = true;
          writeCommand({
            id: input.taskId,
            type: "prompt",
            message: input.task,
          });
          return;
        }

        if (
          event.type === "response" &&
          event.command === "prompt" &&
          event.id === input.taskId
        ) {
          if (!promptSent) {
            terminate(
              new Error("Child accepted prompt before tool verification"),
            );
            return;
          }
          if (event.success !== true) {
            terminate(
              new Error(
                `Child rejected prompt: ${String(event.error ?? "unknown error")}`,
              ),
            );
            return;
          }
          promptAccepted = true;
          clearTimeout(startupTimer);
          runTimer = setTimeout(
            () =>
              terminate(
                new Error(`Child run timed out after ${this.#runTimeoutMs}ms`),
              ),
            this.#runTimeoutMs,
          );
          runTimer.unref();
          return;
        }

        if (event.type === "message_end") {
          const message = event.message as AssistantMessage | undefined;
          if (message?.role === "assistant") {
            output = (message.content ?? [])
              .filter((block) => block.type === "text")
              .map((block) => block.text ?? "")
              .join("");
            finalStopReason = message.stopReason;
            finalErrorMessage = message.errorMessage;
          }
          return;
        }

        if (event.type === "agent_settled") {
          if (!promptAccepted) {
            terminate(new Error("Child settled before accepting the prompt"));
          } else if (
            finalStopReason === "error" ||
            finalStopReason === "aborted"
          ) {
            terminate(
              new Error(
                finalErrorMessage ??
                  `Child agent stopped with ${finalStopReason}`,
              ),
            );
          } else {
            terminate();
          }
        }
      };

      const startupTimer = setTimeout(
        () =>
          terminate(
            new Error(
              `Child startup/prompt timed out after ${this.#startupTimeoutMs}ms: ${stderr}`,
            ),
          ),
        this.#startupTimeoutMs,
      );
      startupTimer.unref();

      child.stdout.on("data", (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer, "utf8") > this.#maxFrameBytes) {
          terminate(new Error("Child RPC frame exceeded the size limit"));
          return;
        }
        for (;;) {
          const index = buffer.indexOf("\n");
          if (index < 0) break;
          const value = buffer.slice(0, index).replace(/\r$/u, "");
          buffer = buffer.slice(index + 1);
          handleLine(value);
        }
      });
      child.stdio[3]?.on("data", (chunk: Buffer) => {
        readinessBuffer += readinessDecoder.write(chunk);
        if (Buffer.byteLength(readinessBuffer, "utf8") > this.#maxFrameBytes) {
          terminate(
            new Error("Child tool readiness frame exceeded the size limit"),
          );
          return;
        }
        const newline = readinessBuffer.indexOf("\n");
        if (newline >= 0) {
          handleLine(readinessBuffer.slice(0, newline), true);
          readinessBuffer = readinessBuffer.slice(newline + 1);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = boundedText(stderr + chunk.toString("utf8"), {
          maxBytes: 8192,
          tail: true,
        });
      });
      for (const stream of child.stdio) {
        stream?.on("error", (error: Error) =>
          terminate(new Error(`Child RPC stream failed: ${error.message}`)),
        );
      }
      child.on("error", (error) => settle(error));
      child.on("close", (code) => {
        if (finishing) {
          settle(outcomeError);
        } else {
          settle(
            new Error(`Child exited before settlement (${code}): ${stderr}`),
          );
        }
      });

      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
    });
  }
}
