import { createHash } from "node:crypto";
import type { DynamicPlanV1, ValidatedPlan } from "./types.js";
export class DynamicPlanError extends Error {}
const MAX_NODES = 8,
  MAX_EDGES = 16,
  MAX_DEPTH = 4;
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const label = (value: string) => value.trim().toLocaleLowerCase();
export function validateDag(plan: DynamicPlanV1): ValidatedPlan {
  if (
    plan.version !== 1 ||
    !Array.isArray(plan.roles) ||
    !Array.isArray(plan.nodes)
  )
    throw new DynamicPlanError("invalid plan version or shape");
  if (
    plan.nodes.length < 1 ||
    plan.nodes.length > MAX_NODES ||
    plan.roles.length < 1 ||
    plan.roles.length > MAX_NODES
  )
    throw new DynamicPlanError("plan node or role limit exceeded");
  if (bytes(plan.summary) > 4096)
    throw new DynamicPlanError("summary too large");
  const labels = new Set<string>();
  for (const role of plan.roles) {
    if (
      !role.label.trim() ||
      bytes(role.roleBrief) > 4096 ||
      labels.has(label(role.label))
    )
      throw new DynamicPlanError("invalid or duplicate role");
    labels.add(label(role.label));
  }
  let edges = 0;
  const used = new Set<number>();
  const indegree = plan.nodes.map(() => 0);
  const outgoing = plan.nodes.map(() => [] as number[]);
  for (const [index, node] of plan.nodes.entries()) {
    if (
      !Number.isInteger(node.role) ||
      node.role < 0 ||
      node.role >= plan.roles.length ||
      !node.task.trim() ||
      bytes(node.task) > 16384
    )
      throw new DynamicPlanError("invalid node");
    used.add(node.role);
    const deps = new Set(node.dependsOn);
    if (deps.size !== node.dependsOn.length || deps.has(index))
      throw new DynamicPlanError("duplicate or self dependency");
    for (const dependency of deps) {
      if (
        !Number.isInteger(dependency) ||
        dependency < 0 ||
        dependency >= plan.nodes.length
      )
        throw new DynamicPlanError("invalid dependency");
      indegree[index] = (indegree[index] ?? 0) + 1;
      outgoing[dependency]!.push(index);
      edges++;
    }
  }
  if (edges > MAX_EDGES || used.size !== plan.roles.length)
    throw new DynamicPlanError("edge limit or unused role");
  const ready = indegree.flatMap((v, i) => (v === 0 ? [i] : []));
  const order: number[] = [];
  const depth = plan.nodes.map(() => 1);
  while (ready.length) {
    ready.sort((a, b) => a - b);
    const current = ready.shift()!;
    order.push(current);
    for (const child of outgoing[current]!) {
      depth[child] = Math.max(depth[child]!, depth[current]! + 1);
      const remaining = (indegree[child] ?? 0) - 1;
      indegree[child] = remaining;
      if (remaining === 0) ready.push(child);
    }
  }
  if (order.length !== plan.nodes.length)
    throw new DynamicPlanError("plan contains a cycle");
  if (Math.max(...depth) > MAX_DEPTH)
    throw new DynamicPlanError("plan depth limit exceeded");
  return {
    version: 1,
    summary: plan.summary,
    roles: plan.roles.map((role, i) => ({
      ...role,
      id: `dynamic-role-${i}` as const,
    })),
    nodes: plan.nodes.map((node, i) => ({
      id: `dynamic-node-${i}` as const,
      roleId: `dynamic-role-${node.role}` as const,
      task: node.task,
      dependsOn: [...node.dependsOn],
    })),
    order,
  };
}
export function planDigest(plan: DynamicPlanV1): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}
