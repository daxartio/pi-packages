import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { runCommand, runScripts } from "../src/runner.ts";

const cwd = process.cwd();
const command = (source: string) => ["node", "-e", source || "void 0"];

test("runs in project cwd with literal arguments and captures stdout only", async () => {
	const result = await runCommand(
		[
			...command(
				'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1) })); console.error("diagnostic")',
			),
			"with spaces",
			"$(false)",
			"",
		],
		cwd,
		5000,
	);
	expect(result.error).toBeUndefined();
	expect(JSON.parse(result.stdout)).toEqual({
		cwd,
		args: ["with spaces", "$(false)", ""],
	});
});

test("all scripts run sequentially even after failures; one summary omits failed output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-startup-run-"));
	try {
		const config = parseConfig({
			scripts: [
				{
					command: command(
						'require("fs").writeFileSync("order", "first"); console.log("inventory")',
					),
					prompt: `Project: \${projectName}`,
				},
				{
					command: command(
						'require("fs").appendFileSync("order", ",second"); console.log("partial failure"); console.error("private diagnostic"); process.exit(7)',
					),
				},
				{ command: [join(directory, "missing-executable")] },
				{
					command: command(
						'require("fs").appendFileSync("order", ",third"); console.log(process.argv[1])',
					).concat(`\${projectPath}`),
				},
			],
		});
		const summary = await runScripts(config, directory);
		expect(await readFile(join(directory, "order"), "utf8")).toBe(
			"first,second,third",
		);
		expect(summary.context).toContain("inventory");
		expect(summary.context).toContain(directory);
		expect(summary.context).toContain(
			`Project: ${directory.split("/").at(-1)}`,
		);
		expect(summary.context).not.toContain("partial failure");
		expect(summary.errors).toEqual([
			"Script #2: exit code 7",
			"Script #3: could not start command (ENOENT)",
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("globally disabled config executes nothing even with explicitly enabled scripts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-startup-disabled-"));
	try {
		const summary = await runScripts(
			parseConfig({
				enabled: false,
				scripts: [
					{
						command: command('require("fs").writeFileSync("executed", "yes")'),
						enabled: true,
					},
				],
			}),
			directory,
		);
		expect(summary).toEqual({ context: "", errors: [] });
		await expect(readFile(join(directory, "executed"))).rejects.toThrow();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("disabled scripts do not run and output/error indices retain original positions", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-startup-disabled-"));
	try {
		const summary = await runScripts(
			parseConfig({
				scripts: [
					{
						enabled: false,
						command: command('require("fs").writeFileSync("executed", "yes")'),
						prompt: "disabled prompt",
						includeEmpty: true,
					},
					{ command: command('console.log("active output")') },
					{ enabled: false, command: [join(directory, "missing-disabled")] },
					{ command: command("process.exit(9)") },
				],
			}),
			directory,
		);
		expect(summary.errors).toEqual(["Script #4: exit code 9"]);
		expect(summary.context).toContain("### Startup script #2");
		expect(summary.context).toContain("active output");
		expect(summary.context).not.toContain("disabled prompt");
		expect(summary.context).not.toContain("Startup script #1");
		await expect(readFile(join(directory, "executed"))).rejects.toThrow();
		expect(
			await runScripts(
				parseConfig({ scripts: [{ enabled: false, command: ["missing"] }] }),
				directory,
			),
		).toEqual({ context: "", errors: [] });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("empty and whitespace output omitted by default, including prompt", async () => {
	const summary = await runScripts(
		parseConfig({
			scripts: [
				{ command: command('console.log("  ")'), prompt: "omit this" },
				{ command: command(""), prompt: "retain this", includeEmpty: true },
			],
		}),
		cwd,
	);
	expect(summary.errors).toEqual([]);
	expect(summary.context).not.toContain("omit this");
	expect(summary.context).toContain("retain this");
	expect(
		(
			await runScripts(
				parseConfig({ scripts: [{ command: command("") }] }),
				cwd,
			)
		).context,
	).toBe("");
});

test("timeout terminates command and remaining scripts still run", async () => {
	const summary = await runScripts(
		parseConfig({
			timeoutMs: 100,
			scripts: [
				{ command: command("setInterval(() => {}, 1000)") },
				{ command: command('console.log("after timeout")'), timeoutMs: 5000 },
			],
		}),
		cwd,
	);
	expect(summary.errors).toEqual(["Script #1: timed out after 100 ms"]);
	expect(summary.context).toContain("after timeout");
});

test("timeout also closes pipes held by descendants", async () => {
	const source =
		'require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", process.stdout, process.stderr] });';
	const result = await runCommand(command(source), cwd, 200);
	expect(result.error).toBe("timed out after 200 ms");
});

test("output limit applies to both stdout and stderr", async () => {
	for (const stream of ["stdout", "stderr"]) {
		const result = await runCommand(
			command(`process.${stream}.write("a".repeat(2 * 1024 * 1024))`),
			cwd,
			5000,
		);
		expect(result.error).toBe("output exceeded 1 MiB (stdout + stderr)");
	}
});
