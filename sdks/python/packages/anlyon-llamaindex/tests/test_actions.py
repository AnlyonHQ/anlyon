import json
import re

import httpx
import respx
from anlyon_llamaindex import action_tools

from anlyon import Client, EndUserRequiredError

ACTIONS = "https://api.anlyon.com/api/v2/actions"
INPUT_SCHEMA = {
    "type": "object",
    "properties": {"to": {"type": "array", "items": {"type": "string"}}, "subject": {"type": "string"}},
    "required": ["to"],
}
LISTED = [
    {
        "name": "send-email",
        "description": "Sends an email.",
        "enabled": True,
        "inputSchema": INPUT_SCHEMA,
        "governed": True,
        "impact": {"dimension": "emails", "unit": "emails", "amount": "count(input.to)", "bound": "exact"},
        "verify": None,
    },
    {"name": "lookup-order", "description": "Reads an order.", "enabled": True, "inputSchema": None, "governed": False, "impact": None, "verify": None},
    {"name": "retired", "description": "Off.", "enabled": False, "inputSchema": None, "governed": False, "impact": None, "verify": None},
]


def _ok(data) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": data})


@respx.mock
def test_description_carries_the_declared_impact_only_when_one_is_declared() -> None:
    respx.get(ACTIONS).mock(return_value=_ok(LISTED))
    with Client(api_key="anlyon_live_test") as client:
        tools = action_tools(client)
    assert [tool.metadata.name for tool in tools] == ["send-email", "lookup-order"]
    assert tools[0].metadata.description == "Sends an email. Declared impact: emails. Each call counts toward any shared limit set for this environment."
    assert tools[1].metadata.description == "Reads an order."
    assert tools[0].metadata.get_parameters_dict() == INPUT_SCHEMA
    assert tools[0].metadata.to_openai_tool()["function"]["parameters"] == INPUT_SCHEMA
    assert tools[1].metadata.get_parameters_dict() == {"type": "object", "properties": {}}


@respx.mock
def test_tool_invokes_the_action_and_returns_the_grade() -> None:
    respx.get(ACTIONS).mock(return_value=_ok(LISTED))
    governed = respx.post(f"{ACTIONS}/send-email/invoke").mock(
        return_value=_ok({"invocationId": "inv_1", "effectId": "eff_1", "status": "succeeded", "grade": "confirmed", "pendingApproval": False})
    )
    template = respx.post(f"{ACTIONS}/lookup-order/invoke").mock(
        return_value=_ok({"invocationId": "inv_2", "status": "succeeded", "pendingApproval": False})
    )
    with Client(api_key="anlyon_live_test") as client:
        send, lookup = action_tools(client, names=["send-email", "lookup-order"])
        sent = send.call(to=["a@example.com"], subject="Hi")
        looked = lookup.call()
    assert json.loads(governed.calls[0].request.content) == {"input": {"to": ["a@example.com"], "subject": "Hi"}}
    assert json.loads(template.calls[0].request.content) == {"input": {}}
    assert sent.raw_output["grade"] == "confirmed"
    assert sent.raw_output["status"] == "succeeded"
    assert "confirmed" in str(sent)
    assert looked.raw_output["grade"] is None


@respx.mock
def test_a_gated_action_returns_the_approval_and_a_pending_grade() -> None:
    respx.get(ACTIONS).mock(return_value=_ok(LISTED))
    respx.post(f"{ACTIONS}/send-email/invoke").mock(
        return_value=_ok({"invocationId": "inv_3", "effectId": "eff_3", "status": "pending_approval", "grade": "pending", "pendingApproval": True, "approvalId": "apr_1"})
    )
    with Client(api_key="anlyon_live_test") as client:
        (send,) = action_tools(client, names=["send-email"])
        result = send.call(to=["a@example.com"])
    assert result.raw_output["pendingApproval"] is True
    assert result.raw_output["approvalId"] == "apr_1"
    assert result.raw_output["grade"] == "pending"


CONNECT = {
    "integration": "gmail",
    "endUserId": "user_42",
    "connectUrl": "https://connect.anlyon.com/l/cl_abc",
    "expiresAt": "2026-10-24T12:10:00.000Z",
}


def _err(status: int, code: str, details=None) -> httpx.Response:
    return httpx.Response(status, json={"success": False, "error": {"code": code, "message": code, "details": details}})


def _property_names(schema, into=None):
    into = [] if into is None else into
    if isinstance(schema, list):
        for item in schema:
            _property_names(item, into)
    elif isinstance(schema, dict):
        for key, value in schema.items():
            if key == "properties" and isinstance(value, dict):
                into.extend(value)
            _property_names(value, into)
    return into


@respx.mock
def test_a_for_user_tool_acts_for_the_end_user_and_returns_connect_required() -> None:
    respx.get(ACTIONS).mock(return_value=_ok(LISTED))
    invoke = respx.post(f"{ACTIONS}/send-email/invoke").mock(
        side_effect=[_err(409, "END_USER_NOT_CONNECTED", CONNECT), _err(409, "END_USER_RECONNECT_REQUIRED", CONNECT)]
    )
    with Client(api_key="anlyon_live_test") as client:
        (send,) = action_tools(client.for_user("user_42"), names=["send-email"])
        first = send.call(to=["a@example.com"]).raw_output
        second = send.call(to=["a@example.com"]).raw_output
    assert invoke.calls[0].request.headers["Anlyon-End-User"] == "user_42"
    assert first == {
        "status": "connect_required",
        "integration": "gmail",
        "connectUrl": CONNECT["connectUrl"],
        "message": "The user has not connected gmail yet, so nothing was done. Ask them to connect it, then try again.",
    }
    assert second["status"] == "reconnect_required"
    assert second["connectUrl"] == CONNECT["connectUrl"]


@respx.mock
def test_other_errors_still_raise() -> None:
    respx.get(ACTIONS).mock(return_value=_ok(LISTED))
    respx.post(f"{ACTIONS}/send-email/invoke").mock(return_value=_err(400, "END_USER_REQUIRED"))
    with Client(api_key="anlyon_live_test") as client:
        (send,) = action_tools(client, names=["send-email"])
        try:
            send.call(to=["a@example.com"])
        except EndUserRequiredError:
            pass
        else:
            raise AssertionError("END_USER_REQUIRED should raise")


@respx.mock
def test_no_tool_schema_has_an_end_user_field() -> None:
    respx.get(ACTIONS).mock(return_value=_ok(LISTED))
    with Client(api_key="anlyon_live_test") as client:
        plain = action_tools(client)
        bound = action_tools(client.for_user("user_42"))
    for tools in (plain, bound):
        for tool in tools:
            names = _property_names(tool.metadata.get_parameters_dict())
            assert [n for n in names if re.search(r"end[\W_]*user|anlyon[\W_]*end", n, re.IGNORECASE)] == [], names
    assert [t.metadata.get_parameters_dict() for t in bound] == [t.metadata.get_parameters_dict() for t in plain]
