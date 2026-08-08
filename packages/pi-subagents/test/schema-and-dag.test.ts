import assert from "node:assert/strict";
import test from "node:test";
import { validateDag } from "../src/dag.js";
import { parseRequest } from "../src/schema.js";

test("omitted agent creates a dynamic workflow while explicit agent bypasses planning", () => {
  assert.equal(parseRequest({ task: "inspect auth" }).mode, "dynamic");
  assert.equal(
    parseRequest({ task: "inspect auth", agent: "scout" }).mode,
    "single",
  );
});
test("DAG gets stable IDs and rejects cycles", () => {
  const plan = validateDag({
    version: 1,
    summary: "x",
    roles: [{ label: "Scout", roleBrief: "x" }],
    nodes: [
      { role: 0, task: "a", dependsOn: [] },
      { role: 0, task: "b", dependsOn: [0] },
    ],
  });
  assert.deepEqual(
    plan.nodes.map((node) => node.id),
    ["dynamic-node-0", "dynamic-node-1"],
  );
  assert.throws(() =>
    validateDag({
      version: 1,
      summary: "x",
      roles: [{ label: "Scout", roleBrief: "x" }],
      nodes: [
        { role: 0, task: "a", dependsOn: [1] },
        { role: 0, task: "b", dependsOn: [0] },
      ],
    }),
  );
});
