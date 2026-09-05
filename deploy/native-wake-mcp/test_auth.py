"""Auth checks use fake credentials and local ASGI; no GitHub sign-in occurs."""
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastmcp import FastMCP
from fastmcp.server.auth.providers.github import GitHubTokenVerifier
from mcp.shared.auth import OAuthClientInformationFull
from auth import build_auth, OwnerGitHubVerifier


class AuthTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = {
            "NEKO_NATIVE_WAKE_AUTH_MODE": "github",
            "NEKO_NATIVE_WAKE_PUBLIC_URL": "https://wake.example.test",
            "NEKO_NATIVE_WAKE_GITHUB_OWNER": "test-owner",
            "NEKO_NATIVE_WAKE_GITHUB_CLIENT_ID": "fake-client-id",
            "NEKO_NATIVE_WAKE_GITHUB_CLIENT_SECRET": "fake-client-secret",
            "NEKO_NATIVE_WAKE_JWT_SIGNING_KEY": "test-only-key-" * 5,
            "NEKO_NATIVE_WAKE_AUTH_STORE": str(Path(self.tmp.name) / "oauth"),
        }
        self.patch = patch.dict(os.environ, self.env, clear=True)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    async def test_owner_only_after_upstream_verification(self):
        verifier = OwnerGitHubVerifier("test-owner")
        owner = SimpleNamespace(claims={"login": "Test-Owner"})
        other = SimpleNamespace(claims={"login": "another-user"})
        with patch.object(GitHubTokenVerifier, "verify_token", new_callable=AsyncMock) as verify:
            for upstream, expected in [(owner, owner), (other, None), (None, None)]:
                verify.return_value = upstream
                self.assertIs(await verifier.verify_token("fake-token"), expected)
            self.assertEqual(verify.await_count, 3)

    async def test_configuration_fails_closed(self):
        for key, value in [
            ("NEKO_NATIVE_WAKE_AUTH_MODE", "typo"),
            ("NEKO_NATIVE_WAKE_PUBLIC_URL", "http://wake.example.test"),
            ("NEKO_NATIVE_WAKE_PUBLIC_URL", "https://wake.example.test/prefix"),
            ("NEKO_NATIVE_WAKE_GITHUB_OWNER", ""),
            ("NEKO_NATIVE_WAKE_GITHUB_CLIENT_SECRET", ""),
            ("NEKO_NATIVE_WAKE_JWT_SIGNING_KEY", "short"),
            ("NEKO_NATIVE_WAKE_AUTH_STORE", "relative"),
        ]:
            with self.subTest(key=key), patch.dict(os.environ, {key: value}):
                with self.assertRaises(ValueError):
                    build_auth()
        with patch.dict(os.environ, {"NEKO_NATIVE_WAKE_AUTH_MODE": "private"}):
            self.assertIsNone(build_auth())

    async def test_http_rejects_missing_and_invalid_tokens(self):
        app = FastMCP("Auth test", auth=build_auth()).http_app()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://wake.example.test") as client:
            for headers in [{}, {"Authorization": "Bearer invalid-test-token"}]:
                result = await client.post("/mcp", headers=headers, json={})
                self.assertEqual(result.status_code, 401)
            metadata = await client.get("/.well-known/oauth-authorization-server")
            self.assertEqual(metadata.status_code, 200)
            self.assertEqual(metadata.json()["authorization_endpoint"], "https://wake.example.test/authorize")

    async def test_registration_survives_new_provider_instance(self):
        first = build_auth()
        registration = OAuthClientInformationFull(
            client_id="fake-downstream-client",
            client_secret="fake-downstream-secret",
            redirect_uris=["http://127.0.0.1:7777/callback"],
            token_endpoint_auth_method="client_secret_post",
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
        )
        await first.register_client(registration)
        second = build_auth()
        loaded = await second.get_client(registration.client_id)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.client_id, registration.client_id)
        for p in Path(self.env["NEKO_NATIVE_WAKE_AUTH_STORE"]).rglob("*"):
            if p.is_file():
                self.assertNotIn(b"fake-downstream-secret", p.read_bytes())


if __name__ == "__main__":
    unittest.main()
