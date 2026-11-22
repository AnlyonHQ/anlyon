"""
Authentication: inspect the credential this client is using.

Read-only, and only about the caller's own credential. It never returns a secret, a hash, another key
or an account detail, and it is not key administration: creating keys stays an operator action in the
console.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

from ..errors import AnlyonError, ScopeCheckError
from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_BASE = "/api/v2/auth"


def _check_scopes(identity: Any, required: Iterable[str], forbidden: Iterable[str]) -> Any:
    data = identity.data if hasattr(identity, "data") else identity
    if not isinstance(data, dict) or "scopes" not in data or (
        data["scopes"] is not None
        and (
            not isinstance(data["scopes"], list)
            or any(not isinstance(scope, str) for scope in data["scopes"])
        )
    ):
        raise AnlyonError("Credential identity response has no valid scope information.")
    held = set(data.get("scopes") or [])
    missing = [scope for scope in required if scope not in held]
    present = [scope for scope in forbidden if scope in held]
    if missing or present:
        raise ScopeCheckError(missing, present)
    return data


class AuthResource(BaseResource):
    """Credential self-inspection (sync)."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _BASE)

    def identity(self) -> Any:
        """What this credential is, where it is bound, and what it may do.

        Check it at startup: fail fast if the key lacks a scope you need, and refuse to run with one
        you should not hold. Holding a scope is not proof a call will run: policies, budgets,
        environment halt and quotas still apply when the request is made.
        """
        return self._get("/identity")

    def require_scopes(self, required: Iterable[str], *, forbidden: Iterable[str] = ()) -> Any:
        """Startup check: raise unless the credential holds every scope needed and none it must not.

        Only inspects; it never asks for or grants anything. Pass what the application actually uses (least
        privilege), not whatever would make the check pass. A session credential has no scope list, so it cannot
        satisfy a scope requirement. Returns the identity on success.
        """
        return _check_scopes(self.identity(), required, forbidden)


class AsyncAuthResource(AsyncBaseResource):
    """Credential self-inspection (async)."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _BASE)

    async def identity(self) -> Any:
        """What this credential is, where it is bound, and what it may do."""
        return await self._get("/identity")

    async def require_scopes(
        self, required: Iterable[str], *, forbidden: Iterable[str] = ()
    ) -> Any:
        """Startup check (async twin of the sync method)."""
        return _check_scopes(await self.identity(), required, forbidden)
