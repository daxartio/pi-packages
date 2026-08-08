import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ChildExecutor } from "./orchestrator.js";
import { boundedText } from "./output.js";

export interface RpcChildExecutorOptions {
  prefixArgs?: string[];
  startupTimeoutMs?: number;
  runTimeoutMs?: number;
  terminationGraceMs?: number;
  maxFrameBytes?: number;
}

interface AssistantMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}

export class RpcChildExecutor implements ChildExecutor {
  readonly #prefixArgs: string[];
  readonly #startupTimeoutMs: number;
  readonly #runTimeoutMs: number;
  readonly #terminationGraceMs: number;
  readonly #maxFrameBytes: number;

  constructor(
    private readonly executable = process.env.PI_SUBAGENTS_PI ?? "pi",
    options: RpcChildExecutorOptions = {},
  ) {
    this.#prefixArgs = options.prefixArgs ?? [];
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.#runTimeoutMs = options.runTimeoutMs ?? 300_000;
    this.#terminationGraceMs = options.terminationGraceMs ?? 2_000;
    this.#maxFrameBytes = options.maxFrameBytes ?? 1_000_000;
  }

  run(input: Parameters<ChildExecutor["run"]>[0]): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        ...this.#prefixArgs,
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--tools",
        input.agent.tools.join(","),
      ];
      if (input.agent.model) args.push("--model", input.agent.model);
      if (input.agent.thinking) args.push("--thinking", input.agent.thinking);
      if (input.agent.systemPrompt.trim()) {
        args.push("--append-system-prompt", input.agent.systemPrompt);
      }

      const child = spawn(this.executable, args, {
        cwd: input.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let stderr = "";
      let output = "";
      let promptAccepted = false;
      let finalStopReason: string | undefined;
      let finalErrorMessage: string | undefined;
      let finishing = false;
      let finished = false;
      let outcomeError: Error | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let runTimer: NodeJS.Timeout | undefined;

      const clearTimers = () => {
        clearTimeout(startupTimer);
        if (runTimer) clearTimeout(runTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
      };

      const settle = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimers();
        input.signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve(boundedText(output));
      };

      const terminate = (error?: Error) => {
        if (finishing || finished) return;
        finishing = true;
        outcomeError = error;
        clearTimeout(startupTimer);
        if (runTimer) clearTimeout(runTimer);
        if (child.exitCode !== null) return settle(outcomeError);
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(
          () => child.kill("SIGKILL"),
          this.#terminationGraceMs,
        );
        forceKillTimer.unref();
      };

      const abort = () => {
        if (!child.stdin.destroyed && child.stdin.writable) {
          child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
        }
        terminate(new Error("Child run aborted"));
      };

      const handleLine = (value: string) => {
        if (!value) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(value) as Record<string, unknown>;
        } catch {
          terminate(new Error("Invalid child RPC frame"));
          return;
        }

        if (
          event.type === "response" &&
          event.command === "prompt" &&
          event.id === input.taskId
        ) {
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
              `Child prompt timed out after ${this.#startupTimeoutMs}ms`,
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
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = boundedText(stderr + chunk.toString("utf8"), {
          maxBytes: 8192,
          tail: true,
        });
      });
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

      child.stdin.write(
        `${JSON.stringify({ id: input.taskId, type: "prompt", message: input.task })}\n`,
      );
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
    });
  }
}
