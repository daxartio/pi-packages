import assert from "node:assert/strict";
import test from "node:test";
import type { ChildUI } from "../src/child-ui.js";
import { ChildUIQueue } from "../src/child-ui-queue.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("parent-session queue serializes concurrent child approval dialogs", async () => {
  const queue = new ChildUIQueue();
  const first = deferred<boolean>();
  const started: string[] = [];
  const ui: ChildUI = {
    async confirm(title) {
      started.push(title);
      return started.length === 1 ? first.promise : false;
    },
    async select() {
      throw new Error("unexpected select");
    },
    async input() {
      throw new Error("unexpected input");
    },
    notify() {},
  };
  const signal = new AbortController().signal;
  const a = queue.run(
    { method: "confirm", id: "a", title: "A", message: "Proceed?" },
    ui,
    signal,
  );
  const b = queue.run(
    { method: "confirm", id: "b", title: "B", message: "Proceed?" },
    ui,
    signal,
  );
  assert.deepEqual(started, ["[Subagent] A"]);
  first.resolve(true);
  assert.deepEqual(await a, {
    type: "extension_ui_response",
    id: "a",
    confirmed: true,
  });
  assert.deepEqual(await b, {
    type: "extension_ui_response",
    id: "b",
    confirmed: false,
  });
  assert.deepEqual(started, ["[Subagent] A", "[Subagent] B"]);
});

test("cancelling a queued dialog does not abort or hide the active child's dialog", async () => {
  const queue = new ChildUIQueue();
  const first = deferred<boolean>();
  const activeController = new AbortController();
  const queuedController = new AbortController();
  const started: string[] = [];
  const ui: ChildUI = {
    async confirm(title, _message, options) {
      started.push(title);
      assert.equal(options?.signal, activeController.signal);
      return first.promise;
    },
    async select() {
      throw new Error("unexpected select");
    },
    async input() {
      throw new Error("unexpected input");
    },
    notify() {},
  };
  const a = queue.run(
    { method: "confirm", id: "a", title: "A", message: "Proceed?" },
    ui,
    activeController.signal,
  );
  const b = queue.run(
    { method: "confirm", id: "b", title: "B", message: "Proceed?" },
    ui,
    queuedController.signal,
  );
  queuedController.abort();
  assert.deepEqual(await b, {
    type: "extension_ui_response",
    id: "b",
    cancelled: true,
  });
  assert.equal(activeController.signal.aborted, false);
  assert.deepEqual(started, ["[Subagent] A"]);
  first.resolve(true);
  await a;
});

test("a failed parent dialog does not strand later queued dialogs", async () => {
  const queue = new ChildUIQueue();
  const ui: ChildUI = {
    async confirm(title) {
      if (title.endsWith("A")) throw new Error("dialog failed");
      return false;
    },
    async select() {
      return undefined;
    },
    async input() {
      return undefined;
    },
    notify() {},
  };
  const signal = new AbortController().signal;
  const a = queue.run(
    { method: "confirm", id: "a", title: "A", message: "Proceed?" },
    ui,
    signal,
  );
  const rejected = assert.rejects(a, /dialog failed/u);
  const b = queue.run(
    { method: "confirm", id: "b", title: "B", message: "Proceed?" },
    ui,
    signal,
  );
  await rejected;
  assert.deepEqual(await b, {
    type: "extension_ui_response",
    id: "b",
    confirmed: false,
  });
});
