"""Connected accounts: request shapes for the connect flow."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
import respx

from anlyon import AnlyonError, AsyncClient, Client

BASE_URL = "https://api.anlyon.com"
CONNECTIONS = f"{BASE_URL}/api/v2/connections"


def _ok(data: Any) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": data})


@respx.mock
def test_sync_connect_flow() -> None:
    integrations = respx.get(f"{CONNECTIONS}/integrations").mock(return_value=_ok([{"id": "hubspot"}]))
    listed = respx.get(CONNECTIONS).mock(return_value=_ok([]))
    session = respx.post(f"{CONNECTIONS}/sessions").mock(return_value=_ok({"sessionId": "csn_abcdef123456"}))
    complete = respx.post(f"{CONNECTIONS}/sessions/csn_abcdef123456/complete").mock(
        return_value=_ok({"status": "pending", "secret": None})
    )
    client = Client(api_key="test-key", base_url=BASE_URL)

    assert client.connections.integrations().data == [{"id": "hubspot"}]
    client.connections.list()
    client.connections.create_session(integration_id="hubspot", secret_name="HUBSPOT", description="CRM")
    client.connections.complete("csn_abcdef123456")
    client.connections.complete("csn_abcdef123456", reference="conn-1")

    assert integrations.called and listed.called

    found = respx.get(f"{CONNECTIONS}/integrations/find").mock(return_value=_ok({"route": {"kind": "openapi"}}))
    assert client.connections.find_route("Acme & co").data == {"route": {"kind": "openapi"}}
    assert found.calls[0].request.url.params["name"] == "Acme & co"
    assert json.loads(session.calls[0].request.content) == {
        "integrationId": "hubspot",
        "secretName": "HUBSPOT",
        "description": "CRM",
    }
    assert json.loads(complete.calls[0].request.content) == {}
    assert json.loads(complete.calls[1].request.content) == {"reference": "conn-1"}
    assert client.connections is client.connections


@pytest.mark.asyncio
@respx.mock
async def test_async_connect_flow() -> None:
    session = respx.post(f"{CONNECTIONS}/sessions").mock(return_value=_ok({"sessionId": "csn_abcdef123456"}))
    complete = respx.post(f"{CONNECTIONS}/sessions/csn_abcdef123456/complete").mock(
        return_value=_ok({"status": "completed", "secret": {"name": "HUBSPOT"}})
    )
    async with AsyncClient(api_key="test-key", base_url=BASE_URL) as client:
        await client.connections.create_session(integration_id="hubspot", secret_name="HUBSPOT")
        result = await client.connections.complete("csn_abcdef123456", reference="conn-1")
    assert result.data == {"status": "completed", "secret": {"name": "HUBSPOT"}}
    assert json.loads(session.calls[0].request.content) == {"integrationId": "hubspot", "secretName": "HUBSPOT"}
    assert json.loads(complete.calls[0].request.content) == {"reference": "conn-1"}


@respx.mock
def test_sync_connect_with_api_key() -> None:
    secret = {"name": "GITHUB", "kind": "static", "integrationId": "github"}
    route = respx.post(f"{CONNECTIONS}/keys").mock(return_value=_ok(secret))
    client = Client(api_key="test-key", base_url=BASE_URL)

    result = client.connections.connect_with_api_key(
        integration_id="github", secret_name="GITHUB", api_key="fixture-token-not-a-key"
    )

    assert result.data == secret
    assert json.loads(route.calls[0].request.content) == {
        "integrationId": "github",
        "secretName": "GITHUB",
        "apiKey": "fixture-token-not-a-key",
    }


@pytest.mark.asyncio
@respx.mock
async def test_async_connect_with_api_key() -> None:
    route = respx.post(f"{CONNECTIONS}/keys").mock(return_value=_ok({"name": "NOTION"}))
    async with AsyncClient(api_key="test-key", base_url=BASE_URL) as client:
        await client.connections.connect_with_api_key(
            integration_id="notion",
            secret_name="NOTION",
            api_key="fixture-token-not-a-key",
            description="Docs",
        )
    assert json.loads(route.calls[0].request.content) == {
        "integrationId": "notion",
        "secretName": "NOTION",
        "apiKey": "fixture-token-not-a-key",
        "description": "Docs",
    }


@respx.mock
def test_check_and_reconnect() -> None:
    checked = {"name": "GITHUB", "health": {"status": "needs_reauth", "checkedAt": "2026-10-15T00:00:00Z", "reason": "key_rejected"}}
    check = respx.post(f"{CONNECTIONS}/GITHUB/check").mock(return_value=_ok(checked))
    renew = respx.post(f"{CONNECTIONS}/GITHUB/reconnect").mock(
        return_value=_ok({"status": "completed", "secret": {"name": "GITHUB"}, "session": None})
    )
    signin = respx.post(f"{CONNECTIONS}/HUBSPOT/reconnect").mock(
        return_value=_ok({"status": "pending", "secret": None, "session": {"sessionId": "csn_abcdef123456"}})
    )
    client = Client(api_key="test-key", base_url=BASE_URL)

    assert client.connections.check("GITHUB").data == checked
    assert client.connections.reconnect("GITHUB", api_key="fixture-renewed-not-a-key").data["status"] == "completed"
    assert client.connections.reconnect("HUBSPOT").data["status"] == "pending"

    assert check.called
    assert json.loads(check.calls[0].request.content) == {}
    assert json.loads(renew.calls[0].request.content) == {"apiKey": "fixture-renewed-not-a-key"}
    assert json.loads(signin.calls[0].request.content) == {}


@pytest.mark.asyncio
@respx.mock
async def test_async_check_and_reconnect() -> None:
    check = respx.post(f"{CONNECTIONS}/GITHUB/check").mock(return_value=_ok({"name": "GITHUB"}))
    renew = respx.post(f"{CONNECTIONS}/GITHUB/reconnect").mock(
        return_value=_ok({"status": "completed", "secret": {"name": "GITHUB"}, "session": None})
    )
    async with AsyncClient(api_key="test-key", base_url=BASE_URL) as client:
        await client.connections.check("GITHUB")
        result = await client.connections.reconnect("GITHUB", api_key="fixture-renewed-not-a-key")
    assert result.data["status"] == "completed"
    assert check.called
    assert json.loads(renew.calls[0].request.content) == {"apiKey": "fixture-renewed-not-a-key"}


JIRA_FIELDS = {"site": "acme", "email": "ana@acme.test", "apiToken": "fixture-token-not-a-key"}


@respx.mock
def test_connect_and_reconnect_with_fields() -> None:
    route = respx.post(f"{CONNECTIONS}/keys").mock(return_value=_ok({"name": "JIRA"}))
    renew = respx.post(f"{CONNECTIONS}/JIRA/reconnect").mock(
        return_value=_ok({"status": "completed", "secret": {"name": "JIRA"}, "session": None})
    )
    client = Client(api_key="test-key", base_url=BASE_URL)
    client.connections.connect_with_api_key(integration_id="jira", secret_name="JIRA", fields=JIRA_FIELDS)
    client.connections.reconnect("JIRA", fields=JIRA_FIELDS)
    assert json.loads(route.calls[0].request.content) == {
        "integrationId": "jira",
        "secretName": "JIRA",
        "fields": JIRA_FIELDS,
    }
    assert json.loads(renew.calls[0].request.content) == {"fields": JIRA_FIELDS}


@pytest.mark.asyncio
@respx.mock
async def test_async_connect_and_reconnect_with_fields() -> None:
    route = respx.post(f"{CONNECTIONS}/keys").mock(return_value=_ok({"name": "JIRA"}))
    renew = respx.post(f"{CONNECTIONS}/JIRA/reconnect").mock(
        return_value=_ok({"status": "completed", "secret": {"name": "JIRA"}, "session": None})
    )
    async with AsyncClient(api_key="test-key", base_url=BASE_URL) as client:
        await client.connections.connect_with_api_key(
            integration_id="jira", secret_name="JIRA", fields=JIRA_FIELDS, description="Support"
        )
        await client.connections.reconnect("JIRA", fields=JIRA_FIELDS)
    assert json.loads(route.calls[0].request.content) == {
        "integrationId": "jira",
        "secretName": "JIRA",
        "fields": JIRA_FIELDS,
        "description": "Support",
    }
    assert json.loads(renew.calls[0].request.content) == {"fields": JIRA_FIELDS}


@respx.mock
def test_a_key_is_api_key_or_fields_never_both_and_never_neither() -> None:
    route = respx.post(f"{CONNECTIONS}/keys").mock(return_value=_ok({}))
    client = Client(api_key="test-key", base_url=BASE_URL)
    with pytest.raises(AnlyonError, match="not both"):
        client.connections.connect_with_api_key(
            integration_id="jira", secret_name="JIRA", api_key="fixture", fields=JIRA_FIELDS
        )
    with pytest.raises(AnlyonError, match="required"):
        client.connections.connect_with_api_key(integration_id="jira", secret_name="JIRA")
    with pytest.raises(AnlyonError, match="fields is required"):
        client.connections.connect_with_api_key(integration_id="jira", secret_name="JIRA", fields={})
    with pytest.raises(AnlyonError, match="not both"):
        client.connections.reconnect("JIRA", api_key="fixture", fields=JIRA_FIELDS)
    assert not route.called
