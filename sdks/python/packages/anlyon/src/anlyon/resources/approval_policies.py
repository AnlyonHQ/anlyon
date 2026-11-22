"""
Approval policies: deterministic, environment-scoped rules that decide whether a request needs
approval, is auto-approved, or is auto-denied.

This is deployment/setup code, run with an OPERATOR credential (``policies:read``,
``policies:write``). Those scopes are privileged and never in the default set, so the agent's own
runtime key cannot create, alter, disable or delete the policy that governs it. Keep policy
configuration in your deploy step and hand the running agent only its restricted key.

The environment is the credential's own. There is no environment argument, and a request that tries
to name one is rejected.

``update`` follows the API's PATCH semantics: a field you leave out is unchanged, and passing
``None`` clears a nullable matcher (``match_action_name``, ``match_agent_id``, ``match_user_id``,
``match_tags``, ``min_amount``, ``conditions``). The two are different on purpose, so unset fields
use the :data:`UNSET` sentinel rather than ``None``.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING, Any, Literal

from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_BASE = "/api/v2/approval-policies"

PolicyMatchKind = Literal["any", "action", "custom"]
PolicyEffect = Literal["require_approval", "auto_approve", "auto_deny"]
DecidedBy = Literal["team", "end_user"]


class _Unset:
    """Marks an argument the caller did not pass, so it is omitted rather than sent as null."""

    def __repr__(self) -> str:
        return "UNSET"

    def __bool__(self) -> bool:
        return False


UNSET: Any = _Unset()


def _drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}


def _build_create_body(
    name: str,
    match_kind: PolicyMatchKind,
    match_action_name: str | None,
    match_agent_id: str | None,
    match_user_id: str | None,
    match_tags: Sequence[str] | None,
    min_amount: float | None,
    conditions: dict[str, Any] | None,
    effect: PolicyEffect | None,
    required_approvals: int | None,
    priority: int | None,
    enabled: bool | None,
    acknowledge_broad_scope: bool | None,
    change_note: str | None = None,
    condition: str | None = None,
    decided_by: str | None = None,
) -> dict[str, Any]:
    return _drop_none(
        {
            "name": name,
            "matchKind": match_kind,
            "matchActionName": match_action_name,
            "matchAgentId": match_agent_id,
            "matchUserId": match_user_id,
            "matchTags": match_tags,
            "minAmount": min_amount,
            "conditions": conditions,
            "condition": condition,
            "effect": effect,
            "requiredApprovals": required_approvals,
            "decidedBy": decided_by,
            "priority": priority,
            "enabled": enabled,
            "acknowledgeBroadScope": acknowledge_broad_scope,
            "changeNote": change_note,
        }
    )


def _versions_params(limit: int | None, before: int | None) -> dict[str, Any]:
    """History pages are newest first; ``before`` is the previous page's ``pagination.nextBefore``."""
    return _drop_none({"limit": limit, "before": before})


def _build_update_body(**fields: Any) -> dict[str, Any]:
    """Only what the caller passed. ``None`` is kept (it clears); ``UNSET`` is dropped (unchanged)."""
    return {k: v for k, v in fields.items() if v is not UNSET}


_UPDATE_KEYS = {
    "change_note": "changeNote",
    "name": "name",
    "match_kind": "matchKind",
    "match_action_name": "matchActionName",
    "match_agent_id": "matchAgentId",
    "match_user_id": "matchUserId",
    "match_tags": "matchTags",
    "min_amount": "minAmount",
    "conditions": "conditions",
    "condition": "condition",
    "effect": "effect",
    "required_approvals": "requiredApprovals",
    "decided_by": "decidedBy",
    "priority": "priority",
    "enabled": "enabled",
    "acknowledge_broad_scope": "acknowledgeBroadScope",
}


def _update_body(values: dict[str, Any]) -> dict[str, Any]:
    return _build_update_body(**{_UPDATE_KEYS[k]: v for k, v in values.items()})


