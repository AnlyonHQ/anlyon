"""Acting for your users: for_user(), end_users, the end-user errors and the confirm step."""

import json

import httpx
import pytest
import respx

from anlyon import (
    AnlyonError,
    AsyncClient,
    Client,
    EndUserConnectionRequiredError,
    EndUserMismatchError,
    EndUserNotConnectedError,
    EndUserReconnectRequiredError,
    EndUserRequiredError,
    RedirectUrlRequiredError,
    RetryConfig,
    is_valid_end_user_id,
    parse_connect_redirect,
)

API = "https://api.anlyon.com/api/v2"
CONNECT = {
    "integration": "gmail",
    "endUserId": "user_42",
    "connectUrl": "https://connect.anlyon.com/l/cl_abc",
    "expiresAt": "2026-10-24T12:10:00.000Z",
}


def _ok(data) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": data})


def _err(status: int, code: str, details=None) -> httpx.Response:
    error = {"code": code, "message": code.lower()}
    if details is not None:
        error["details"] = details
    return httpx.Response(status, json={"success": False, "error": error})


def _end_user(route: respx.Route, index: int = 0) -> str | None:
    return route.calls[index].request.headers.get("Anlyon-End-User")


@respx.mock
def test_bound_client_sends_the_header_and_the_parent_never_does() -> None:
    invoke = respx.post(f"{API}/actions/gmail-send-email/invoke").mock(
        return_value=_ok({"status": "succeeded", "pendingApproval": False})
    )
    with Client(api_key="anlyon_live_test") as client:
        bound = client.for_user("user_42")
        bound.actions.invoke("gmail-send-email", {"to": ["a@example.com"]})
        client.actions.invoke("gmail-send-email", {"to": ["a@example.com"]})
        assert bound.end_user_id == "user_42"
        assert client.end_user_id is None
    assert _end_user(invoke, 0) == "user_42"
    assert _end_user(invoke, 1) is None


@respx.mock
def test_two_end_users_stay_apart() -> None:
    invoke = respx.post(f"{API}/actions/x/invoke").mock(return_value=_ok({"status": "succeeded"}))
    with Client(api_key="anlyon_live_test") as client:
        a, b = client.for_user("user_a"), client.for_user("user_b")
        a.actions.invoke("x", {})
        b.actions.invoke("x", {})
        a.actions.invoke("x", {})
    assert [_end_user(invoke, i) for i in range(3)] == ["user_a", "user_b", "user_a"]


@pytest.mark.parametrize(
    "bad", ["", "a b", "user/42", "ü", "x" * 129, "a\r\nX-Injected: 1", None, 42]
)
def test_for_user_checks_the_id_before_sending(bad) -> None:
    with Client(api_key="anlyon_live_test") as client, pytest.raises(AnlyonError) as info:
        client.for_user(bad)
    assert info.value.code == "VALIDATION_ERROR"


def test_good_ids() -> None:
    for good in ["u", "user_42", "auth0:abc", "jane@example.com", "A.b-c_d:e@f", "x" * 128]:
        assert is_valid_end_user_id(good)


def test_binding_is_fixed() -> None:
    with Client(api_key="anlyon_live_test") as client:
        bound = client.for_user("user_a")
        assert bound.for_user("user_a") is bound
        with pytest.raises(AnlyonError, match="cannot be switched"):
            bound.for_user("user_b")
        with pytest.raises(AttributeError):
            bound.end_user_id = "user_b"  # type: ignore[misc]
        assert bound.end_user_id == "user_a"


def test_closing_a_bound_client_leaves_the_parent_open() -> None:
    client = Client(api_key="anlyon_live_test")
    bound = client.for_user("user_a")
    bound.close()
    assert not client._http._client.is_closed
    client.close()
    assert client._http._client.is_closed


@pytest.mark.parametrize("name", ["Anlyon-End-User", "anlyon-end-user", "ANLYON-END-USER"])
def test_default_headers_cannot_name_an_end_user(name: str) -> None:
    with pytest.raises(AnlyonError, match="for_user"):
        Client(api_key="anlyon_live_test", default_headers={name: "user_42"})


