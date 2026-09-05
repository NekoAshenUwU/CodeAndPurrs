"""Run after installing requirements.txt; uses only a temporary local database."""
import asyncio
import os
from pathlib import Path
import tempfile

from fastmcp import Client


async def verify():
    with tempfile.TemporaryDirectory() as directory:
        os.environ["NEKO_NATIVE_WAKE_DB"] = str(Path(directory) / "test.sqlite3")
        from server import mcp, policy
        policy.cache_clear()
        async with Client(mcp) as client:
            registered = {tool.name: tool for tool in await client.list_tools()}
            expected = {
                "get_native_wake_status", "set_native_wake_enabled",
                "claim_native_wake", "record_native_wake_outcome",
            }
            assert set(registered) == expected
            assert registered["get_native_wake_status"].annotations.readOnlyHint is True
            for platform in ("chatgpt", "claude"):
                result = await client.call_tool("get_native_wake_status", {"client": platform})
                assert result.data["enabled"] is False
                assert result.data["client"] == platform
                denied = await client.call_tool("claim_native_wake", {"client": platform})
                assert denied.data["allowed"] is False
            await client.call_tool("set_native_wake_enabled", {"client": "chatgpt", "enabled": True})
            enabled = await client.call_tool("get_native_wake_status", {"client": "chatgpt"})
            assert enabled.data["enabled"] is True
            other = await client.call_tool("get_native_wake_status", {"client": "claude"})
            assert other.data["enabled"] is False
            await client.call_tool("set_native_wake_enabled", {"client": "chatgpt", "enabled": False})
        policy.cache_clear()
    print("MCP registration and local tool calls passed; no live messages sent.")


if __name__ == "__main__":
    asyncio.run(verify())