class ApprovalPoliciesResource(BaseResource):
    """Approval policies (sync)."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _BASE)

    def list(self, *, action_name: str | None = None) -> Any:
        """Policies in this credential's environment, in evaluation order.

        Pass ``action_name`` for the policies that could govern one action: the ones naming it
        plus the broad ones that also catch it.
        """
        return self._get("", params=_drop_none({"actionName": action_name}) or None)

    def get(self, policy_id: str) -> Any:
        return self._get(f"/{policy_id}")

    def versions(self, policy_id: str, *, limit: int | None = None, before: int | None = None) -> Any:
        """Retained immutable snapshots, including a tombstone after deletion."""
        return self._get(f"/{policy_id}/versions", params=_versions_params(limit, before))

    def plan_file(self, source: str) -> Any:
        """Plan a policy file (YAML or JSON text). Read-only; returns changes, errors and the digest."""
        return self._post("/files/plan", body={"source": source})

    def apply_file(self, source: str, *, digest: str, change_note: str | None = None) -> Any:
        """Apply exactly the reviewed plan. Refuses with 409 STALE_PLAN if anything changed since."""
        return self._post("/files/apply", body=_drop_none({"source": source, "digest": digest, "changeNote": change_note}))

    def test_file(self, source: str, cases: str | Sequence[dict[str, Any]]) -> Any:
        """Decide fixture requests against the post-apply environment. Writes and dispatches nothing."""
        return self._post("/files/test", body={"source": source, "cases": cases})

    def version(self, policy_id: str, version: int) -> Any:
        """One retained version, for example the one a decision recorded. Readable after deletion."""
        return self._get(f"/{policy_id}/versions/{version}")

    def evaluate(
        self, *, kind: Literal["action", "custom"], action_name: str | None = None,
        agent_id: str | None = None, user_id: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> Any:
        """Read-only policy matching, not an authorization or final invocation decision."""
        return self._post("/evaluate", body=_drop_none({
            "kind": kind, "actionName": action_name, "agentId": agent_id,
            "userId": user_id, "payload": payload,
        }))

    def create(
        self,
        *,
        name: str,
        match_kind: PolicyMatchKind,
        match_action_name: str | None = None,
        match_agent_id: str | None = None,
        match_user_id: str | None = None,
        match_tags: Sequence[str] | None = None,
        min_amount: float | None = None,
        conditions: dict[str, Any] | None = None,
        condition: str | None = None,
        effect: PolicyEffect | None = None,
        required_approvals: int | None = None,
        priority: int | None = None,
        enabled: bool | None = None,
        acknowledge_broad_scope: bool | None = None,
        change_note: str | None = None,
        decided_by: DecidedBy | None = None,
    ) -> Any:
        """Create a policy. Targeting is required: nothing is inferred from the name.

        ``condition`` is a CEL expression that must also hold, for example
        ``'input.amount >= 500 && input.currency == "USD"'``. It is checked against the target
        action's input schema when saved; a condition that errors at run time requires approval.

        ``match_kind="action"`` with ``match_action_name`` targets one action; ``"action"`` alone
        targets every action; ``"custom"`` targets custom approval requests; ``"any"`` targets
        every request. An ``auto_deny`` that applies to every action or request needs
        ``acknowledge_broad_scope=True``.

        ``decided_by="end_user"`` lets the end user a call was made for decide its approvals in
        your app (``end_users.approvals``) instead of your team. Defaults to ``"team"``.
        """
        body = _build_create_body(
            name,
            match_kind,
            match_action_name,
            match_agent_id,
            match_user_id,
            match_tags,
            min_amount,
            conditions,
            effect,
            required_approvals,
            priority,
            enabled,
            acknowledge_broad_scope,
            change_note,
            condition=condition,
            decided_by=decided_by,
        )
        return self._post("", body=body)

    def update(
        self,
        policy_id: str,
        *,
        name: str = UNSET,
        match_kind: PolicyMatchKind = UNSET,
        match_action_name: str | None = UNSET,
        match_agent_id: str | None = UNSET,
        match_user_id: str | None = UNSET,
        match_tags: Sequence[str] | None = UNSET,
        min_amount: float | None = UNSET,
        conditions: dict[str, Any] | None = UNSET,
        condition: str | None = UNSET,
        effect: PolicyEffect = UNSET,
        required_approvals: int = UNSET,
        priority: int = UNSET,
        enabled: bool = UNSET,
        acknowledge_broad_scope: bool = UNSET,
        change_note: str = UNSET,
        decided_by: DecidedBy = UNSET,
    ) -> Any:
        """Update a policy. Omitted means unchanged; ``None`` clears a nullable matcher."""
        body = _update_body(
            {
                "name": name,
                "match_kind": match_kind,
                "match_action_name": match_action_name,
                "match_agent_id": match_agent_id,
                "match_user_id": match_user_id,
                "match_tags": match_tags,
                "min_amount": min_amount,
                "conditions": conditions,
                "condition": condition,
                "effect": effect,
                "required_approvals": required_approvals,
                "priority": priority,
                "enabled": enabled,
                "acknowledge_broad_scope": acknowledge_broad_scope,
                "change_note": change_note,
                "decided_by": decided_by,
            }
        )
        return self._patch(f"/{policy_id}", body=body)

    def enable(self, policy_id: str) -> Any:
        """Turn a policy on. Same as ``update(policy_id, enabled=True)``."""
        return self.update(policy_id, enabled=True)

    def disable(self, policy_id: str) -> Any:
        """Turn a policy off without deleting it."""
        return self.update(policy_id, enabled=False)

    def delete(self, policy_id: str) -> Any:
        """Delete a policy. Decisions already recorded on invocations keep their explanation."""
        return self._delete(f"/{policy_id}")


class AsyncApprovalPoliciesResource(AsyncBaseResource):
    """Approval policies (async)."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _BASE)

    async def list(self, *, action_name: str | None = None) -> Any:
        """Policies in this credential's environment, in evaluation order."""
        return await self._get("", params=_drop_none({"actionName": action_name}) or None)

    async def get(self, policy_id: str) -> Any:
        return await self._get(f"/{policy_id}")

    async def versions(self, policy_id: str, *, limit: int | None = None, before: int | None = None) -> Any:
        """Retained immutable snapshots, including a tombstone after deletion."""
        return await self._get(f"/{policy_id}/versions", params=_versions_params(limit, before))

    async def plan_file(self, source: str) -> Any:
        """Plan a policy file (YAML or JSON text). Read-only; returns changes, errors and the digest."""
        return await self._post("/files/plan", body={"source": source})

    async def apply_file(self, source: str, *, digest: str, change_note: str | None = None) -> Any:
        """Apply exactly the reviewed plan. Refuses with 409 STALE_PLAN if anything changed since."""
        return await self._post(
            "/files/apply", body=_drop_none({"source": source, "digest": digest, "changeNote": change_note})
        )

    async def test_file(self, source: str, cases: str | Sequence[dict[str, Any]]) -> Any:
        """Decide fixture requests against the post-apply environment. Writes and dispatches nothing."""
        return await self._post("/files/test", body={"source": source, "cases": cases})

    async def version(self, policy_id: str, version: int) -> Any:
        """One retained version, for example the one a decision recorded. Readable after deletion."""
        return await self._get(f"/{policy_id}/versions/{version}")

    async def evaluate(
        self, *, kind: Literal["action", "custom"], action_name: str | None = None,
        agent_id: str | None = None, user_id: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> Any:
        """Read-only policy matching, not an authorization or final invocation decision."""
        return await self._post("/evaluate", body=_drop_none({
            "kind": kind, "actionName": action_name, "agentId": agent_id,
            "userId": user_id, "payload": payload,
        }))

    async def create(
        self,
        *,
        name: str,
        match_kind: PolicyMatchKind,
        match_action_name: str | None = None,
        match_agent_id: str | None = None,
        match_user_id: str | None = None,
        match_tags: Sequence[str] | None = None,
        min_amount: float | None = None,
        conditions: dict[str, Any] | None = None,
        condition: str | None = None,
        effect: PolicyEffect | None = None,
        required_approvals: int | None = None,
        priority: int | None = None,
        enabled: bool | None = None,
        acknowledge_broad_scope: bool | None = None,
        change_note: str | None = None,
        decided_by: DecidedBy | None = None,
    ) -> Any:
        """Create a policy. Targeting is required: nothing is inferred from the name."""
        body = _build_create_body(
            name,
            match_kind,
            match_action_name,
            match_agent_id,
            match_user_id,
            match_tags,
            min_amount,
            conditions,
            effect,
            required_approvals,
            priority,
            enabled,
            acknowledge_broad_scope,
            change_note,
            condition=condition,
            decided_by=decided_by,
        )
        return await self._post("", body=body)

    async def update(
        self,
        policy_id: str,
        *,
        name: str = UNSET,
        match_kind: PolicyMatchKind = UNSET,
        match_action_name: str | None = UNSET,
        match_agent_id: str | None = UNSET,
        match_user_id: str | None = UNSET,
        match_tags: Sequence[str] | None = UNSET,
        min_amount: float | None = UNSET,
        conditions: dict[str, Any] | None = UNSET,
        condition: str | None = UNSET,
        effect: PolicyEffect = UNSET,
        required_approvals: int = UNSET,
        priority: int = UNSET,
        enabled: bool = UNSET,
        acknowledge_broad_scope: bool = UNSET,
        change_note: str = UNSET,
        decided_by: DecidedBy = UNSET,
    ) -> Any:
        """Update a policy. Omitted means unchanged; ``None`` clears a nullable matcher."""
        body = _update_body(
            {
                "name": name,
                "match_kind": match_kind,
                "match_action_name": match_action_name,
                "match_agent_id": match_agent_id,
                "match_user_id": match_user_id,
                "match_tags": match_tags,
                "min_amount": min_amount,
                "conditions": conditions,
                "condition": condition,
                "effect": effect,
                "required_approvals": required_approvals,
                "priority": priority,
                "enabled": enabled,
                "acknowledge_broad_scope": acknowledge_broad_scope,
                "change_note": change_note,
                "decided_by": decided_by,
            }
        )
        return await self._patch(f"/{policy_id}", body=body)

    async def enable(self, policy_id: str) -> Any:
        """Turn a policy on."""
        return await self.update(policy_id, enabled=True)

    async def disable(self, policy_id: str) -> Any:
        """Turn a policy off without deleting it."""
        return await self.update(policy_id, enabled=False)

    async def delete(self, policy_id: str) -> Any:
        """Delete a policy. Decisions already recorded on invocations keep their explanation."""
        return await self._delete(f"/{policy_id}")