@respx.mock
def test_a_bound_client_refuses_another_end_user_before_sending() -> None:
    route = respx.route().mock(return_value=_ok({}))
    with Client(api_key="anlyon_live_test") as client:
        bound = client.for_user("user_a")
        with pytest.raises(AnlyonError, match="different end user"):
            bound.end_users.list_connections("user_b")
        with pytest.raises(AnlyonError, match="different end user"):
            bound.end_users.approvals.decide("user_b", "apr_1", decision="approve")
        with pytest.raises(AnlyonError, match="different end user"):
            bound.end_users.confirm_connection("user_b", "flow_1")
        with pytest.raises(AnlyonError, match="cannot list the others"):
            bound.end_users.list()
    assert not route.called


@respx.mock
def test_connect_link_with_and_without_a_redirect() -> None:
    link = {"url": "https://connect.anlyon.com/l/cl_abc", "expiresAt": "2026-10-24T12:10:00Z"}
    first = respx.post(f"{API}/end-users/user_42/connect-links").mock(return_value=_ok(link))
    second = respx.post(f"{API}/end-users/jane%40example.com/connect-links").mock(
        return_value=_ok(link)
    )
    with Client(api_key="anlyon_live_test") as client:
        result = client.end_users.create_connect_link(
            end_user_id="user_42", integration="gmail", redirect_url="https://app.example.com/cb"
        )
        client.end_users.create_connect_link(end_user_id="jane@example.com", integration="slack")
    assert result.data == link
    assert json.loads(first.calls[0].request.content) == {
        "integration": "gmail",
        "redirectUrl": "https://app.example.com/cb",
    }
    assert json.loads(second.calls[0].request.content) == {"integration": "slack"}
    assert _end_user(first) == "user_42"
    assert _end_user(second) == "jane@example.com"


@respx.mock
def test_connections_and_erase() -> None:
    connection = {"integration": "notion", "status": "active", "scopes": []}
    put = respx.put(f"{API}/end-users/user_42/connections/notion").mock(
        return_value=_ok(connection)
    )
    listed = respx.get(f"{API}/end-users/user_42/connections").mock(return_value=_ok([connection]))
    deleted = respx.delete(f"{API}/end-users/user_42/connections/notion").mock(
        return_value=_ok({"deleted": True})
    )
    erasure = {
        "connectionsDeleted": 1,
        "approvalsCancelled": 2,
        "countersCleared": 3,
        "erasedAs": "eu_erased_0000",
    }
    erased = respx.delete(f"{API}/end-users/user_42").mock(return_value=_ok(erasure))
    with Client(api_key="anlyon_live_test") as client:
        assert (
            client.end_users.set_connection("user_42", "notion", token="fixture").data == connection
        )
        assert client.end_users.list_connections("user_42").data == [connection]
        assert client.end_users.delete_connection("user_42", "notion").data == {"deleted": True}
        assert client.end_users.erase("user_42").data == erasure
    assert json.loads(put.calls[0].request.content) == {"token": "fixture"}
    for route in (put, listed, deleted, erased):
        assert _end_user(route) == "user_42"


_PAGE = {
    "success": True,
    "data": [],
    "pagination": {"page": 1, "limit": 20, "total": 0, "totalPages": 0, "hasMore": False},
}


@respx.mock
def test_lists_take_acting_for_end_user_id_and_decider() -> None:
    invocations = respx.get(f"{API}/actions/invocations").mock(
        return_value=httpx.Response(200, json=_PAGE)
    )
    per_action = respx.get(f"{API}/actions/gmail-send/invocations").mock(
        return_value=httpx.Response(200, json=_PAGE)
    )
    effects = respx.get(f"{API}/actions/effects").mock(return_value=httpx.Response(200, json=_PAGE))
    approvals = respx.get(f"{API}/approvals").mock(return_value=httpx.Response(200, json=_PAGE))
    with Client(api_key="anlyon_live_test") as client:
        client.actions.invocations(acting_for="end_users", end_user_id="user_42")
        client.actions.invocations_for("gmail-send", acting_for="workspace", status="unknown")
        client.actions.effects(acting_for="end_users", end_user_id="user_42")
        client.approvals.list(acting_for="workspace", decider="end_user", end_user_id="user_42")
    assert dict(invocations.calls[0].request.url.params) == {"actingFor": "end_users", "endUserId": "user_42"}
    assert dict(per_action.calls[0].request.url.params) == {"actingFor": "workspace", "status": "unknown"}
    assert dict(effects.calls[0].request.url.params) == {"actingFor": "end_users", "endUserId": "user_42"}
    assert dict(approvals.calls[0].request.url.params) == {
        "actingFor": "workspace",
        "decider": "end_user",
        "endUserId": "user_42",
    }


