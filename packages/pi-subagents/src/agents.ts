import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isToolName } from "./tools.js";
import type { AgentDefinition } from "./types.js";

const roots = (cwd: string) => [
  {
    source: "builtin" as const,
    root: join(dirname(new URL(import.meta.url).pathname), "..", "agents"),
  },
  {
    source: "user" as const,
    root: join(process.env.HOME ?? "", ".pi", "agent", "agents"),
  },
  { source: "project" as const, root: join(cwd, ".pi", "agents") },
];
function frontmatter(text: string): [Record<string, unknown>, string] {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(text);
  if (!match) throw new Error("agent frontmatter is required");
  const fields: Record<string, unknown> = {};
  for (const line of match[1]!.split("\n")) {
    const item = /^([\w-]+):\s*(.*)$/u.exec(line);
    if (!item) throw new Error("invalid agent frontmatter");
    fields[item[1]!] = item[2]!;
  }
  return [fields, match[2]!];
}
async function files(root: string): Promise<string[]> {
  try {
    const result: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) result.push(...(await files(path)));
      else if (entry.isFile() && entry.name.endsWith(".md")) result.push(path);
    }
    return result;
  } catch {
    return [];
  }
}
export async function discoverAgents(input: {
  cwd: string;
  scope: "user" | "project" | "both";
  projectTrusted: boolean;
}): Promise<AgentDefinition[]> {
  const definitions = new Map<string, AgentDefinition>();
  for (const candidate of roots(input.cwd)) {
    if (
      candidate.source === "project" &&
      (!input.projectTrusted || input.scope === "user")
    )
      continue;
    if (candidate.source === "user" && input.scope === "project") continue;
    let canonical: string;
    try {
      canonical = await realpath(candidate.root);
    } catch {
      continue;
    }
    for (const file of await files(canonical)) {
      const actual = await realpath(file);
      if (relative(canonical, actual).startsWith(".."))
        throw new Error(`Agent escapes trusted root: ${file}`);
      const [meta, systemPrompt] = frontmatter(await readFile(actual, "utf8"));
      const name = String(meta.name ?? "").trim();
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name))
        throw new Error(`Invalid agent name: ${name}`);
      const selectedTools =
        meta.tools === undefined
          ? undefined
          : String(meta.tools)
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean);
      if (selectedTools && !selectedTools.every(isToolName))
        throw new Error(`Invalid agent tool: ${name}`);
      definitions.set(name, {
        name,
        description: String(meta.description ?? ""),
        ...(selectedTools ? { tools: selectedTools } : {}),
        systemPrompt,
        aliases: String(meta.aliases ?? "")
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
        fallbackModels: [],
        defaultContext: "fresh",
        inheritProjectContext: false,
        inheritSkills: false,
        source: candidate.source,
        filePath: actual,
      });
    }
  }
  return [...definitions.values()];
}
export function formatAvailableAgents(definitions: AgentDefinition[]): string {
  return [...definitions]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (agent) =>
        `- ${agent.name}${agent.aliases.length ? ` (aliases: ${agent.aliases.join(", ")})` : ""} — ${agent.description}`,
    )
    .join("\n");
}

export function resolveAgent(
  definitions: AgentDefinition[],
  name: string,
): AgentDefinition {
  const found = definitions.filter(
    (agent) => agent.name === name || agent.aliases.includes(name),
  );
  if (found.length !== 1)
    throw new Error(
      found.length ? `Ambiguous agent: ${name}` : `Unknown agent: ${name}`,
    );
  return found[0]!;
}
