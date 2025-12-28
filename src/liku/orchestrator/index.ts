/**
 * Liku Orchestrator module - Multi-agent pipeline execution.
 * 
 * Exports:
 * - Orchestrator: Main orchestration engine
 * - TaskRegistry: A2A-compliant task state management
 * - Types: All orchestration types
 */

// Core orchestration
export { Orchestrator, StubLlmClient } from "./orchestrator.js";
export type { LlmClient, LlmResponse } from "./orchestrator.js";

// Task registry for A2A
export { TaskRegistry, taskRegistry } from "./taskRegistry.js";

// Types
export type {
  PlanStep,
  PlannerOutput,
  StepResult,
  EscalationInfo,
  OrchestrationResult,
  OrchestrationConfig,
  OrchestrationInput,
  TaskState
} from "./types.js";

export { DEFAULT_ORCHESTRATION_CONFIG } from "./types.js";
