#!/usr/bin/env python3
"""Run in the VPS console; OAuth secrets stay on the VPS and are not echoed."""
import getpass
import os
from pathlib import Path
import re
import secrets
import sys


def main():
    target = Path("/etc/neko-native-wake.env")
    if os.geteuid() != 0 or not sys.stdin.isatty() or not sys.stderr.isatty():
        raise SystemExit("Run this script as root in the VPS interactive console.")
    if target.exists():
        raise SystemExit("Configuration already exists. Inspect before changing it.")
    client_id = input("New GitHub OAuth App Client ID: ").strip()
    client_secret = getpass.getpass("New Client Secret (hidden): ").strip()
    for value in [client_id, client_secret]:
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,256}", value) or value.startswith("REPLACE_"):
            raise SystemExit("Unexpected credential format; nothing was saved.")
    values = {
        "NEKO_NATIVE_WAKE_AUTH_MODE": "github",
        "NEKO_NATIVE_WAKE_PUBLIC_URL": "https://wake-mcp.nekopurrs.uk",
        "NEKO_NATIVE_WAKE_GITHUB_OWNER": "NekoAshenUwU",
        "NEKO_NATIVE_WAKE_GITHUB_CLIENT_ID": client_id,
        "NEKO_NATIVE_WAKE_GITHUB_CLIENT_SECRET": client_secret,
        "NEKO_NATIVE_WAKE_JWT_SIGNING_KEY": secrets.token_urlsafe(48),
    }
    previous_umask = os.umask(0o077)
    try:
        with target.open("x") as stream:
            stream.write("".join(f"{key}={value}\n" for key, value in values.items()))
    finally:
        os.umask(previous_umask)
    print("Saved new OAuth configuration on this VPS. No existing project was changed.")
    print("The new service can now be restarted and its authentication verified.")


if __name__ == "__main__":
    main()
