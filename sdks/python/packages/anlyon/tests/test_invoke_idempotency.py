"""
An action invoke must never reach the API twice without an idempotency key.

The client retries its own HTTP request on a timeout, a 429 or a 5xx, and without a key
the API treats a resend as a new invocation. These tests assert on the wire.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

import httpx
import pytest
import respx

from anlyon import AsyncClient, Client, RetryConfig

BASE_URL = "https://api.anlyon.com"
INVOKE_URL = f"{BASE_URL}/api/v2/actions/refund/invoke"
FAST_RETRY = RetryConfig(max_attempts=3, initial_delay=0.001, jitter=False)
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def _ok() -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": {"id": "inv_1", "status": "succeeded"}})


def _unavailable() -> httpx.Response:
    return httpx.Response(503, json={"success": False, "error": {"code": "INTERNAL", "message": "boom"}})


def _keys(route: respx.Route) -> list[str | None]:
    return [call.request.headers.get("idempotency-key") for call in route.calls]


def _client() -> Client:
    return Client(api_key="anlyon_live_test", base_url=BASE_URL, retry=FAST_RETRY)


def _async_client() -> AsyncClient:
    return AsyncClient(api_key="anlyon_live_test", base_url=BASE_URL, retry=FAST_RETRY)


@respx.mock
def test_invoke_without_a_key_sends_a_generated_idempotency_key() -> None:
    route = respx.post(INVOKE_URL).mock(return_value=_ok())

    with _client() as client:
        client.actions.invoke("refund", {"charge": "ch_1"})

    keys = _keys(route)
    assert len(keys) == 1
    assert keys[0] is not None and UUID.match(keys[0])


@respx.mock
def test_invoke_retried_after_a_5xx_sends_the_same_key() -> None:
    route = respx.post(INVOKE_URL).mock(side_effect=[_unavailable(), _ok()])

    with _client() as client:
        client.actions.invoke("refund", {"charge": "ch_1"})

    keys = _keys(route)
    assert len(keys) == 2
    assert keys[0] is not None and UUID.match(keys[0])
    assert keys[1] == keys[0]


@respx.mock
def test_invoke_retried_after_a_timeout_sends_the_same_key() -> None:
    route = respx.post(INVOKE_URL).mock(
        side_effect=[httpx.ReadTimeout("timed out"), httpx.ReadTimeout("timed out"), _ok()]
    )

    with _client() as client:
        client.actions.invoke("refund", {"charge": "ch_1"})

    keys = _keys(route)
    assert len(keys) == 3
    assert keys[0] is not None and UUID.match(keys[0])
    assert len(set(keys)) == 1


@respx.mock
def test_invoke_passes_a_caller_supplied_key_through_unchanged() -> None:
    route = respx.post(INVOKE_URL).mock(side_effect=[_unavailable(), _ok()])

    with _client() as client:
        client.actions.invoke("refund", {"charge": "ch_1"}, idempotency_key="refund:ord_42")

    assert _keys(route) == ["refund:ord_42", "refund:ord_42"]
    assert b"idempotency" not in route.calls[0].request.content.lower()


@respx.mock
def test_two_invoke_calls_get_different_generated_keys() -> None:
    route = respx.post(INVOKE_URL).mock(side_effect=lambda request: _ok())

    with _client() as client:
        client.actions.invoke("refund", {"charge": "ch_1"})
        client.actions.invoke("refund", {"charge": "ch_1"})

    keys = _keys(route)
    assert len(keys) == 2
    assert all(key is not None and UUID.match(key) for key in keys)
    assert keys[0] != keys[1]


@pytest.mark.asyncio
@respx.mock
async def test_async_invoke_without_a_key_sends_a_generated_idempotency_key() -> None:
    route = respx.post(INVOKE_URL).mock(return_value=_ok())

    async with _async_client() as client:
        await client.actions.invoke("refund", {"charge": "ch_1"})

    keys = _keys(route)
    assert len(keys) == 1
    assert keys[0] is not None and UUID.match(keys[0])


@pytest.mark.asyncio
@respx.mock
async def test_async_invoke_retried_after_a_5xx_or_timeout_sends_the_same_key() -> None:
    route = respx.post(INVOKE_URL).mock(
        side_effect=[_unavailable(), httpx.ReadTimeout("timed out"), _ok()]
    )

    async with _async_client() as client:
        await client.actions.invoke("refund", {"charge": "ch_1"})

    keys = _keys(route)
    assert len(keys) == 3
    assert keys[0] is not None and UUID.match(keys[0])
    assert len(set(keys)) == 1


@pytest.mark.asyncio
@respx.mock
async def test_async_invoke_passes_a_caller_supplied_key_through_unchanged() -> None:
    route = respx.post(INVOKE_URL).mock(side_effect=[_unavailable(), _ok()])

    async with _async_client() as client:
        await client.actions.invoke("refund", {"charge": "ch_1"}, idempotency_key="refund:ord_42")

    assert _keys(route) == ["refund:ord_42", "refund:ord_42"]


@pytest.mark.asyncio
@respx.mock
async def test_async_two_invoke_calls_get_different_generated_keys() -> None:
    route = respx.post(INVOKE_URL).mock(side_effect=lambda request: _ok())

    async with _async_client() as client:
        await client.actions.invoke("refund", {"charge": "ch_1"})
        await client.actions.invoke("refund", {"charge": "ch_1"})

    keys = _keys(route)
    assert len(keys) == 2
    assert all(key is not None and UUID.match(key) for key in keys)
    assert keys[0] != keys[1]


_WRITES: list[tuple[str, Callable[[Any], Any]]] = [
    ("actions.create", lambda c: c.actions.create(name="a", url_template="https://x")),
    ("actions.import_openapi", lambda c: c.actions.import_openapi({"openapi": "3.1.0"})),
    ("actions.update", lambda c: c.actions.update("a", description="d")),
    ("actions.declare", lambda c: c.actions.declare("a", verify=None)),
    ("actions.delete", lambda c: c.actions.delete("a")),
    ("actions.preview", lambda c: c.actions.preview("a", {})),
    ("actions.refresh_preview", lambda c: c.actions.refresh_preview("prv_1")),
    ("actions.reconcile_effect", lambda c: c.actions.reconcile_effect("eff_1")),
    ("actions.add_effect_note", lambda c: c.actions.add_effect_note("eff_1", "checked the provider")),
    (
        "actions.resolve_effect",
        lambda c: c.actions.resolve_effect("eff_1", outcome="failed", reason="never arrived"),
    ),
    ("actions.replay_effect", lambda c: c.actions.replay_effect("eff_1")),
    (
        "actions.resolve_invocation",
        lambda c: c.actions.resolve_invocation("inv_1", outcome="failed", evidence="never arrived"),
    ),
    ("approvals.request", lambda c: c.approvals.request(title="ship it")),
    ("approvals.approve", lambda c: c.approvals.approve("apr_1")),
    ("approvals.deny", lambda c: c.approvals.deny("apr_1")),
]


@pytest.mark.parametrize(("name", "write"), _WRITES, ids=[name for name, _ in _WRITES])
@respx.mock
def test_every_action_and_approval_write_reuses_one_generated_key_on_a_retry(
    name: str, write: Callable[[Any], Any]
) -> None:
    route = respx.route().mock(side_effect=[_unavailable(), _ok()])

    with _client() as client:
        write(client)

    keys = _keys(route)
    assert len(keys) == 2, name
    assert keys[0] is not None and UUID.match(keys[0]), name
    assert keys[1] == keys[0], name


@pytest.mark.parametrize(("name", "write"), _WRITES, ids=[name for name, _ in _WRITES])
@pytest.mark.asyncio
@respx.mock
async def test_async_every_action_and_approval_write_reuses_one_generated_key_on_a_retry(
    name: str, write: Callable[[Any], Any]
) -> None:
    route = respx.route().mock(side_effect=[_unavailable(), _ok()])

    async with _async_client() as client:
        await write(client)

    keys = _keys(route)
    assert len(keys) == 2, name
    assert keys[0] is not None and UUID.match(keys[0]), name
    assert keys[1] == keys[0], name


@respx.mock
def test_reads_carry_no_idempotency_key() -> None:
    route = respx.route().mock(side_effect=lambda request: _ok())

    with _client() as client:
        client.actions.list()
        client.actions.invocation("inv_1")
        client.actions.effect("eff_1")
        client.approvals.get("apr_1")

    assert [call.request.method for call in route.calls] == ["GET"] * 4
    assert _keys(route) == [None] * 4


def _in_progress() -> httpx.Response:
    return httpx.Response(
        409,
        headers={"Retry-After": "1"},
        json={
            "success": False,
            "error": {
                "code": "idempotency_request_in_progress",
                "message": "A request with this Idempotency-Key is still being processed. Retry shortly.",
            },
        },
    )


@respx.mock
def test_in_progress_409_is_not_retried_and_names_the_generated_key() -> None:
    from anlyon import AnlyonError

    route = respx.post(INVOKE_URL).mock(side_effect=[_unavailable(), _in_progress()])

    with _client() as client, pytest.raises(AnlyonError) as raised:
        client.actions.invoke("refund", {"charge": "ch_1"})

    keys = _keys(route)
    assert len(keys) == 2
    assert keys[0] is not None and keys[1] == keys[0]
    error = raised.value
    assert error.code == "idempotency_request_in_progress"
    assert error.status == 409
    assert error.details == {"idempotency_key": keys[0]}
    assert keys[0] in str(error)


@pytest.mark.asyncio
@respx.mock
async def test_async_in_progress_409_names_the_key_the_caller_passed() -> None:
    from anlyon import AnlyonError

    route = respx.post(INVOKE_URL).mock(return_value=_in_progress())

    async with _async_client() as client:
        with pytest.raises(AnlyonError) as raised:
            await client.actions.invoke("refund", {"charge": "ch_1"}, idempotency_key="refund-ch_1")

    assert len(route.calls) == 1
    assert raised.value.details == {"idempotency_key": "refund-ch_1"}
