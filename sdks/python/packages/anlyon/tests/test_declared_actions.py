"""Declared actions and receipt grades: request shapes and response parsing."""

from __future__ import annotations

import json
from typing import Any, get_args

import httpx
import pytest
import respx

from anlyon import (
    ActionImpactDeclaration,
    ActionVerifyDeclaration,
    AsyncClient,
    Client,
    EffectGrade,
)
from anlyon.integrations.action_tools import (
    action_tool_description,
    action_tool_input_schema,
    impact_sentence,
    invocation_tool_result,
)
from anlyon.resources.actions import EFFECT_GRADES

BASE_URL = "https://api.anlyon.com"
ACTIONS = f"{BASE_URL}/api/v2/actions"
LIMITS = f"{BASE_URL}/api/v2/impact-limits"

IMPACT: ActionImpactDeclaration = {"dimension": "emails", "amount": "count(input.to)", "bound": "exact"}
VERIFY: ActionVerifyDeclaration = {
    "url": "https://api.example.com/v1/messages/{{response.id}}",
    "status": 200,
    "match": [{"path": "status", "equals": "sent"}],
}
ACTION = {
    "id": "act_1",
    "name": "send-email",
    "description": "Sends an email.",
    "governed": True,
    "impact": {**IMPACT, "unit": "emails"},
    "verify": VERIFY,
}


def _ok(data: Any = None, **envelope: Any) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": {} if data is None else data, **envelope})


def test_grades_are_the_seven_the_api_returns() -> None:
    assert set(get_args(EffectGrade)) == set(EFFECT_GRADES)
    assert EFFECT_GRADES == ("confirmed", "acknowledged", "unknown", "failed", "refused", "denied", "pending")


@respx.mock
def test_create_sends_declarations_and_parses_them_back() -> None:
    route = respx.post(ACTIONS).mock(return_value=_ok(ACTION))
    with Client(api_key="anlyon_live_test") as client:
        created = client.actions.create(
            name="send-email",
            method="POST",
            url_template="https://api.example.com/v1/messages",
            impact=IMPACT,
            verify=VERIFY,
        )
        client.actions.create(name="ping", url_template="https://api.example.com/v1/ping", governed=True)
        client.actions.create(name="plain", url_template="https://api.example.com/v1/plain")
    assert json.loads(route.calls[0].request.content) == {
        "name": "send-email",
        "method": "POST",
        "urlTemplate": "https://api.example.com/v1/messages",
        "impact": IMPACT,
        "verify": VERIFY,
    }
    assert json.loads(route.calls[1].request.content) == {
        "name": "ping",
        "urlTemplate": "https://api.example.com/v1/ping",
        "governed": True,
    }
    assert json.loads(route.calls[2].request.content) == {
        "name": "plain",
        "urlTemplate": "https://api.example.com/v1/plain",
    }
    assert created.data["governed"] is True
    assert created.data["impact"] == {"dimension": "emails", "unit": "emails", "amount": "count(input.to)", "bound": "exact"}
    assert created.data["verify"]["status"] == 200


@respx.mock
def test_declare_patches_the_action_with_the_declarations_alone() -> None:
    route = respx.patch(f"{ACTIONS}/send-email").mock(return_value=_ok(ACTION))
    with Client(api_key="anlyon_live_test") as client:
        declared = client.actions.declare("send-email", impact=IMPACT, verify=VERIFY, idempotency_key="declare-1")
        client.actions.declare("send-email", verify=None)
        client.actions.declare("send-email", impact=None, verify=None)
        client.actions.declare("send-email", governed=False)
        client.actions.declare("send-email", governed=True)
    bodies = [json.loads(call.request.content) for call in route.calls]
    assert bodies == [
        {"impact": IMPACT, "verify": VERIFY},
        {"verify": None},
        {"impact": None, "verify": None},
        {"governed": False},
        {"governed": True},
    ]
    assert route.calls[0].request.headers["Idempotency-Key"] == "declare-1"
    assert declared.data["impact"]["dimension"] == "emails"


@respx.mock
def test_update_keeps_a_declaration_it_leaves_out_and_removes_one_set_to_none() -> None:
    route = respx.patch(f"{ACTIONS}/send-email").mock(return_value=_ok(ACTION))
    with Client(api_key="anlyon_live_test") as client:
        client.actions.update("send-email", description="Sends one email.")
        client.actions.update("send-email", description="Sends one email.", impact=None)
        client.actions.update("send-email", verify=VERIFY, governed=True)
    bodies = [json.loads(call.request.content) for call in route.calls]
    assert bodies == [
        {"description": "Sends one email."},
        {"description": "Sends one email.", "impact": None},
        {"verify": VERIFY, "governed": True},
    ]


@respx.mock
def test_invoke_and_invocation_read_carry_the_grade() -> None:
    respx.post(f"{ACTIONS}/send-email/invoke").mock(
        return_value=_ok({"invocationId": "inv_1", "effectId": "eff_1", "status": "succeeded", "grade": "confirmed", "pendingApproval": False})
    )
    respx.get(f"{ACTIONS}/invocations/inv_1").mock(
        return_value=_ok({"invocationId": "inv_1", "effectId": "eff_1", "status": "succeeded", "grade": "acknowledged"})
    )
    respx.post(f"{ACTIONS}/plain/invoke").mock(
        return_value=_ok({"invocationId": "inv_2", "status": "succeeded", "pendingApproval": False})
    )
    with Client(api_key="anlyon_live_test") as client:
        invoked = client.actions.invoke("send-email", {"to": ["a@example.com"]})
        read = client.actions.invocation("inv_1")
        plain = client.actions.invoke("plain")
    assert invoked.data["grade"] == "confirmed"
    assert read.data["grade"] == "acknowledged"
    assert "grade" not in plain.data
    assert invocation_tool_result(plain.data)["grade"] is None
    assert invocation_tool_result(invoked.data)["grade"] == "confirmed"


