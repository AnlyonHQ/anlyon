"""
Approvals resource  human-in-the-loop gates.

An agent can ask its human directly (`request`), and gated actions create
approvals automatically. Deciding needs the separate `approvals:decide` scope,
and a key may never decide an approval it requested itself.
"""

from __future__ import annotations

import asyncio
import functools
import math
import time
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any, TypeVar

from ..errors import ApprovalDeniedError, ApprovalPendingError
from .base import AsyncBaseResource, BaseResource, always_idempotency_headers

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_R = TypeVar("_R")

_BASE = "/api/v2/approvals"

_MAX_WAIT_SECONDS = 55
_MIN_HOP_SECONDS = 1.0


def _drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}


def _hop_seconds(remaining: float) -> int:
    """How long the next long-poll hop may hold, without overshooting the deadline."""
    return max(1, min(_MAX_WAIT_SECONDS, math.ceil(remaining)))


def _build_get_params(
    wait_seconds: int | None,
) -> tuple[dict[str, Any] | None, float | None]:
    """Query params + the request timeout that has to outlive the server's wait."""
    if not wait_seconds:
        return None, None
    return {"waitSeconds": wait_seconds}, float(wait_seconds + 15)


def _build_request_body(
    title: str,
    description: str | None,
    payload: dict[str, Any] | None,
    expires_in_seconds: int | None,
    run_id: str | None,
    parent_span_id: str | None,
) -> dict[str, Any]:
    return _drop_none(
        {
            "title": title,
            "description": description,
            "payload": payload,
            "expiresInSeconds": expires_in_seconds,
            "runId": run_id,
            "parentSpanId": parent_span_id,
        }
    )


def _build_list_params(
    status: str | None,
    limit: int | None,
    offset: int | None,
    decision_origin: str | None = None,
    end_user_id: str | None = None,
    acting_for: str | None = None,
    decider: str | None = None,
) -> dict[str, Any]:
    return _drop_none(
        {
            "status": status,
            "decisionOrigin": decision_origin,
            "endUserId": end_user_id,
            "actingFor": acting_for,
            "decider": decider,
            "limit": limit,
            "offset": offset,
        }
    )


def _build_decision_body(note: str | None) -> dict[str, Any]:
    return _drop_none({"note": note})


