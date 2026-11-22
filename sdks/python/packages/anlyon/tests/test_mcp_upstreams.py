"""Registering an MCP server, and adopting its tools: adopting raises SignOffRequiredError until a person approves."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
import respx

from anlyon import AsyncClient, Client, SignOffRequiredError

BASE_URL = "https://api.anlyon.com"
UPSTREAMS = f"{BASE_URL}/api/v2/mcp-upstreams"


def _upstream(**overrides: Any) -> dict[str, Any]:
    return {
        "id": "mcpu_1",
        "name": "tracker",
        "url": "https://mcp.example.com/mcp",
        "tools": [],
        "adopted": [],
        **overrides,
    }


def _sign_off() -> dict[str, Any]:
    return {
        "object": "sign_off_request",
        "id": "sor_1",
        "status": "pending",
        "operation": "mcp_upstream.adopt",
        "environmentId": "env-1",
        "resource": {"type": "mcp_upstream", "id": "mcpu_1", "name": "tracker"},
        "summary": 'Adopt 1 tool from MCP server "tracker" (suggested: destructive)',
        "changes": [],
        "diff": "",
        "signOffUrl": "https://console.anlyon.com/sign-offs/sor_1",
        "pollUrl": "/api/v2/sign-offs/sor_1",
        "pollAfterSeconds": 5,
        "requestedBy": {"type": "api_key", "id": "key_1", "onBehalfOf": None},
        "createdAt": "2026-11-02T00:00:00.000Z",
        "expiresAt": "2026-11-03T00:00:00.000Z",
        "decidedAt": None,
        "decidedBy": None,
        "decisionNote": None,
        "result": None,
        "error": None,
    }


@respx.mock
def test_register_sends_only_what_was_given() -> None:
    route = respx.post(UPSTREAMS).mock(
        return_value=httpx.Response(201, json={"success": True, "data": _upstream()})
    )
    client = Client(api_key="test")
    client.mcp_upstreams.register(
        "tracker",
        "https://mcp.example.com/mcp",
        headers={"Authorization": "Bearer {{secret:TRACKER}}"},
    )
    assert json.loads(route.calls.last.request.content) == {
        "name": "tracker",
        "url": "https://mcp.example.com/mcp",
        "headers": {"Authorization": "Bearer {{secret:TRACKER}}"},
    }


@respx.mock
def test_reads_inspect_refresh_archive_and_connect_link() -> None:
    ok = httpx.Response(200, json={"success": True, "data": _upstream()})
    listed = respx.get(UPSTREAMS).mock(
        return_value=httpx.Response(200, json={"success": True, "data": [_upstream()]})
    )
    one = respx.get(f"{UPSTREAMS}/mcpu_1").mock(return_value=ok)
    inspected = respx.post(f"{UPSTREAMS}/inspect").mock(
        return_value=httpx.Response(
            200, json={"success": True, "data": {"kind": "open", "host": "mcp.example.com"}}
        )
    )
    refreshed = respx.post(f"{UPSTREAMS}/mcpu_1/refresh").mock(return_value=ok)
    archived = respx.post(f"{UPSTREAMS}/mcpu_1/archive").mock(return_value=ok)
    linked = respx.post(f"{UPSTREAMS}/mcpu_1/connect-links").mock(
        return_value=httpx.Response(
            201, json={"success": True, "data": {"url": "https://x", "expiresAt": "t"}}
        )
    )

    client = Client(api_key="test")
    client.mcp_upstreams.list()
    client.mcp_upstreams.get("mcpu_1")
    client.mcp_upstreams.inspect("https://mcp.example.com/mcp")
    client.mcp_upstreams.refresh("mcpu_1")
    client.mcp_upstreams.archive("mcpu_1")
    client.mcp_upstreams.create_connect_link("mcpu_1", "user-1")

    assert all(route.called for route in (listed, one, inspected, refreshed, archived, linked))
    assert json.loads(inspected.calls.last.request.content) == {
        "url": "https://mcp.example.com/mcp"
    }
    assert json.loads(linked.calls.last.request.content) == {"endUserId": "user-1"}


@respx.mock
def test_adopt_raises_with_the_link_a_person_approves_at() -> None:
    route = respx.post(f"{UPSTREAMS}/mcpu_1/adopt").mock(
        return_value=httpx.Response(
            202, json={"success": True, "signOffRequired": True, "data": _sign_off()}
        )
    )
    client = Client(api_key="test")
    with pytest.raises(SignOffRequiredError) as raised:
        client.mcp_upstreams.adopt("mcpu_1", {"delete_issue": {"requiresApproval": True}})
    assert raised.value.sign_off_url == "https://console.anlyon.com/sign-offs/sor_1"
    assert json.loads(route.calls.last.request.content) == {
        "tools": {"delete_issue": {"requiresApproval": True}}
    }


@respx.mock
@pytest.mark.asyncio
async def test_async_client_has_the_same_operations() -> None:
    ok = httpx.Response(200, json={"success": True, "data": _upstream()})
    listed = respx.get(UPSTREAMS).mock(
        return_value=httpx.Response(200, json={"success": True, "data": []})
    )
    one = respx.get(f"{UPSTREAMS}/mcpu_1").mock(return_value=ok)
    inspected = respx.post(f"{UPSTREAMS}/inspect").mock(
        return_value=httpx.Response(
            200, json={"success": True, "data": {"kind": "open", "host": "h"}}
        )
    )
    registered = respx.post(UPSTREAMS).mock(
        return_value=httpx.Response(201, json={"success": True, "data": _upstream()})
    )
    refreshed = respx.post(f"{UPSTREAMS}/mcpu_1/refresh").mock(return_value=ok)
    archived = respx.post(f"{UPSTREAMS}/mcpu_1/archive").mock(return_value=ok)
    linked = respx.post(f"{UPSTREAMS}/mcpu_1/connect-links").mock(
        return_value=httpx.Response(
            201, json={"success": True, "data": {"url": "https://x", "expiresAt": "t"}}
        )
    )
    respx.post(f"{UPSTREAMS}/mcpu_1/adopt").mock(
        return_value=httpx.Response(
            202, json={"success": True, "signOffRequired": True, "data": _sign_off()}
        )
    )

    async with AsyncClient(api_key="test") as client:
        await client.mcp_upstreams.list()
        await client.mcp_upstreams.get("mcpu_1")
        await client.mcp_upstreams.inspect("https://mcp.example.com/mcp")
        await client.mcp_upstreams.register("tracker", "https://mcp.example.com/mcp")
        await client.mcp_upstreams.refresh("mcpu_1")
        await client.mcp_upstreams.archive("mcpu_1")
        await client.mcp_upstreams.create_connect_link(
            "mcpu_1", "user-1", redirect_url="https://app.example.com/done"
        )
        with pytest.raises(SignOffRequiredError):
            await client.mcp_upstreams.adopt("mcpu_1", {"delete_issue": {}})

    assert all(
        route.called for route in (listed, one, inspected, registered, refreshed, archived, linked)
    )
    assert json.loads(linked.calls.last.request.content) == {
        "endUserId": "user-1",
        "redirectUrl": "https://app.example.com/done",
    }
