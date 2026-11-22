"""A loosening change answered 202 raises SignOffRequiredError; sign_offs follows the request."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
import respx

from anlyon import AnlyonError, AsyncClient, Client, NotFoundError, SignOffRequiredError

BASE_URL = "https://api.anlyon.com"
LIMITS = f"{BASE_URL}/api/v2/impact-limits"
SIGN_OFFS = f"{BASE_URL}/api/v2/sign-offs"


def _sign_off(**overrides: Any) -> dict[str, Any]:
    request: dict[str, Any] = {
        "object": "sign_off_request",
        "id": "sor_123",
        "status": "pending",
        "operation": "impact_limit.update",
        "environmentId": "env-1",
        "resource": {"type": "impact_limit", "id": "lim_123", "name": "Daily refunds"},
        "summary": 'Raise impact limit "Daily refunds" from 50000 to 200000',
        "changes": [{"field": "amount", "from": 50000, "to": 200000, "direction": "loosening"}],
        "diff": "- amount: 50000\n+ amount: 200000",
        "signOffUrl": "https://console.anlyon.com/sign-offs/sor_123",
        "pollUrl": "/api/v2/sign-offs/sor_123",
        "pollAfterSeconds": 5,
        "requestedBy": {"type": "api_key", "id": "key_1", "onBehalfOf": None},
        "createdAt": "2026-10-28T00:00:00.000Z",
        "expiresAt": "2026-10-29T00:00:00.000Z",
        "decidedAt": None,
        "decidedBy": None,
        "decisionNote": None,
        "result": None,
        "error": None,
    }
    request.update(overrides)
    return request


def _pending() -> httpx.Response:
    return httpx.Response(
        202,
        json={"success": True, "signOffRequired": True, "data": _sign_off()},
        headers={"x-request-id": "req_1", "location": "/api/v2/sign-offs/sor_123"},
    )


def _ok(data: Any) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": data})


@respx.mock
def test_a_loosening_change_raises_with_the_link_and_is_not_retried() -> None:
    route = respx.patch(f"{LIMITS}/lim_123").mock(return_value=_pending())
    with Client(api_key="anlyon_live_test") as client, pytest.raises(SignOffRequiredError) as raised:
        client.impact_limits.update("lim_123", amount=200_000)
    error = raised.value
    assert isinstance(error, AnlyonError)
    assert error.code == "SIGN_OFF_REQUIRED"
    assert error.status == 202
    assert error.sign_off_id == "sor_123"
    assert error.sign_off_url == "https://console.anlyon.com/sign-offs/sor_123"
    assert error.sign_off["diff"] == "- amount: 50000\n+ amount: 200000"
    assert error.request_id == "req_1"
    assert error.args[0] == (
        "A human must approve this change before it applies. "
        "Give them this link: https://console.anlyon.com/sign-offs/sor_123"
    )
    assert route.call_count == 1


@respx.mock
def test_a_202_without_sign_off_required_is_a_normal_response() -> None:
    respx.patch(f"{LIMITS}/lim_123").mock(
        return_value=httpx.Response(202, json={"success": True, "data": {"id": "lim_123"}})
    )
    with Client(api_key="anlyon_live_test") as client:
        assert client.impact_limits.update("lim_123", amount=10).data == {"id": "lim_123"}


@respx.mock
def test_error_fix_is_parsed_and_malformed_fixes_are_dropped() -> None:
    fix = {
        "summary": "Log in with the scope that decides approvals.",
        "command": "anlyon auth login --scope anlyon:approvals.decide",
        "url": "https://console.anlyon.com/settings/api-keys",
    }
    respx.get(f"{LIMITS}/missing").mock(
        return_value=httpx.Response(
            404, json={"success": False, "error": {"code": "NOT_FOUND", "message": "No such limit", "fix": fix}}
        )
    )
    respx.get(f"{LIMITS}/odd").mock(
        return_value=httpx.Response(
            400,
            json={"success": False, "error": {"code": "SOMETHING", "message": "x", "fix": {"command": "x"}}},
        )
    )
    with Client(api_key="anlyon_live_test") as client:
        with pytest.raises(NotFoundError) as missing:
            client.impact_limits.get("missing")
        assert missing.value.fix == fix
        with pytest.raises(AnlyonError) as odd:
            client.impact_limits.get("odd")
        assert odd.value.fix is None


@respx.mock
def test_sign_offs_routes_and_wait() -> None:
    respx.get(f"{SIGN_OFFS}/sor_123").mock(
        side_effect=[
            _ok(_sign_off()),
            _ok(_sign_off()),
            _ok(_sign_off(status="applied", result={"id": "lim_123", "amount": 200000})),
        ]
    )
    listed = respx.get(SIGN_OFFS).mock(return_value=_ok([_sign_off()]))
    cancelled = respx.post(f"{SIGN_OFFS}/sor_123/cancel").mock(
        return_value=_ok(_sign_off(status="cancelled"))
    )
    with Client(api_key="anlyon_live_test") as client:
        decided = client.sign_offs.wait("sor_123", poll_interval=0)
        assert decided["status"] == "applied"
        assert decided["result"] == {"id": "lim_123", "amount": 200000}
        client.sign_offs.list(status="pending", limit=50)
        assert client.sign_offs.cancel("sor_123").data["status"] == "cancelled"
    assert dict(listed.calls[0].request.url.params) == {"status": "pending", "limit": "50"}
    assert cancelled.called


@respx.mock
def test_wait_returns_the_pending_request_when_time_runs_out() -> None:
    respx.get(f"{SIGN_OFFS}/sor_123").mock(return_value=_ok(_sign_off()))
    with Client(api_key="anlyon_live_test") as client:
        assert client.sign_offs.wait("sor_123", timeout_seconds=0.05, poll_interval=0.01)["status"] == "pending"


@pytest.mark.asyncio
@respx.mock
async def test_async_raises_and_waits() -> None:
    respx.patch(f"{LIMITS}/lim_123").mock(return_value=_pending())
    respx.get(f"{SIGN_OFFS}/sor_123").mock(
        side_effect=[_ok(_sign_off()), _ok(_sign_off(status="rejected", decisionNote="Too high"))]
    )
    async with AsyncClient(api_key="anlyon_live_test") as client:
        with pytest.raises(SignOffRequiredError) as raised:
            await client.impact_limits.update("lim_123", amount=200_000)
        decided = await client.sign_offs.wait(raised.value.sign_off_id, poll_interval=0)
    assert decided["status"] == "rejected"
    assert decided["decisionNote"] == "Too high"
