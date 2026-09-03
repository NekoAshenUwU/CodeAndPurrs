# Neko Auto Wake MCP

Private automatic-wake and recent-screen tools shared by ChatGPT and Claude.
Production mounts these tools into the existing authenticated MCP at:

```text
https://mcp.nekopurrs.uk/mcp
```

The public MCP keeps its current HTTPS and OAuth/DCR flow. The mounted tool
module calls a localhost-only CodeAndPurrs control API using
`AUTOWAKE_MCP_INTERNAL_KEY`; the key and the screen bridge are never exposed as
MCP tool arguments or results.

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

The installer backs up both the existing public MCP source and the
CodeAndPurrs `.env`, generates the localhost bridge key when missing, compiles
the Python sources, restarts both services, tests the internal status route,
and restores the backup if a check fails.

## App connection

- ChatGPT: enable Developer mode, add the HTTPS URL above as an MCP server,
  then finish its OAuth flow.
- Claude: Customize → Connectors → Add custom connector, use the same URL,
  then connect it.

The connector gives both apps control and screen-reading tools. MCP itself is
request/response and cannot start a closed ChatGPT or Claude conversation. An
in-app scheduled task must call these tools if the wake message should appear
inside that app; `send_codeandpurrs_wake_now` specifically targets the existing
CodeAndPurrs Web Push subscription.

Do not expose the standalone port `8893` without an authentication layer.