@pytest.mark.asyncio
@respx.mock
async def test_async_lists_take_acting_for() -> None:
    invocations = respx.get(f"{API}/actions/invocations").mock(
        return_value=httpx.Response(200, json=_PAGE)
    )
    effects = respx.get(f"{API}/actions/effects").mock(return_value=httpx.Response(200, json=_PAGE))
    approvals = respx.get(f"{API}/approvals").mock(return_value=httpx.Response(200, json=_PAGE))
    async with AsyncClient(api_key="anlyon_live_test") as client:
        await client.actions.invocations(acting_for="workspace")
        await client.actions.effects(acting_for="end_users", end_user_id="user_42")
        await client.approvals.list(decider="team", acting_for="end_users")
    assert dict(invocations.calls[0].request.url.params) == {"actingFor": "workspace"}
    assert dict(effects.calls[0].request.url.params) == {"actingFor": "end_users", "endUserId": "user_42"}
    assert dict(approvals.calls[0].request.url.params) == {"decider": "team", "actingFor": "end_users"}


@respx.mock
def test_policy_decided_by_on_create_and_update() -> None:
    created = respx.post(f"{API}/approval-policies").mock(return_value=_ok({"id": "apol_1"}))
    updated = respx.patch(f"{API}/approval-policies/apol_1").mock(return_value=_ok({"id": "apol_1"}))
    with Client(api_key="anlyon_live_test") as client:
        client.approval_policies.create(
            name="Users approve their own emails",
            match_kind="action",
            match_action_name="gmail-send",
            decided_by="end_user",
        )
        client.approval_policies.update("apol_1", decided_by="team")
        client.approval_policies.update("apol_1", enabled=True)
    assert json.loads(created.calls[0].request.content)["decidedBy"] == "end_user"
    assert json.loads(updated.calls[0].request.content) == {"decidedBy": "team"}
    assert "decidedBy" not in json.loads(updated.calls[1].request.content)


@respx.mock
def test_a_successful_response_carries_the_request_id() -> None:
    respx.get(f"{API}/actions/invocations/inv_1").mock(
        return_value=httpx.Response(
            200,
            json={"success": True, "data": {"id": "inv_1"}},
            headers={"x-request-id": "req_fixture_1"},
        )
    )
    with Client(api_key="anlyon_live_test") as client:
        result = client.actions.invocation("inv_1")
    assert result.request_id == "req_fixture_1"
    assert result.data == {"id": "inv_1"}


@respx.mock
def test_list_end_users_by_cursor() -> None:
    page = {
        "success": True,
        "data": [{"endUserId": "user_42", "connections": 2, "invocations": 5, "pendingApprovals": 1}],
        "pagination": {"nextCursor": "c_2"},
    }
    route = respx.get(f"{API}/end-users").mock(return_value=httpx.Response(200, json=page))
    with Client(api_key="anlyon_live_test") as client:
        result = client.end_users.list(cursor="c_1")
    assert result.pagination == {"nextCursor": "c_2"}
    assert route.calls[0].request.url.params["cursor"] == "c_1"
    assert _end_user(route) is None


@respx.mock
def test_end_user_approvals() -> None:
    listed = respx.get(f"{API}/end-users/user_42/approvals").mock(return_value=_ok([]))
    decided = respx.post(f"{API}/end-users/user_42/approvals/apr_1/decide").mock(
        return_value=_ok({"approval": {"id": "apr_1", "status": "denied"}})
    )
    with Client(api_key="anlyon_live_test") as client:
        client.end_users.approvals.list("user_42", status="pending")
        client.end_users.approvals.decide(
            "user_42", "apr_1", decision="deny", reason="Not this one"
        )
    assert listed.calls[0].request.url.params["status"] == "pending"
    assert json.loads(decided.calls[0].request.content) == {
        "decision": "deny",
        "reason": "Not this one",
    }
    assert _end_user(listed) == _end_user(decided) == "user_42"


