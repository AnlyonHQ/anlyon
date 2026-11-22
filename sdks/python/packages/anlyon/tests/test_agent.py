"""
Agent platform resource tests  secrets, actions, approvals, budgets.
Unwrapped-envelope contract; respx mocks the HTTP layer.
"""

import json

import httpx
import pytest
import respx

from anlyon import AsyncClient, Client

BASE_URL = "https://api.anlyon.com"


@respx.mock
def test_secrets_are_write_only():
    put_route = respx.put(f"{BASE_URL}/api/v2/secrets/STRIPE_KEY").mock(
        return_value=httpx.Response(
            200,
            json={"success": True, "data": {"id": "sec_1", "name": "STRIPE_KEY"}},
        )
    )
    respx.get(f"{BASE_URL}/api/v2/secrets").mock(
        return_value=httpx.Response(
            200,
            json={"success": True, "data": [{"id": "sec_1", "name": "STRIPE_KEY"}]},
        )
    )

    with Client(api_key="anlyon_live_test") as client:
        stored = client.secrets.put("STRIPE_KEY", value="sk_live_x")
        assert stored["name"] == "STRIPE_KEY"
        assert json.loads(put_route.calls.last.request.content) == {"value": "sk_live_x"}

        listed = client.secrets.list()
        assert "value" not in listed[0]


@respx.mock
def test_secret_destination_policy_is_sent_and_none_clears_it():
    put_route = respx.put(f"{BASE_URL}/api/v2/secrets/STRIPE_KEY").mock(
        return_value=httpx.Response(200, json={"success": True, "data": {"id": "sec_1"}})
    )

    with Client(api_key="anlyon_live_test") as client:
        client.secrets.put(
            "STRIPE_KEY",
            value="sk_live_x",
            allowed_hosts=["api.stripe.com"],
            allowed_placements=["header"],
        )
        assert json.loads(put_route.calls[0].request.content) == {
            "value": "sk_live_x",
            "allowedHosts": ["api.stripe.com"],
            "allowedPlacements": ["header"],
        }

        client.secrets.put("STRIPE_KEY", value="sk_live_y", allowed_hosts=None)
        assert json.loads(put_route.calls[1].request.content) == {
            "value": "sk_live_y",
            "allowedHosts": None,
        }


@respx.mock
def test_action_invoke_pending_approval():
    invoke_route = respx.post(f"{BASE_URL}/api/v2/actions/refund/invoke").mock(
        return_value=httpx.Response(
            202,
            json={
                "success": True,
                "data": {
                    "id": "inv_1",
                    "actionName": "refund",
                    "status": "pending_approval",
                    "approvalId": "apr_1",
                    "pendingApproval": True,
                },
            },
        )
    )

    with Client(api_key="anlyon_live_test") as client:
        result = client.actions.invoke("refund", {"charge": "ch_1"})
        assert result["pendingApproval"] is True
        assert result["approvalId"] == "apr_1"
        assert json.loads(invoke_route.calls.last.request.content) == {"input": {"charge": "ch_1"}}


@respx.mock
def test_approvals_request_and_approve():
    request_route = respx.post(f"{BASE_URL}/api/v2/approvals").mock(
        return_value=httpx.Response(
            201,
            json={"success": True, "data": {"id": "apr_1", "status": "pending"}},
        )
    )
    approve_route = respx.post(f"{BASE_URL}/api/v2/approvals/apr_1/approve").mock(
        return_value=httpx.Response(
            200,
            json={
                "success": True,
                "data": {
                    "approval": {"id": "apr_1", "status": "approved"},
                    "invocation": {"id": "inv_1", "status": "succeeded"},
                },
            },
        )
    )

    with Client(api_key="anlyon_live_test") as client:
        approval = client.approvals.request(
            title="Send the contract?", run_id="run_trace", parent_span_id="span_parent"
        )
        assert approval["id"] == "apr_1"
        assert json.loads(request_route.calls.last.request.content) == {
            "title": "Send the contract?",
            "runId": "run_trace",
            "parentSpanId": "span_parent",
        }

        decided = client.approvals.approve("apr_1", note="looks right")
        assert decided["invocation"]["status"] == "succeeded"
        assert json.loads(approve_route.calls.last.request.content) == {"note": "looks right"}


@respx.mock
def test_actions_import_openapi():
    route = respx.post(f"{BASE_URL}/api/v2/actions/import").mock(
        return_value=httpx.Response(
            201,
            json={
                "success": True,
                "data": {
                    "created": [{"name": "listPets", "warnings": []}],
                    "skipped": [{"path": "/pets", "method": "POST", "reason": "oneOf"}],
                    "dryRun": False,
                },
            },
        )
    )

    spec = {"openapi": "3.0.0", "paths": {}}

    with Client(api_key="anlyon_live_test") as client:
        result = client.actions.import_openapi(
            spec,
            base_url="https://api.acme.com",
            auth={"headerName": "Authorization", "secretName": "ACME_KEY"},
            requires_approval=True,
        )

    assert result["created"][0]["name"] == "listPets"
    assert result["skipped"][0]["reason"] == "oneOf"
    assert json.loads(route.calls.last.request.content) == {
        "spec": spec,
        "baseUrl": "https://api.acme.com",
        "auth": {"headerName": "Authorization", "secretName": "ACME_KEY"},
        "requiresApproval": True,
    }


