"""
The calling key's own environment  including the kill switch.

These address *the environment this key is bound to* rather than taking an id.
A key belongs to exactly one environment, so a staging key halts staging and
cannot reach production: the isolation falls out of the credential, with no
extra argument to get wrong.

``halt`` and ``resume`` need the ``environments:halt`` scope, which is not
granted by default  stopping the system is an operator act, not agent work.
Put an operator key holding it behind your on-call runbook.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_BASE = "/api/v2/environment"


def _halt_body(reason: str | None) -> dict[str, Any]:
    return {"reason": reason} if reason is not None else {}


class EnvironmentResource(BaseResource):
    """The key's own environment and kill switch (sync)."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _BASE)

    def get(self) -> Any:
        """Which environment is this key bound to, and is it halted?

        Needs no special scope -- a runbook checks before and after, and a
        caller can infer it from 409s anyway.
        """
        return self._get("")

    def halt(self, *, reason: str | None = None) -> Any:
        """The kill switch.

        The agent stops acting and nothing leaves the environment: action
        invocations block and deliveries defer. What you publish
        still queues and approvals can still be decided, so nothing in flight is
        lost -- ``resume`` releases it all.
        """
        return self._post("/halt", body=_halt_body(reason))

    def resume(self) -> Any:
        """Release the deferred work and let the agent act again."""
        return self._post("/resume", body={})


class AsyncEnvironmentResource(AsyncBaseResource):
    """The key's own environment and kill switch (async)."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _BASE)

    async def get(self) -> Any:
        """Which environment is this key bound to, and is it halted?

        Needs no special scope -- a runbook checks before and after, and a
        caller can infer it from 409s anyway.
        """
        return await self._get("")

    async def halt(self, *, reason: str | None = None) -> Any:
        """The kill switch.

        The agent stops acting and nothing leaves the environment: action
        invocations block and deliveries defer. What you publish
        still queues and approvals can still be decided, so nothing in flight is
        lost -- ``resume`` releases it all.
        """
        return await self._post("/halt", body=_halt_body(reason))

    async def resume(self) -> Any:
        """Release the deferred work and let the agent act again."""
        return await self._post("/resume", body={})
