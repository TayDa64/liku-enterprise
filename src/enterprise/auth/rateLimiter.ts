import type { Context, Next, MiddlewareHandler } from "hono";
import type { Tenant } from "./types.js";
import { AuthError } from "./types.js";

/**
 * Per-Tenant Rate Limiting
 * 
 * Implements sliding window rate limiting per tenant.
 */

export type RateLimitConfig = {
  /** Default requests per minute if tenant has no config */
  defaultRpm?: number;
  /** Default max concurrent tasks */
  defaultMaxConcurrent?: number;
  /** Window size in milliseconds */
  windowMs?: number;
};

type TenantRateLimitState = {
  /** Request timestamps in current window */
  requests: number[];
  /** Currently running tasks */
  runningTasks: number;
};

/**
 * Per-tenant rate limiter
 */
export class TenantRateLimiter {
  private state: Map<string, TenantRateLimitState> = new Map();
  private config: Required<RateLimitConfig>;

  constructor(config?: RateLimitConfig) {
    this.config = {
      defaultRpm: config?.defaultRpm ?? 100,
      defaultMaxConcurrent: config?.defaultMaxConcurrent ?? 10,
      windowMs: config?.windowMs ?? 60_000 // 1 minute
    };
  }

  /**
   * Check if request is allowed under rate limits
   */
  checkLimit(tenant: Tenant): RateLimitResult {
    const state = this.getOrCreateState(tenant.id);
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    // Clean old requests
    state.requests = state.requests.filter(t => t > windowStart);

    // Get tenant limits
    const rpm = tenant.rateLimits?.requestsPerMinute ?? this.config.defaultRpm;
    const maxConcurrent = tenant.rateLimits?.maxConcurrentTasks ?? this.config.defaultMaxConcurrent;

    // Check request rate
    if (state.requests.length >= rpm) {
      const oldestRequest = state.requests[0];
      const retryAfterMs = oldestRequest + this.config.windowMs - now;
      
      return {
        allowed: false,
        reason: "rate_limit",
        remaining: 0,
        limit: rpm,
        resetAt: oldestRequest + this.config.windowMs,
        retryAfterMs: Math.max(0, retryAfterMs)
      };
    }

    // Check concurrent tasks (for task creation endpoints)
    if (state.runningTasks >= maxConcurrent) {
      return {
        allowed: false,
        reason: "concurrent_limit",
        remaining: 0,
        limit: maxConcurrent,
        currentConcurrent: state.runningTasks
      };
    }

    // Record this request
    state.requests.push(now);

    return {
      allowed: true,
      remaining: rpm - state.requests.length,
      limit: rpm
    };
  }

  /**
   * Increment concurrent task count
   */
  incrementConcurrent(tenantId: string): void {
    const state = this.getOrCreateState(tenantId);
    state.runningTasks++;
  }

  /**
   * Decrement concurrent task count
   */
  decrementConcurrent(tenantId: string): void {
    const state = this.getOrCreateState(tenantId);
    state.runningTasks = Math.max(0, state.runningTasks - 1);
  }

  /**
   * Get current state for a tenant
   */
  getState(tenantId: string): TenantRateLimitState | undefined {
    return this.state.get(tenantId);
  }

  /**
   * Reset state for a tenant
   */
  reset(tenantId: string): void {
    this.state.delete(tenantId);
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.state.clear();
  }

  private getOrCreateState(tenantId: string): TenantRateLimitState {
    let state = this.state.get(tenantId);
    if (!state) {
      state = { requests: [], runningTasks: 0 };
      this.state.set(tenantId, state);
    }
    return state;
  }
}

export type RateLimitResult = 
  | { allowed: true; remaining: number; limit: number }
  | { 
      allowed: false; 
      reason: "rate_limit"; 
      remaining: number; 
      limit: number;
      resetAt: number;
      retryAfterMs: number;
    }
  | {
      allowed: false;
      reason: "concurrent_limit";
      remaining: number;
      limit: number;
      currentConcurrent: number;
    };

/**
 * Create rate limiting middleware
 */
export function createRateLimitMiddleware(limiter: TenantRateLimiter): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const tenant = c.get("tenant");
    if (!tenant) {
      // No tenant context - skip rate limiting (likely unauthenticated endpoint)
      return next();
    }

    const result = limiter.checkLimit(tenant);

    // Add rate limit headers
    c.header("X-RateLimit-Limit", String(result.limit));
    c.header("X-RateLimit-Remaining", String(result.remaining));

    if (!result.allowed) {
      if (result.reason === "rate_limit") {
        c.header("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
        c.header("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
      }

      throw new AuthError(
        "RATE_LIMITED",
        result.reason === "rate_limit" 
          ? "Too many requests" 
          : "Too many concurrent tasks",
        429,
        result
      );
    }

    return next();
  };
}

/**
 * Middleware for tracking concurrent tasks
 */
export function createConcurrentTaskMiddleware(
  limiter: TenantRateLimiter
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const tenant = c.get("tenant");
    if (!tenant) {
      return next();
    }

    // Increment at start
    limiter.incrementConcurrent(tenant.id);

    try {
      await next();
    } finally {
      // Decrement when done (success or failure)
      limiter.decrementConcurrent(tenant.id);
    }
  };
}
