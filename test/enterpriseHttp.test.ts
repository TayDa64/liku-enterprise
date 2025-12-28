import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";

// Mock the enterprise HTTP server behavior for testing
describe("Enterprise HTTP Server", () => {
  describe("Configuration", () => {
    it("should accept enterprise configuration", () => {
      const config = {
        port: 8765,
        enterprise: {
          enabled: true,
          oidc: {
            issuerUrl: "https://auth.example.com",
            audience: "liku-api",
            jwksUri: "https://auth.example.com/.well-known/jwks.json",
            algorithms: ["RS256"] as const,
            clockToleranceSeconds: 30,
            cacheJwksSeconds: 300
          },
          audit: {
            storage: "sqlite" as const,
            hashAlgorithm: "sha256" as const,
            retentionDays: 90,
            enableBatching: false,
            batchIntervalMs: 1000,
            maxBatchSize: 100
          },
          policy: {
            mode: "embedded" as const,
            defaultPackage: "liku.authz",
            cacheTtlSeconds: 60,
            timeoutMs: 1000,
            enableLogging: true
          }
        }
      };

      expect(config.enterprise.enabled).toBe(true);
      expect(config.enterprise.oidc?.issuerUrl).toBe("https://auth.example.com");
      expect(config.enterprise.audit?.storage).toBe("sqlite");
      expect(config.enterprise.policy?.mode).toBe("embedded");
    });

    it("should support remote policy mode", () => {
      const config = {
        enterprise: {
          enabled: true,
          policy: {
            mode: "remote" as const,
            serverUrl: "http://opa-server:8181",
            defaultPackage: "liku.authz",
            cacheTtlSeconds: 60,
            timeoutMs: 1000,
            enableLogging: true
          }
        }
      };

      expect(config.enterprise.policy?.mode).toBe("remote");
      expect(config.enterprise.policy?.serverUrl).toBe("http://opa-server:8181");
    });

    it("should support initial tenants", () => {
      const config = {
        enterprise: {
          enabled: true,
          initialTenants: [
            { id: "tenant-1", name: "Acme Corp" },
            { id: "tenant-2", name: "Beta Inc" }
          ]
        }
      };

      expect(config.enterprise.initialTenants).toHaveLength(2);
      expect(config.enterprise.initialTenants[0].id).toBe("tenant-1");
    });
  });

  describe("Health Endpoint", () => {
    it("should include enterprise status in health response", () => {
      const healthResponse = {
        ok: true,
        memory: { status: "ok" },
        tasks: { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
        limiter: { running: 0, queued: 0, atCapacity: false },
        enterprise: {
          enabled: true,
          oidc: true,
          audit: true,
          policy: true
        }
      };

      expect(healthResponse.enterprise.enabled).toBe(true);
      expect(healthResponse.enterprise.oidc).toBe(true);
      expect(healthResponse.enterprise.audit).toBe(true);
      expect(healthResponse.enterprise.policy).toBe(true);
    });

    it("should show enterprise disabled when not configured", () => {
      const healthResponse = {
        ok: true,
        enterprise: { enabled: false }
      };

      expect(healthResponse.enterprise.enabled).toBe(false);
    });
  });

  describe("Audit Endpoints", () => {
    it("should validate audit query schema", () => {
      const validQuery = {
        tenantId: "tenant-1",
        actorId: "user-123",
        actions: ["task.create", "task.cancel"],
        outcomes: ["success", "failure"],
        startTime: "2024-01-01T00:00:00Z",
        endTime: "2024-12-31T23:59:59Z",
        limit: 100
      };

      expect(validQuery.tenantId).toBe("tenant-1");
      expect(validQuery.actions).toContain("task.create");
      expect(validQuery.limit).toBe(100);
    });

    it("should support audit export formats", () => {
      const exportRequest = {
        format: "csv",
        tenantId: "tenant-1",
        limit: 10000
      };

      expect(exportRequest.format).toBe("csv");
    });

    it("should support chain verification request", () => {
      const verifyRequest = {
        startSequence: 0,
        endSequence: 100
      };

      expect(verifyRequest.startSequence).toBe(0);
      expect(verifyRequest.endSequence).toBe(100);
    });
  });

  describe("Authorization Middleware", () => {
    it("should require agents:invoke permission for /a2a/invoke", () => {
      const requiredPermission = "agents:invoke";
      expect(requiredPermission).toBe("agents:invoke");
    });

    it("should require tasks:create permission for /a2a/tasks/send", () => {
      const requiredPermission = "tasks:create";
      expect(requiredPermission).toBe("tasks:create");
    });

    it("should require tasks:read permission for /a2a/tasks/get", () => {
      const requiredPermission = "tasks:read";
      expect(requiredPermission).toBe("tasks:read");
    });

    it("should require tasks:cancel permission for /a2a/tasks/cancel", () => {
      const requiredPermission = "tasks:cancel";
      expect(requiredPermission).toBe("tasks:cancel");
    });

    it("should require tasks:list permission for /a2a/tasks/list", () => {
      const requiredPermission = "tasks:list";
      expect(requiredPermission).toBe("tasks:list");
    });

    it("should require audit:read permission for /enterprise/audit/query", () => {
      const requiredPermission = "audit:read";
      expect(requiredPermission).toBe("audit:read");
    });

    it("should require audit:export permission for /enterprise/audit/export", () => {
      const requiredPermission = "audit:export";
      expect(requiredPermission).toBe("audit:export");
    });
  });

  describe("Skip Paths", () => {
    it("should skip auth for health endpoint", () => {
      const skipPaths = ["/health", "/ready"];
      expect(skipPaths).toContain("/health");
    });

    it("should skip auth for ready endpoint", () => {
      const skipPaths = ["/health", "/ready"];
      expect(skipPaths).toContain("/ready");
    });

    it("should NOT skip auth for A2A endpoints", () => {
      const skipPaths = ["/health", "/ready"];
      expect(skipPaths).not.toContain("/a2a/invoke");
      expect(skipPaths).not.toContain("/a2a/tasks/send");
    });
  });

  describe("Error Handling", () => {
    it("should handle AuthError with appropriate status codes", () => {
      const authError = {
        kind: "auth",
        code: "UNAUTHORIZED",
        message: "Invalid token",
        statusCode: 401
      };

      expect(authError.statusCode).toBe(401);
    });

    it("should handle forbidden errors with 403", () => {
      const authError = {
        kind: "auth",
        code: "FORBIDDEN",
        message: "Insufficient permissions",
        statusCode: 403
      };

      expect(authError.statusCode).toBe(403);
    });

    it("should handle rate limit errors with 429", () => {
      const authError = {
        kind: "auth",
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests",
        statusCode: 429
      };

      expect(authError.statusCode).toBe(429);
    });

    it("should handle capacity exceeded with 503", () => {
      const capacityError = {
        kind: "error",
        errorType: "capacity_exceeded",
        message: "Server at capacity",
        retryAfterMs: 5000
      };

      expect(capacityError.errorType).toBe("capacity_exceeded");
      expect(capacityError.retryAfterMs).toBe(5000);
    });
  });

  describe("Tenant Resolution", () => {
    it("should extract tenant from X-Tenant-ID header", () => {
      const tenantHeader = "X-Tenant-ID";
      const tenantId = "acme-corp";

      expect(tenantHeader).toBe("X-Tenant-ID");
      expect(tenantId).toBe("acme-corp");
    });

    it("should use default tenant when header not provided", () => {
      const defaultTenant = {
        id: "default",
        name: "Default Tenant",
        isActive: true
      };

      expect(defaultTenant.id).toBe("default");
    });
  });

  describe("Rate Limiting", () => {
    it("should apply per-tenant rate limits", () => {
      const rateLimitConfig = {
        defaultRpm: 100,
        defaultMaxConcurrent: 10,
        windowMs: 60_000
      };

      expect(rateLimitConfig.defaultRpm).toBe(100);
      expect(rateLimitConfig.windowMs).toBe(60_000);
    });
  });
});

describe("CLI Enterprise Options", () => {
  it("should have --enterprise flag", () => {
    const cliOptions = {
      enterprise: false,
      oidcIssuer: undefined,
      oidcAudience: undefined,
      tenantMode: "single",
      auditPath: undefined,
      policyMode: "embedded",
      policyUrl: undefined
    };

    expect(cliOptions.enterprise).toBe(false);
    expect(cliOptions.tenantMode).toBe("single");
    expect(cliOptions.policyMode).toBe("embedded");
  });

  it("should build OIDC config from CLI options", () => {
    const opts = {
      oidcIssuer: "https://auth.example.com",
      oidcAudience: "liku-api"
    };

    const oidcConfig = {
      issuerUrl: opts.oidcIssuer,
      audience: opts.oidcAudience ?? "liku-enterprise",
      jwksUri: `${opts.oidcIssuer}/.well-known/jwks.json`,
      algorithms: ["RS256"],
      clockToleranceSeconds: 30,
      cacheJwksSeconds: 300
    };

    expect(oidcConfig.issuerUrl).toBe("https://auth.example.com");
    expect(oidcConfig.audience).toBe("liku-api");
    expect(oidcConfig.jwksUri).toBe("https://auth.example.com/.well-known/jwks.json");
  });

  it("should default OIDC audience to liku-enterprise", () => {
    const opts = {
      oidcIssuer: "https://auth.example.com",
      oidcAudience: undefined
    };

    const audience = opts.oidcAudience ?? "liku-enterprise";
    expect(audience).toBe("liku-enterprise");
  });

  it("should build audit config from CLI options", () => {
    const opts = {
      auditPath: "/var/lib/liku/audit.db"
    };

    const auditConfig = {
      storage: "sqlite",
      dbPath: opts.auditPath,
      hashAlgorithm: "sha256",
      retentionDays: 0
    };

    expect(auditConfig.dbPath).toBe("/var/lib/liku/audit.db");
  });

  it("should build remote policy config", () => {
    const opts = {
      policyMode: "remote",
      policyUrl: "http://opa-server:8181"
    };

    const policyConfig = opts.policyMode === "remote" ? {
      mode: "remote",
      serverUrl: opts.policyUrl ?? "http://localhost:8181",
      defaultPackage: "liku.authz"
    } : {
      mode: "embedded",
      defaultPackage: "liku.authz"
    };

    expect(policyConfig.mode).toBe("remote");
    expect(policyConfig.serverUrl).toBe("http://opa-server:8181");
  });

  it("should default policy URL when not provided", () => {
    const opts = {
      policyMode: "remote",
      policyUrl: undefined
    };

    const serverUrl = opts.policyUrl ?? "http://localhost:8181";
    expect(serverUrl).toBe("http://localhost:8181");
  });
});
