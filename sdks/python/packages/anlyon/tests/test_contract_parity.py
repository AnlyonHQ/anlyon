"""Public contract parity for newly exposed resource families."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import httpx
import pytest
import respx

from anlyon import ApiResponse, AsyncClient, Client

BASE_URL = "https://api.anlyon.com"


@respx.mock
def test_workspace_billing_budget_is_read_only() -> None:
    budget = {"maxOverageCents": 2500, "enabled": True, "behaviourAtMax": "alert_only"}
    route = respx.get(f"{BASE_URL}/api/v2/billing/budget").mock(
        return_value=httpx.Response(200, json={"success": True, "data": budget})
    )
    with Client(api_key="anlyon_live_test") as client:
        assert client.billing.workspace_budget().data == budget
    assert route.call_count == 1


@pytest.mark.asyncio
@respx.mock
async def test_async_workspace_billing_budget_is_read_only() -> None:
    budget = {"maxOverageCents": 2500, "enabled": True, "behaviourAtMax": "alert_only"}
    route = respx.get(f"{BASE_URL}/api/v2/billing/budget").mock(
        return_value=httpx.Response(200, json={"success": True, "data": budget})
    )
    async with AsyncClient(api_key="anlyon_live_test") as client:
        assert (await client.billing.workspace_budget()).data == budget
    assert route.call_count == 1


def _success(
    data: object = None, *, content: str | None = None, content_type: str = "application/json"
) -> httpx.Response:
    if content is not None:
        return httpx.Response(200, content=content, headers={"content-type": content_type})
    return httpx.Response(200, json={"success": True, "data": data if data is not None else {}})


def test_sync_client_exposes_all_resource_families_as_singletons() -> None:
    with Client(api_key="anlyon_live_test") as client:
        for name in (
            "dlq",
            "analytics",
            "billing",
            "notifications",
            "integrations",
            "logs",
        ):
            assert getattr(client, name) is getattr(client, name)


@respx.mock
def test_canonical_response_preserves_envelope_metadata_and_legacy_access() -> None:
    respx.get(f"{BASE_URL}/api/v2/dlq").mock(
        return_value=httpx.Response(
            200,
            json={
                "success": True,
                "data": [{"messageId": "msg_1"}],
                "pagination": {
                    "total": 1,
                    "page": 1,
                    "limit": 20,
                    "totalPages": 1,
                    "hasMore": False,
                },
            },
            headers={"x-request-id": "req_1"},
        )
    )
    with Client(api_key="anlyon_live_test") as client:
        result = client.dlq.list()
    assert isinstance(result, ApiResponse)
    assert result.success is True
    assert result.data[0]["messageId"] == "msg_1"
    assert result.pagination["hasMore"] is False
    assert result.request_id == "req_1"
    assert result[0]["messageId"] == "msg_1"


@pytest.mark.asyncio
async def test_async_client_exposes_all_resource_families_as_singletons() -> None:
    async with AsyncClient(api_key="anlyon_live_test") as client:
        for name in (
            "dlq",
            "analytics",
            "billing",
            "notifications",
            "integrations",
            "logs",
        ):
            assert getattr(client, name) is getattr(client, name)


@respx.mock
def test_resource_paths_and_snake_case_request_mapping() -> None:
    approval = respx.post(f"{BASE_URL}/api/v2/approvals").mock(return_value=_success())
    retry = respx.post(f"{BASE_URL}/api/v2/dlq/msg_1/retry").mock(return_value=_success())
    analytics = respx.get(f"{BASE_URL}/api/v2/analytics/time-series").mock(
        return_value=_success([])
    )
    billing = respx.get(f"{BASE_URL}/api/v2/billing/quota").mock(return_value=_success())
    integration = respx.patch(f"{BASE_URL}/api/v2/integrations/int_1/toggle").mock(
        return_value=_success()
    )
    with Client(api_key="anlyon_live_test") as client:
        client.approvals.request(
            title="Ship it?",
            expires_in_seconds=3600,
            run_id="run_trace",
            parent_span_id="span_parent",
        )
        client.dlq.retry("msg_1")
        client.analytics.time_series(
            start_date=datetime(2026, 7, 1, tzinfo=timezone.utc), granularity="week"
        )
        client.billing.quota()
        client.integrations.toggle("int_1", is_active=False)
    assert json.loads(approval.calls.last.request.content) == {
        "title": "Ship it?",
        "expiresInSeconds": 3600,
        "runId": "run_trace",
        "parentSpanId": "span_parent",
    }
    assert retry.called and billing.called
    assert analytics.calls.last.request.url.params["startDate"] == "2026-07-01T00:00:00+00:00"
    assert json.loads(integration.calls.last.request.content) == {"isActive": False}


@respx.mock
def test_cross_product_analytics_paths_and_environment_filter() -> None:
    routes = [
        respx.get(f"{BASE_URL}/api/v2/analytics/overview").mock(return_value=_success()),
        respx.get(f"{BASE_URL}/api/v2/analytics/agents").mock(return_value=_success()),
        respx.get(f"{BASE_URL}/api/v2/analytics/trust-control").mock(return_value=_success()),
        respx.get(f"{BASE_URL}/api/v2/analytics/delivery").mock(return_value=_success()),
    ]
    params = {
        "start_date": datetime(2026, 7, 1, tzinfo=timezone.utc),
        "granularity": "day",
        "environment_id": "123e4567-e89b-42d3-a456-426614174000",
        "limit": 8,
    }
    with Client(api_key="anlyon_live_test") as client:
        client.analytics.overview(**params)
        client.analytics.agent_analytics(**params)
        client.analytics.trust_control_analytics(**params)
        client.analytics.delivery_analytics(**params)

    assert all(route.called for route in routes)
    assert routes[0].calls.last.request.url.params["environmentId"] == params["environment_id"]
    assert routes[0].calls.last.request.url.params["granularity"] == "day"


@respx.mock
def test_nullable_updates_and_required_webhook_body_are_preserved() -> None:
    preferences = respx.patch(f"{BASE_URL}/api/v2/notifications/preferences").mock(
        return_value=_success()
    )
    webhook = respx.post(f"{BASE_URL}/api/v2/notifications/preferences/test-webhook").mock(
        return_value=_success()
    )
    with Client(api_key="anlyon_live_test") as client:
        client.notifications.update_preferences(webhook_url=None, webhook_secret=None)
        client.notifications.test_webhook(
            webhook_url="https://example.com/notify", webhook_secret="secret"
        )
    assert json.loads(preferences.calls.last.request.content) == {
        "webhookUrl": None,
        "webhookSecret": None,
    }
    assert json.loads(webhook.calls.last.request.content) == {
        "webhookUrl": "https://example.com/notify",
        "webhookSecret": "secret",
    }


@respx.mock
def test_own_notification_preferences_are_read_and_replaced() -> None:
    mine = {"mutedTypes": ["quota_warning"], "updatedAt": "2026-10-03T00:00:00.000Z"}
    read = respx.get(f"{BASE_URL}/api/v2/notifications/preferences/me").mock(
        return_value=_success(mine)
    )
    write = respx.patch(f"{BASE_URL}/api/v2/notifications/preferences/me").mock(
        return_value=_success(mine)
    )
    with Client(api_key="anlyon_live_test") as client:
        assert client.notifications.my_preferences().data == mine
        client.notifications.update_my_preferences(muted_types=("quota_warning",))
        assert json.loads(write.calls.last.request.content) == {"mutedTypes": ["quota_warning"]}
        client.notifications.update_my_preferences(muted_types=[])
    assert read.called
    assert json.loads(write.calls.last.request.content) == {"mutedTypes": []}


@pytest.mark.asyncio
@respx.mock
async def test_async_own_notification_preferences_are_read_and_replaced() -> None:
    mine = {"mutedTypes": [], "updatedAt": None}
    read = respx.get(f"{BASE_URL}/api/v2/notifications/preferences/me").mock(
        return_value=_success(mine)
    )
    write = respx.patch(f"{BASE_URL}/api/v2/notifications/preferences/me").mock(
        return_value=_success(mine)
    )
    async with AsyncClient(api_key="anlyon_live_test") as client:
        assert (await client.notifications.my_preferences()).data == mine
        await client.notifications.update_my_preferences(muted_types=["security_alert"])
    assert read.called
    assert json.loads(write.calls.last.request.content) == {"mutedTypes": ["security_alert"]}


@respx.mock
def test_log_export_supports_raw_csv_and_json() -> None:
    csv = respx.get(f"{BASE_URL}/api/v2/logs/export", params={"format": "csv"}).mock(
        return_value=_success(content="id,type\n1,message", content_type="text/csv")
    )
    json_route = respx.get(f"{BASE_URL}/api/v2/logs/export", params={"format": "json"}).mock(
        return_value=httpx.Response(200, json={"logs": []})
    )
    with Client(api_key="anlyon_live_test") as client:
        assert client.logs.export(format="csv").startswith("id,type")
        assert client.logs.export(format="json") == {"logs": []}
    assert csv.called and json_route.called


@respx.mock
def test_per_action_invocations_are_exposed() -> None:
    invocations = respx.get(
        f"{BASE_URL}/api/v2/actions/refund-customer/invocations",
        params={"limit": "10", "offset": "20"},
    ).mock(return_value=_success([]))
    with Client(api_key="anlyon_live_test") as client:
        client.actions.invocations_for("refund-customer", limit=10, offset=20)
    assert invocations.called
