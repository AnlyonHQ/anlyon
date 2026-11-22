"""
Runs resource  the agent trace model. A run is a tree of spans.

Report runs from any runtime: start a run, ingest spans as steps happen, then
end it. Span ingestion is idempotent when each span carries an ``id``.

Body/params builders are module-level pure functions so the sync and async
classes share one implementation.
"""

from __future__ import annotations

import builtins
from typing import TYPE_CHECKING, Any

from .base import AsyncBaseResource, BaseResource, idempotency_headers

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_BASE = "/api/v2/runs"

Span = dict[str, Any]


def _drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}


def _build_start_body(
    name: str | None,
    agent_id: str | None,
    agent_version: str | None,
    user_id: str | None,
    application: str | None,
    input: Any,
    tags: list[str] | None,
    metadata: dict[str, Any] | None,
) -> dict[str, Any]:
    return _drop_none(
        {
            "name": name,
            "agentId": agent_id,
            "agentVersion": agent_version,
            "userId": user_id,
            "application": application,
            "input": input,
            "tags": tags,
            "metadata": metadata,
        }
    )


def _build_end_body(
    status: str | None,
    output: Any,
    error: dict[str, Any] | None,
    tokens: int | None,
    cost: float | None,
    metadata: dict[str, Any] | None,
) -> dict[str, Any]:
    return _drop_none(
        {
            "status": status,
            "output": output,
            "error": error,
            "tokens": tokens,
            "cost": cost,
            "metadata": metadata,
        }
    )


def _build_list_params(
    search: str | None,
    status: str | None,
    agent_id: str | None,
    user_id: str | None,
    started_after: str | None,
    started_before: str | None,
    limit: int | None,
    offset: int | None,
) -> dict[str, Any]:
    return _drop_none(
        {
            "search": search,
            "status": status,
            "agentId": agent_id,
            "userId": user_id,
            "startedAfter": started_after,
            "startedBefore": started_before,
            "limit": limit,
            "offset": offset,
        }
    )


