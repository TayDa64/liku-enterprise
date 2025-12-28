import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "../src/liku/utils/concurrencyLimiter.js";

describe("ConcurrencyLimiter", () => {
  it("runs tasks up to maxConcurrent", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 5 }, () =>
      limiter.run(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
        return "done";
      })
    );

    await Promise.all(tasks);
    expect(maxRunning).toBe(2);
  });

  it("queues tasks when at capacity", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const order: number[] = [];

    const task1 = limiter.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });

    const task2 = limiter.run(async () => {
      order.push(2);
    });

    expect(limiter.running).toBe(1);
    expect(limiter.queued).toBe(1);

    await Promise.all([task1, task2]);
    expect(order).toEqual([1, 2]);
  });

  it("handles errors without breaking queue", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const results: string[] = [];

    const task1 = limiter.run(async () => {
      throw new Error("fail");
    }).catch(() => results.push("error1"));

    const task2 = limiter.run(async () => {
      results.push("ok2");
    });

    await Promise.all([task1, task2]);
    // Both should complete, order may vary but both should be present
    expect(results).toContain("error1");
    expect(results).toContain("ok2");
    expect(results.length).toBe(2);
  });

  it("throws on invalid maxConcurrent", () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow();
    expect(() => new ConcurrencyLimiter(-1)).toThrow();
  });

  it("handles max 5 concurrent operations", async () => {
    const limiter = new ConcurrencyLimiter(5);
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 20 }, () =>
      limiter.run(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
      })
    );

    await Promise.all(tasks);
    expect(maxRunning).toBe(5);
  });
});
