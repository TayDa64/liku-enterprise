/**
 * LLM Client module for BYOK integration.
 * 
 * Exports:
 * - Types and interfaces
 * - OpenAI-compatible client
 * - Factory functions for creating clients from env
 */

// Types
export type {
  LlmErrorType,
  TokenUsage,
  LlmInput,
  LlmOutput,
  LlmClientConfig,
  LlmClient
} from "./types.js";

export { LlmError, StubLlmClient } from "./types.js";

// OpenAI client
export { OpenAIClient, createOpenAIClientFromEnv } from "./openai.js";

// Factory
import { StubLlmClient } from "./types.js";
import { createOpenAIClientFromEnv } from "./openai.js";
import type { LlmClient } from "./types.js";

/**
 * Create an LLM client from environment variables.
 * Returns StubLlmClient if no provider keys are configured.
 */
export function createLlmClientFromEnv(): LlmClient {
  // Try OpenAI first
  const openai = createOpenAIClientFromEnv();
  if (openai) {
    return openai;
  }

  // Add other providers here (Anthropic, Ollama, etc.)
  // const anthropic = createAnthropicClientFromEnv();
  // if (anthropic) return anthropic;

  // Default to stub
  return new StubLlmClient();
}