class RunsResource(BaseResource):
    """Agent runs and spans (sync)."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _BASE)

    def start(
        self,
        *,
        name: str | None = None,
        agent_id: str | None = None,
        agent_version: str | None = None,
        user_id: str | None = None,
        application: str | None = None,
        input: Any = None,
        tags: builtins.list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Start a run. The environment is taken from the API key."""
        body = _build_start_body(name, agent_id, agent_version, user_id, application, input, tags, metadata)
        return self._post("", body=body, headers=idempotency_headers(idempotency_key))

    def list(
        self,
        *,
        search: str | None = None,
        status: str | None = None,
        agent_id: str | None = None,
        user_id: str | None = None,
        started_after: str | None = None,
        started_before: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> Any:
        """List runs, newest first."""
        params = _build_list_params(search, status, agent_id, user_id, started_after, started_before, limit, offset)
        return self._get("", params=params)

    def get(self, run_id: str) -> Any:
        """Get a run with its span tree."""
        return self._get(f"/{run_id}")

    def export_trace(self, run_id: str) -> Any:
        """Export a redacted trace in OpenTelemetry Protocol JSON shape."""
        return self._get(f"/{run_id}/export")

    def import_trace(self, trace: dict[str, Any], *, idempotency_key: str | None = None) -> Any:
        """Import one OTLP/JSON trace into this API key's environment."""
        return self._post("/import", body=trace, headers=idempotency_headers(idempotency_key))

    def end(
        self,
        run_id: str,
        *,
        status: str | None = None,
        output: Any = None,
        error: dict[str, Any] | None = None,
        tokens: int | None = None,
        cost: float | None = None,
        metadata: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """End or update a run."""
        body = _build_end_body(status, output, error, tokens, cost, metadata)
        return self._patch(f"/{run_id}", body=body, headers=idempotency_headers(idempotency_key))

    def ingest_spans(
        self,
        run_id: str,
        spans: builtins.list[Span],
        *,
        idempotency_key: str | None = None,
    ) -> Any:
        """Idempotently ingest a batch of spans. Give each span an ``id`` so a retry updates it."""
        return self._post(
            f"/{run_id}/spans",
            body={"spans": spans},
            headers=idempotency_headers(idempotency_key),
        )

    def add_feedback(
        self,
        run_id: str,
        *,
        span_id: str | None = None,
        source: str | None = None,
        label: str | None = None,
        rating: float | None = None,
        comment: str | None = None,
        metadata: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Attach feedback to a run, or a span within it."""
        body = _drop_none(
            {"spanId": span_id, "source": source, "label": label, "rating": rating, "comment": comment, "metadata": metadata}
        )
        return self._post(f"/{run_id}/feedback", body=body, headers=idempotency_headers(idempotency_key))

    def list_feedback(self, run_id: str) -> Any:
        """List feedback for a run."""
        return self._get(f"/{run_id}/feedback")


class AsyncRunsResource(AsyncBaseResource):
    """Agent runs and spans (async)."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _BASE)

    async def start(
        self,
        *,
        name: str | None = None,
        agent_id: str | None = None,
        agent_version: str | None = None,
        user_id: str | None = None,
        application: str | None = None,
        input: Any = None,
        tags: builtins.list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Start a run. The environment is taken from the API key."""
        body = _build_start_body(name, agent_id, agent_version, user_id, application, input, tags, metadata)
        return await self._post("", body=body, headers=idempotency_headers(idempotency_key))

    async def list(
        self,
        *,
        search: str | None = None,
        status: str | None = None,
        agent_id: str | None = None,
        user_id: str | None = None,
        started_after: str | None = None,
        started_before: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> Any:
        """List runs, newest first."""
        params = _build_list_params(search, status, agent_id, user_id, started_after, started_before, limit, offset)
        return await self._get("", params=params)

    async def get(self, run_id: str) -> Any:
        """Get a run with its span tree."""
        return await self._get(f"/{run_id}")

    async def export_trace(self, run_id: str) -> Any:
        """Export a redacted trace in OpenTelemetry Protocol JSON shape."""
        return await self._get(f"/{run_id}/export")

    async def import_trace(self, trace: dict[str, Any], *, idempotency_key: str | None = None) -> Any:
        """Import one OTLP/JSON trace into this API key's environment."""
        return await self._post("/import", body=trace, headers=idempotency_headers(idempotency_key))

    async def end(
        self,
        run_id: str,
        *,
        status: str | None = None,
        output: Any = None,
        error: dict[str, Any] | None = None,
        tokens: int | None = None,
        cost: float | None = None,
        metadata: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """End or update a run."""
        body = _build_end_body(status, output, error, tokens, cost, metadata)
        return await self._patch(f"/{run_id}", body=body, headers=idempotency_headers(idempotency_key))

    async def ingest_spans(
        self,
        run_id: str,
        spans: builtins.list[Span],
        *,
        idempotency_key: str | None = None,
    ) -> Any:
        """Idempotently ingest a batch of spans. Give each span an ``id`` so a retry updates it."""
        return await self._post(
            f"/{run_id}/spans",
            body={"spans": spans},
            headers=idempotency_headers(idempotency_key),
        )

    async def add_feedback(
        self,
        run_id: str,
        *,
        span_id: str | None = None,
        source: str | None = None,
        label: str | None = None,
        rating: float | None = None,
        comment: str | None = None,
        metadata: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Attach feedback to a run, or a span within it."""
        body = _drop_none(
            {"spanId": span_id, "source": source, "label": label, "rating": rating, "comment": comment, "metadata": metadata}
        )
        return await self._post(f"/{run_id}/feedback", body=body, headers=idempotency_headers(idempotency_key))

    async def list_feedback(self, run_id: str) -> Any:
        """List feedback for a run."""
        return await self._get(f"/{run_id}/feedback")
