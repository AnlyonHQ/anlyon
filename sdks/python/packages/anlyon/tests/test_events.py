"""
Events resource tests  unwrapped-envelope contract.
Uses respx to mock HTTP responses.
"""

import json

import httpx
import pytest
import respx

from anlyon import AsyncClient, Client

BASE_URL = "https://api.anlyon.com"


@respx.mock
def test_publish_returns_unwrapped_data():
    route = respx.post(f"{BASE_URL}/api/v2/events").mock(
        return_value=httpx.Response(
            202,
            json={"success": True, "data": {"id": "evt_1", "status": "published"}},
        )
    )
    with Client(api_key="anlyon_live_test") as client:
        result = client.events.publish(
            topic="orders",
            type="order.created",
            data={"orderId": "o1"},
            idempotency_key="evt-key-1",
            run_id="run_trace",
            parent_span_id="span_parent",
        )
    assert result == {"id": "evt_1", "status": "published"}
    request = route.calls.last.request
    assert request.headers["Idempotency-Key"] == "evt-key-1"
    body = json.loads(request.content)
    assert body["topic"] == "orders"
    assert body["type"] == "order.created"
    assert body["data"] == {"orderId": "o1"}
    assert body["idempotencyKey"] == "evt-key-1"
    assert body["runId"] == "run_trace"
    assert body["parentSpanId"] == "span_parent"


@respx.mock
def test_list_and_get():
    respx.get(f"{BASE_URL}/api/v2/events").mock(
        return_value=httpx.Response(
            200,
            json={
                "success": True,
                "data": [{"id": "evt_1", "type": "order.created"}],
                "pagination": {
                    "total": 1,
                    "page": 1,
                    "limit": 20,
                    "totalPages": 1,
                    "hasMore": False,
                },
            },
        )
    )
    respx.get(f"{BASE_URL}/api/v2/events/evt_1").mock(
        return_value=httpx.Response(
            200,
            json={
                "success": True,
                "data": {
                    "id": "evt_1",
                    "type": "order.created",
                    "deliveries": [{"subscriptionId": "sub_1", "status": "delivered"}],
                },
            },
        )
    )
    with Client(api_key="anlyon_live_test") as client:
        listed = client.events.list(topic="orders", type="order.created", limit=10, offset=0)
        assert listed[0]["id"] == "evt_1"
        got = client.events.get("evt_1")
        assert got["deliveries"][0]["status"] == "delivered"


@respx.mock
def test_topics_crud():
    respx.post(f"{BASE_URL}/api/v2/events/topics").mock(
        return_value=httpx.Response(
            201,
            json={"success": True, "data": {"id": "top_1", "name": "orders"}},
        )
    )
    respx.get(f"{BASE_URL}/api/v2/events/topics").mock(
        return_value=httpx.Response(
            200,
            json={"success": True, "data": [{"id": "top_1", "name": "orders"}]},
        )
    )
    respx.get(f"{BASE_URL}/api/v2/events/topics/orders").mock(
        return_value=httpx.Response(
            200,
            json={"success": True, "data": {"id": "top_1", "name": "orders"}},
        )
    )
    route = respx.patch(f"{BASE_URL}/api/v2/events/topics/top_1").mock(
        return_value=httpx.Response(
            200,
            json={"success": True, "data": {"id": "top_1", "name": "orders-v2"}},
        )
    )
    respx.delete(f"{BASE_URL}/api/v2/events/topics/top_1").mock(
        return_value=httpx.Response(200, json={"success": True, "data": {"deleted": True}})
    )
    with Client(api_key="anlyon_live_test") as client:
        created = client.events.create_topic(name="orders", description="Order events")
        assert created["id"] == "top_1"
        listed = client.events.list_topics()
        assert listed[0]["name"] == "orders"
        got = client.events.get_topic("orders")
        assert got["id"] == "top_1"
        updated = client.events.update_topic("top_1", name="orders-v2")
        assert updated["name"] == "orders-v2"
        assert json.loads(route.calls.last.request.content) == {"name": "orders-v2"}
        deleted = client.events.delete_topic("top_1")
        assert deleted["deleted"] is True


@respx.mock
def test_subscriptions():
    create_route = respx.post(f"{BASE_URL}/api/v2/events/topics/orders/subscriptions").mock(
        return_value=httpx.Response(
            201,
            json={
                "success": True,
                "data": {
                    "id": "sub_1",
                    "url": "https://example.com/hook",
                    "secret": "whsec_once",
                },
            },
        )
    )
    respx.get(f"{BASE_URL}/api/v2/events/topics/orders/subscriptions").mock(
        return_value=httpx.Response(
            200,
            json={"success": True, "data": [{"id": "sub_1", "url": "https://example.com/hook"}]},
        )
    )
    respx.patch(f"{BASE_URL}/api/v2/events/subscriptions/sub_1").mock(
        return_value=httpx.Response(
            200,
            json={"success": True, "data": {"id": "sub_1", "enabled": False}},
        )
    )
    respx.post(f"{BASE_URL}/api/v2/events/subscriptions/sub_1/rotate-secret").mock(
        return_value=httpx.Response(
            200,
            json={"success": True, "data": {"id": "sub_1", "secret": "whsec_rotated"}},
        )
    )
    respx.delete(f"{BASE_URL}/api/v2/events/subscriptions/sub_1").mock(
        return_value=httpx.Response(200, json={"success": True, "data": {"deleted": True}})
    )
    with Client(api_key="anlyon_live_test") as client:
        created = client.events.create_subscription(
            "orders",
            url="https://example.com/hook",
            event_types=["order.*"],
            generate_secret=True,
        )
        assert created["secret"] == "whsec_once"
        body = json.loads(create_route.calls.last.request.content)
        assert body["eventTypes"] == ["order.*"]
        assert body["generateSecret"] is True
        listed = client.events.list_subscriptions("orders")
        assert listed[0]["id"] == "sub_1"
        updated = client.events.update_subscription("sub_1", enabled=False)
        assert updated["enabled"] is False
        rotated = client.events.rotate_subscription_secret("sub_1")
        assert rotated["secret"] == "whsec_rotated"
        deleted = client.events.delete_subscription("sub_1")
        assert deleted["deleted"] is True


@respx.mock
@pytest.mark.asyncio
async def test_async_publish():
    respx.post(f"{BASE_URL}/api/v2/events").mock(
        return_value=httpx.Response(
            202,
            json={"success": True, "data": {"id": "evt_async", "status": "published"}},
        )
    )
    async with AsyncClient(api_key="anlyon_live_test") as client:
        result = await client.events.publish(topic="orders", type="order.created")
        assert result["id"] == "evt_async"


@respx.mock
@pytest.mark.asyncio
async def test_async_topics_and_subscriptions():
    respx.get(f"{BASE_URL}/api/v2/events/topics").mock(
        return_value=httpx.Response(200, json={"success": True, "data": [{"id": "top_1"}]})
    )
    respx.get(f"{BASE_URL}/api/v2/events/topics/orders/subscriptions").mock(
        return_value=httpx.Response(200, json={"success": True, "data": [{"id": "sub_1"}]})
    )
    async with AsyncClient(api_key="anlyon_live_test") as client:
        topics = await client.events.list_topics()
        assert topics[0]["id"] == "top_1"
        subs = await client.events.list_subscriptions("orders")
        assert subs[0]["id"] == "sub_1"