@respx.mock
def test_set_connection_with_fields() -> None:
    fields = {"subdomain": "acme", "email": "ana@acme.test", "apiToken": "fixture"}
    put = respx.put(f"{API}/end-users/user_42/connections/zendesk").mock(
        return_value=_ok({"integration": "zendesk", "status": "active", "scopes": []})
    )
    with Client(api_key="anlyon_live_test") as client:
        client.end_users.set_connection("user_42", "zendesk", fields=fields)
        with pytest.raises(AnlyonError, match="not both"):
            client.end_users.set_connection("user_42", "zendesk", token="fixture", fields=fields)
        with pytest.raises(AnlyonError, match="fields is required"):
            client.end_users.set_connection("user_42", "zendesk", fields={})
        with pytest.raises(AnlyonError, match="apiToken"):
            client.end_users.set_connection("user_42", "zendesk", fields={**fields, "apiToken": ""})
    assert len(put.calls) == 1
    assert json.loads(put.calls[0].request.content) == {"fields": fields}
    assert _end_user(put) == "user_42"


@pytest.mark.asyncio
@respx.mock
async def test_async_set_connection_with_fields() -> None:
    fields = {"site": "acme", "email": "ana@acme.test", "apiToken": "fixture"}
    put = respx.put(f"{API}/end-users/user_42/connections/jira").mock(
        return_value=_ok({"integration": "jira", "status": "active", "scopes": []})
    )
    async with AsyncClient(api_key="anlyon_live_test") as client:
        await client.end_users.set_connection("user_42", "jira", fields=fields)
    assert json.loads(put.calls[0].request.content) == {"fields": fields}


SESSION = {
    "token": "eus_v1.e30.sig",
    "expiresAt": "2026-10-26T12:15:00Z",
    "endUserId": "user_42",
    "capabilities": ["connections", "approvals"],
}


@respx.mock
def test_create_session_with_and_without_a_lifetime() -> None:
    first = respx.post(f"{API}/end-users/user_42/sessions").mock(return_value=_ok(SESSION))
    second = respx.post(f"{API}/end-users/jane%40example.com/sessions").mock(
        return_value=_ok(SESSION)
    )
    with Client(api_key="anlyon_live_test") as client:
        result = client.end_users.create_session("user_42")
        client.end_users.create_session("jane@example.com", ttl_seconds=300)
    assert result.data == SESSION
    assert json.loads(first.calls[0].request.content) == {}
    assert json.loads(second.calls[0].request.content) == {"ttlSeconds": 300}
    assert _end_user(first) == "user_42"
    assert _end_user(second) == "jane@example.com"


@pytest.mark.asyncio
@respx.mock
async def test_async_create_session() -> None:
    route = respx.post(f"{API}/end-users/user_42/sessions").mock(return_value=_ok(SESSION))
    async with AsyncClient(api_key="anlyon_live_test") as client:
        result = await client.end_users.create_session("user_42", ttl_seconds=120)
    assert result.data == SESSION
    assert json.loads(route.calls[0].request.content) == {"ttlSeconds": 120}


@pytest.mark.parametrize("ttl", [59, 3601, 90.5, True])
def test_create_session_refuses_a_lifetime_outside_the_range(ttl) -> None:
    with (
        Client(api_key="anlyon_live_test") as client,
        pytest.raises(AnlyonError, match="ttl_seconds"),
    ):
        client.end_users.create_session("user_42", ttl_seconds=ttl)


def test_malformed_input_is_refused_before_sending() -> None:
    with Client(api_key="anlyon_live_test") as client:
        with pytest.raises(AnlyonError):
            client.end_users.list_connections("../admin")
        with pytest.raises(AnlyonError, match="integration"):
            client.end_users.create_connect_link(end_user_id="user_42", integration="")
        with pytest.raises(AnlyonError, match="token"):
            client.end_users.set_connection("user_42", "notion", token="")
        with pytest.raises(AnlyonError, match="approve"):
            client.end_users.approvals.decide("user_42", "apr_1", decision="maybe")  # type: ignore[arg-type]
        with pytest.raises(AnlyonError, match="flow_id"):
            client.end_users.confirm_connection("user_42", "")


@respx.mock
def test_confirm_connection_and_connections_confirm() -> None:
    route = respx.post(f"{API}/end-users/user_42/connections/confirm").mock(
        return_value=_ok({"integration": "gmail", "status": "active"})
    )
    with Client(api_key="anlyon_live_test") as client:
        assert client.end_users.confirm_connection("user_42", "flow_1").data == {
            "integration": "gmail",
            "status": "active",
        }
        client.for_user("user_42").connections.confirm("flow_2")
        with pytest.raises(AnlyonError, match="for_user"):
            client.connections.confirm("flow_3")
    assert [json.loads(c.request.content) for c in route.calls] == [
        {"flowId": "flow_1"},
        {"flowId": "flow_2"},
    ]
    assert _end_user(route, 0) == _end_user(route, 1) == "user_42"


