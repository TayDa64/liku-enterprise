import { describe, expect, it } from "vitest";
import { LikuError, toLikuError, okResult, errorResult, escalationResult } from "../src/liku/errors.js";
import { z } from "zod";

describe("LikuError", () => {
  it("creates error with code and message", () => {
    const err = new LikuError("INVALID_RESIDENCE", "Test message");
    expect(err.code).toBe("INVALID_RESIDENCE");
    expect(err.message).toBe("Test message");
    expect(err.name).toBe("LikuError");
  });

  it("includes details when provided", () => {
    const err = new LikuError("IO_ERROR", "File not found", { path: "/test" });
    expect(err.details).toEqual({ path: "/test" });
  });

  it("toJSON returns serializable object", () => {
    const err = new LikuError("BAD_REQUEST", "Invalid input", { field: "name" });
    const json = err.toJSON();

    expect(json.code).toBe("BAD_REQUEST");
    expect(json.message).toBe("Invalid input");
    expect(json.details).toEqual({ field: "name" });
  });

  it("toJSON excludes details when undefined", () => {
    const err = new LikuError("INTERNAL", "Something went wrong");
    const json = err.toJSON();

    expect(json.code).toBe("INTERNAL");
    expect(json.message).toBe("Something went wrong");
    expect("details" in json).toBe(false);
  });
});

describe("toLikuError", () => {
  it("returns LikuError unchanged", () => {
    const original = new LikuError("MEMORY_DEGRADED", "Memory unavailable");
    const result = toLikuError(original);
    expect(result).toBe(original);
  });

  it("converts regular Error to INTERNAL", () => {
    const err = new Error("Something failed");
    const result = toLikuError(err);

    expect(result.code).toBe("INTERNAL");
    expect(result.message).toBe("Something failed");
    expect(result.details).toHaveProperty("name", "Error");
    expect(result.details).toHaveProperty("stack");
  });

  it("converts ZodError to BAD_REQUEST", () => {
    const schema = z.object({ name: z.string() });

    try {
      schema.parse({});
    } catch (err) {
      const result = toLikuError(err);
      expect(result.code).toBe("BAD_REQUEST");
      expect(result.message).toBe("Validation error");
      expect(result.details).toHaveProperty("issues");
    }
  });

  it("converts unknown values to INTERNAL", () => {
    const result = toLikuError("string error");
    expect(result.code).toBe("INTERNAL");
    expect(result.message).toBe("Unknown error");
    expect(result.details).toEqual({ err: "string error" });
  });

  it("converts null/undefined to INTERNAL", () => {
    const resultNull = toLikuError(null);
    expect(resultNull.code).toBe("INTERNAL");

    const resultUndefined = toLikuError(undefined);
    expect(resultUndefined.code).toBe("INTERNAL");
  });
});

describe("Result helpers", () => {
  it("okResult wraps bundle correctly", () => {
    const bundle = { data: "test" };
    const result = okResult(bundle);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.bundle).toBe(bundle);
    }
  });

  it("errorResult creates error envelope", () => {
    const err = new LikuError("PATH_TRAVERSAL", "Invalid path", { path: "../.." });
    const result = errorResult(err);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("PATH_TRAVERSAL");
      expect(result.message).toBe("Invalid path");
      expect(result.details).toEqual({ path: "../.." });
    }
  });

  it("escalationResult creates escalation envelope", () => {
    const result = escalationResult(
      "root_access",
      "modify_system_config",
      "Liku/specialist/ts",
      "Liku/root/policy.md"
    );

    expect(result.kind).toBe("escalation");
    if (result.kind === "escalation") {
      expect(result.missingSkill).toBe("root_access");
      expect(result.requestedAction).toBe("modify_system_config");
      expect(result.residence).toBe("Liku/specialist/ts");
      expect(result.policyRef).toBe("Liku/root/policy.md");
    }
  });
});
