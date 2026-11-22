"""
Budgets resource  per-API-key spend control.

Postgres reservations cap the three supported admission dimensions (messages,
eventPublishes, actionInvokes) and their estimated cost; external provider
spend is outside it.
429 BUDGET_EXCEEDED refuses admission. 503 BUDGET_RECONCILIATION_REQUIRED holds
unknown legacy usage (also exposed as reconciliationRequired in budget views).
409 BUDGET_EFFECT_ALREADY_RESERVED prevents re-execution when a durable
Idempotency-Key reservation exists but its cached result is lost. Inspect the
original outcome; a new key can create duplicate work. Failed/partial work
keeps its reservation until reconciled.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_BASE = "/api/v2/budgets"


def _drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}


def _build_put_body(
    monthly_cost_cents_cap: int | None,
    dimension_caps: dict[str, int] | None,
    alert_threshold: float | None,
    enabled: bool | None,
) -> dict[str, Any]:
    return _drop_none(
        {
            "monthlyCostCentsCap": monthly_cost_cents_cap,
            "dimensionCaps": dimension_caps,
            "alertThreshold": alert_threshold,
            "enabled": enabled,
        }
    )


class BudgetsResource(BaseResource):
    """Per-key budgets (sync)."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _BASE)

    def list(self) -> Any:
        """Every budgeted key with this month's usage and estimated spend."""
        return self._get("")

    def get(self, api_key_id: str) -> Any:
        return self._get(f"/{api_key_id}")

    def put(
        self,
        api_key_id: str,
        *,
        monthly_cost_cents_cap: int | None = None,
        dimension_caps: dict[str, int] | None = None,
        alert_threshold: float | None = None,
        enabled: bool | None = None,
    ) -> Any:
        """Create or update a key's budget."""
        body = _build_put_body(monthly_cost_cents_cap, dimension_caps, alert_threshold, enabled)
        return self._put(f"/{api_key_id}", body=body)

    def delete(self, api_key_id: str) -> Any:
        """Remove the cap  the key becomes unbudgeted."""
        return self._delete(f"/{api_key_id}")


class AsyncBudgetsResource(AsyncBaseResource):
    """Per-key budgets (async)."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _BASE)

    async def list(self) -> Any:
        """Every budgeted key with this month's usage and estimated spend."""
        return await self._get("")

    async def get(self, api_key_id: str) -> Any:
        return await self._get(f"/{api_key_id}")

    async def put(
        self,
        api_key_id: str,
        *,
        monthly_cost_cents_cap: int | None = None,
        dimension_caps: dict[str, int] | None = None,
        alert_threshold: float | None = None,
        enabled: bool | None = None,
    ) -> Any:
        """Create or update a key's budget."""
        body = _build_put_body(monthly_cost_cents_cap, dimension_caps, alert_threshold, enabled)
        return await self._put(f"/{api_key_id}", body=body)

    async def delete(self, api_key_id: str) -> Any:
        """Remove the cap  the key becomes unbudgeted."""
        return await self._delete(f"/{api_key_id}")
