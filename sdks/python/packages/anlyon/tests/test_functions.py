"""Hosted functions: create, list, publish, run (plan, then apply) and runs.get, for_user included."""

import json

import httpx
import pytest
import respx

from anlyon import AnlyonError, AsyncClient, Client

API = "https://api.anlyon.com/api/v2"

VERSION = {
    "id": "fnv_1",
    "version": 1,
    "language": "javascript",
    "digest": "sha256:abc",
    "allowedActions": ["lookup-order", "refund"],
    "inputSchema": {},
    "budgets": {"maxActionCalls": 50, "maxCpuMs": 1000, "maxSubrequests": 100, "timeoutMs": 30000},
    "straightThrough": None,
    "createdAt": "2026-10-24T12:00:00.000Z",
}
FUNCTION = {
    "id": "fn_1",
    "name": "refund-with-checks",
    "description": None,
    "environmentId": "123e4567-e89b-42d3-a456-426614174000",
    "currentVersion": VERSION,
    "createdAt": "2026-10-24T12:00:00.000Z",
    "updatedAt": "2026-10-24T12:00:00.000Z",
}
PLANNED = {
    "id": "frn_plan",
    "functionId": "fn_1",
    "functionName": "refund-with-checks",
    "functionVersionId": "fnv_1",
    "mode": "plan",
    "status": "awaiting_approval",
    "endUserId": None,
    "input": {"order": "ord_123"},
    "inputDigest": "sha256:in",
    "output": None,
    "error": None,
    "logs": [],
    "budget": None,
    "actionCalls": 1,
    "calls": [],
    "plan": {
        "digest": "sha256:plan",
        "writes": [{"sequence": 2, "action": "refund", "input": {"order": "ord_123"}}],
        "approval": {"id": "apr_1", "status": "pending", "decider": "team"},
        "appliedByRunId": None,
    },
    "planRunId": None,
    "planDigest": None,
    "approvalId": None,
    "receipt": None,
    "durationMs": 12,
    "createdAt": "2026-10-24T12:00:00.000Z",
    "finishedAt": "2026-10-24T12:00:00.012Z",
}
APPLIED = {
    **PLANNED,
    "id": "frn_apply",
    "mode": "apply",
    "status": "succeeded",
    "plan": None,
    "planRunId": "frn_plan",
    "planDigest": "sha256:plan",
    "approvalId": "apr_1",
}


def _ok(data) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": data})


def _body(route: respx.Route, index: int = 0):
    return json.loads(route.calls[index].request.content)


def _header(route: respx.Route, name: str, index: int = 0) -> str | None:
    return route.calls[index].request.headers.get(name)


@respx.mock
def test_create_list_and_publish_request_shapes() -> None:
    create = respx.post(f"{API}/functions").mock(return_value=_ok(FUNCTION))
    listing = respx.get(f"{API}/functions").mock(return_value=_ok([FUNCTION]))
    publish = respx.post(f"{API}/functions/refund-with-checks/versions").mock(
        return_value=_ok({"function": FUNCTION, "version": VERSION})
    )
    with Client(api_key="anlyon_live_test") as client:
        client.functions.create(name="refund-with-checks")
        client.functions.create(name="refund-with-checks", description="Refund a paid order.")
        assert client.functions.list().data == [FUNCTION]
        published = client.functions.publish(
            "refund-with-checks",
            language="javascript",
            source="export default async function run(input, anlyon) {}",
            allowed_actions=["lookup-order", "refund"],
            input_schema={"type": "object"},
            budgets={"max_action_calls": 10, "timeout_ms": 5000},
            straight_through={"actions": ["refund"], "max_writes": 1},
        )
    assert _body(create, 0) == {"name": "refund-with-checks"}
    assert _body(create, 1) == {"name": "refund-with-checks", "description": "Refund a paid order."}
    assert listing.called
    assert _body(publish) == {
        "language": "javascript",
        "source": "export default async function run(input, anlyon) {}",
        "allowedActions": ["lookup-order", "refund"],
        "inputSchema": {"type": "object"},
        "budgets": {"maxActionCalls": 10, "timeoutMs": 5000},
        "straightThrough": {"actions": ["refund"], "maxWrites": 1},
    }
    for route in (create, publish):
        assert _header(route, "Idempotency-Key") is None
    assert published.data["version"]["id"] == "fnv_1"


