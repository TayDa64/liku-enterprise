# Liku Enterprise

Enterprise-grade multi-agent orchestration framework for building trustworthy AI coding assistants with SSO, RBAC, audit logging, and multi-tenancy.

> **Fork of [TayDa64/liku-system](https://github.com/TayDa64/liku-system)** - Baseline includes Plan Validator, Output Contracts, Memory Provenance.

## Overview

Liku Enterprise extends the core Liku System with enterprise security and compliance features:

### Core Features (from baseline)
- **Privilege Escalation via Skills** - Agents can only perform actions their residence grants
- **Plan Validation** - Guards against planner-induced DoS and privilege escalation
- **Output Contracts** - Validates agent output with retry-then-escalate pattern
- **Memory Provenance** - Tracks origin and confidence of all stored knowledge
- **Concurrency Limits** - Prevents resource exhaustion at ingress

### Enterprise Features
- **🔐 SSO/OIDC Authentication** - Integrate with enterprise identity providers (Okta, Azure AD, Auth0)
- **📝 Immutable Audit Logging** - Append-only, tamper-evident audit trail for compliance
- **🛡️ RBAC** - Role-based access control with fine-grained permissions
- **🏢 Multi-Tenancy** - Tenant isolation with data segregation
- **⏱️ Per-Tenant Rate Limiting** - Fair resource allocation across tenants
- **🔑 Secrets Vault Integration** - HashiCorp Vault, AWS Secrets Manager support
- **📜 OPA Policy Engine** - Declarative policy-as-code with Open Policy Agent

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Enterprise Gateway                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐  ┌──────────────┐   │
│  │ SSO/OIDC │  │   RBAC   │  │ Rate     │  │   OPA   │  │ Tenant       │   │
│  │ Middleware│  │ Enforcer │  │ Limiter  │  │ Engine  │  │ Resolver     │   │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘  └──────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Orchestrator                                        │
│  ┌─────────┐  ┌────────┐  ┌─────────┐  ┌────────────┐                       │
│  │Supervisor│→ │ Parser │→ │ Planner │→ │ Specialist │                       │
│  └─────────┘  └────────┘  └─────────┘  └────────────┘                       │
│       ↓                        ↓              ↓                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │              Plan Validator + Output Contracts                          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Liku Engine                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐              │
│  │ Skill Loader │  │ Path Security│  │ Privilege Validation │              │
│  └─────────────┘  └──────────────┘  └────────────────────────┘              │
└─────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Immutable Audit Log + Secrets Vault                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Enterprise Components

### Authentication (SSO/OIDC)

```typescript
import { OIDCMiddleware } from "liku-enterprise/auth";

const auth = new OIDCMiddleware({
  issuer: "https://your-idp.example.com",
  clientId: process.env.OIDC_CLIENT_ID,
  clientSecret: process.env.OIDC_CLIENT_SECRET,
  audience: "liku-api"
});
```

### Role-Based Access Control

| Role | Permissions |
|------|-------------|
| `admin` | Full access, manage tenants, view audit logs |
| `developer` | Create/run tasks, manage own agents |
| `viewer` | Read-only access to task results |
| `auditor` | Read audit logs, no task execution |

### Multi-Tenancy

Tenants are isolated at the data layer:
- Separate memory databases per tenant
- Tenant-scoped agent residences
- Cross-tenant access denied by default

### Audit Logging

Every operation is logged with:
- **Timestamp** (ISO 8601)
- **Actor** (user ID, service account)
- **Tenant** (tenant ID)
- **Action** (operation type)
- **Resource** (affected entity)
- **Outcome** (success/failure)
- **Hash chain** (tamper-evident linking)

## Installation

```bash
npm install
```

## Configuration

### Environment Variables

#### Core
- `LIKU_LLM_PROVIDER` - LLM provider (openai, anthropic, etc.)
- `LIKU_LLM_MODEL` - Model name
- `LIKU_API_KEY` - API key for LLM provider

#### Enterprise Authentication
- `LIKU_OIDC_ISSUER` - OIDC provider issuer URL
- `LIKU_OIDC_CLIENT_ID` - OIDC client ID
- `LIKU_OIDC_CLIENT_SECRET` - OIDC client secret
- `LIKU_OIDC_AUDIENCE` - Expected JWT audience

#### Secrets Vault
- `LIKU_VAULT_PROVIDER` - Vault provider (hashicorp, aws, azure)
- `LIKU_VAULT_ADDR` - Vault server address
- `LIKU_VAULT_TOKEN` - Vault authentication token

#### Audit
- `LIKU_AUDIT_STORAGE` - Audit storage backend (sqlite, postgres, s3)
- `LIKU_AUDIT_RETENTION_DAYS` - Audit log retention period

#### OPA Policy
- `LIKU_OPA_ENDPOINT` - OPA server endpoint (optional, embedded by default)
- `LIKU_OPA_POLICY_PATH` - Path to policy bundle

## Usage

### CLI

```bash
# Initialize Liku directory structure
npx liku init

# Run orchestration
npx liku run "Create a test file for utils.ts"

# Create a new task directory
npx liku task:new --name my-feature
```

### HTTP Server (Basic)

```bash
# Start basic HTTP server (no auth)
npx liku serve --port 8765
```

### HTTP Server with Enterprise Features

```bash
# Start with enterprise features enabled
npx liku serve --enterprise --port 8765

# With OIDC authentication
npx liku serve --enterprise \
  --oidc-issuer https://auth.example.com \
  --oidc-audience liku-api

# With persistent audit logging
npx liku serve --enterprise \
  --audit-path /var/lib/liku/audit.db

# With remote OPA server
npx liku serve --enterprise \
  --policy-mode remote \
  --policy-url http://opa-server:8181
```

#### Enterprise CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `--enterprise` | Enable enterprise features | `false` |
| `--oidc-issuer <url>` | OIDC issuer URL for token validation | - |
| `--oidc-audience <aud>` | Expected JWT audience | `liku-enterprise` |
| `--tenant-mode <mode>` | Tenant mode: `single` or `multi` | `single` |
| `--audit-path <path>` | SQLite audit log path | `:memory:` |
| `--policy-mode <mode>` | Policy mode: `embedded` or `remote` | `embedded` |
| `--policy-url <url>` | Remote OPA server URL | `http://localhost:8181` |

### API Authentication

```bash
# Obtain token from your IdP, then:
curl -X POST http://localhost:8765/a2a/tasks/send \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-ID: acme-corp" \
  -H "Content-Type: application/json" \
  -d '{"query": "Create unit tests for auth module"}'
```

### Enterprise Audit Endpoints

```bash
# Query audit logs
curl -X POST http://localhost:8765/enterprise/audit/query \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"tenantId": "acme-corp", "limit": 100}'

# Export audit logs as CSV
curl -X POST http://localhost:8765/enterprise/audit/export \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"format": "csv"}' > audit.csv

# Verify audit chain integrity
curl -X POST http://localhost:8765/enterprise/audit/verify \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"startSequence": 0, "endSequence": 100}'
```

## Development

```bash
# Run tests
npm test

# Type check
npm run typecheck

# Build
npm run build
```

## Upstream Sync

This fork tracks `upstream/master` for baseline updates:

```bash
# Add upstream if not configured
git remote add upstream https://github.com/TayDa64/liku-system.git

# Sync with upstream
git fetch upstream
git merge upstream/master
```

## License

UNLICENSED - Enterprise License Required
