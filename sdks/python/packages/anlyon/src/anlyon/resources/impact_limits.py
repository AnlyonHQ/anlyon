"""
Impact limits resource  shared business-impact caps for governed effects.

A limit caps ``money`` (one currency, integer minor units), ``resource_mutations``, or a unit your
workspace declares on an action (for example ``emails``) for the whole
environment, optionally narrowed to one action or a resource prefix. Every agent, session and key
shares it; none of them can reset it. Effects reserve every applicable limit atomically immediately
before dispatch. Separate from budgets, which cap Anlyon usage. Changing limits needs
``impact-limits:write``, which no key receives by default.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_BASE = "/api/v2/impact-limits"

Dimension = Literal["money", "resource_mutations"] | str
"""``money``, ``resource_mutations``, or a declared unit such as ``emails``.
A declared unit matches ``^[a-z][a-z0-9_]{0,31}$``."""
Period = Literal["day", "month", "total"]
Scope = Literal["environment", "end_user"]


def _drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}


def _build_create_body(
    name: str,
    dimension: Dimension,
    period: Period,
    amount: int,
    currency: str | None,
    action_name: str | None,
    resource_prefix: str | None,
    unit: str | None = None,
    scope: Scope | None = None,
) -> dict[str, Any]:
    return _drop_none(
        {
            "name": name,
            "dimension": dimension,
            "period": period,
            "amount": amount,
            "currency": currency,
            "unit": unit,
            "actionName": action_name,
            "resourcePrefix": resource_prefix,
            "scope": scope,
        }
    )


class ImpactLimitsResource(BaseResource):
    """Shared impact limits (sync)."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _BASE)

    def list(self, *, include_archived: bool = False) -> Any:
        """Limit, unit, consumed, reserved, unknown exposure and available, per limit."""
        return self._get("", params={"includeArchived": "true"} if include_archived else None)

    def get(self, limit_id: str) -> Any:
        return self._get(f"/{limit_id}")

    def create(
        self,
        *,
        name: str,
        dimension: Dimension,
        period: Period,
        amount: int,
        currency: str | None = None,
        action_name: str | None = None,
        resource_prefix: str | None = None,
        unit: str | None = None,
        scope: Scope | None = None,
    ) -> Any:
        """Create a limit. ``amount`` is integer minor units for money, a count for anything else.

        ``dimension`` may be a declared unit such as ``emails``. The limit then caps the actions
        that declare an impact in that unit. ``unit`` is optional: the currency for money, the
        dimension name otherwise. Every limit comes back with ``unit``. ``scope="end_user"`` gives
        each end user (the end user of a ``for_user()`` call) the whole amount to themselves.
        """
        body = _build_create_body(
            name, dimension, period, amount, currency, action_name, resource_prefix, unit, scope
        )
        return self._post("", body=body)

    def update(self, limit_id: str, *, name: str | None = None, amount: int | None = None) -> Any:
        """Rename or change the amount. Lowering never releases existing exposure."""
        return self._patch(f"/{limit_id}", body=_drop_none({"name": name, "amount": amount}))

    def archive(self, limit_id: str) -> Any:
        """Stop applying to new effects. Existing reservations still settle."""
        return self._delete(f"/{limit_id}")


class AsyncImpactLimitsResource(AsyncBaseResource):
    """Shared impact limits (async)."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _BASE)

    async def list(self, *, include_archived: bool = False) -> Any:
        """Limit, unit, consumed, reserved, unknown exposure and available, per limit."""
        return await self._get("", params={"includeArchived": "true"} if include_archived else None)

    async def get(self, limit_id: str) -> Any:
        return await self._get(f"/{limit_id}")

    async def create(
        self,
        *,
        name: str,
        dimension: Dimension,
        period: Period,
        amount: int,
        currency: str | None = None,
        action_name: str | None = None,
        resource_prefix: str | None = None,
        unit: str | None = None,
        scope: Scope | None = None,
    ) -> Any:
        """Create a limit. ``amount`` is integer minor units for money, a count for anything else.

        ``dimension`` may be a declared unit such as ``emails``. The limit then caps the actions
        that declare an impact in that unit. ``unit`` is optional: the currency for money, the
        dimension name otherwise. Every limit comes back with ``unit``. ``scope="end_user"`` gives
        each end user (the end user of a ``for_user()`` call) the whole amount to themselves.
        """
        body = _build_create_body(
            name, dimension, period, amount, currency, action_name, resource_prefix, unit, scope
        )
        return await self._post("", body=body)

    async def update(self, limit_id: str, *, name: str | None = None, amount: int | None = None) -> Any:
        """Rename or change the amount. Lowering never releases existing exposure."""
        return await self._patch(f"/{limit_id}", body=_drop_none({"name": name, "amount": amount}))

    async def archive(self, limit_id: str) -> Any:
        """Stop applying to new effects. Existing reservations still settle."""
        return await self._delete(f"/{limit_id}")
