"""
Events resource  topics, subscriptions, and published events.

Body/params-building logic is extracted into module-level pure functions so the
sync and async classes share a single implementation.
"""

from __future__ import annotations

import builtins
from typing import TYPE_CHECKING, Any

from .base import AsyncBaseResource, BaseResource, idempotency_headers

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_BASE = "/api/v2/events"


def _drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}


def _build_publish_body(
    topic: str,
    type: str,
    data: dict[str, Any] | None,
    idempotency_key: str | None,
    run_id: str | None,
    parent_span_id: str | None,
) -> dict[str, Any]:
    return _drop_none(
        {
            "topic": topic,
            "type": type,
            "data": data,
            "idempotencyKey": idempotency_key,
            "runId": run_id,
            "parentSpanId": parent_span_id,
        }
    )


def _build_list_params(
    topic: str | None,
    type: str | None,
    limit: int | None,
    offset: int | None,
) -> dict[str, Any]:
    return _drop_none({"topic": topic, "type": type, "limit": limit, "offset": offset})


def _build_create_topic_body(name: str, description: str | None) -> dict[str, Any]:
    return _drop_none({"name": name, "description": description})


def _build_update_topic_body(name: str | None, description: str | None) -> dict[str, Any]:
    return _drop_none({"name": name, "description": description})


def _build_create_subscription_body(
    url: str,
    event_types: list[str] | None,
    enabled: bool | None,
    generate_secret: bool | None,
    headers: dict[str, str] | None,
) -> dict[str, Any]:
    return _drop_none(
        {
            "url": url,
            "eventTypes": event_types,
            "enabled": enabled,
            "generateSecret": generate_secret,
            "headers": headers,
        }
    )


def _build_update_subscription_body(
    url: str | None,
    event_types: list[str] | None,
    enabled: bool | None,
    headers: dict[str, str] | None,
) -> dict[str, Any]:
    return _drop_none(
        {
            "url": url,
            "eventTypes": event_types,
            "enabled": enabled,
            "headers": headers,
        }
    )


