"""Policy governance against a REAL backend (real Postgres, real Redis, the real API).

Skipped unless ANLYON_E2E_BASE_URL is set. ``pnpm sdk:e2e`` in server stands up an isolated
backend, seeds credentials and runs this file and its TypeScript twin
(src/__tests__/real-backend.e2e.test.ts) with identical scenarios.
"""

from __future__ import annotations

import os
import secrets
from collections.abc import Callable, Iterator
from typing import Any

import pytest

from anlyon import AnlyonError, Client, ScopeCheckError

BASE_URL = os.environ.get("ANLYON_E2E_BASE_URL")
pytestmark = pytest.mark.skipif(not BASE_URL, reason="needs a real backend (ANLYON_E2E_BASE_URL)")

SUFFIX = secrets.token_hex(3)


def _status(fn: Callable[[], Any]) -> int:
    try:
        fn()
    except AnlyonError as error:
        assert error.status is not None
        return error.status
    return 200


@pytest.fixture(scope="module")
def clients() -> Iterator[dict[str, Client]]:
    def make(key: str) -> Client:
        return Client(api_key=key, base_url=BASE_URL)

    made = {
        "operator": make(os.environ["ANLYON_E2E_OPERATOR_KEY"]),
        "runtime": make(os.environ["ANLYON_E2E_RUNTIME_KEY"]),
        "narrow": make(os.environ["ANLYON_E2E_NARROW_KEY"]),
        "other": make(os.environ["ANLYON_E2E_OTHER_OPERATOR_KEY"]),
    }
    yield made
    for client in made.values():
        client.close()


def test_scoped_deny_affects_only_the_intended_action(clients: dict[str, Client]) -> None:
    operator, runtime = clients["operator"], clients["runtime"]
    read_action = os.environ["ANLYON_E2E_READ_ACTION"]
    refund_action = os.environ["ANLYON_E2E_REFUND_ACTION"]
    policy = operator.approval_policies.create(
        name=f"py_refund_denied_{SUFFIX}",
        match_kind="action",
        match_action_name=refund_action,
        effect="auto_deny",
    ).data
    assert policy["scope"] == "specific_action"
    assert policy["needsScopeReview"] is False and policy["version"] == 1

    assert runtime.actions.invoke(read_action, {}).data["status"] == "succeeded"

    refund = runtime.actions.invoke(refund_action, {}).data
    assert refund["status"] == "denied"
    assert refund["responseStatus"] is None and refund["body"] is None
    decision = refund["decision"]
    assert decision["source"] == "policy" and decision["code"] == "POLICY_DENIED"
    assert decision["effect"] == "denied"
    assert decision["policy"] == {"id": policy["id"], "name": policy["name"], "version": 1}

    operator.approval_policies.update(policy["id"], priority=9)
    operator.approval_policies.delete(policy["id"])
    assert runtime.actions.invocation(refund["id"]).data["decision"] == decision


def test_runtime_credentials_cannot_read_or_modify_policy(clients: dict[str, Client]) -> None:
    operator, runtime = clients["operator"], clients["runtime"]
    policy = operator.approval_policies.create(
        name=f"py_guarded_{SUFFIX}", match_kind="custom", effect="require_approval"
    ).data
    try:
        assert _status(lambda: runtime.approval_policies.list()) == 403
        assert _status(lambda: runtime.approval_policies.get(policy["id"])) == 403
        assert (
            _status(
                lambda: runtime.approval_policies.create(
                    name=f"py_mine_{SUFFIX}", match_kind="custom", effect="auto_approve"
                )
            )
            == 403
        )
        assert _status(lambda: runtime.approval_policies.disable(policy["id"])) == 403
        assert _status(lambda: runtime.approval_policies.delete(policy["id"])) == 403
        assert operator.approval_policies.get(policy["id"]).data["enabled"] is True
    finally:
        operator.approval_policies.delete(policy["id"])


def test_other_environments_are_unreachable(clients: dict[str, Client]) -> None:
    operator, other = clients["operator"], clients["other"]
    policy = operator.approval_policies.create(
        name=f"py_scoped_{SUFFIX}", match_kind="custom", effect="require_approval"
    ).data
    try:
        assert _status(lambda: other.approval_policies.get(policy["id"])) == 404
        assert _status(lambda: other.approval_policies.update(policy["id"], enabled=False)) == 404
        assert _status(lambda: other.approval_policies.delete(policy["id"])) == 404
        assert policy["id"] not in [p["id"] for p in other.approval_policies.list().data]
        assert (
            _status(
                lambda: operator.approval_policies.create(
                    name=f"py_cross_{SUFFIX}",
                    match_kind="action",
                    match_action_name=os.environ["ANLYON_E2E_FOREIGN_ACTION"],
                    effect="auto_deny",
                )
            )
            == 400
        )
    finally:
        operator.approval_policies.delete(policy["id"])


def test_create_update_and_null_clearing_match_the_typescript_sdk(
    clients: dict[str, Client],
) -> None:
    operator = clients["operator"]
    refund_action = os.environ["ANLYON_E2E_REFUND_ACTION"]
    created = operator.approval_policies.create(
        name=f"py_null_{SUFFIX}",
        match_kind="action",
        match_action_name=refund_action,
        match_agent_id="agent_1",
        min_amount=50,
        effect="require_approval",
        priority=40,
    ).data
    try:
        match = created["match"]
        assert match["actionName"] == refund_action and match["agentId"] == "agent_1"
        assert match["minAmount"] == 50
        unchanged = operator.approval_policies.update(created["id"], priority=41).data["match"]
        assert unchanged["agentId"] == "agent_1" and unchanged["minAmount"] == 50
        cleared = operator.approval_policies.update(
            created["id"], match_agent_id=None, min_amount=None
        ).data["match"]
        assert cleared["actionName"] == refund_action
        assert cleared["agentId"] is None and cleared["minAmount"] is None
        assert (
            _status(lambda: operator.approval_policies.update(created["id"], match_kind="custom"))
            == 400
        )
        ok = operator.approval_policies.update(
            created["id"], match_kind="custom", match_action_name=None
        ).data
        assert ok["scope"] == "custom_requests"
        assert operator.approval_policies.disable(created["id"]).data["enabled"] is False
        assert operator.approval_policies.enable(created["id"]).data["enabled"] is True
    finally:
        operator.approval_policies.delete(created["id"])


def test_identity_reports_the_credential(clients: dict[str, Client]) -> None:
    required = ["actions:invoke", "runs:write"]
    checked = clients["runtime"].auth.require_scopes(required, forbidden=["policies:write"])
    assert set(required) <= set(checked["scopes"])
    with pytest.raises(ScopeCheckError) as missing:
        clients["narrow"].auth.require_scopes(required)
    assert missing.value.missing == ["runs:write"]
    with pytest.raises(ScopeCheckError) as broad:
        clients["operator"].auth.require_scopes(required, forbidden=["policies:write"])
    assert broad.value.forbidden == ["policies:write"]
    identity = clients["runtime"].auth.identity().data
    assert identity["credentialType"] == "api_key" and identity["apiKeyId"]
    assert "actions:invoke" in identity["scopes"]
    assert "policies:write" not in identity["scopes"]
    op = clients["operator"].auth.identity().data
    assert {"policies:read", "policies:write"} <= set(op["scopes"])
    assert op["environmentId"] == identity["environmentId"]