@respx.mock
def test_publish_sends_null_straight_through_and_leaves_out_what_was_not_given() -> None:
    publish = respx.post(f"{API}/functions/fn_1/versions").mock(
        return_value=_ok({"function": FUNCTION, "version": VERSION})
    )
    with Client(api_key="anlyon_live_test") as client:
        client.functions.publish(
            "fn_1", language="python", source="def run(input, anlyon): pass", allowed_actions=[]
        )
        client.functions.publish(
            "fn_1",
            language="python",
            source="def run(input, anlyon): pass",
            allowed_actions=[],
            straight_through=None,
        )
        client.functions.publish("fn_1", language="python", source="def run(input, anlyon): pass")
    assert _body(publish, 2) == {"language": "python", "source": "def run(input, anlyon): pass"}
    assert _body(publish, 0) == {
        "language": "python",
        "source": "def run(input, anlyon): pass",
        "allowedActions": [],
    }
    assert _body(publish, 1)["straightThrough"] is None


@respx.mock
def test_plan_then_apply() -> None:
    run = respx.post(f"{API}/functions/refund-with-checks/runs").mock(
        side_effect=[_ok(PLANNED), _ok(APPLIED)]
    )
    get = respx.get(f"{API}/function-runs/frn_plan").mock(return_value=_ok(PLANNED))
    with Client(api_key="anlyon_live_test") as client:
        plan = client.functions.run("refund-with-checks", {"order": "ord_123"})
        assert plan.data["status"] == "awaiting_approval"
        assert plan.data["plan"]["approval"]["id"] == "apr_1"
        assert client.functions.runs.get(plan.data["id"]).data["id"] == "frn_plan"
        done = client.functions.run(
            "refund-with-checks", {"order": "ord_123"}, mode="apply", plan_run_id=plan.data["id"]
        )
    assert done.data["status"] == "succeeded"
    assert _body(run, 0) == {"input": {"order": "ord_123"}}
    assert _body(run, 1) == {"input": {"order": "ord_123"}, "mode": "apply", "planRunId": "frn_plan"}
    assert get.called
    assert _header(run, "Idempotency-Key", 1) is None


@respx.mock
def test_run_with_nothing_given_and_straight_through() -> None:
    run = respx.post(f"{API}/functions/f/runs").mock(return_value=_ok(PLANNED))
    with Client(api_key="anlyon_live_test") as client:
        client.functions.run("f")
        client.functions.run("f", mode="straight_through")
    assert _body(run, 0) == {}
    assert _body(run, 1) == {"mode": "straight_through"}


@pytest.mark.parametrize(
    "kwargs",
    [
        {"mode": "apply"},
        {"plan_run_id": "frn_1"},
        {"mode": "plan", "plan_run_id": "frn_1"},
        {"mode": "apply", "plan_run_id": ""},
    ],
)
@respx.mock
def test_apply_and_plan_run_id_go_together(kwargs) -> None:
    route = respx.post(f"{API}/functions/f/runs").mock(return_value=_ok(PLANNED))
    with Client(api_key="anlyon_live_test") as client, pytest.raises(AnlyonError) as info:
        client.functions.run("f", **kwargs)
    assert info.value.code == "VALIDATION_ERROR"
    assert not route.called


def test_malformed_names_are_refused_before_sending() -> None:
    with Client(api_key="anlyon_live_test") as client:
        for call in (
            lambda: client.functions.run(""),
            lambda: client.functions.runs.get(""),
            lambda: client.functions.create(name=""),
        ):
            with pytest.raises(AnlyonError):
                call()


@respx.mock
def test_version_history_one_version_and_run_history() -> None:
    versions = respx.get(f"{API}/functions/refund-with-checks/versions").mock(
        return_value=_ok([{**VERSION, "current": True}])
    )
    current = respx.get(f"{API}/functions/refund-with-checks/versions/current").mock(
        return_value=_ok({**VERSION, "current": True, "source": "def run(input, anlyon): pass"})
    )
    third = respx.get(f"{API}/functions/refund-with-checks/versions/3").mock(
        return_value=_ok({**VERSION, "current": False, "source": "x"})
    )
    runs = respx.get(f"{API}/functions/refund-with-checks/runs").mock(return_value=_ok([]))
    with Client(api_key="anlyon_live_test") as client:
        assert client.functions.list_versions("refund-with-checks").data[0]["current"] is True
        assert "run" in client.functions.get_version("refund-with-checks", "current").data["source"]
        client.functions.get_version("refund-with-checks", 3)
        client.functions.list_runs("refund-with-checks")
        client.functions.list_runs("refund-with-checks", limit=20, end_user_id="user_1")
    assert versions.called and current.called and third.called
    assert runs.calls[0].request.url.query == b""
    assert dict(runs.calls[1].request.url.params) == {"limit": "20", "endUserId": "user_1"}


