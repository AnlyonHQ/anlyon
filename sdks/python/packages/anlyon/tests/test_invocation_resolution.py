"""Resolving unknown invocations, deliberate retries and the unknown queue: request shapes only."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
import respx

from anlyon import AsyncClient, Client

BASE_URL = "https://api.anlyon.com"
ACTIONS = f"{BASE_URL}/api/v2/actions"


def _ok(data: Any = None) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": data or {}})


@respx.mock
def test_resolve_sends_outcome_and_evidence_only() -> None:
    route = respx.post(f"{ACTIONS}/invocations/inv_1/resolve").mock(return_value=_ok())
    with Client(api_key="anlyon_live_test") as client:
        client.actions.resolve_invocation(
            "inv_1", outcome="failed", evidence="No charge exists at the provider.", external_reference="ch_none"
        )
        client.actions.resolve_invocation("inv_1", outcome="succeeded", evidence="Charge ch_42 captured.")
    assert json.loads(route.calls[0].request.content) == {
        "outcome": "failed",
        "evidence": "No charge exists at the provider.",
        "externalReference": "ch_none",
    }
    assert json.loads(route.calls[1].request.content) == {"outcome": "succeeded", "evidence": "Charge ch_42 captured."}


@respx.mock
def test_retry_sends_retry_of_with_its_own_key() -> None:
    route = respx.post(f"{ACTIONS}/refund_order/invoke").mock(return_value=_ok())
    with Client(api_key="anlyon_live_test") as client:
        client.actions.invoke("refund_order", {"amount": 5}, retry_of="inv_1", idempotency_key="refund:42:retry-1")
    request = route.calls[0].request
    assert json.loads(request.content) == {"input": {"amount": 5}, "retryOf": "inv_1"}
    assert request.headers["Idempotency-Key"] == "refund:42:retry-1"


@respx.mock
def test_unknown_queue_filter() -> None:
    route = respx.get(f"{ACTIONS}/invocations").mock(return_value=_ok([]))
    with Client(api_key="anlyon_live_test") as client:
        client.actions.invocations(status="unknown", limit=10)
    assert dict(route.calls[0].request.url.params) == {"status": "unknown", "limit": "10"}


@pytest.mark.asyncio
@respx.mock
async def test_async_twin() -> None:
    resolve = respx.post(f"{ACTIONS}/invocations/inv_2/resolve").mock(return_value=_ok())
    invoke = respx.post(f"{ACTIONS}/refund_order/invoke").mock(return_value=_ok())
    listing = respx.get(f"{ACTIONS}/invocations").mock(return_value=_ok([]))
    async with AsyncClient(api_key="anlyon_live_test") as client:
        await client.actions.resolve_invocation("inv_2", outcome="failed", evidence="Checked the provider logs.")
        await client.actions.invoke("refund_order", retry_of="inv_2", idempotency_key="k2")
        await client.actions.invocations(status="unknown")
    assert json.loads(resolve.calls[0].request.content)["outcome"] == "failed"
    assert json.loads(invoke.calls[0].request.content)["retryOf"] == "inv_2"
    assert listing.calls[0].request.url.params["status"] == "unknown"