def _json_safe(value: Any) -> Any:
    """Keep gate payloads JSON-serializable, best-effort."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return str(value)


def _default_gate_payload(
    fn: Callable[..., Any], args: tuple[Any, ...], kwargs: dict[str, Any]
) -> dict[str, Any]:
    return {
        "function": getattr(fn, "__name__", "function"),
        "args": _json_safe(list(args)),
        "kwargs": _json_safe(kwargs),
    }


def _settle_gate(decided: Any) -> None:
    """Raise unless the decision is an approval."""
    status = decided.get("status")
    if status == "approved":
        return
    if status == "pending":
        raise ApprovalPendingError(decided)
    raise ApprovalDeniedError(decided)


class ApprovalsResource(BaseResource):
    """Approvals (sync)."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _BASE)

    def request(
        self,
        *,
        title: str,
        description: str | None = None,
        payload: dict[str, Any] | None = None,
        expires_in_seconds: int | None = None,
        run_id: str | None = None,
        parent_span_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Ask a human to decide something. Returns an apr_ id to poll."""
        return self._post(
            "",
            body=_build_request_body(title, description, payload, expires_in_seconds, run_id, parent_span_id),
            headers=always_idempotency_headers(idempotency_key),
        )

    def list(
        self,
        *,
        status: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
        decision_origin: str | None = None,
        end_user_id: str | None = None,
        acting_for: str | None = None,
        decider: str | None = None,
    ) -> Any:
        """The inbox. Pass status="pending" for what still needs a decision.

        ``decision_origin`` is "human", "policy", "system", "assistant" or "automated" (policy, system or assistant).
        ``end_user_id`` lists the approvals of calls made for one end user. ``acting_for`` is
        "workspace" (calls with the workspace's own accounts) or "end_users". ``decider`` is "team"
        (the inbox) or "end_user" (decided by the end user in your app; read-only here).
        """
        return self._get(
            "",
            params=_build_list_params(status, limit, offset, decision_origin, end_user_id, acting_for, decider),
        )

    def get(self, approval_id: str, *, wait_seconds: int | None = None) -> Any:
        """
        Read an approval.

        With ``wait_seconds`` the server holds the request open until a human
        decides, or until the wait runs out (in which case the approval comes
        back still ``pending``  not an error). Prefer ``wait_for_decision``
        unless you are driving the loop yourself.
        """
        params, timeout = _build_get_params(wait_seconds)
        return self._get(f"/{approval_id}", params=params, timeout=timeout)

    def wait_for_decision(self, approval_id: str, *, timeout_seconds: float = 300.0) -> Any:
        """
        Block until a human decides  one call instead of a polling loop.

        Returns the approval whatever happens: if ``timeout_seconds`` elapses
        first it is still ``pending``, so branch on ``["status"]``.
        """
        deadline = time.monotonic() + timeout_seconds

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return self.get(approval_id)

            started = time.monotonic()
            approval = self.get(approval_id, wait_seconds=_hop_seconds(remaining))
            if approval.get("status") != "pending":
                return approval
            if time.monotonic() >= deadline:
                return approval

            elapsed = time.monotonic() - started
            if elapsed < _MIN_HOP_SECONDS:
                time.sleep(min(_MIN_HOP_SECONDS - elapsed, deadline - time.monotonic()))

    def gate(
        self,
        *,
        title: str | None = None,
        description: str | None = None,
        payload: dict[str, Any] | None = None,
        expires_in_seconds: int | None = None,
        timeout_seconds: float = 300.0,
        run_id: str | None = None,
        parent_span_id: str | None = None,
    ) -> Callable[[Callable[..., _R]], Callable[..., _R]]:
        """
        Gate any function on human approval  request, wait, then run.

        Each call first creates an approval (payload defaults to the call's
        function name and arguments), blocks for the decision, and only then
        runs the function. Denied or expired raises ``ApprovalDeniedError``;
        a wait that elapses while still pending raises ``ApprovalPendingError``
        and the function does not run (the approval stays decidable).

        .. code-block:: python

            @client.approvals.gate(title="Refund a customer?", timeout_seconds=600)
            def refund(order_id: str, amount: float) -> None:
                stripe.Refund.create(...)

            refund("ord_42", 129.99)  # runs only after a human approves
        """

        def decorator(fn: Callable[..., _R]) -> Callable[..., _R]:
            @functools.wraps(fn)
            def wrapper(*args: Any, **kwargs: Any) -> _R:
                approval = self.request(
                    title=title or f"Approve {getattr(fn, '__name__', 'function')}?",
                    description=description,
                    payload=payload if payload is not None else _default_gate_payload(fn, args, kwargs),
                    expires_in_seconds=expires_in_seconds,
                    run_id=run_id,
                    parent_span_id=parent_span_id,
                )
                decided = self.wait_for_decision(approval["id"], timeout_seconds=timeout_seconds)
                _settle_gate(decided)
                return fn(*args, **kwargs)

            return wrapper

        return decorator

    def approve(
        self,
        approval_id: str,
        *,
        note: str | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Approve. For a gated action this also runs the parked invocation."""
        return self._post(
            f"/{approval_id}/approve",
            body=_build_decision_body(note),
            headers=always_idempotency_headers(idempotency_key),
        )

    def deny(
        self,
        approval_id: str,
        *,
        note: str | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Deny. A gated action's invocation is marked denied and never runs."""
        return self._post(
            f"/{approval_id}/deny",
            body=_build_decision_body(note),
            headers=always_idempotency_headers(idempotency_key),
        )


class AsyncApprovalsResource(AsyncBaseResource):
    """Approvals (async)."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _BASE)

    async def request(
        self,
        *,
        title: str,
        description: str | None = None,
        payload: dict[str, Any] | None = None,
        expires_in_seconds: int | None = None,
        run_id: str | None = None,
        parent_span_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Ask a human to decide something. Returns an apr_ id to poll."""
        return await self._post(
            "",
            body=_build_request_body(title, description, payload, expires_in_seconds, run_id, parent_span_id),
            headers=always_idempotency_headers(idempotency_key),
        )

    async def list(
        self,
        *,
        status: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
        decision_origin: str | None = None,
        end_user_id: str | None = None,
        acting_for: str | None = None,
        decider: str | None = None,
    ) -> Any:
        """The inbox. Pass status="pending" for what still needs a decision; see the sync twin for the filters."""
        return await self._get(
            "",
            params=_build_list_params(status, limit, offset, decision_origin, end_user_id, acting_for, decider),
        )

    async def get(self, approval_id: str, *, wait_seconds: int | None = None) -> Any:
        """Read an approval; ``wait_seconds`` long-polls (see the sync twin)."""
        params, timeout = _build_get_params(wait_seconds)
        return await self._get(f"/{approval_id}", params=params, timeout=timeout)

    async def wait_for_decision(self, approval_id: str, *, timeout_seconds: float = 300.0) -> Any:
        """Await a human decision. Returns a still-``pending`` approval on timeout."""
        loop_clock = time.monotonic
        deadline = loop_clock() + timeout_seconds

        while True:
            remaining = deadline - loop_clock()
            if remaining <= 0:
                return await self.get(approval_id)

            started = loop_clock()
            approval = await self.get(approval_id, wait_seconds=_hop_seconds(remaining))
            if approval.get("status") != "pending":
                return approval
            if loop_clock() >= deadline:
                return approval

            elapsed = loop_clock() - started
            if elapsed < _MIN_HOP_SECONDS:
                await asyncio.sleep(min(_MIN_HOP_SECONDS - elapsed, deadline - loop_clock()))

    def gate(
        self,
        *,
        title: str | None = None,
        description: str | None = None,
        payload: dict[str, Any] | None = None,
        expires_in_seconds: int | None = None,
        timeout_seconds: float = 300.0,
        run_id: str | None = None,
        parent_span_id: str | None = None,
    ) -> Callable[[Callable[..., Awaitable[_R]]], Callable[..., Awaitable[_R]]]:
        """Gate an async function on human approval (see the sync twin)."""

        def decorator(fn: Callable[..., Awaitable[_R]]) -> Callable[..., Awaitable[_R]]:
            @functools.wraps(fn)
            async def wrapper(*args: Any, **kwargs: Any) -> _R:
                approval = await self.request(
                    title=title or f"Approve {getattr(fn, '__name__', 'function')}?",
                    description=description,
                    payload=payload if payload is not None else _default_gate_payload(fn, args, kwargs),
                    expires_in_seconds=expires_in_seconds,
                    run_id=run_id,
                    parent_span_id=parent_span_id,
                )
                decided = await self.wait_for_decision(approval["id"], timeout_seconds=timeout_seconds)
                _settle_gate(decided)
                return await fn(*args, **kwargs)

            return wrapper

        return decorator

    async def approve(
        self,
        approval_id: str,
        *,
        note: str | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Approve. For a gated action this also runs the parked invocation."""
        return await self._post(
            f"/{approval_id}/approve",
            body=_build_decision_body(note),
            headers=always_idempotency_headers(idempotency_key),
        )

    async def deny(
        self,
        approval_id: str,
        *,
        note: str | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Deny. A gated action's invocation is marked denied and never runs."""
        return await self._post(
            f"/{approval_id}/deny",
            body=_build_decision_body(note),
            headers=always_idempotency_headers(idempotency_key),
        )
