import type {
  ExtensionUIContext,
  RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";

export type ChildUI = Pick<
  ExtensionUIContext,
  "select" | "confirm" | "input" | "notify"
>;

export async function handleChildUI(
  event: Record<string, unknown>,
  ui: ChildUI | undefined,
  signal: AbortSignal,
): Promise<RpcExtensionUIResponse | undefined> {
  if (event.method === "notify") {
    if (typeof event.message === "string") {
      const severity =
        event.notifyType === "error" || event.notifyType === "warning"
          ? event.notifyType
          : "info";
      ui?.notify(`[Subagent] ${event.message}`, severity);
    }
    return undefined;
  }
  if (
    !["select", "confirm", "input", "editor"].includes(String(event.method)) ||
    typeof event.id !== "string"
  ) {
    return undefined;
  }
  const cancelled: RpcExtensionUIResponse = {
    type: "extension_ui_response",
    id: event.id,
    cancelled: true,
  };
  if (!ui || signal.aborted || typeof event.title !== "string")
    return cancelled;
  const title = `[Subagent] ${event.title}`;
  const options = {
    signal,
    ...(typeof event.timeout === "number" && event.timeout > 0
      ? { timeout: event.timeout }
      : {}),
  };
  if (event.method === "confirm" && typeof event.message === "string") {
    const confirmed = await ui.confirm(title, event.message, options);
    return signal.aborted
      ? cancelled
      : { type: "extension_ui_response", id: event.id, confirmed };
  }
  let value: string | undefined;
  if (
    event.method === "select" &&
    Array.isArray(event.options) &&
    event.options.every((item) => typeof item === "string")
  ) {
    value = await ui.select(title, event.options, options);
  } else if (event.method === "input") {
    value = await ui.input(
      title,
      typeof event.placeholder === "string" ? event.placeholder : undefined,
      options,
    );
  }
  return value === undefined || signal.aborted
    ? cancelled
    : { type: "extension_ui_response", id: event.id, value };
}