@respx.mock
def test_actions_import_openapi_can_opt_out_of_governed():
    route = respx.post(f"{BASE_URL}/api/v2/actions/import").mock(
        return_value=httpx.Response(
            200,
            json={
                "success": True,
                "data": {
                    "created": [
                        {
                            "name": "createPet",
                            "warnings": [],
                            "governed": False,
                            "impact": None,
                            "proposedVerify": None,
                            "verifyNote": None,
                        }
                    ],
                    "skipped": [],
                    "dryRun": True,
                },
            },
        )
    )
    spec = {"openapi": "3.0.0", "paths": {}}

    with Client(api_key="anlyon_live_test") as client:
        result = client.actions.import_openapi(spec, dry_run=True, governed=False)

    assert result["created"][0]["governed"] is False
    assert json.loads(route.calls.last.request.content) == {
        "spec": spec,
        "dryRun": True,
        "governed": False,
    }


@respx.mock
def test_actions_import_openapi_sends_operation_choices():
    route = respx.post(f"{BASE_URL}/api/v2/actions/import").mock(
        return_value=httpx.Response(
            201,
            json={"success": True, "data": {"created": [], "skipped": [], "dryRun": False, "suggestedAllowedHosts": []}},
        )
    )
    spec = {"openapi": "3.0.0", "paths": {}}
    operations = {
        "PostRefunds": {
            "requiresApproval": True,
            "impact": {"dimension": "money", "unit": "usd", "amount": "input.amount", "bound": "exact"},
        },
        "POST /search": {"impact": None},
    }

    with Client(api_key="anlyon_live_test") as client:
        client.actions.import_openapi(spec, operations=operations)

    assert json.loads(route.calls.last.request.content) == {"spec": spec, "operations": operations}


@respx.mock
def test_approvals_get_passes_wait_seconds():
    route = respx.get(f"{BASE_URL}/api/v2/approvals/apr_1").mock(
        return_value=httpx.Response(
            200, json={"success": True, "data": {"id": "apr_1", "status": "pending"}}
        )
    )

    with Client(api_key="anlyon_live_test") as client:
        client.approvals.get("apr_1", wait_seconds=30)

    assert route.calls.last.request.url.params["waitSeconds"] == "30"


@respx.mock
def test_wait_for_decision_returns_when_decided():
    responses = [
        httpx.Response(200, json={"success": True, "data": {"id": "apr_1", "status": "pending"}}),
        httpx.Response(200, json={"success": True, "data": {"id": "apr_1", "status": "approved"}}),
    ]
    route = respx.get(f"{BASE_URL}/api/v2/approvals/apr_1").mock(side_effect=responses)

    with Client(api_key="anlyon_live_test") as client:
        decided = client.approvals.wait_for_decision("apr_1", timeout_seconds=120)

    assert decided["status"] == "approved"
    assert route.call_count == 2
    assert route.calls[0].request.url.params["waitSeconds"] == "55"


@respx.mock
def test_wait_for_decision_returns_pending_on_timeout():
    route = respx.get(f"{BASE_URL}/api/v2/approvals/apr_1").mock(
        return_value=httpx.Response(
            200, json={"success": True, "data": {"id": "apr_1", "status": "pending"}}
        )
    )

    with Client(api_key="anlyon_live_test") as client:
        result = client.approvals.wait_for_decision("apr_1", timeout_seconds=0)

    assert result["status"] == "pending"
    assert route.call_count == 1
    assert "waitSeconds" not in route.calls.last.request.url.params


@pytest.mark.asyncio
@respx.mock
async def test_async_wait_for_decision():
    responses = [
        httpx.Response(200, json={"success": True, "data": {"id": "apr_1", "status": "pending"}}),
        httpx.Response(200, json={"success": True, "data": {"id": "apr_1", "status": "denied"}}),
    ]
    route = respx.get(f"{BASE_URL}/api/v2/approvals/apr_1").mock(side_effect=responses)

    async with AsyncClient(api_key="anlyon_live_test") as client:
        decided = await client.approvals.wait_for_decision("apr_1", timeout_seconds=120)

    assert decided["status"] == "denied"
    assert route.call_count == 2


