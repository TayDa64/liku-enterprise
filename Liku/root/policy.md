# Liku Policy (Root)

- The filesystem under `Liku/` is the canonical source of truth.
- Sub-agents may only narrow policies; they may not override root policy.
- Escalations are returned as structured events; interactive prompting is optional per client.
