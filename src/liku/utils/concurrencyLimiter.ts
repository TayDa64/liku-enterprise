/**
 * Error thrown when queue wait times out.
 */
export class CapacityExceededError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "CapacityExceededError";
    this.retryAfterMs = retryAfterMs;
  }
}

export type ConcurrencyLimiterOptions = {
  maxConcurrent: number;
  /** Timeout for waiting in queue (ms). 0 = no timeout */
  queueTimeoutMs?: number;
};

/**
 * A simple concurrency limiter that queues tasks and runs at most `maxConcurrent` at once.
 * Supports queue timeout to prevent indefinite waits.
 */
export class ConcurrencyLimiter {
  private readonly maxConcurrent: number;
  private readonly queueTimeoutMs: number;
  private currentCount = 0;
  private readonly queue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timeoutId?: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(options: number | ConcurrencyLimiterOptions) {
    if (typeof options === "number") {
      this.maxConcurrent = options;
      this.queueTimeoutMs = 0;
    } else {
      this.maxConcurrent = options.maxConcurrent;
      this.queueTimeoutMs = options.queueTimeoutMs ?? 0;
    }
    if (this.maxConcurrent < 1) {
      throw new Error("maxConcurrent must be at least 1");
    }
  }

  /**
   * The number of tasks currently running.
   */
  get running(): number {
    return this.currentCount;
  }

  /**
   * The number of tasks waiting in the queue.
   */
  get queued(): number {
    return this.queue.length;
  }

  /**
   * Check if currently at capacity.
   */
  get atCapacity(): boolean {
    return this.currentCount >= this.maxConcurrent;
  }

  /**
   * Run a task with concurrency limiting.
   * If we're at capacity, the task waits in a queue.
   * @throws CapacityExceededError if queue wait times out
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    // Wait for a slot if we're at capacity
    if (this.currentCount >= this.maxConcurrent) {
      await this.waitForSlot();
    }

    this.currentCount++;
    try {
      return await task();
    } finally {
      this.currentCount--;
      // Release the next waiting task
      const next = this.queue.shift();
      if (next) {
        if (next.timeoutId) {
          clearTimeout(next.timeoutId);
        }
        next.resolve();
      }
    }
  }

  /**
   * Try to run a task immediately. Returns null if at capacity.
   */
  tryRun<T>(task: () => Promise<T>): Promise<T> | null {
    if (this.currentCount >= this.maxConcurrent) {
      return null;
    }
    return this.run(task);
  }

  /**
   * Wait for a slot to become available.
   */
  private waitForSlot(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const entry: typeof this.queue[number] = { resolve, reject };

      // Set up timeout if configured
      if (this.queueTimeoutMs > 0) {
        entry.timeoutId = setTimeout(() => {
          // Remove from queue
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
          }
          reject(
            new CapacityExceededError(
              `Queue wait exceeded ${this.queueTimeoutMs}ms timeout`,
              this.queueTimeoutMs
            )
          );
        }, this.queueTimeoutMs);
      }

      this.queue.push(entry);
    });
  }

  /**
   * Clear all waiting tasks with a capacity error.
   */
  clearQueue(): number {
    const count = this.queue.length;
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      if (entry.timeoutId) {
        clearTimeout(entry.timeoutId);
      }
      entry.reject(new CapacityExceededError("Queue cleared", 1000));
    }
    return count;
  }
}
