/**
 * OpenAI-compatible LLM client.
 * 
 * Works with:
 * - OpenAI API
 * - Azure OpenAI
 * - OpenAI-compatible APIs (Ollama, LM Studio, vLLM, etc.)
 */

import type { LlmClient, LlmInput, LlmOutput, LlmClientConfig, LlmErrorType } from "./types.js";
import { LlmError } from "./types.js";

type OpenAIMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type OpenAIResponse = {
  id: string;
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model: string;
};

type OpenAIError = {
  error: {
    message: string;
    type: string;
    code?: string;
  };
};

export class OpenAIClient implements LlmClient {
  readonly provider = "openai";
  readonly model: string;
  
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxTokens: number;
  private readonly defaultTemperature: number;

  constructor(config: LlmClientConfig) {
    if (!config.apiKey) {
      throw new Error("OpenAI client requires apiKey");
    }
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 60_000;
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    this.defaultTemperature = config.defaultTemperature ?? 0.7;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async generate(input: LlmInput): Promise<LlmOutput> {
    const messages: OpenAIMessage[] = [];
    
    // Add system message
    if (input.system) {
      messages.push({ role: "system", content: input.system });
    }
    
    // Add context as system or user message
    if (input.context) {
      messages.push({ role: "user", content: `Context:\n${input.context}` });
    }
    
    // Add task
    messages.push({ role: "user", content: input.task });

    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    
    // Wire up external abort signal
    if (input.abortSignal) {
      input.abortSignal.addEventListener("abort", () => controller.abort());
    }
    
    // Set timeout
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: input.maxTokens ?? this.defaultMaxTokens,
          temperature: input.temperature ?? this.defaultTemperature
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw await this.handleErrorResponse(response);
      }

      const data = await response.json() as OpenAIResponse;
      const choice = data.choices[0];

      const result: LlmOutput = {
        text: choice?.message.content ?? ""
      };
      
      // Conditionally add optional properties to satisfy exactOptionalPropertyTypes
      const finishReason = this.normalizeFinishReason(choice?.finish_reason);
      if (finishReason !== undefined) {
        result.finishReason = finishReason;
      }
      if (data.model) {
        result.model = data.model;
      }
      if (data.usage) {
        result.usage = {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens
        };
      }

      return result;

    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof LlmError) {
        throw err;
      }

      if (err instanceof Error) {
        if (err.name === "AbortError") {
          throw new LlmError("timeout", `Request timed out after ${timeoutMs}ms`, {
            provider: this.provider,
            retryable: true
          });
        }
        throw new LlmError("unknown", err.message, {
          provider: this.provider,
          cause: err
        });
      }

      throw new LlmError("unknown", "Unknown error during LLM call", {
        provider: this.provider
      });
    }
  }

  private async handleErrorResponse(response: Response): Promise<LlmError> {
    const status = response.status;
    let message = `HTTP ${status}`;
    let errorType: LlmErrorType = "unknown";
    let retryAfterMs: number | undefined;

    try {
      const errorData = await response.json() as OpenAIError;
      message = errorData.error?.message ?? message;
    } catch {
      // Ignore JSON parse errors
    }

    // Check for Retry-After header
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) {
      retryAfterMs = parseInt(retryAfter, 10) * 1000;
      if (isNaN(retryAfterMs)) {
        retryAfterMs = undefined;
      }
    }

    switch (status) {
      case 401:
        errorType = "auth_error";
        break;
      case 403:
        errorType = "auth_error";
        break;
      case 429:
        errorType = "rate_limited";
        retryAfterMs = retryAfterMs ?? 5000;
        break;
      case 400:
        if (message.toLowerCase().includes("context length") || 
            message.toLowerCase().includes("maximum context")) {
          errorType = "context_length";
        } else {
          errorType = "invalid_request";
        }
        break;
      case 500:
      case 502:
      case 503:
      case 504:
        errorType = "provider_error";
        break;
      default:
        errorType = status >= 500 ? "provider_error" : "unknown";
    }

    const errorOptions: {
      provider: string;
      statusCode: number;
      retryAfterMs?: number;
    } = {
      provider: this.provider,
      statusCode: status
    };
    
    if (retryAfterMs !== undefined) {
      errorOptions.retryAfterMs = retryAfterMs;
    }
    
    return new LlmError(errorType, message, errorOptions);
  }

  private normalizeFinishReason(reason?: string): LlmOutput["finishReason"] {
    switch (reason) {
      case "stop":
        return "stop";
      case "length":
        return "length";
      case "content_filter":
        return "content_filter";
      case "tool_calls":
      case "function_call":
        return "tool_calls";
      default:
        return undefined;
    }
  }
}

/**
 * Create an OpenAI client from environment variables.
 */
export function createOpenAIClientFromEnv(): OpenAIClient | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const config: LlmClientConfig = {
    apiKey,
    model: process.env.OPENAI_MODEL ?? "gpt-4o",
    defaultTimeoutMs: parseInt(process.env.OPENAI_TIMEOUT_MS ?? "60000", 10),
    defaultMaxTokens: parseInt(process.env.OPENAI_MAX_TOKENS ?? "4096", 10),
    defaultTemperature: parseFloat(process.env.OPENAI_TEMPERATURE ?? "0.7")
  };
  
  const baseUrl = process.env.OPENAI_BASE_URL;
  if (baseUrl) {
    config.baseUrl = baseUrl;
  }

  return new OpenAIClient(config);
}