@pytest.mark.parametrize("bad", [0, -1, 1.5, True, "latest"])
def test_get_version_refuses_a_bad_version_before_sending(bad) -> None:
    with Client(api_key="anlyon_live_test") as client, pytest.raises(AnlyonError):
        client.functions.get_version("refund-with-checks", bad)


@respx.mock
def test_names_and_ids_are_encoded_in_the_path() -> None:
    run = respx.post(f"{API}/functions/a%2Fb/runs").mock(return_value=_ok(PLANNED))
    get = respx.get(f"{API}/function-runs/frn_1%2Fx").mock(return_value=_ok(PLANNED))
    with Client(api_key="anlyon_live_test") as client:
        client.functions.run("a/b")
        client.functions.runs.get("frn_1/x")
    assert run.called and get.called


def test_function_runs_are_apart_from_agent_runs() -> None:
    with Client(api_key="anlyon_live_test") as client:
        assert client.functions is client.functions
        assert client.functions.runs is client.functions.runs
        assert client.functions.runs is not client.runs


@respx.mock
def test_for_user_runs_and_reads_for_the_end_user_and_the_parent_never_does() -> None:
    run = respx.post(f"{API}/functions/refund-with-checks/runs").mock(
        return_value=_ok({**PLANNED, "endUserId": "user_42"})
    )
    get = respx.get(f"{API}/function-runs/frn_plan").mock(return_value=_ok(PLANNED))
    with Client(api_key="anlyon_live_test") as client:
        bound = client.for_user("user_42")
        plan = bound.functions.run("refund-with-checks", {"order": "ord_123"})
        bound.functions.runs.get(plan.data["id"])
        bound.functions.run(
            "refund-with-checks", {"order": "ord_123"}, mode="apply", plan_run_id="frn_plan"
        )
        client.functions.run("refund-with-checks")
        client.functions.runs.get("frn_plan")
    assert [_header(run, "Anlyon-End-User", i) for i in range(3)] == ["user_42", "user_42", None]
    assert [_header(get, "Anlyon-End-User", i) for i in range(2)] == ["user_42", None]


@respx.mock
async def test_async_functions_and_for_user() -> None:
    create = respx.post(f"{API}/functions").mock(return_value=_ok(FUNCTION))
    listing = respx.get(f"{API}/functions").mock(return_value=_ok([FUNCTION]))
    publish = respx.post(f"{API}/functions/refund-with-checks/versions").mock(
        return_value=_ok({"function": FUNCTION, "version": VERSION})
    )
    run = respx.post(f"{API}/functions/refund-with-checks/runs").mock(
        side_effect=[_ok(PLANNED), _ok(APPLIED)]
    )
    get = respx.get(f"{API}/function-runs/frn_plan").mock(return_value=_ok(PLANNED))
    async with AsyncClient(api_key="anlyon_live_test") as client:
        await client.functions.create(name="refund-with-checks")
        await client.functions.list()
        await client.functions.publish(
            "refund-with-checks",
            language="javascript",
            source="export default async function run() {}",
            allowed_actions=["refund"],
            straight_through={"actions": ["refund"], "max_writes": 2},
        )
        bound = client.for_user("user_42")
        plan = await bound.functions.run("refund-with-checks", {"order": "ord_123"})
        await bound.functions.runs.get(plan.data["id"])
        await bound.functions.run(
            "refund-with-checks", {"order": "ord_123"}, mode="apply", plan_run_id="frn_plan"
        )
    assert create.called and listing.called
    assert _body(publish)["straightThrough"] == {"actions": ["refund"], "maxWrites": 2}
    assert _body(run, 1) == {"input": {"order": "ord_123"}, "mode": "apply", "planRunId": "frn_plan"}
    assert [_header(run, "Anlyon-End-User", i) for i in range(2)] == ["user_42", "user_42"]
    assert _header(get, "Anlyon-End-User") == "user_42"
    assert _header(create, "Anlyon-End-User") is None


@respx.mock
def test_delete_archives_by_name() -> None:
    route = respx.delete(f"{API}/functions/a%2Fb").mock(
        return_value=_ok({"deleted": True, "id": "fn_1", "name": "a/b"})
    )
    with Client(api_key="anlyon_live_test") as client:
        assert client.functions.delete("a/b").data == {"deleted": True, "id": "fn_1", "name": "a/b"}
    assert route.called


@respx.mock
async def test_async_delete() -> None:
    route = respx.delete(f"{API}/functions/refund").mock(
        return_value=_ok({"deleted": True, "id": "fn_1", "name": "refund"})
    )
    async with AsyncClient(api_key="anlyon_live_test") as client:
        await client.functions.delete("refund")
    assert route.called
