"""Delivery and onboarding analytics (sync and async)."""

from __future__ import annotations

from datetime import date, datetime
from typing import TYPE_CHECKING, Any

from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient
DateLike = str | date | datetime


def _iso(value: DateLike | None) -> str | None:
    return value.isoformat() if isinstance(value, (date, datetime)) else value


def _range(
    start_date: DateLike | None = None, end_date: DateLike | None = None, **extra: Any
) -> dict[str, Any]:
    return {
        k: v
        for k, v in {"startDate": _iso(start_date), "endDate": _iso(end_date), **extra}.items()
        if v is not None
    }


class AnalyticsResource(BaseResource):
    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, "/api/v2/analytics")

    def overview(
        self,
        *,
        start_date: DateLike | None = None,
        end_date: DateLike | None = None,
        granularity: str | None = None,
        environment_id: str | None = None,
        limit: int | None = None,
    ) -> Any:
        return self._get(
            "/overview",
            params=_range(
                start_date,
                end_date,
                granularity=granularity,
                environmentId=environment_id,
                limit=limit,
            ),
        )

    def agent_analytics(
        self,
        *,
        start_date: DateLike | None = None,
        end_date: DateLike | None = None,
        granularity: str | None = None,
        environment_id: str | None = None,
        limit: int | None = None,
    ) -> Any:
        return self._get(
            "/agents",
            params=_range(
                start_date,
                end_date,
                granularity=granularity,
                environmentId=environment_id,
                limit=limit,
            ),
        )

    def trust_control_analytics(
        self,
        *,
        start_date: DateLike | None = None,
        end_date: DateLike | None = None,
        granularity: str | None = None,
        environment_id: str | None = None,
        limit: int | None = None,
    ) -> Any:
        return self._get(
            "/trust-control",
            params=_range(
                start_date,
                end_date,
                granularity=granularity,
                environmentId=environment_id,
                limit=limit,
            ),
        )

    def delivery_analytics(
        self,
        *,
        start_date: DateLike | None = None,
        end_date: DateLike | None = None,
        granularity: str | None = None,
        environment_id: str | None = None,
        limit: int | None = None,
    ) -> Any:
        return self._get(
            "/delivery",
            params=_range(
                start_date,
                end_date,
                granularity=granularity,
                environmentId=environment_id,
                limit=limit,
            ),
        )

    def message_stats(
        self, *, start_date: DateLike | None = None, end_date: DateLike | None = None
    ) -> Any:
        return self._get("/messages", params=_range(start_date, end_date))

    def time_series(
        self,
        *,
        start_date: DateLike | None = None,
        end_date: DateLike | None = None,
        granularity: str | None = None,
    ) -> Any:
        return self._get(
            "/time-series", params=_range(start_date, end_date, granularity=granularity)
        )

    def top_urls(
        self,
        *,
        start_date: DateLike | None = None,
        end_date: DateLike | None = None,
        limit: int | None = None,
    ) -> Any:
        return self._get("/top-urls", params=_range(start_date, end_date, limit=limit))

    def current_usage(self) -> Any:
        return self._get("/usage/current")

    def usage_history(
        self, *, start_date: DateLike | None = None, end_date: DateLike | None = None
    ) -> Any:
        return self._get("/usage/history", params=_range(start_date, end_date))

    def error_distribution(
        self,
        *,
        start_date: DateLike | None = None,
        end_date: DateLike | None = None,
        limit: int | None = None,
    ) -> Any:
        return self._get("/errors", params=_range(start_date, end_date, limit=limit))

    def onboarding_status(self) -> Any:
        return self._get("/onboarding")


class AsyncAnalyticsResource(AsyncBaseResource):
    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, "/api/v2/analytics")

    async def overview(
        self,
        *,
        start_date: DateLike | None = None,
        end_date: DateLike | None = None,
        granularity: str | None = None,
        environment_id: str | None = None,
        limit: int | None = None,
    ) -> Any:
        return await self._get(
            "/overview",
            params=_range(
                start_date,
                end_date,
                granularity=granularity,
                environmentId=environment_id,
                limit=limit,
            ),
        )

    async def agent_analytics(
        self,
        *,
        start_date: DateLike | None = None,
        end_date: DateLike | None = None,
        granularity: str | None = None,
        environment_id: str | None = None,
        limit: int | None = None,
    ) -> Any:
        return await self._get(
            "/agents",
            params=_range(
                start_date,
                end_date,
                granularity=granularity,
                environmentId=environment_id,
                limit=limit,
            ),
        )

    async def trust_control_analytics(
        self,
        *,
        start_date: DateLike | None = None,
        end_date: DateLike | None = None,
        granularity: str | None = None,
        environment_id: str | None = None,
        limit: int | None = None,
    ) -> Any:
        return await self._get(
            "/trust-control",
            params=_range(
                start_date,
                end_date,
                granularity=granularity,
                environmentId=environment_id,
                limit=limit,
            ),
        )

    async def delivery_analytics(
        self,
        *,
        start_date: DateLike | None = None,
        end_date: DateLike | None = None,
        granularity: str | None = None,
        environment_id: str | None = None,
        limit: int | None = None,
    ) -> Any:
        return await self._get(
            "/delivery",
            params=_range(
                start_date,
                end_date,
                granularity=granularity,
                environmentId=environment_id,
                limit=limit,
            ),
        )

    async def message_stats(
        self, *, start_date: DateLike | None = None, end_date: DateLike | None = None
    ) -> Any:
        return await self._get("/messages", params=_range(start_date, end_date))

    async def time_series(
        self,
        *,
        start_date: DateLike | None = None,
        end_date: DateLike | None = None,
        granularity: str | None = None,
    ) -> Any:
        return await self._get(
            "/time-series", params=_range(start_date, end_date, granularity=granularity)
        )

    async def top_urls(
        self,
        *,
        start_date: DateLike | None = None,
        end_date: DateLike | None = None,
        limit: int | None = None,
    ) -> Any:
        return await self._get("/top-urls", params=_range(start_date, end_date, limit=limit))

    async def current_usage(self) -> Any:
        return await self._get("/usage/current")

    async def usage_history(
        self, *, start_date: DateLike | None = None, end_date: DateLike | None = None
    ) -> Any:
        return await self._get("/usage/history", params=_range(start_date, end_date))

    async def error_distribution(
        self,
        *,
        start_date: DateLike | None = None,
        end_date: DateLike | None = None,
        limit: int | None = None,
    ) -> Any:
        return await self._get("/errors", params=_range(start_date, end_date, limit=limit))

    async def onboarding_status(self) -> Any:
        return await self._get("/onboarding")
