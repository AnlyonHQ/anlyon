"""Governed effects, previews and impact limits: request shapes for the sync and async clients."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
import respx

from anlyon import AsyncClient, Client

BASE_URL = "https://api.anlyon.com"
ACTIONS = f"{BASE_URL}/api/v2/actions"
LIMITS = f"{BASE_URL}/api/v2/impact-limits"
ADAPTER = {
    "type": "stripe.refund",
    "config": {"account": "acct_1", "mode": "test", "currency": "usd"},
    "credentialSecret": "STRIPE_TEST_KEY",
}


def _ok(data: Any = None) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": data or {}})


@respx.mock
def test_adapter_action_needs_no_url_template() -> None:
    route = respx.post(ACTIONS).mock(return_value=_ok())
    with Client(api_key="anlyon_live_test") as client:
        client.actions.create(name="refund", adapter=ADAPTER, requires_approval=True)
        with pytest.raises(ValueError):
            client.actions.create(name="nothing")
    assert json.loads(route.calls[0].request.content) == {"name": "refund", "adapter": ADAPTER, "requiresApproval": True}


@respx.mock
def test_preview_then_bound_invoke() -> None:
    preview = respx.post(f"{ACTIONS}/refund/previews").mock(return_value=_ok({"id": "prv_1"}))
    invoke = respx.post(f"{ACTIONS}/refund/invoke").mock(return_value=_ok())
    refund = {"paymentIntent": "pi_1", "amount": 1250, "currency": "usd"}
    with Client(api_key="anlyon_live_test") as client:
        client.actions.preview("refund", refund, ttl_seconds=600)
        client.actions.invoke(
            "refund",
            refund,
            preview_id="prv_1",
            operation_key="order-42-refund",
            depends_on=[{"effect": "eff_0", "outcome": "succeeded"}],
        )
    assert json.loads(preview.calls[0].request.content) == {"input": refund, "ttlSeconds": 600}
    assert json.loads(invoke.calls[0].request.content) == {
        "input": refund,
        "operationKey": "order-42-refund",
        "previewId": "prv_1",
        "dependsOn": [{"effect": "eff_0", "outcome": "succeeded"}],
    }


@respx.mock
def test_effect_recovery_operations() -> None:
    listing = respx.get(f"{ACTIONS}/effects").mock(return_value=_ok([]))
    get = respx.get(f"{ACTIONS}/effects/eff_1").mock(return_value=_ok())
    reconcile = respx.post(f"{ACTIONS}/effects/eff_1/reconcile").mock(return_value=_ok())
    note = respx.post(f"{ACTIONS}/effects/eff_1/notes").mock(return_value=_ok())
    resolve = respx.post(f"{ACTIONS}/effects/eff_1/resolve").mock(return_value=_ok())
    replay = respx.post(f"{ACTIONS}/effects/eff_1/replay").mock(return_value=_ok())
    get_preview = respx.get(f"{ACTIONS}/previews/prv_1").mock(return_value=_ok())
    refresh = respx.post(f"{ACTIONS}/previews/prv_1/refresh").mock(return_value=_ok())
    with Client(api_key="anlyon_live_test") as client:
        client.actions.effects(unresolved=True, outcome="unknown", limit=5)
        client.actions.effect("eff_1")
        client.actions.reconcile_effect("eff_1")
        client.actions.add_effect_note("eff_1", "Checked the Stripe dashboard")
        client.actions.resolve_effect(
            "eff_1",
            outcome="failed",
            partial_effect="confirmed",
            actual_impact=[{"dimension": "money", "currency": "usd", "amount": 500, "bound": "exact"}],
            reason="Support confirmed 5.00 was refunded.",
        )
        client.actions.replay_effect("eff_1")
        client.actions.get_preview("prv_1")
        client.actions.refresh_preview("prv_1", ttl_seconds=120)
    assert dict(listing.calls[0].request.url.params) == {"outcome": "unknown", "unresolved": "true", "limit": "5"}
    for route in (get, reconcile, note, resolve, replay, get_preview, refresh):
        assert route.called
    assert json.loads(note.calls[0].request.content) == {"note": "Checked the Stripe dashboard"}
    assert json.loads(resolve.calls[0].request.content) == {
        "outcome": "failed",
        "reason": "Support confirmed 5.00 was refunded.",
        "partialEffect": "confirmed",
        "actualImpact": [{"dimension": "money", "currency": "usd", "amount": 500, "bound": "exact"}],
    }
    assert json.loads(refresh.calls[0].request.content) == {"ttlSeconds": 120}


@respx.mock
def test_impact_limits() -> None:
    listing = respx.get(LIMITS).mock(return_value=_ok([]))
    create = respx.post(LIMITS).mock(return_value=_ok())
    get = respx.get(f"{LIMITS}/lim_1").mock(return_value=_ok())
    update = respx.patch(f"{LIMITS}/lim_1").mock(return_value=_ok())
    archive = respx.delete(f"{LIMITS}/lim_1").mock(return_value=_ok())
    with Client(api_key="anlyon_live_test") as client:
        client.impact_limits.list(include_archived=True)
        client.impact_limits.create(name="Daily refunds", dimension="money", currency="usd", period="day", amount=10_000)
        client.impact_limits.get("lim_1")
        client.impact_limits.update("lim_1", amount=5000)
        client.impact_limits.archive("lim_1")
        assert client.impact_limits is client.impact_limits
    assert dict(listing.calls[0].request.url.params) == {"includeArchived": "true"}
    assert json.loads(create.calls[0].request.content) == {
        "name": "Daily refunds",
        "dimension": "money",
        "period": "day",
        "amount": 10_000,
        "currency": "usd",
    }
    assert get.called and archive.called
    assert json.loads(update.calls[0].request.content) == {"amount": 5000}


@pytest.mark.asyncio
@respx.mock
async def test_async_twins() -> None:
    preview = respx.post(f"{ACTIONS}/refund/previews").mock(return_value=_ok())
    effects = respx.get(f"{ACTIONS}/effects").mock(return_value=_ok([]))
    resolve = respx.post(f"{ACTIONS}/effects/eff_1/resolve").mock(return_value=_ok())
    replay = respx.post(f"{ACTIONS}/effects/eff_1/replay").mock(return_value=_ok())
    limits = respx.post(LIMITS).mock(return_value=_ok())
    async with AsyncClient(api_key="anlyon_live_test") as client:
        await client.actions.preview("refund", {"paymentIntent": "pi_1", "amount": 1, "currency": "usd"})
        await client.actions.effects(action="refund")
        await client.actions.resolve_effect("eff_1", outcome="succeeded", reason="Refund re_1 exists in Stripe.")
        await client.actions.replay_effect("eff_1")
        await client.impact_limits.create(name="Files", dimension="resource_mutations", period="day", amount=20)
    assert preview.called and replay.called
    assert dict(effects.calls[0].request.url.params) == {"action": "refund"}
    assert json.loads(resolve.calls[0].request.content) == {"outcome": "succeeded", "reason": "Refund re_1 exists in Stripe."}
    assert json.loads(limits.calls[0].request.content) == {
        "name": "Files",
        "dimension": "resource_mutations",
        "period": "day",
        "amount": 20,
    }
