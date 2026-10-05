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
test("tasks take precedence over chain and duplicated single-task fields", () => {
  const selected = {
    agent: "reviewer",
    task: "Review CLI configuration",
    context: "fresh" as const,
    cwd: "/project",
  };
  const tasks = [selected];
  const chain = [{ ...selected, task: "same" }];
  const input = { ...selected, tasks, chain };

  assert.deepEqual(parseRequest(input), { mode: "parallel", tasks });
  assert.deepEqual(input, { ...selected, tasks, chain });
});

test("chain takes precedence over single-task fields when tasks are omitted", () => {
  const chain = [
    { agent: "scout", task: "Inspect configuration" },
    { agent: "reviewer", task: "Review {previous}" },
  ];

  assert.deepEqual(parseRequest({ agent: "default", task: "ignored", chain }), {
    mode: "chain",
    tasks: chain,
  });
});

test("parallel tasks and single-task validation retain their existing behavior", () => {
  const tasks = [{ agent: "scout", task: "Inspect configuration" }];
  assert.deepEqual(parseRequest({ tasks }), { mode: "parallel", tasks });
  assert.throws(() => parseRequest({}), /task is required/u);
  assert.throws(
    () => parseRequest({ agent: " ", task: "inspect" }),
    /agent must be a non-empty string/u,
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