@respx.mock
def test_effects_filter_by_grade_and_every_effect_carries_one() -> None:
    listing = respx.get(f"{ACTIONS}/effects").mock(
        return_value=_ok(
            [{"id": "eff_1", "grade": "unknown", "outcome": "unknown"}],
            pagination={"total": 1, "page": 1, "limit": 5, "totalPages": 1, "hasMore": False},
        )
    )
    respx.get(f"{ACTIONS}/effects/eff_1").mock(return_value=_ok({"id": "eff_1", "grade": "refused"}))
    with Client(api_key="anlyon_live_test") as client:
        effects = client.actions.effects(grade="unknown", action="send-email", limit=5)
        client.actions.effects(unresolved=True)
        effect = client.actions.effect("eff_1")
    assert dict(listing.calls[0].request.url.params) == {"action": "send-email", "grade": "unknown", "limit": "5"}
    assert dict(listing.calls[1].request.url.params) == {"unresolved": "true"}
    assert [e["grade"] for e in effects.data] == ["unknown"]
    assert effects.pagination["hasMore"] is False
    assert effect.data["grade"] == "refused"


@respx.mock
def test_impact_limit_in_a_declared_unit() -> None:
    limit = {"id": "lim_1", "name": "Daily emails", "dimension": "emails", "currency": None, "unit": "emails"}
    create = respx.post(LIMITS).mock(return_value=_ok(limit))
    respx.get(LIMITS).mock(return_value=_ok([limit, {"id": "lim_2", "dimension": "money", "currency": "usd", "unit": "usd"}]))
    with Client(api_key="anlyon_live_test") as client:
        created = client.impact_limits.create(name="Daily emails", dimension="emails", period="day", amount=500)
        client.impact_limits.create(name="Daily rows", dimension="rows", unit="rows", period="day", amount=1000)
        listed = client.impact_limits.list()
    assert json.loads(create.calls[0].request.content) == {
        "name": "Daily emails",
        "dimension": "emails",
        "period": "day",
        "amount": 500,
    }
    assert json.loads(create.calls[1].request.content) == {
        "name": "Daily rows",
        "dimension": "rows",
        "period": "day",
        "amount": 1000,
        "unit": "rows",
    }
    assert created.data["unit"] == "emails"
    assert [item["unit"] for item in listed.data] == ["emails", "usd"]


@pytest.mark.asyncio
@respx.mock
async def test_async_twins() -> None:
    create = respx.post(ACTIONS).mock(return_value=_ok(ACTION))
    patch = respx.patch(f"{ACTIONS}/send-email").mock(return_value=_ok(ACTION))
    effects = respx.get(f"{ACTIONS}/effects").mock(return_value=_ok([{"id": "eff_1", "grade": "denied"}]))
    respx.post(f"{ACTIONS}/send-email/invoke").mock(return_value=_ok({"effectId": "eff_1", "grade": "pending"}))
    limits = respx.post(LIMITS).mock(return_value=_ok({"unit": "emails"}))
    async with AsyncClient(api_key="anlyon_live_test") as client:
        await client.actions.create(name="send-email", url_template="https://api.example.com/v1/messages", impact=IMPACT)
        declared = await client.actions.declare("send-email", verify=VERIFY)
        await client.actions.declare("send-email", impact=None)
        await client.actions.update("send-email", enabled=False, verify=None)
        listed = await client.actions.effects(grade="denied")
        invoked = await client.actions.invoke("send-email", {"to": ["a@example.com"]})
        limit = await client.impact_limits.create(name="Daily emails", dimension="emails", unit="emails", period="day", amount=500)
    assert json.loads(create.calls[0].request.content) == {
        "name": "send-email",
        "urlTemplate": "https://api.example.com/v1/messages",
        "impact": IMPACT,
    }
    assert [json.loads(call.request.content) for call in patch.calls] == [
        {"verify": VERIFY},
        {"impact": None},
        {"enabled": False, "verify": None},
    ]
    assert dict(effects.calls[0].request.url.params) == {"grade": "denied"}
    assert declared.data["governed"] is True
    assert listed.data[0]["grade"] == "denied"
    assert invoked.data["grade"] == "pending"
    assert json.loads(limits.calls[0].request.content)["unit"] == "emails"
    assert limit.data["unit"] == "emails"


def test_tool_description_carries_the_declared_impact_and_nothing_otherwise() -> None:
    assert impact_sentence(ACTION["impact"]) == "Declared impact: emails. Each call counts toward any shared limit set for this environment."  # type: ignore[arg-type]
    assert (
        impact_sentence({"dimension": "money", "unit": "usd", "amount": "input.amount", "bound": "exact"})
        == "Declared impact: money in USD. Each call counts toward any shared limit set for this environment."
    )
    assert (
        impact_sentence({"dimension": "resource_mutations", "unit": "resource_mutations", "amount": "1", "bound": "upper_bound"})
        == "Declared impact: resource mutations. Each call counts toward any shared limit set for this environment."
    )
    assert impact_sentence(None) is None
    assert action_tool_description(ACTION) == "Sends an email. Declared impact: emails. Each call counts toward any shared limit set for this environment."
    assert action_tool_description({"name": "plain", "description": "Pings.", "impact": None}) == "Pings."
    assert action_tool_description({"name": "plain", "description": None}) == "Invoke the Anlyon action plain."
    assert action_tool_input_schema({"inputSchema": None}) == {"type": "object", "properties": {}}
