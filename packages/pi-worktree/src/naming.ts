import { createHash } from "node:crypto";
export function slugify(value: string, maximum = 32): string {
  const slug = value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, maximum);
  if (!slug) throw new Error("Worktree name must contain letters or numbers");
  return slug;
}
export function deriveIdentity(input: {
  repositoryId: string;
  baseCommit: string;
  name: string;
}): { id: string; branch: string } {
  const slug = slugify(input.name);
  const hash = createHash("sha256")
    .update(
      `${input.repositoryId}\0${input.baseCommit}\0${input.name.normalize("NFKC")}`,
    )
    .digest("hex")
    .slice(0, 12);
  const id = `${slug}-${hash}`;
  return { id, branch: `pi-worktree/${id}` };
}
