"""client.audit: audit records, the evidence export and the JSON Schema."""

from __future__ import annotations

from datetime import date, datetime, timezone

import httpx
import pytest
import respx

from anlyon import AsyncClient, Client
from anlyon.errors import NotFoundError

BASE_URL = "https://api.anlyon.com"

EVENT = {
    "schema": "anlyon.audit.v1",
    "id": "aud_1",
    "sequence": 7,
    "type": "approval.vote",
    "category": "approval",
    "occurredAt": "2026-10-19T10:00:00.000Z",
    "workspaceId": "ws",
    "environmentId": "env",
    "actor": {"type": "user", "id": "u"},
    "resource": {"type": "approval", "id": "apr_1"},
    "outcome": "approve",
    "data": {},
    "context": None,
}


@respx.mock
def test_list_events_sends_filters_and_returns_the_page() -> None:
    route = respx.get(f"{BASE_URL}/api/v2/audit/events").mock(
        return_value=httpx.Response(
            200, json={"success": True, "data": [EVENT], "pagination": {"nextBefore": 7}}
        )
    )
    with Client(api_key="anlyon_live_xxx") as client:
        page = client.audit.list_events(
            start=datetime(2026, 10, 1, tzinfo=timezone.utc),
            type=["approval.*", "policy.updated"],
            action="refund_order",
            limit=50,
            before=99,
        )
    assert page.data[0]["id"] == "aud_1"
    assert page.pagination == {"nextBefore": 7}
    params = dict(route.calls.last.request.url.params)
    assert params == {
        "from": "2026-10-01T00:00:00+00:00",
        "type": "approval.*,policy.updated",
        "action": "refund_order",
        "limit": "50",
        "before": "99",
    }


@respx.mock
def test_export_returns_csv_text_or_the_json_document() -> None:
    csv = respx.get(f"{BASE_URL}/api/v2/audit/export", params={"format": "csv"}).mock(
        return_value=httpx.Response(
            200, content="id,sequence\r\naud_1,7\r\n", headers={"content-type": "text/csv"}
        )
    )
    document = respx.get(f"{BASE_URL}/api/v2/audit/export", params={"format": "json"}).mock(
        return_value=httpx.Response(
            200, json={"schema": "anlyon.audit.export.v1", "events": [EVENT], "count": 1}
        )
    )
    with Client(api_key="anlyon_live_xxx") as client:
        assert "aud_1,7" in client.audit.export(
            start=date(2026, 10, 1), end="2026-11-01", format="csv"
        )
        assert client.audit.export(start="2026-10-01", end="2026-11-01")["count"] == 1
    assert csv.calls.last.request.url.params["from"] == "2026-10-01T00:00:00+00:00"
    assert document.calls.last.request.url.params["to"] == "2026-11-01T00:00:00+00:00"


@respx.mock
def test_schema_and_not_found_outside_enterprise() -> None:
    respx.get(f"{BASE_URL}/api/v2/audit/schema").mock(
        return_value=httpx.Response(
            200,
            json={
                "success": True,
                "data": {"schema": "anlyon.audit.v1", "jsonSchema": {}, "eventTypes": {}},
            },
        )
    )
    respx.get(f"{BASE_URL}/api/v2/audit/events").mock(
        return_value=httpx.Response(
            404,
            json={
                "success": False,
                "error": {"code": "NOT_FOUND", "message": "Endpoint not found"},
            },
        )
    )
    with Client(api_key="anlyon_live_xxx") as client:
        assert client.audit.schema().data["schema"] == "anlyon.audit.v1"
        with pytest.raises(NotFoundError):
            client.audit.list_events()


@pytest.mark.asyncio
@respx.mock
async def test_async_list_events() -> None:
    respx.get(f"{BASE_URL}/api/v2/audit/events").mock(
        return_value=httpx.Response(
            200, json={"success": True, "data": [EVENT], "pagination": {"nextBefore": None}}
        )
    )
    async with AsyncClient(api_key="anlyon_live_xxx") as client:
        page = await client.audit.list_events(category="approval")
        assert page.data[0]["type"] == "approval.vote"
        assert client.audit is client.audit