@respx.mock
def test_gate_runs_the_function_only_after_approval():
    create_route = respx.post(f"{BASE_URL}/api/v2/approvals").mock(
        return_value=httpx.Response(
            201,
            json={"success": True, "data": {"id": "apr_1", "status": "pending", "title": "Refund a customer?"}},
        )
    )
    respx.get(f"{BASE_URL}/api/v2/approvals/apr_1").mock(
        return_value=httpx.Response(
            200,
            json={"success": True, "data": {"id": "apr_1", "status": "approved", "title": "Refund a customer?"}},
        )
    )

    calls = []
    with Client(api_key="anlyon_live_test") as client:

        @client.approvals.gate(title="Refund a customer?")
        def refund(order_id: str, amount: float) -> str:
            calls.append((order_id, amount))
            return f"{order_id}:{amount}"

        result = refund("ord_42", 129.99)

    assert result == "ord_42:129.99"
    assert calls == [("ord_42", 129.99)]
    body = json.loads(create_route.calls.last.request.content)
    assert body["title"] == "Refund a customer?"
    assert body["payload"] == {"function": "refund", "args": ["ord_42", 129.99], "kwargs": {}}


@respx.mock
def test_gate_raises_and_skips_the_function_on_deny():
    from anlyon import ApprovalDeniedError

    respx.post(f"{BASE_URL}/api/v2/approvals").mock(
        return_value=httpx.Response(
            201, json={"success": True, "data": {"id": "apr_1", "status": "pending", "title": "Refund?"}}
        )
    )
    respx.get(f"{BASE_URL}/api/v2/approvals/apr_1").mock(
        return_value=httpx.Response(
            200,
            json={
                "success": True,
                "data": {"id": "apr_1", "status": "denied", "title": "Refund?", "decisionNote": "too large"},
            },
        )
    )

    calls = []
    with Client(api_key="anlyon_live_test") as client:

        @client.approvals.gate(title="Refund?")
        def refund() -> None:
            calls.append(True)

        with pytest.raises(ApprovalDeniedError) as exc:
            refund()

    assert calls == []
    assert exc.value.approval["decisionNote"] == "too large"


@respx.mock
def test_gate_raises_pending_when_the_wait_elapses():
    from anlyon import ApprovalPendingError

    respx.post(f"{BASE_URL}/api/v2/approvals").mock(
        return_value=httpx.Response(
            201, json={"success": True, "data": {"id": "apr_1", "status": "pending", "title": "Refund?"}}
        )
    )
    respx.get(f"{BASE_URL}/api/v2/approvals/apr_1").mock(
        return_value=httpx.Response(
            200, json={"success": True, "data": {"id": "apr_1", "status": "pending", "title": "Refund?"}}
        )
    )

    calls = []
    with Client(api_key="anlyon_live_test") as client:

        @client.approvals.gate(title="Refund?", timeout_seconds=0)
        def refund() -> None:
            calls.append(True)

        with pytest.raises(ApprovalPendingError):
            refund()

    assert calls == []


@pytest.mark.asyncio
@respx.mock
async def test_async_gate_awaits_the_function_after_approval():
    respx.post(f"{BASE_URL}/api/v2/approvals").mock(
        return_value=httpx.Response(
            201, json={"success": True, "data": {"id": "apr_1", "status": "pending", "title": "Ship?"}}
        )
    )
    respx.get(f"{BASE_URL}/api/v2/approvals/apr_1").mock(
        return_value=httpx.Response(
            200, json={"success": True, "data": {"id": "apr_1", "status": "approved", "title": "Ship?"}}
        )
    )

    async with AsyncClient(api_key="anlyon_live_test") as client:

        @client.approvals.gate(title="Ship?")
        async def ship(version: str) -> str:
            return f"shipped {version}"

        assert await ship("v2") == "shipped v2"


@respx.mock
def test_budgets_put():
    route = respx.put(f"{BASE_URL}/api/v2/budgets/key_1").mock(
        return_value=httpx.Response(
            200,
            json={
                "success": True,
                "data": {
                    "apiKeyId": "key_1",
                    "monthlyCostCentsCap": 500,
                    "usage": {"actionInvokes": 3},
                    "estimatedCostCents": 0.0015,
                },
            },
        )
    )

    with Client(api_key="anlyon_live_test") as client:
        budget = client.budgets.put(
            "key_1",
            monthly_cost_cents_cap=500,
            dimension_caps={"actionInvokes": 1000},
        )
        assert budget["monthlyCostCentsCap"] == 500
        assert json.loads(route.calls.last.request.content) == {
            "monthlyCostCentsCap": 500,
            "dimensionCaps": {"actionInvokes": 1000},
        }


@pytest.mark.asyncio
@respx.mock
async def test_async_invoke():
    respx.post(f"{BASE_URL}/api/v2/actions/ping/invoke").mock(
        return_value=httpx.Response(
            200,
            json={
                "success": True,
                "data": {"id": "inv_2", "status": "succeeded", "pendingApproval": False},
            },
        )
    )

    async with AsyncClient(api_key="anlyon_live_test") as client:
        result = await client.actions.invoke("ping")
        assert result["status"] == "succeeded"
