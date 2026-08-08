export class TaskScheduler {
  readonly #limit: number;
  #active = 0;
  #queue: Array<() => void> = [];
  #cancelled = new Set<string>();
  constructor(limit = 4) {
    this.#limit = limit;
  }
  async run<T>(
    runId: string,
    _taskId: string,
    signal: AbortSignal | undefined,
    job: () => Promise<T>,
  ): Promise<T> {
    if (this.#cancelled.has(runId)) throw new Error("run cancelled");
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        if (signal?.aborted) return reject(signal.reason);
        this.#active++;
        resolve();
      };
      this.#active < this.#limit ? start() : this.#queue.push(start);
    });
    try {
      if (this.#cancelled.has(runId) || signal?.aborted)
        throw signal?.reason ?? new Error("run cancelled");
      return await job();
    } finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }
  async cancelRun(runId: string): Promise<void> {
    this.#cancelled.add(runId);
  }
  async shutdown(): Promise<void> {
    this.#queue.splice(0).forEach((start) => start());
  }
}
