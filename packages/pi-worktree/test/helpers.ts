import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    );
  });

export async function createRepository(): Promise<{
  parent: string;
  root: string;
}> {
  const parent = await mkdtemp(join(tmpdir(), "pi-worktree-test-"));
  const root = join(parent, "repository");
  await mkdir(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "x\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return { parent, root };
}
