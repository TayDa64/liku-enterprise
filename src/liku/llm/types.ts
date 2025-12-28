/**
 * LLM Client Types and Interfaces for BYOK Integration.
 * 
 * Provides a unified interface for invoking LLMs from various providers.
 * All errors are normalized to a common taxonomy for consistent handling.
 */

/**
 * Error types from LLM providers, normalized for orchestrator handling.
 */
export type LlmErrorType =
  | "rate_limited"      // Provider rate limit hit
  | "timeout"           // Request timed out
  | "auth_error"        // Invalid API key or auth failure
  | "invalid_request"   // Malformed request (terminal error)
  | "provider_error"    // Provider-side issue (5xx)
  | "model_error"       // Model refused or failed to generate
  | "context_length"    // Input too long for model
  | "content_filter"    // Content filtered by safety system
  | "unknown";          // Unclassified error

/**
 * Normalized LLM error.
 */
export class LlmError extends Error {
  readonly type: LlmErrorType;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly provider?: string;
  readonly statusCode?: number;

  constructor(
    type: LlmErrorType,
    message: string,
    options?: {
      retryable?: boolean;
      retryAfterMs?: number;
      provider?: string;
      statusCode?: number;
      cause?: Error;
    }
  ) {
    super(message, { cause: options?.cause });
    this.name = "LlmError";
    this.type = type;
    this.retryable = options?.retryable ?? this.isDefaultRetryable(type);
    // Use conditional assignment to satisfy exactOptionalPropertyTypes
    if (options?.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options?.provider !== undefined) {
      this.provider = options.provider;
    }
    if (options?.statusCode !== undefined) {
      this.statusCode = options.statusCode;
    }
  }

  private isDefaultRetryable(type: LlmErrorType): boolean {
    switch (type) {
      case "rate_limited":
      case "timeout":
      case "provider_error":
        return true;
      default:
        return false;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      type: this.type,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterMs && { retryAfterMs: this.retryAfterMs }),
      ...(this.provider && { provider: this.provider }),
      ...(this.statusCode && { statusCode: this.statusCode })
    };
  }
}

/**
 * Token usage from a completion.
 */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
};

/**
 * Input to an LLM generation request.
 */
export type LlmInput = {
  /** System prompt (agent context) */
  system: string;
  /** Context documents or prior conversation */
  context?: string;
  /** User task/query */
  task: string;
  /** Maximum tokens to generate */
  maxTokens: number;
  /** Temperature (0-2, lower = more deterministic) */
  temperature?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Request timeout in ms */
  timeoutMs?: number;
};

/**
 * Output from an LLM generation.
 */
export type LlmOutput = {
  /** Generated text */
  text: string;
  /** Token usage statistics */
  usage?: TokenUsage;
  /** Model identifier used */
  model?: string;
  /** Finish reason */
  finishReason?: "stop" | "length" | "content_filter" | "tool_calls" | "error";
};

/**
 * LLM client configuration.
 */
export type LlmClientConfig = {
  /** API key (required for cloud providers) */
  apiKey?: string;
  /** Base URL for API (for self-hosted or proxy) */
  baseUrl?: string;
  /** Model identifier */
  model: string;
  /** Default timeout in ms */
  defaultTimeoutMs?: number;
  /** Default max tokens */
  defaultMaxTokens?: number;
  /** Default temperature */
  defaultTemperature?: number;
};

/**
 * LLM client interface for BYOK integration.
 */
export interface LlmClient {
  /**
   * Generate a completion.
   */
  generate(input: LlmInput): Promise<LlmOutput>;
  
  /**
   * Check if the client is properly configured.
   */
  isConfigured(): boolean;
  
  /**
   * Get the provider name.
   */
  readonly provider: string;
  
  /**
   * Get the model being used.
   */
  readonly model: string;
}

/**
 * Stub LLM client that returns bundle-only (no actual LLM call).
 * Used when BYOK keys are not configured.
 */
export class StubLlmClient implements LlmClient {
  readonly provider = "stub";
  readonly model = "none";

  generate(_input: LlmInput): Promise<LlmOutput> {
    return Promise.resolve({
      text: "[LLM execution disabled - bundle-only mode. Configure BYOK keys to enable execution.]",
      finishReason: "stop"
    });
  }

  isConfigured(): boolean {
    return false;
  }
}
