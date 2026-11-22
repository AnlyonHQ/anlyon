"""Redacted execution logs, statistics, and exports (sync and async)."""

from __future__ import annotations

from datetime import date, datetime
from typing import TYPE_CHECKING, Any

from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient


def _params(**values: Any) -> dict[str, Any]:
    mapping = {
        "start_date": "startDate",
        "end_date": "endDate",
        "http_status": "httpStatus",
        "min_duration": "minDuration",
        "max_duration": "maxDuration",
        "message_id": "messageId",
        "error_code": "errorCode",
        "sort_by": "sortBy",
        "sort_order": "sortOrder",
    }
    return {
        mapping.get(k, k): (v.isoformat() if isinstance(v, (date, datetime)) else v)
        for k, v in values.items()
        if v is not None
    }


class LogsResource(BaseResource):
    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, "/api/v2/logs")

    def list(self, **filters: Any) -> Any:
        return self._get(params=_params(**filters))

    def stats(
        self, *, type: str | None = None, start_date: Any = None, end_date: Any = None
    ) -> Any:
        return self._get(
            "/stats", params=_params(type=type, start_date=start_date, end_date=end_date)
        )

    def export(self, *, format: str = "json", **filters: Any) -> Any:
        return self._get(
            "/export",
            params=_params(format=format, **filters),
            response_type="text" if format == "csv" else "json",
        )


class AsyncLogsResource(AsyncBaseResource):
    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, "/api/v2/logs")

    async def list(self, **filters: Any) -> Any:
        return await self._get(params=_params(**filters))

    async def stats(
        self, *, type: str | None = None, start_date: Any = None, end_date: Any = None
    ) -> Any:
        return await self._get(
            "/stats", params=_params(type=type, start_date=start_date, end_date=end_date)
        )

    async def export(self, *, format: str = "json", **filters: Any) -> Any:
        return await self._get(
            "/export",
            params=_params(format=format, **filters),
            response_type="text" if format == "csv" else "json",
        )
