import assert from "node:assert/strict";
import test from "node:test";
import { resolvePiLauncher } from "../src/child-launch.js";

test("child launch reuses the parent runtime and Pi CLI instead of a Windows command shim", () => {
  const parentExecutable = "C:\\Program Files\\nodejs\\node.exe";
  const parentScript =
    "C:\\Users\\user\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js";
  assert.deepEqual(resolvePiLauncher({ parentExecutable, parentScript }), {
    executable: parentExecutable,
    prefixArgs: [parentScript],
  });
});

test("explicit executables and JavaScript CLI overrides take precedence", () => {
  assert.deepEqual(
    resolvePiLauncher({ executable: "/custom/pi", prefixArgs: ["--extra"] }),
    {
      executable: "/custom/pi",
      prefixArgs: ["--extra"],
    },
  );
  assert.deepEqual(
    resolvePiLauncher({
      override: "/custom/cli.js",
      parentExecutable: "/bin/node",
    }),
    {
      executable: "/bin/node",
      prefixArgs: ["/custom/cli.js"],
    },
  );
});

test("a standalone Pi binary is reused without invoking a shell", () => {
  assert.deepEqual(
    resolvePiLauncher({
      parentExecutable: "/opt/pi",
      parentScript: "/unrelated/app.js",
    }),
    {
      executable: "/opt/pi",
      prefixArgs: [],
    },
  );
});
