# Liku System

A multi-agent orchestration framework for building trustworthy AI coding assistants.

## Overview

Liku System provides a hierarchical privilege model with bounded trust for AI agents operating on code repositories. It implements defense-in-depth through:

- **Privilege Escalation via Skills** - Agents can only perform actions their residence grants
- **Plan Validation** - Guards against planner-induced DoS and privilege escalation
- **Output Contracts** - Validates agent output with retry-then-escalate pattern
- **Memory Provenance** - Tracks origin and confidence of all stored knowledge
- **Concurrency Limits** - Prevents resource exhaustion at ingress

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Orchestrator                           │
│  ┌─────────┐  ┌────────┐  ┌─────────┐  ┌────────────┐          │
│  │Supervisor│→ │ Parser │→ │ Planner │→ │ Specialist │          │
│  └─────────┘  └────────┘  └─────────┘  └────────────┘          │
│       ↓                        ↓              ↓                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Plan Validator + Output Contracts              ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                         Liku Engine                             │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ Skill Loader │  │ Path Security│  │ Privilege Validation │ │
│  └─────────────┘  └──────────────┘  └────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### Privilege Hierarchy

| Level | Residence | Capabilities |
|-------|-----------|--------------|
| **root** | `Liku/root/` | Full access, network, shell, escalate |
| **specialist** | `Liku/specialist/*` | Read/write repo, run tests, lint |
| **user** | Other paths | Read-only access |

### Trust Boundaries

1. **Planner Trust** - `validatePlan()` enforces step limits, parallelism caps, capability checks, and circular dependency detection
2. **LLM Output Trust** - Agent contracts validate output structure with reflect-repair loop
3. **Memory Trust** - Provenance metadata tracks taskId, agentRole, confidence, TTL

## Installation

```bash
npm install
```

## Usage

### CLI

```bash
# Initialize Liku directory structure
npx liku init

# Run orchestration
npx liku run --goal "Create a test file for utils.ts"
```

### MCP Server

```bash
# Start MCP server
npx liku mcp --repo /path/to/repo
```

### HTTP Server

```bash
# Start HTTP API
npx liku serve --port 3000
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

## Configuration

Environment variables:
- `LIKU_LLM_PROVIDER` - LLM provider (openai, anthropic, etc.)
- `LIKU_LLM_MODEL` - Model name
- `LIKU_API_KEY` - API key for LLM provider

## Forking for Enterprise

This repository is designed as a baseline for different implementation directions:

- **Enterprise** - Add SSO, audit logging, compliance features
- **Local** - Optimize for local LLM inference
- **Specialized** - Domain-specific agent residences

Fork this repo and extend the base components while maintaining the trust boundaries.

## License

MIT
