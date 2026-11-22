"""Approval policies and credential identity: request shapes, and PATCH null-vs-omitted semantics."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from anlyon import AnlyonError, AsyncClient, Client, ScopeCheckError

BASE_URL = "https://api.anlyon.com"
POLICIES = f"{BASE_URL}/api/v2/approval-policies"


@respx.mock
def test_versions_and_change_note() -> None:
    history = respx.get(f"{POLICIES}/apol_deleted/versions").mock(return_value=_ok([]))
    update = respx.patch(f"{POLICIES}/apol_1").mock(return_value=_ok())
    with Client(api_key="anlyon_live_test") as client:
        client.approval_policies.versions("apol_deleted")
        client.approval_policies.update("apol_1", min_amount=300, change_note="Finance review")
    assert history.called
    assert json.loads(update.calls[0].request.content) == {"minAmount": 300, "changeNote": "Finance review"}


@respx.mock
def test_history_pages_and_exact_version() -> None:
    page = respx.get(f"{POLICIES}/apol_1/versions").mock(return_value=_ok([]))
    one = respx.get(f"{POLICIES}/apol_1/versions/7").mock(return_value=_ok())
    with Client(api_key="anlyon_live_test") as client:
        client.approval_policies.versions("apol_1", limit=10, before=40)
        client.approval_policies.versions("apol_1")
        client.approval_policies.version("apol_1", 7)
    assert dict(page.calls[0].request.url.params) == {"limit": "10", "before": "40"}
    assert dict(page.calls[1].request.url.params) == {}
    assert one.called


@pytest.mark.asyncio
@respx.mock
async def test_async_history_pages_and_exact_version() -> None:
    page = respx.get(f"{POLICIES}/apol_1/versions").mock(return_value=_ok([]))
    one = respx.get(f"{POLICIES}/apol_1/versions/3").mock(return_value=_ok())
    async with AsyncClient(api_key="anlyon_live_test") as client:
        await client.approval_policies.versions("apol_1", before=5)
        await client.approval_policies.version("apol_1", 3)
    assert dict(page.calls[0].request.url.params) == {"before": "5"}
    assert one.called


@respx.mock
def test_condition_is_sent_and_none_clears_it() -> None:
    create = respx.post(POLICIES).mock(return_value=_ok())
    update = respx.patch(f"{POLICIES}/apol_1").mock(return_value=_ok())
    with Client(api_key="anlyon_live_test") as client:
        client.approval_policies.create(
            name="big refunds", match_kind="action", match_action_name="refund_order",
            condition='input.amount >= 500 && input.currency == "USD"',
        )
        client.approval_policies.update("apol_1", condition=None)
        client.approval_policies.update("apol_1", priority=5)
    assert json.loads(create.calls[0].request.content)["condition"] == 'input.amount >= 500 && input.currency == "USD"'
    assert json.loads(update.calls[0].request.content) == {"condition": None}
    assert "condition" not in json.loads(update.calls[1].request.content)


@pytest.mark.asyncio
@respx.mock
async def test_async_condition() -> None:
    update = respx.patch(f"{POLICIES}/apol_1").mock(return_value=_ok())
    async with AsyncClient(api_key="anlyon_live_test") as client:
        await client.approval_policies.update("apol_1", condition="input.replicas > 5")
    assert json.loads(update.calls[0].request.content) == {"condition": "input.replicas > 5"}


@pytest.mark.asyncio
@respx.mock
async def test_async_versions_and_change_note() -> None:
    history = respx.get(f"{POLICIES}/apol_deleted/versions").mock(return_value=_ok([]))
    create = respx.post(POLICIES).mock(return_value=_ok())
    async with AsyncClient(api_key="anlyon_live_test") as client:
        await client.approval_policies.versions("apol_deleted")
        await client.approval_policies.create(name="refunds", match_kind="custom", change_note="Finance review")
    assert history.called
    assert json.loads(create.calls[0].request.content)["changeNote"] == "Finance review"


@respx.mock
def test_evaluate_policy_only() -> None:
    route = respx.post(f"{POLICIES}/evaluate").mock(return_value=httpx.Response(
        200, json={"success": True, "data": {"evaluation": "policy_only"}},
    ))
    with Client(api_key="anlyon_live_test") as client:
        client.approval_policies.evaluate(kind="action", action_name="refund_order", payload={"amount": 120})
    assert json.loads(route.calls[0].request.content) == {
        "kind": "action", "actionName": "refund_order", "payload": {"amount": 120},
    }


@pytest.mark.asyncio
@respx.mock
async def test_async_evaluate_policy_only() -> None:
    route = respx.post(f"{POLICIES}/evaluate").mock(return_value=httpx.Response(
        200, json={"success": True, "data": {"evaluation": "policy_only"}},
    ))
    async with AsyncClient(api_key="anlyon_live_test") as client:
        await client.approval_policies.evaluate(kind="custom", payload={"amount": 0})
    assert json.loads(route.calls[0].request.content) == {"kind": "custom", "payload": {"amount": 0}}


def _ok(data: object = None) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": data if data is not None else {}})


@respx.mock
def test_create_sends_explicit_targeting_and_no_environment() -> None:
    route = respx.post(POLICIES).mock(return_value=_ok({"id": "apol_1"}))
    with Client(api_key="anlyon_live_test") as client:
        client.approval_policies.create(
            name="refund_order_denied",
            match_kind="action",
            match_action_name="refund_order",
            effect="auto_deny",
        )
    body = json.loads(route.calls[0].request.content)
    assert body == {
        "name": "refund_order_denied",
        "matchKind": "action",
        "matchActionName": "refund_order",
        "effect": "auto_deny",
    }
    assert "environmentId" not in body


@respx.mock
def test_update_omitted_is_unchanged_and_none_clears() -> None:
    route = respx.patch(f"{POLICIES}/apol_1").mock(return_value=_ok())
    with Client(api_key="anlyon_live_test") as client:
        client.approval_policies.update("apol_1", priority=3, match_agent_id=None, min_amount=None)
    assert json.loads(route.calls[0].request.content) == {
        "priority": 3,
        "matchAgentId": None,
        "minAmount": None,
    }


@respx.mock
def test_enable_disable_patch_only_enabled() -> None:
    route = respx.patch(f"{POLICIES}/apol_1").mock(return_value=_ok())
    with Client(api_key="anlyon_live_test") as client:
        client.approval_policies.enable("apol_1")
        client.approval_policies.disable("apol_1")
    assert [json.loads(c.request.content) for c in route.calls] == [
        {"enabled": True},
        {"enabled": False},
    ]


@respx.mock
def test_list_get_delete_paths() -> None:
    lst = respx.get(POLICIES).mock(return_value=_ok([]))
    one = respx.get(f"{POLICIES}/apol_1").mock(return_value=_ok())
    gone = respx.delete(f"{POLICIES}/apol_1").mock(return_value=_ok({"deleted": True}))
    with Client(api_key="anlyon_live_test") as client:
        client.approval_policies.list(action_name="refund_order")
        client.approval_policies.get("apol_1")
        client.approval_policies.delete("apol_1")
    assert lst.calls[0].request.url.params["actionName"] == "refund_order"
    assert one.call_count == 1 and gone.call_count == 1


@respx.mock
def test_identity_and_approval_origin_filter() -> None:
    ident = respx.get(f"{BASE_URL}/api/v2/auth/identity").mock(
        return_value=_ok({"credentialType": "api_key", "scopes": ["actions:invoke"]})
    )
    inbox = respx.get(f"{BASE_URL}/api/v2/approvals").mock(return_value=_ok([]))
    with Client(api_key="anlyon_live_test") as client:
        assert client.auth.identity().data["scopes"] == ["actions:invoke"]
        client.approvals.list(status="pending", decision_origin="automated")
    assert ident.call_count == 1
    params = inbox.calls[0].request.url.params
    assert params["decisionOrigin"] == "automated" and params["status"] == "pending"


@pytest.mark.asyncio
@respx.mock
async def test_async_twin_matches_sync_serialization() -> None:
    route = respx.patch(f"{POLICIES}/apol_1").mock(return_value=_ok())
    create = respx.post(POLICIES).mock(return_value=_ok())
    async with AsyncClient(api_key="anlyon_live_test") as client:
        await client.approval_policies.update(
            "apol_1", priority=3, match_agent_id=None, min_amount=None
        )
        await client.approval_policies.create(
            name="n", match_kind="custom", effect="require_approval"
        )
    assert json.loads(route.calls[0].request.content) == {
        "priority": 3,
        "matchAgentId": None,
        "minAmount": None,
    }
    assert json.loads(create.calls[0].request.content) == {
        "name": "n",
        "matchKind": "custom",
        "effect": "require_approval",
    }


IDENTITY = f"{BASE_URL}/api/v2/auth/identity"
DEMO_NEEDS = ["actions:invoke", "sessions:write"]


@pytest.mark.parametrize("identity", [None, {}, {"scopes": "policies:write"}, {"scopes": [42]}])
@respx.mock
def test_require_scopes_rejects_malformed_identity(identity: object) -> None:
    respx.get(IDENTITY).mock(return_value=httpx.Response(200, json={"success": True, "data": identity}))
    with Client(api_key="anlyon_live_test") as client, pytest.raises(AnlyonError, match="no valid scope information"):
        client.auth.require_scopes([], forbidden=["policies:write"])


@respx.mock
def test_require_scopes_rejects_a_key_without_sessions_write() -> None:
    respx.get(IDENTITY).mock(return_value=_ok({"scopes": ["actions:invoke", "sessions:read"]}))
    with Client(api_key="anlyon_live_test") as client, pytest.raises(ScopeCheckError) as caught:
        client.auth.require_scopes(DEMO_NEEDS)
    assert caught.value.missing == ["sessions:write"]
    assert caught.value.forbidden == []


@respx.mock
def test_require_scopes_accepts_a_key_that_holds_them_and_refuses_ones_it_should_not() -> None:
    respx.get(IDENTITY).mock(
        return_value=_ok({"scopes": ["actions:invoke", "sessions:write"], "environmentId": "e"})
    )
    with Client(api_key="anlyon_live_test") as client:
        assert client.auth.require_scopes(DEMO_NEEDS)["environmentId"] == "e"
        with pytest.raises(ScopeCheckError) as caught:
            client.auth.require_scopes(DEMO_NEEDS, forbidden=["sessions:write"])
    assert caught.value.forbidden == ["sessions:write"]


@respx.mock
def test_require_scopes_treats_a_session_as_holding_no_scopes() -> None:
    respx.get(IDENTITY).mock(return_value=_ok({"credentialType": "session", "scopes": None}))
    with Client(api_key="anlyon_live_test") as client, pytest.raises(ScopeCheckError):
        client.auth.require_scopes(["actions:invoke"])


@pytest.mark.asyncio
@respx.mock
async def test_async_require_scopes() -> None:
    respx.get(IDENTITY).mock(return_value=_ok({"scopes": ["actions:invoke"]}))
    async with AsyncClient(api_key="anlyon_live_test") as client:
        with pytest.raises(ScopeCheckError):
            await client.auth.require_scopes(DEMO_NEEDS)


@respx.mock
def test_policy_files_plan_apply_test() -> None:
    plan = respx.post(f"{POLICIES}/files/plan").mock(return_value=_ok())
    apply = respx.post(f"{POLICIES}/files/apply").mock(return_value=_ok())
    test = respx.post(f"{POLICIES}/files/test").mock(return_value=_ok())
    with Client(api_key="anlyon_live_test") as client:
        client.approval_policies.plan_file("src")
        client.approval_policies.apply_file("src", digest="d" * 64)
        client.approval_policies.apply_file("src", digest="d" * 64, change_note="FIN-42")
        client.approval_policies.test_file("src", "cases: []")
    assert json.loads(plan.calls[0].request.content) == {"source": "src"}
    assert json.loads(apply.calls[0].request.content) == {"source": "src", "digest": "d" * 64}
    assert json.loads(apply.calls[1].request.content) == {"source": "src", "digest": "d" * 64, "changeNote": "FIN-42"}
    assert json.loads(test.calls[0].request.content) == {"source": "src", "cases": "cases: []"}


@pytest.mark.asyncio
@respx.mock
async def test_async_policy_files() -> None:
    plan = respx.post(f"{POLICIES}/files/plan").mock(return_value=_ok())
    apply = respx.post(f"{POLICIES}/files/apply").mock(return_value=_ok())
    test = respx.post(f"{POLICIES}/files/test").mock(return_value=_ok())
    async with AsyncClient(api_key="anlyon_live_test") as client:
        await client.approval_policies.plan_file("src")
        await client.approval_policies.apply_file("src", digest="d" * 64)
        await client.approval_policies.test_file("src", [{"name": "x"}])
    assert plan.called and apply.called
    assert json.loads(test.calls[0].request.content)["cases"] == [{"name": "x"}]
