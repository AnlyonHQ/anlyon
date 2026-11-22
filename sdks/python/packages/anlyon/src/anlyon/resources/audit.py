"""
Audit resource: the workspace's stored audit records and the evidence export.

Enterprise edition and Team plan; elsewhere every call answers 404. Needs an operator key holding
``audit:read``, which no key receives by default, and returns only the key's own environment's
records. Streaming to a SIEM, sinks and retention are managed in the console.

Every record has the ``anlyon.audit.v1`` shape. Its ``id`` is stable across every delivery and
export: deduplicate on it.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime, timezone
from typing import TYPE_CHECKING, Any, Literal

from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_BASE = "/api/v2/audit"

ExportFormat = Literal["json", "csv"]


def _iso(value: str | date | datetime | None) -> str | None:
    """A time as ISO 8601 with an offset, which the API requires. A bare date is UTC midnight."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc).isoformat()
    if len(value) == 10:
        return f"{value}T00:00:00+00:00"
    return value


def _params(
    *,
    start: str | date | datetime | None = None,
    end: str | date | datetime | None = None,
    type: Sequence[str] | None = None,
    category: str | None = None,
    action: str | None = None,
    limit: int | None = None,
    before: int | None = None,
    format: ExportFormat | None = None,
) -> dict[str, Any]:
    values: dict[str, Any] = {
        "from": _iso(start),
        "to": _iso(end),
        "type": ",".join(type) if type else None,
        "category": category,
        "action": action,
        "limit": limit,
        "before": before,
        "format": format,
    }
    return {k: v for k, v in values.items() if v is not None}


class AuditResource(BaseResource):
    """Audit records and the evidence export (sync)."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _BASE)

    def list_events(
        self,
        *,
        start: str | date | datetime | None = None,
        end: str | date | datetime | None = None,
        type: Sequence[str] | None = None,
        category: str | None = None,
        action: str | None = None,
        limit: int | None = None,
        before: int | None = None,
    ) -> Any:
        """Records newest first. Pass ``response.pagination["nextBefore"]`` as ``before`` for the next page.

        ``type`` takes event types or prefixes, for example ``["approval.*", "policy.updated"]``.
        ``action`` matches a governed action by name or id.
        """
        return self._get(
            "/events",
            params=_params(
                start=start,
                end=end,
                type=type,
                category=category,
                action=action,
                limit=limit,
                before=before,
            ),
        )

    def export(
        self,
        *,
        start: str | date | datetime,
        end: str | date | datetime,
        format: ExportFormat = "json",
        type: Sequence[str] | None = None,
        category: str | None = None,
        action: str | None = None,
    ) -> Any:
        """Every record in a range of at most 366 days, oldest first.

        ``format="json"`` returns the export document (``events`` and ``count``); ``"csv"`` returns text.
        Taking an export is itself recorded.
        """
        return self._get(
            "/export",
            params=_params(
                start=start, end=end, type=type, category=category, action=action, format=format
            ),
            response_type="text" if format == "csv" else "json",
        )

    def schema(self) -> Any:
        """The JSON Schema of one v1 record, and the record types by category."""
        return self._get("/schema")


class AsyncAuditResource(AsyncBaseResource):
    """Audit records and the evidence export (async)."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _BASE)

    async def list_events(
        self,
        *,
        start: str | date | datetime | None = None,
        end: str | date | datetime | None = None,
        type: Sequence[str] | None = None,
        category: str | None = None,
        action: str | None = None,
        limit: int | None = None,
        before: int | None = None,
    ) -> Any:
        return await self._get(
            "/events",
            params=_params(
                start=start,
                end=end,
                type=type,
                category=category,
                action=action,
                limit=limit,
                before=before,
            ),
        )

    async def export(
        self,
        *,
        start: str | date | datetime,
        end: str | date | datetime,
        format: ExportFormat = "json",
        type: Sequence[str] | None = None,
        category: str | None = None,
        action: str | None = None,
    ) -> Any:
        return await self._get(
            "/export",
            params=_params(
                start=start, end=end, type=type, category=category, action=action, format=format
            ),
            response_type="text" if format == "csv" else "json",
        )

    async def schema(self) -> Any:
        return await self._get("/schema")
