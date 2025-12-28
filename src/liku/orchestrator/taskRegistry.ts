/**
 * Task Registry for A2A protocol compliance.
 * Maintains state of orchestration tasks for tasks/get, tasks/cancel, etc.
 */

import crypto from "node:crypto";
import type { TaskState, OrchestrationInput, OrchestrationResult } from "./types.js";

function isoNow(): string {
  return new Date().toISOString();
}

function generateTaskId(): string {
  return crypto.randomUUID();
}

/**
 * Result of setResult operation.
 */
export type SetResultOutcome = 
  | { success: true; wasIdempotent: false }
  | { success: true; wasIdempotent: true }
  | { success: false; reason: "not_found" | "already_terminal" };

/**
 * In-memory task registry.
 * For production, this could be backed by SQLite or Redis.
 */
export class TaskRegistry {
  private readonly tasks = new Map<string, TaskState>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly maxTasks: number;

  constructor(maxTasks = 1000) {
    this.maxTasks = maxTasks;
  }

  /**
   * Create a new task and return its ID.
   * Optionally returns an AbortController for cancellation.
   */
  create(input: OrchestrationInput): { id: string; abortController: AbortController } {
    // Evict oldest tasks if at capacity
    if (this.tasks.size >= this.maxTasks) {
      const oldest = this.getOldestTask();
      if (oldest) {
        this.tasks.delete(oldest.id);
        this.abortControllers.delete(oldest.id);
      }
    }

    const id = generateTaskId();
    const now = isoNow();
    const task: TaskState = {
      id,
      createdAt: now,
      updatedAt: now,
      status: "pending",
      input
    };
    const abortController = new AbortController();
    
    this.tasks.set(id, task);
    this.abortControllers.set(id, abortController);
    
    return { id, abortController };
  }

  /**
   * Get a task by ID.
   */
  get(id: string): TaskState | undefined {
    return this.tasks.get(id);
  }

  /**
   * Get the abort signal for a task.
   */
  getAbortSignal(id: string): AbortSignal | undefined {
    return this.abortControllers.get(id)?.signal;
  }

  /**
   * Update task status.
   */
  updateStatus(id: string, status: TaskState["status"], currentStep?: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.status = status;
    task.updatedAt = isoNow();
    if (currentStep !== undefined) task.currentStep = currentStep;
    return true;
  }

  /**
   * Set task result and mark complete.
   * This operation is IDEMPOTENT - calling it multiple times with the same
   * result has no additional effect once the task reaches a terminal state.
   * 
   * Returns outcome indicating whether the operation succeeded and was idempotent.
   */
  setResult(id: string, result: OrchestrationResult): SetResultOutcome {
    const task = this.tasks.get(id);
    if (!task) {
      return { success: false, reason: "not_found" };
    }
    
    // Terminal states: completed, failed, cancelled
    const isTerminal = task.status === "completed" || 
                       task.status === "failed" || 
                       task.status === "cancelled";
    
    if (isTerminal) {
      // Idempotent: if result is already set, this is a no-op
      if (task.result !== undefined) {
        return { success: true, wasIdempotent: true };
      }
      // Already terminal but no result - shouldn't happen, but handle gracefully
      return { success: false, reason: "already_terminal" };
    }
    
    task.result = result;
    task.status = result.kind === "error" ? "failed" : "completed";
    task.updatedAt = isoNow();
    return { success: true, wasIdempotent: false };
  }

  /**
   * Set task result - simplified boolean API for backward compatibility.
   */
  setResultSimple(id: string, result: OrchestrationResult): boolean {
    const outcome = this.setResult(id, result);
    return outcome.success;
  }

  /**
   * Cancel a task if it's pending or running.
   * This also triggers the abort signal for the task.
   */
  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === "pending" || task.status === "running") {
      task.status = "cancelled";
      task.updatedAt = isoNow();
      
      // Trigger abort signal
      const controller = this.abortControllers.get(id);
      if (controller && !controller.signal.aborted) {
        controller.abort();
      }
      return true;
    }
    return false;
  }

  /**
   * List all tasks, optionally filtered by status.
   */
  list(status?: TaskState["status"]): TaskState[] {
    const all = Array.from(this.tasks.values());
    if (status) return all.filter((t) => t.status === status);
    return all;
  }

  /**
   * Delete a task.
   */
  delete(id: string): boolean {
    this.abortControllers.delete(id);
    return this.tasks.delete(id);
  }

  /**
   * Get the oldest task (by creation time).
   */
  private getOldestTask(): TaskState | undefined {
    let oldest: TaskState | undefined;
    for (const task of this.tasks.values()) {
      if (!oldest || task.createdAt < oldest.createdAt) {
        oldest = task;
      }
    }
    return oldest;
  }

  /**
   * Get registry stats.
   */
  stats(): { total: number; byStatus: Record<TaskState["status"], number> } {
    const byStatus: Record<TaskState["status"], number> = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    };
    for (const task of this.tasks.values()) {
      byStatus[task.status]++;
    }
    return { total: this.tasks.size, byStatus };
  }
}

// Singleton instance for the application
export const taskRegistry = new TaskRegistry();
