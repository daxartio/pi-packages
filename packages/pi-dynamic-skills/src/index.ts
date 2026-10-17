import { readFile } from "node:fs/promises";
import {
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { evaluateRule, parseCompatibility } from "./rules.js";

export async function filterDynamicSkills(
	options: BuildSystemPromptOptions,
): Promise<number> {
	if (!options.skills?.length) return 0;
	const skills = [];
	let errors = 0;
	for (const skill of options.skills) {
		try {
			const { frontmatter } = parseFrontmatter(
				await readFile(skill.filePath, "utf8"),
			);
			const rule = parseCompatibility(frontmatter.compatibility);
			if (rule && !(await evaluateRule(rule, options.cwd))) continue;
		} catch {
			errors++;
		}
		skills.push(skill);
	}
	options.skills = skills;
	return errors;
}

export default function dynamicSkillsExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const errors = await filterDynamicSkills(event.systemPromptOptions);
		if (errors > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`pi-dynamic-skills: could not check ${errors} skill(s); left enabled.`,
				"warning",
			);
		}
	});
}
