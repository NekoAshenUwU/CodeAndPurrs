#!/usr/bin/env python3
"""MCP policy tools for native ChatGPT and Claude Cowork scheduled tasks."""

from __future__ import annotations

from functools import lru_cache
import os
from pathlib import Path
from typing import Literal

from fastmcp import FastMCP
from wake_policy import WakePolicy


Client = Literal["chatgpt", "claude"]
mcp = FastMCP(
    "Neko Native Wake",
    instructions=(
        "This MCP coordinates native scheduled tasks; it cannot wake an app, start "
        "a conversation, or deliver a message. A task on the calling platform must "
        "already be running. Call claim_native_wake for your own client once, and "
        "continue only when allowed is true. A missing tool, error or denied claim "
        "is not permission. Write directly in the calling platform using its own "
        "persona and context. Never generate through CodeAndPurrs or send its Web "
        "Push notifications. Client labels separate bookkeeping, not authorization. "
        "This server is for one owner only, behind an authenticated private endpoint."
    ),
)


@lru_cache(maxsize=1)
def policy():
    location = os.environ.get("NEKO_NATIVE_WAKE_DB")
    if not location:
        raise RuntimeError("Set NEKO_NATIVE_WAKE_DB to a durable absolute SQLite path")
    if not Path(location).is_absolute():
        raise RuntimeError("NEKO_NATIVE_WAKE_DB must be absolute")
    return WakePolicy(location)


@mcp.tool(annotations={"readOnlyHint": True})
def get_native_wake_status(client: Client) -> dict:
    """Read this client's schedule gate and counts; this does not verify task delivery."""
    return policy().status(client)


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
def set_native_wake_enabled(client: Client, enabled: bool) -> dict:
    """Enable or pause the requested client's gate on an explicit user request.

    This does not create, resume, or pause the platform's own scheduled task.
    """
    return policy().set_enabled(client, enabled)


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False})
def claim_native_wake(client: Client) -> dict:
    """Reserve one attempt for an already running, user-authorized native task.

    Only an allowed=true response permits composing this attempt. Repeated calls
    are denied. The reservation consumes one daily slot even if generation fails.
    """
    return policy().claim(client)


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True})
def record_native_wake_outcome(
    client: Client, claim_id: str, outcome: Literal["generated", "skipped", "failed"]
) -> dict:
    """Record your own attempt's outcome without storing text or asserting delivery."""
    return policy().record_outcome(client, claim_id, outcome)


if __name__ == "__main__":
    transport = os.environ.get("NEKO_NATIVE_WAKE_TRANSPORT", "stdio")
    if transport == "stdio":
        mcp.run()
    elif transport == "http":
        # Deliberately no default port: select a free port after inspecting the VPS.
        # Loopback only. Internet access requires a separately verified OAuth gateway.
        port = int(os.environ["NEKO_NATIVE_WAKE_PORT"])
        if not 1024 <= port <= 65535:
            raise ValueError("NEKO_NATIVE_WAKE_PORT must be between 1024 and 65535")
        mcp.run(transport="http", host="127.0.0.1", port=port)
    else:
        raise ValueError("NEKO_NATIVE_WAKE_TRANSPORT must be stdio or http")
