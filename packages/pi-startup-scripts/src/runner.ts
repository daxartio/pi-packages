import { spawn } from "node:child_process";
import {
	expandTemplate,
	type ScriptConfig,
	type StartupConfig,
} from "./config.ts";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface RunSummary {
	context: string;
	errors: string[];
}

export interface CommandResult {
	stdout: string;
	error?: string;
}

export function runCommand(
	command: string[],
	cwd: string,
	timeoutMs: number,
): Promise<CommandResult> {
	return new Promise((resolve) => {
		const [executable, ...args] = command;
		if (!executable) {
			resolve({ stdout: "", error: "missing executable" });
			return;
		}
		const child = spawn(executable, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
			detached: process.platform !== "win32",
		});
		const chunks: Buffer[] = [];
		let outputBytes = 0;
		let failure: string | undefined;
		const kill = () => {
			if (!child.pid) return;
			try {
				if (process.platform === "win32") child.kill("SIGKILL");
				else process.kill(-child.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
					child.kill("SIGKILL");
				}
			}
		};
		const timer = setTimeout(() => {
			failure = `timed out after ${timeoutMs} ms`;
			kill();
		}, timeoutMs);
		const collect = (chunk: Buffer, stdout: boolean) => {
			outputBytes += chunk.length;
			if (outputBytes > MAX_OUTPUT_BYTES) {
				failure ??= "output exceeded 1 MiB (stdout + stderr)";
				kill();
				return;
			}
			if (stdout) chunks.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
		child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
		child.on("error", (error: NodeJS.ErrnoException) => {
			failure ??= `could not start command (${error.code ?? "unknown error"})`;
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (code !== 0) {
				failure ??= signal ? `terminated by ${signal}` : `exit code ${code}`;
			}
			resolve({
				stdout: Buffer.concat(chunks).toString("utf8"),
				error: failure,
			});
		});
	});
}

function renderOutput(
	script: ScriptConfig,
	scriptIndex: number,
	stdout: string,
	cwd: string,
): string {
	if (!script.includeEmpty && stdout.trim().length === 0) return "";
	const prompt = expandTemplate(script.prompt, cwd);
	return [`### Startup script #${scriptIndex + 1}`, prompt, stdout]
		.filter(Boolean)
		.join("\n\n");
}

export async function runScripts(
	config: StartupConfig,
	cwd: string,
): Promise<RunSummary> {
	if (!config.enabled) return { context: "", errors: [] };
	const sections: string[] = [];
	const errors: string[] = [];
	for (const [scriptIndex, script] of config.scripts.entries()) {
		if (!script.enabled) continue;
		try {
			const result = await runCommand(
				script.command.map((argument) => expandTemplate(argument, cwd)),
				cwd,
				script.timeoutMs,
			);
			if (result.error) {
				errors.push(`Script #${scriptIndex + 1}: ${result.error}`);
				continue;
			}
			const section = renderOutput(script, scriptIndex, result.stdout, cwd);
			if (section) sections.push(section);
		} catch {
			errors.push(`Script #${scriptIndex + 1}: could not execute command`);
		}
	}
	return {
		context: sections.length
			? `## Startup script context\n\n${sections.join("\n\n")}`
			: "",
		errors,
	};
}
