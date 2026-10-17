import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PREFIX = "pi-dynamic-skills:";
const PATH_OPERATORS = ["exists", "file", "directory", "ancestor"] as const;
type PathOperator = (typeof PATH_OPERATORS)[number];

export type Rule =
	| { operator: PathOperator; path: string }
	| { operator: "platform"; platform: string }
	| { operator: "all" | "any"; rules: Rule[] }
	| { operator: "not"; rule: Rule };

function parseRule(value: unknown, depth = 0): Rule | undefined {
	if (
		depth > 16 ||
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value)
	)
		return undefined;
	const entries = Object.entries(value);
	if (entries.length !== 1) return undefined;
	const [operator, operand] = entries[0];
	const pathOperator = PATH_OPERATORS.find(
		(candidate) => candidate === operator,
	);
	if (pathOperator) {
		if (
			typeof operand !== "string" ||
			!operand.trim() ||
			operand.includes("\0")
		)
			return undefined;
		return { operator: pathOperator, path: operand };
	}
	if (
		operator === "platform" &&
		typeof operand === "string" &&
		[
			"aix",
			"android",
			"darwin",
			"freebsd",
			"haiku",
			"linux",
			"openbsd",
			"sunos",
			"win32",
			"cygwin",
			"netbsd",
		].includes(operand)
	) {
		return { operator, platform: operand };
	}
	if (operator === "not") {
		const rule = parseRule(operand, depth + 1);
		return rule ? { operator, rule } : undefined;
	}
	if (
		(operator === "all" || operator === "any") &&
		Array.isArray(operand) &&
		operand.length > 0
	) {
		const rules: Rule[] = [];
		for (const child of operand) {
			const rule = parseRule(child, depth + 1);
			if (!rule) return undefined;
			rules.push(rule);
		}
		return { operator, rules };
	}
	return undefined;
}

export function parseCompatibility(value: unknown): Rule | undefined {
	if (
		typeof value !== "string" ||
		value.length > 500 ||
		!value.trim().startsWith(PREFIX)
	)
		return undefined;
	try {
		return parseRule(JSON.parse(value.trim().slice(PREFIX.length)));
	} catch {
		return undefined;
	}
}

async function matchesPath(
	path: string,
	operator: PathOperator,
): Promise<boolean> {
	try {
		const metadata = await stat(path);
		return operator === "file"
			? metadata.isFile()
			: operator === "directory"
				? metadata.isDirectory()
				: true;
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		)
			return false;
		throw error;
	}
}

export async function evaluateRule(
	rule: Rule,
	cwd: string,
	platform: string = process.platform,
): Promise<boolean> {
	switch (rule.operator) {
		case "all":
			for (const child of rule.rules)
				if (!(await evaluateRule(child, cwd, platform))) return false;
			return true;
		case "any":
			for (const child of rule.rules)
				if (await evaluateRule(child, cwd, platform)) return true;
			return false;
		case "not":
			return !(await evaluateRule(rule.rule, cwd, platform));
		case "platform":
			return platform === rule.platform;
		case "ancestor": {
			let directory = resolve(cwd);
			while (true) {
				if (await matchesPath(resolve(directory, rule.path), "exists"))
					return true;
				const parent = dirname(directory);
				if (parent === directory) return false;
				directory = parent;
			}
		}
		default:
			return matchesPath(resolve(cwd, rule.path), rule.operator);
	}
}
