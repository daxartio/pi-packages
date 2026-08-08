import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { WorktreeService } from "./service.js";

export const Params = Type.Object(
  {
    action: StringEnum([
      "create",
      "list",
      "status",
      "remove",
      "cleanup",
    ] as const),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    id: Type.Optional(Type.String({ minLength: 1 })),
    baseRef: Type.Optional(Type.String()),
    dirtyPolicy: Type.Optional(
      StringEnum(["reject", "ignore", "snapshot"] as const),
    ),
    force: Type.Optional(Type.Boolean()),
    keepBranch: Type.Optional(Type.Boolean()),
    dryRun: Type.Optional(Type.Boolean()),
    olderThanMs: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type Params = Static<typeof Params>;

export default function register(pi: ExtensionAPI): void {
  const service = (cwd: string) => new WorktreeService(cwd);
  pi.registerTool({
    name: "worktree",
    label: "Worktree",
    description: "Create and manage package-owned isolated Git worktrees.",
    parameters: Params,
    async execute(_id, params, signal, _update, ctx) {
      const runtime = service(ctx.cwd);
      let details: unknown;
      if (params.action === "create") {
        if (!params.name) throw new Error("name is required");
        details = await runtime.create(
          {
            name: params.name,
            ...(params.baseRef ? { baseRef: params.baseRef } : {}),
            ...(params.dirtyPolicy ? { dirtyPolicy: params.dirtyPolicy } : {}),
            ...(params.keepBranch !== undefined
              ? { keepBranchOnRemove: params.keepBranch }
              : {}),
          },
          signal,
        );
      } else if (params.action === "list") {
        details = await runtime.list(
          {
            ...(params.cursor ? { cursor: params.cursor } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
          },
          signal,
        );
      } else if (params.action === "status") {
        if (!params.id) throw new Error("id is required");
        details = await runtime.status(params.id, signal);
      } else if (params.action === "remove") {
        if (!params.id) throw new Error("id is required");
        if (
          params.force &&
          (!ctx.hasUI ||
            !(await ctx.ui.confirm("Force remove worktree?", params.id)))
        ) {
          throw new Error("Force removal was not confirmed");
        }
        details = await runtime.remove(
          {
            id: params.id,
            ...(params.force ? { force: true } : {}),
            ...(params.keepBranch !== undefined
              ? { keepBranch: params.keepBranch }
              : {}),
          },
          signal,
        );
      } else {
        if (
          params.dryRun === false &&
          (!ctx.hasUI ||
            !(await ctx.ui.confirm(
              "Clean up managed worktrees?",
              "This can remove clean package-owned worktrees.",
            )))
        ) {
          throw new Error("Cleanup was not confirmed");
        }
        details = await runtime.cleanup(
          {
            ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
            ...(params.olderThanMs !== undefined
              ? { olderThanMs: params.olderThanMs }
              : {}),
          },
          signal,
        );
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(details, null, 2) },
        ],
        details: details as Record<string, unknown>,
      };
    },
  });
  pi.registerCommand("worktree", {
    description:
      "Use the worktree tool for create, list, status, remove, and cleanup.",
    handler: async (_args, ctx) =>
      ctx.ui.notify("Ask Pi to call the worktree tool.", "info"),
  });
}
