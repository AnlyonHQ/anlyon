"""
The API accepts `Idempotency-Key` on every mutation it marks
`x-anlyon-idempotency: supported`. These tests assert the header actually
reaches the wire  the SDK support manifest only records the claim.
"""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from anlyon import AsyncClient, Client

BASE_URL = "https://api.anlyon.com"
KEY = "idem-key-1"


def _ok() -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": {}})


@respx.mock
def test_post_mutations_send_the_idempotency_header() -> None:
    route = respx.route(method__in=["POST"]).mock(side_effect=lambda request: _ok())

    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        client.approvals.request(title="ship it", idempotency_key=KEY)
        client.approvals.approve("apr_1", idempotency_key=KEY)
        client.events.publish(topic="t", type="e", data={}, idempotency_key=KEY)
        client.events.create_topic(name="orders", idempotency_key=KEY)
        client.events.create_subscription("orders", url="https://x", idempotency_key=KEY)
        client.actions.create(name="a", url_template="https://x", idempotency_key=KEY)
        client.runs.start(idempotency_key=KEY)
        client.runs.ingest_spans("run_1", [], idempotency_key=KEY)

    assert route.call_count == 8
    for call in route.calls:
        assert call.request.headers.get("idempotency-key") == KEY


@respx.mock
def test_patch_and_delete_mutations_send_the_idempotency_header() -> None:
    """These regressed silently: the base resource used to drop headers on PATCH/DELETE."""
    patched = respx.route(method__in=["PATCH"]).mock(side_effect=lambda request: _ok())
    deleted = respx.route(method__in=["DELETE"]).mock(side_effect=lambda request: _ok())

    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        client.events.update_topic("orders", description="d", idempotency_key=KEY)
        client.events.update_subscription("sub_1", enabled=False, idempotency_key=KEY)
        client.actions.update("act_1", description="d", idempotency_key=KEY)
        client.runs.end("run_1", status="succeeded", idempotency_key=KEY)

        client.events.delete_topic("orders", idempotency_key=KEY)
        client.events.delete_subscription("sub_1", idempotency_key=KEY)
        client.actions.delete("act_1", idempotency_key=KEY)

    assert patched.call_count == 4
    assert deleted.call_count == 3
    for call in list(patched.calls) + list(deleted.calls):
        assert call.request.headers.get("idempotency-key") == KEY


@respx.mock
def test_header_is_absent_when_no_key_is_supplied() -> None:
    route = respx.route().mock(side_effect=lambda request: _ok())

    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        client.runs.start()
        client.events.delete_topic("orders")

    assert route.call_count == 2
    for call in route.calls:
        assert "idempotency-key" not in call.request.headers


@respx.mock
def test_idempotency_key_is_not_swallowed_into_an_update_body() -> None:
    """The key is a header; an update body built from the caller's fields must not carry it."""
    route = respx.route(method__in=["PATCH"]).mock(side_effect=lambda request: _ok())

    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        client.events.update_topic("orders", description="d", idempotency_key=KEY)
        client.actions.update("act_1", description="d", idempotency_key=KEY)

    assert route.call_count == 2
    for call in route.calls:
        assert call.request.headers.get("idempotency-key") == KEY
        assert json.loads(call.request.content) == {"description": "d"}


@pytest.mark.asyncio
@respx.mock
async def test_async_client_sends_the_idempotency_header() -> None:
    route = respx.route().mock(side_effect=lambda request: _ok())

    async with AsyncClient(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        await client.events.publish(topic="t", type="e", data={}, idempotency_key=KEY)
        await client.events.delete_topic("orders", idempotency_key=KEY)

    assert route.call_count == 2
    for call in route.calls:
        assert call.request.headers.get("idempotency-key") == KEY