class EventsResource(BaseResource):
    """Events, topics, and webhook subscriptions (sync)."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _BASE)

    def publish(
        self,
        *,
        topic: str,
        type: str,
        data: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
        run_id: str | None = None,
        parent_span_id: str | None = None,
    ) -> Any:
        """Publish an event to a topic. Fan-out is async (typically 202)."""
        body = _build_publish_body(topic, type, data, idempotency_key, run_id, parent_span_id)
        return self._post("", body=body, headers=idempotency_headers(idempotency_key))

    def list(
        self,
        *,
        topic: str | None = None,
        type: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> Any:
        return self._get("", params=_build_list_params(topic, type, limit, offset))

    def get(self, event_id: str) -> Any:
        """Get an event including per-subscription delivery statuses."""
        return self._get(f"/{event_id}")

    def create_topic(self, *, name: str, description: str | None = None, idempotency_key: str | None = None) -> Any:
        return self._post(
            "/topics", body=_build_create_topic_body(name, description),
            headers=idempotency_headers(idempotency_key),
        )

    def list_topics(self) -> Any:
        return self._get("/topics")

    def get_topic(self, ref: str) -> Any:
        """Get a topic by public id (top_...) or name."""
        return self._get(f"/topics/{ref}")

    def update_topic(
        self,
        ref: str,
        *,
        name: str | None = None,
        description: str | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        return self._patch(
            f"/topics/{ref}", body=_build_update_topic_body(name, description),
            headers=idempotency_headers(idempotency_key),
        )

    def delete_topic(self, ref: str, *, idempotency_key: str | None = None) -> Any:
        return self._delete(
            f"/topics/{ref}",
            headers=idempotency_headers(idempotency_key),
        )

    def list_subscriptions(self, topic_ref: str) -> Any:
        return self._get(f"/topics/{topic_ref}/subscriptions")

    def create_subscription(
        self,
        topic_ref: str,
        *,
        url: str,
        event_types: builtins.list[str] | None = None,
        enabled: bool | None = None,
        generate_secret: bool | None = None,
        headers: dict[str, str] | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Subscribe a webhook endpoint to a topic.

        With generate_secret=True the plaintext secret is returned exactly once.
        """
        body = _build_create_subscription_body(url, event_types, enabled, generate_secret, headers)
        return self._post(
            f"/topics/{topic_ref}/subscriptions",
            body=body,
            headers=idempotency_headers(idempotency_key),
        )

    def update_subscription(
        self,
        subscription_id: str,
        *,
        url: str | None = None,
        event_types: builtins.list[str] | None = None,
        enabled: bool | None = None,
        headers: dict[str, str] | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        body = _build_update_subscription_body(url, event_types, enabled, headers)
        return self._patch(
            f"/subscriptions/{subscription_id}",
            body=body,
            headers=idempotency_headers(idempotency_key),
        )

    def delete_subscription(self, subscription_id: str, *, idempotency_key: str | None = None) -> Any:
        return self._delete(
            f"/subscriptions/{subscription_id}",
            headers=idempotency_headers(idempotency_key),
        )

    def rotate_subscription_secret(self, subscription_id: str) -> Any:
        """Rotate the delivery secret; plaintext is returned exactly once."""
        return self._post(f"/subscriptions/{subscription_id}/rotate-secret")


class AsyncEventsResource(AsyncBaseResource):
    """Events, topics, and webhook subscriptions (async)."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _BASE)

    async def publish(
        self,
        *,
        topic: str,
        type: str,
        data: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
        run_id: str | None = None,
        parent_span_id: str | None = None,
    ) -> Any:
        """Publish an event to a topic. Fan-out is async (typically 202)."""
        body = _build_publish_body(topic, type, data, idempotency_key, run_id, parent_span_id)
        return await self._post("", body=body, headers=idempotency_headers(idempotency_key))

    async def list(
        self,
        *,
        topic: str | None = None,
        type: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> Any:
        return await self._get("", params=_build_list_params(topic, type, limit, offset))

    async def get(self, event_id: str) -> Any:
        """Get an event including per-subscription delivery statuses."""
        return await self._get(f"/{event_id}")

    async def create_topic(self, *, name: str, description: str | None = None, idempotency_key: str | None = None) -> Any:
        return await self._post(
            "/topics", body=_build_create_topic_body(name, description),
            headers=idempotency_headers(idempotency_key),
        )

    async def list_topics(self) -> Any:
        return await self._get("/topics")

    async def get_topic(self, ref: str) -> Any:
        """Get a topic by public id (top_...) or name."""
        return await self._get(f"/topics/{ref}")

    async def update_topic(
        self,
        ref: str,
        *,
        name: str | None = None,
        description: str | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        return await self._patch(
            f"/topics/{ref}", body=_build_update_topic_body(name, description),
            headers=idempotency_headers(idempotency_key),
        )

    async def delete_topic(self, ref: str, *, idempotency_key: str | None = None) -> Any:
        return await self._delete(
            f"/topics/{ref}",
            headers=idempotency_headers(idempotency_key),
        )

    async def list_subscriptions(self, topic_ref: str) -> Any:
        return await self._get(f"/topics/{topic_ref}/subscriptions")

    async def create_subscription(
        self,
        topic_ref: str,
        *,
        url: str,
        event_types: builtins.list[str] | None = None,
        enabled: bool | None = None,
        generate_secret: bool | None = None,
        headers: dict[str, str] | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Subscribe a webhook endpoint to a topic.

        With generate_secret=True the plaintext secret is returned exactly once.
        """
        body = _build_create_subscription_body(url, event_types, enabled, generate_secret, headers)
        return await self._post(
            f"/topics/{topic_ref}/subscriptions",
            body=body,
            headers=idempotency_headers(idempotency_key),
        )

    async def update_subscription(
        self,
        subscription_id: str,
        *,
        url: str | None = None,
        event_types: builtins.list[str] | None = None,
        enabled: bool | None = None,
        headers: dict[str, str] | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        body = _build_update_subscription_body(url, event_types, enabled, headers)
        return await self._patch(
            f"/subscriptions/{subscription_id}",
            body=body,
            headers=idempotency_headers(idempotency_key),
        )

    async def delete_subscription(self, subscription_id: str, *, idempotency_key: str | None = None) -> Any:
        return await self._delete(
            f"/subscriptions/{subscription_id}",
            headers=idempotency_headers(idempotency_key),
        )

    async def rotate_subscription_secret(self, subscription_id: str) -> Any:
        """Rotate the delivery secret; plaintext is returned exactly once."""
        return await self._post(f"/subscriptions/{subscription_id}/rotate-secret")
