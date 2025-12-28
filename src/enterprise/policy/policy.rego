# Liku Enterprise Authorization Policy
#
# Default policy rules for the embedded OPA engine.
# This file documents the policy that would be used with a remote OPA server.

package liku.authz

import future.keywords.if
import future.keywords.in

# Default deny
default allow := false

# Admin has full access
allow if {
    "admin" in input.subject.roles
}

# Tenant isolation - subject must belong to resource tenant
deny if {
    input.resource.tenantId
    input.resource.tenantId != input.subject.tenantId
}

# Task operations
allow if {
    input.action == "tasks:create"
    role_allowed(["admin", "developer"])
}

allow if {
    input.action == "tasks:read"
    role_allowed(["admin", "developer", "viewer", "auditor"])
}

allow if {
    input.action == "tasks:cancel"
    role_allowed(["admin", "developer"])
}

allow if {
    input.action == "tasks:list"
    role_allowed(["admin", "developer", "viewer", "auditor"])
}

# Agent operations
allow if {
    input.action == "agents:invoke"
    role_allowed(["admin", "developer"])
    not root_agent_access
}

allow if {
    input.action == "agents:invoke"
    role_allowed(["admin"])
    root_agent_access
}

allow if {
    input.action == "agents:read"
    role_allowed(["admin", "developer", "viewer"])
}

allow if {
    input.action == "agents:manage"
    role_allowed(["admin"])
}

# Tenant operations
allow if {
    startswith(input.action, "tenants:")
    role_allowed(["admin"])
}

# Audit operations
allow if {
    input.action == "audit:read"
    role_allowed(["admin", "auditor"])
}

allow if {
    input.action == "audit:export"
    role_allowed(["admin", "auditor"])
}

# Helper: check if subject has any of the allowed roles
role_allowed(allowed_roles) if {
    some role in input.subject.roles
    role in allowed_roles
}

# Helper: check if accessing root agent
root_agent_access if {
    input.resource.type == "agent"
    contains(input.resource.path, "Liku/root")
}

# Decision metadata
reason := "Admin role has full access" if {
    "admin" in input.subject.roles
}

reason := "Cross-tenant access denied" if {
    input.resource.tenantId
    input.resource.tenantId != input.subject.tenantId
}

reason := concat("", ["Role authorized for action ", input.action]) if {
    allow
    not "admin" in input.subject.roles
}

reason := concat("", ["No authorized role for action ", input.action]) if {
    not allow
}
