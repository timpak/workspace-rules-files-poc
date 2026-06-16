# mcp-server-baseline

**Tier:** baseline
**Pass rule:** STRICT on C1 + C2 (C3 supporting, not gating)
**Skill under test:** `mcp-server`
**Grading:** assertion-based (JSON parse of `.mcp.json`). No LLM judge.

## Prompt

> Set up the Liferay MCP server for Claude Code in this workspace.
> I want to be able to use MCP to call our Liferay APIs.

## Pre-conditions (set up by harness)

- Workspace initialized; `liferay.workspace.product` set in `gradle.properties`.
- Liferay running on the port from `bundles/tomcat*/conf/server.xml` (default 8080).
- `LPD-63311` is on (premise of the eval — flag setup itself belongs to
  the `feature-flags` skill and is not graded here).
- Any pre-existing `.mcp.json` at the repo root is stashed at setup and
  restored at teardown.

## What the canonical solution looks like

A `.mcp.json` at the repo root declares one MCP server entry for Liferay.
The right transport and URL suffix depend on the DXP version:

- **2025.Q4** → SSE transport, URL `http://localhost:${PORT}/o/mcp/sse`
- **2026.Q1+** → Streamable HTTP transport, URL `http://localhost:${PORT}/o/mcp`

```json
{
  "mcpServers": {
    "liferay": {
      "type": "http",
      "url": "http://localhost:8080/o/mcp",
      "headers": {
        "Authorization": "Basic dGVzdEBsaWZlcmF5LmNvbTp0ZXN0"
      }
    }
  }
}
```

## Criteria

### C1 — Transport matches DXP version

Parse `.mcp.json` at the repo root. The Liferay server entry's transport
must match the DXP version detected from `liferay.workspace.product` in
`gradle.properties`:

- 2025.Q4: SSE transport (Claude Code's `.mcp.json` syntax: `"type": "sse"`)
- 2026.Q1 or later: Streamable HTTP (`"type": "http"`)

**Bucket on fail:** `rule-misapplied`

**Cites:** `mcp-server/SKILL.md` — "DXP 2026.Q1+: Streamable HTTP
Transport Required" + "Endpoint URL by DXP Version".

### C2 — Endpoint URL matches DXP version

The server entry's `url` field must end with the version-appropriate suffix:

- 2025.Q4: `/o/mcp/sse`
- 2026.Q1+: `/o/mcp` (NOT `/o/mcp/sse`)

**Bucket on fail:** `rule-misapplied`

**Cites:** `mcp-server/SKILL.md` — "Endpoint URL by DXP Version".

### C3 — Basic auth present (supporting only)

The server entry includes a `headers.Authorization` value starting with
`Basic ` (default credentials `test@liferay.com:test` base64-encoded
unless the workspace overrides). Not gating — recorded for failure-bucket
diagnosis only.

**Bucket on fail:** `rule-misapplied`

**Cites:** `mcp-server/SKILL.md` — "Authentication".

## Aggregate

STRICT on C1 + C2 (both must pass). C3 is supporting — its failure does
not gate the run but is captured in the failure-bucket detail.

## Bucket mapping for out-of-rubric failure modes

| Observation | Bucket |
|---|---|
| `.mcp.json` not created at all | `skill-not-invoked` |
| Agent edited `~/.claude/settings.json` user-scoped instead of project-scoped `.mcp.json` | `rule-misapplied` |
| C1/C2 fail because URL has `/sse` on 2026.Q1+ or missing `/sse` on 2025.Q4 | `rule-misapplied` |
| Agent stopped mid-task awaiting input | `stalled` |
| Failure does not match any criterion above | `unknown` |
