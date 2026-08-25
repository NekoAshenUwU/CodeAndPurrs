# Neko Playlist MCP

Private Spotify playlist tools for ChatGPT and Claude. The standalone source
binds to `127.0.0.1:8892`.

Production uses the existing authenticated CodeAndPurrs MCP on port `8891`.
The installer mounts these five tools into that server so the original public
MCP URL and its OAuth/DCR flow stay unchanged:

- `prepare_spotify_playlist`
- `list_spotify_devices`
- `play_spotify_playlist`
- `get_spotify_playback`
- `control_spotify`

Run as `root` on the VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/NekoAshenUwU/CodeAndPurrs/playlist-mcp-20260825/deploy/playlist-mcp/install-into-existing.py | python3 -
```

The installer downloads the pinned playlist server, backs up
`/root/codeandpurrs-mcp/server.py`, mounts the tools before its existing
startup entrypoint, compiles both files, restarts
`codeandpurrs-mcp.service`, and automatically restores the backup if startup
fails.

Do not expose the standalone `8892` service publicly without its own OAuth
layer.
