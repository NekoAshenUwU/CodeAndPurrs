"""Optional, owner-only GitHub OAuth for this independent MCP service."""
from __future__ import annotations

import os
from pathlib import Path
import re
from urllib.parse import urlsplit

from fastmcp.server.auth.oauth_proxy import OAuthProxy
from fastmcp.server.auth.providers.github import GitHubTokenVerifier
from key_value.aio.stores.disk import DiskStore
from key_value.aio.wrappers.encryption import FernetEncryptionWrapper


class OwnerGitHubVerifier(GitHubTokenVerifier):
    def __init__(self, owner: str):
        super().__init__(required_scopes=["read:user"])
        self.owner = owner.lower()

    async def verify_token(self, token: str):
        result = await super().verify_token(token)
        if result is None:
            return None
        login = (result.claims or {}).get("login", "")
        if not isinstance(login, str) or login.lower() != self.owner:
            return None
        return result


def build_auth():
    mode = os.environ.get("NEKO_NATIVE_WAKE_AUTH_MODE", "private")
    if mode == "private":
        return None
    if mode != "github":
        raise ValueError("NEKO_NATIVE_WAKE_AUTH_MODE must be private or github")
    base = os.environ["NEKO_NATIVE_WAKE_PUBLIC_URL"].rstrip("/")
    url = urlsplit(base)
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.path or url.query or url.fragment or url.port not in (None, 443)):
        raise ValueError("Public URL must be an HTTPS origin without a path")
    owner = os.environ["NEKO_NATIVE_WAKE_GITHUB_OWNER"].strip()
    if not re.fullmatch(r"[A-Za-z0-9-]{1,39}", owner):
        raise ValueError("Exactly one GitHub owner login is required")
    client_id = os.environ["NEKO_NATIVE_WAKE_GITHUB_CLIENT_ID"].strip()
    client_secret = os.environ["NEKO_NATIVE_WAKE_GITHUB_CLIENT_SECRET"].strip()
    signing_key = os.environ["NEKO_NATIVE_WAKE_JWT_SIGNING_KEY"]
    if not client_id or not client_secret or len(signing_key) < 32:
        raise ValueError("GitHub credentials and a persistent signing key are required")
    directory = Path(os.environ["NEKO_NATIVE_WAKE_AUTH_STORE"])
    if not directory.is_absolute():
        raise ValueError("OAuth storage must be an absolute persistent path")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    storage = FernetEncryptionWrapper(
        DiskStore(directory=directory),
        source_material=signing_key,
        salt="neko-native-wake-oauth-v1",
    )
    return OAuthProxy(
        upstream_authorization_endpoint="https://github.com/login/oauth/authorize",
        upstream_token_endpoint="https://github.com/login/oauth/access_token",
        upstream_client_id=client_id,
        upstream_client_secret=client_secret,
        token_verifier=OwnerGitHubVerifier(owner),
        base_url=base,
        redirect_path="/auth/callback",
        client_storage=storage,
        jwt_signing_key=signing_key,
        require_authorization_consent=True,
    )
