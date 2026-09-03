# Neko Auto Wake MCP

Private automatic-wake and recent-screen tools for supported MCP clients.
Production mounts these tools into the existing authenticated MCP at:

```text
https://mcp.nekopurrs.uk/mcp
```

The public MCP keeps its current HTTPS and OAuth/DCR flow. The mounted tool
module calls a localhost-only CodeAndPurrs control API using
`AUTOWAKE_MCP_INTERNAL_KEY`; the key and the screen bridge are never exposed as
MCP tool arguments or results.

The live topology is:

- `8890`: the real FastMCP backend
- `8891`: the `tang-web` OAuth gateway in front of it
- `8892`: playlist MCP
- `8893`: usage MCP

The installer discovers the Python source and systemd unit from the process
currently listening on `8890`, then mounts the auto-wake child MCP into that
backend. It does not add or migrate a port, and it does not change Nginx,
OAuth, or the public URL.

Tools:

- `get_autowake_status`
- `set_codeandpurrs_autowake`
- `send_codeandpurrs_wake_now`
- `list_autowake_deliveries`
- `look_at_recent_screen`

## Deployment order

1. Deploy the current CodeAndPurrs auto-wake backend.
2. Run the MCP mount installer as `root`:

```bash
curl -fsSL https://raw.githubusercontent.com/NekoAshenUwU/CodeAndPurrs/codex/frontend-ai-playlist-20260828/deploy/autowake-mcp/install-into-existing.py | python3 -
```

The installer backs up the detected FastMCP source, CodeAndPurrs `.env`, and
the mounted tool module; generates the localhost bridge key when missing;
compiles the Python sources; restarts only CodeAndPurrs and the detected
`8890` backend service; tests the internal status route; and restores every
changed file if a check fails. If the live backend cannot be identified
unambiguously, it stops before modifying any file and prints the process
diagnostics.

## Client connection

Add the HTTPS URL above as an MCP server and finish its OAuth flow. The connector
provides control and screen-reading tools. MCP itself is request/response and cannot
start a closed client conversation. `send_codeandpurrs_wake_now` specifically targets
the existing CodeAndPurrs Web Push subscription.

Ports `8891`, `8892`, and `8893` are not modified by this installer.
