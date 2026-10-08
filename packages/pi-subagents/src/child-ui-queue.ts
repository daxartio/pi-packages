import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { type ChildUI, handleChildUI } from "./child-ui.js";

interface QueuedDialog {
  execute(): Promise<RpcExtensionUIResponse | undefined>;
  resolve(value: RpcExtensionUIResponse | undefined): void;
  reject(error: unknown): void;
  detach(): void;
}

export class ChildUIQueue {
  readonly #queue: QueuedDialog[] = [];
  #active = false;

  run(
    event: Record<string, unknown>,
    ui: ChildUI | undefined,
    signal: AbortSignal,
  ): Promise<RpcExtensionUIResponse | undefined> {
    if (signal.aborted || !ui || event.method === "notify")
      return handleChildUI(event, ui, signal);
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const index = this.#queue.indexOf(dialog);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        dialog.detach();
        void handleChildUI(event, undefined, signal).then(resolve, reject);
      };
      const dialog: QueuedDialog = {
        execute: () => handleChildUI(event, ui, signal),
        resolve,
        reject,
        detach: () => signal.removeEventListener("abort", cancel),
      };
      this.#queue.push(dialog);
      signal.addEventListener("abort", cancel, { once: true });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.#active) return;
    this.#active = true;
    try {
      for (;;) {
        const dialog = this.#queue.shift();
        if (!dialog) break;
        dialog.detach();
        try {
          dialog.resolve(await dialog.execute());
        } catch (error) {
          dialog.reject(error);
        }
      }
    } finally {
      this.#active = false;
    }
  }
}
