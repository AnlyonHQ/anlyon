"""Public provider-safe billing reads (sync and async)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient


class BillingResource(BaseResource):
    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, "/api/v2/billing")

    def current_plan(self) -> Any:
        return self._get("/plan")

    def current_usage(self) -> Any:
        return self._get("/usage/current")

    def plans(self) -> Any:
        return self._get("/plans")

    def usage_history(self, *, days: int | None = None) -> Any:
        return self._get("/usage/history", params={"days": days})

    def cost_estimate(self) -> Any:
        return self._get("/cost-estimate")

    def invoices(self, *, limit: int | None = None) -> Any:
        return self._get("/invoices", params={"limit": limit})

    def quota(self) -> Any:
        return self._get("/quota")

    def workspace_budget(self) -> Any:
        """Read the alert-only overage target; this is not a spending cap."""
        return self._get("/budget")


class AsyncBillingResource(AsyncBaseResource):
    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, "/api/v2/billing")

    async def current_plan(self) -> Any:
        return await self._get("/plan")

    async def current_usage(self) -> Any:
        return await self._get("/usage/current")

    async def plans(self) -> Any:
        return await self._get("/plans")

    async def usage_history(self, *, days: int | None = None) -> Any:
        return await self._get("/usage/history", params={"days": days})

    async def cost_estimate(self) -> Any:
        return await self._get("/cost-estimate")

    async def invoices(self, *, limit: int | None = None) -> Any:
        return await self._get("/invoices", params={"limit": limit})

    async def quota(self) -> Any:
        return await self._get("/quota")

    async def workspace_budget(self) -> Any:
        """Read the alert-only overage target; this is not a spending cap."""
        return await self._get("/budget")