def test_parse_connect_redirect() -> None:
    parsed = parse_connect_redirect(
        "https://app.example.com/cb?anlyon_status=pending_confirmation&anlyon_flow=flow_1"
        "&integration=gmail&end_user=someone_else"
    )
    assert parsed is not None
    assert (parsed.status, parsed.flow_id, parsed.integration) == (
        "pending_confirmation",
        "flow_1",
        "gmail",
    )
    assert not hasattr(parsed, "end_user_id")
    declined = parse_connect_redirect("anlyon_status=declined&integration=gmail")
    assert declined is not None and declined.flow_id is None
    assert parse_connect_redirect("/cb?anlyon_status=error") is not None
    assert parse_connect_redirect("https://app.example.com/cb") is None
    assert parse_connect_redirect("https://app.example.com/cb?anlyon_status=hacked") is None


@respx.mock
def test_not_connected_maps_to_a_typed_error_and_is_not_retried() -> None:
    route = respx.post(f"{API}/actions/gmail-send-email/invoke").mock(
        return_value=_err(409, "END_USER_NOT_CONNECTED", CONNECT)
    )
    retry = RetryConfig(max_attempts=3, initial_delay=0)
    with (
        Client(api_key="anlyon_live_test", retry=retry) as c,
        pytest.raises(EndUserNotConnectedError) as info,
    ):
        c.for_user("user_42").actions.invoke("gmail-send-email", {})
    error = info.value
    assert isinstance(error, EndUserConnectionRequiredError)
    assert error.status == 409
    assert (error.integration, error.end_user_id, error.connect_url, error.expires_at) == (
        "gmail",
        "user_42",
        CONNECT["connectUrl"],
        CONNECT["expiresAt"],
    )
    assert route.call_count == 1


@respx.mock
def test_the_other_end_user_errors() -> None:
    respx.post(f"{API}/actions/a/invoke").mock(
        return_value=_err(409, "END_USER_RECONNECT_REQUIRED", CONNECT)
    )
    respx.post(f"{API}/actions/b/invoke").mock(return_value=_err(400, "END_USER_REQUIRED"))
    respx.post(f"{API}/actions/c/invoke").mock(
        return_value=_err(409, "END_USER_NOT_CONNECTED", {"integration": "gmail"})
    )
    respx.post(f"{API}/end-users/user_42/connections/confirm").mock(
        return_value=_err(403, "END_USER_MISMATCH")
    )
    respx.post(f"{API}/end-users/user_42/connect-links").mock(
        return_value=_err(400, "REDIRECT_URL_REQUIRED")
    )
    with Client(api_key="anlyon_live_test") as client:
        with pytest.raises(EndUserReconnectRequiredError) as reconnect:
            client.actions.invoke("a", {})
        assert not isinstance(reconnect.value, EndUserNotConnectedError)
        with pytest.raises(EndUserRequiredError):
            client.actions.invoke("b", {})
        with pytest.raises(EndUserNotConnectedError) as no_url:
            client.actions.invoke("c", {})
        assert no_url.value.connect_url is None
        with pytest.raises(EndUserMismatchError):
            client.end_users.confirm_connection("user_42", "flow_1")
        with pytest.raises(RedirectUrlRequiredError):
            client.end_users.create_connect_link(end_user_id="user_42", integration="gmail")


@respx.mock
async def test_async_for_user_and_end_users() -> None:
    invoke = respx.post(f"{API}/actions/x/invoke").mock(return_value=_ok({"status": "succeeded"}))
    confirm = respx.post(f"{API}/end-users/user_42/connections/confirm").mock(
        return_value=_ok({"integration": "gmail", "status": "active"})
    )
    approvals = respx.get(f"{API}/end-users/user_42/approvals").mock(return_value=_ok([]))
    async with AsyncClient(api_key="anlyon_live_test") as client:
        bound = client.for_user("user_42")
        await bound.actions.invoke("x", {})
        await client.actions.invoke("x", {})
        await bound.connections.confirm("flow_1")
        await client.end_users.approvals.list("user_42")
        with pytest.raises(AnlyonError, match="cannot list the others"):
            await bound.end_users.list()
        await bound.close()
        assert not client._http._client.is_closed
    assert [_end_user(invoke, i) for i in range(2)] == ["user_42", None]
    assert _end_user(confirm) == _end_user(approvals) == "user_42"
