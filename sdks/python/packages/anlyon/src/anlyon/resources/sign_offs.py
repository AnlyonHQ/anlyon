"""
Sign-offs resource: follow the governance changes this credential asked for that a human must
approve.

An agent may never loosen its own guardrails. A loosening change made with an API key, a CLI login
or an MCP session is not applied: the call raises ``SignOffRequiredError``, and a workspace admin
approves or rejects the change at its ``sign_off_url``. These methods read and withdraw this
credential's own requests. Nothing here can approve one, and no API key can.

Reading your own requests needs no scope.
"""

from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING, Any, Literal

from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_BASE = "/api/v2/sign-offs"

SignOffStatus = Literal["pending", "applied", "rejected", "expired", "cancelled", "failed"]
"""``pending`` waits for a human. Every other status is final."""

_DEFAULT_POLL_SECONDS = 5.0


def _list_params(status: SignOffStatus | None, limit: int | None) -> dict[str, Any] | None:
    params = {k: v for k, v in {"status": status, "limit": limit}.items() if v is not None}
    return params or None


def _data(response: Any) -> Any:
    return getattr(response, "data", response)


def _interval(request: Any, poll_interval: float | None) -> float:
    if poll_interval is not None:
        return max(0.0, poll_interval)
    seconds = request.get("pollAfterSeconds") if isinstance(request, dict) else None
    return float(seconds) if isinstance(seconds, (int, float)) and seconds > 0 else _DEFAULT_POLL_SECONDS


class SignOffsResource(BaseResource):
    """This credential's sign-off requests (sync)."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _BASE)

    def get(self, sign_off_id: str) -> Any:
        """One of this credential's sign-off requests. 404 when the id is not this credential's."""
        return self._get(f"/{sign_off_id}")

    def list(self, *, status: SignOffStatus | None = None, limit: int | None = None) -> Any:
        """This credential's own sign-off requests, newest to oldest."""
        return self._get("", params=_list_params(status, limit))

    def cancel(self, sign_off_id: str) -> Any:
        """Withdraw a pending request. Answers 409 when it is no longer pending."""
        return self._post(f"/{sign_off_id}/cancel", body={})

    def wait(
        self,
        sign_off_id: str,
        *,
        timeout_seconds: float = 300.0,
        poll_interval: float | None = None,
    ) -> dict[str, Any]:
        """Poll a request until a human decides it, then return it.

        A timeout is not an error: you get the request back still ``pending``, so branch on
        ``["status"]``. ``applied`` carries the applied object in ``["result"]``.
        """
        deadline = time.monotonic() + timeout_seconds
        while True:
            request = _data(self.get(sign_off_id))
            if request.get("status") != "pending":
                return dict(request)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return dict(request)
            time.sleep(min(_interval(request, poll_interval), remaining))


class AsyncSignOffsResource(AsyncBaseResource):
    """This credential's sign-off requests (async)."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _BASE)

    async def get(self, sign_off_id: str) -> Any:
        """One of this credential's sign-off requests. 404 when the id is not this credential's."""
        return await self._get(f"/{sign_off_id}")

    async def list(self, *, status: SignOffStatus | None = None, limit: int | None = None) -> Any:
        """This credential's own sign-off requests, newest to oldest."""
        return await self._get("", params=_list_params(status, limit))

    async def cancel(self, sign_off_id: str) -> Any:
        """Withdraw a pending request. Answers 409 when it is no longer pending."""
        return await self._post(f"/{sign_off_id}/cancel", body={})

    async def wait(
        self,
        sign_off_id: str,
        *,
        timeout_seconds: float = 300.0,
        poll_interval: float | None = None,
    ) -> dict[str, Any]:
        """Async twin of ``SignOffsResource.wait``."""
        deadline = time.monotonic() + timeout_seconds
        while True:
            request = _data(await self.get(sign_off_id))
            if request.get("status") != "pending":
                return dict(request)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return dict(request)
            await asyncio.sleep(min(_interval(request, poll_interval), remaining))
