# Neko Playlist MCP

Private Spotify playlist tools for ChatGPT and Claude. The service reads the
Spotify OAuth session created by CodeAndPurrs and binds to `127.0.0.1:8891`.

Tools:

- `prepare_spotify_playlist`
- `list_spotify_devices`
- `play_spotify_playlist`
- `get_spotify_playback`
- `control_spotify`

Keep the service localhost-only until OAuth is added at the MCP layer.
