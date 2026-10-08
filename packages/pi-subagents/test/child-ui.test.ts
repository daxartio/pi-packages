import assert from "node:assert/strict";
import test from "node:test";
import { type ChildUI, handleChildUI } from "../src/child-ui.js";

test("headless child dialogs are cancelled instead of approved or left waiting", async () => {
  const signal = new AbortController().signal;
  for (const method of ["confirm", "select", "input", "editor"]) {
    assert.deepEqual(
      await handleChildUI(
        { method, id: method, title: "Approval" },
        undefined,
        signal,
      ),
      {
        type: "extension_ui_response",
        id: method,
        cancelled: true,
      },
    );
  }
});

test("child confirmation, selection and input are forwarded to the parent UI", async () => {
  const calls: string[] = [];
  const notifications: string[] = [];
  const signal = new AbortController().signal;
  const ui: ChildUI = {
    async confirm(title, message, options) {
      calls.push(`${title}: ${message}`);
      assert.equal(options?.signal, signal);
      return false;
    },
    async select(title, choices) {
      calls.push(title);
      return choices[1];
    },
    async input(title, placeholder) {
      calls.push(`${title}: ${placeholder}`);
      return "answer";
    },
    notify(message) {
      notifications.push(message);
    },
  };
  assert.deepEqual(
    await handleChildUI(
      { method: "confirm", id: "c", title: "Execute MCP", message: "Proceed?" },
      ui,
      signal,
    ),
    {
      type: "extension_ui_response",
      id: "c",
      confirmed: false,
    },
  );
  assert.deepEqual(
    await handleChildUI(
      { method: "select", id: "s", title: "Choose", options: ["a", "b"] },
      ui,
      signal,
    ),
    {
      type: "extension_ui_response",
      id: "s",
      value: "b",
    },
  );
  assert.deepEqual(
    await handleChildUI(
      { method: "input", id: "i", title: "Token", placeholder: "Enter" },
      ui,
      signal,
    ),
    {
      type: "extension_ui_response",
      id: "i",
      value: "answer",
    },
  );
  await handleChildUI(
    { method: "notify", message: "MCP connected" },
    ui,
    signal,
  );
  assert.deepEqual(calls, [
    "[Subagent] Execute MCP: Proceed?",
    "[Subagent] Choose",
    "[Subagent] Token: Enter",
  ]);
  assert.deepEqual(notifications, ["[Subagent] MCP connected"]);
});

test("aborted or unsupported dialog requests never open a parent dialog", async () => {
  const controller = new AbortController();
  controller.abort();
  const ui: ChildUI = {
    async confirm() {
      throw new Error("must not prompt");
    },
    async select() {
      throw new Error("must not prompt");
    },
    async input() {
      throw new Error("must not prompt");
    },
    notify() {
      throw new Error("must not notify");
    },
  };
  assert.deepEqual(
    await handleChildUI(
      { method: "confirm", id: "c", title: "Approval", message: "Proceed?" },
      ui,
      controller.signal,
    ),
    {
      type: "extension_ui_response",
      id: "c",
      cancelled: true,
    },
  );
  assert.equal(
    await handleChildUI(
      { method: "set_editor_text", id: "x", text: "overwrite" },
      ui,
      controller.signal,
    ),
    undefined,
  );
});
