export type LikuErrorCode =
  | "INVALID_RESIDENCE"
  | "INVALID_REPO_ROOT"
  | "MEMORY_NOT_INITIALIZED"
  | "MEMORY_DEGRADED"
  | "SQLITE_INIT_FAILED"
  | "IO_ERROR"
  | "BAD_REQUEST"
  | "PATH_TRAVERSAL"
  | "ESCALATION_REQUIRED"
  | "INVALID_PLAN"
  | "CONTRACT_VIOLATION"
  | "INTERNAL";

export class LikuError extends Error {
  readonly code: LikuErrorCode;
  readonly details?: unknown;

  constructor(code: LikuErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "LikuError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: LikuErrorCode; message: string; details?: unknown } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined && { details: this.details })
    };
  }
}

export function toLikuError(err: unknown): LikuError {
  if (err instanceof LikuError) return err;
  if (err instanceof Error) {
    // Check for Zod validation errors
    if (err.name === "ZodError") {
      return new LikuError("BAD_REQUEST", "Validation error", { issues: (err as { issues?: unknown }).issues });
    }
    return new LikuError("INTERNAL", err.message, { name: err.name, stack: err.stack });
  }
  return new LikuError("INTERNAL", "Unknown error", { err });
}

/**
 * Result envelope for agent invocations
 */
export type InvokeResult<T> =
  | { kind: "ok"; bundle: T }
  | { kind: "escalation"; missingSkill: string; requestedAction: string; residence: string; policyRef: string }
  | { kind: "error"; code: LikuErrorCode; message: string; details?: unknown };

export function okResult<T>(bundle: T): InvokeResult<T> {
  return { kind: "ok", bundle };
}

export function errorResult(err: LikuError): InvokeResult<never> {
  return { kind: "error", code: err.code, message: err.message, details: err.details };
}

export function escalationResult(
  missingSkill: string,
  requestedAction: string,
  residence: string,
  policyRef: string
): InvokeResult<never> {
  return { kind: "escalation", missingSkill, requestedAction, residence, policyRef };
}

