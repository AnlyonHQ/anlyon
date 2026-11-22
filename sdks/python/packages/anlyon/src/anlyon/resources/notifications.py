"""Workspace notifications and secret-safe preferences (sync and async)."""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient


def _preferences(**values: Any) -> dict[str, Any]:
    mapping = {
        "email_enabled": "emailEnabled",
        "webhook_enabled": "webhookEnabled",
        "in_app_enabled": "inAppEnabled",
        "email_recipients": "emailRecipients",
        "webhook_url": "webhookUrl",
        "webhook_secret": "webhookSecret",
        "quota_alert_thresholds": "quotaAlertThresholds",
        "enabled_types": "enabledTypes",
    }
    return {mapping[key]: value for key, value in values.items()}


class NotificationsResource(BaseResource):
    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, "/api/v2/notifications")

    def list(self, *, unread_only: bool | None = None, limit: int | None = None) -> Any:
        return self._get(params={"unreadOnly": unread_only, "limit": limit})

    def mark_read(self, notification_id: str) -> Any:
        return self._patch(f"/{notification_id}/read")

    def mark_all_read(self) -> Any:
        return self._patch("/read-all")

    def delete(self, notification_id: str) -> Any:
        return self._delete(f"/{notification_id}")

    def preferences(self) -> Any:
        return self._get("/preferences")

    def my_preferences(self) -> Any:
        """Your own preferences. Needs a user (an OAuth connection), not an API key."""
        return self._get("/preferences/me")

    def update_my_preferences(self, *, muted_types: Sequence[str]) -> Any:
        """Replace the types left out of your own list and unread count.

        Delivery to email, Slack, Discord and the webhook is unaffected, and so is
        every other member's list. An empty sequence mutes nothing.
        """
        return self._patch("/preferences/me", body={"mutedTypes": list(muted_types)})

    def update_preferences(self, **values: Any) -> Any:
        return self._patch("/preferences", body=_preferences(**values))

    def unread_count(self) -> Any:
        return self._get("/unread-count")

    def test_webhook(self, *, webhook_url: str, webhook_secret: str | None = None) -> Any:
        return self._post(
            "/preferences/test-webhook",
            body={
                k: v
                for k, v in {"webhookUrl": webhook_url, "webhookSecret": webhook_secret}.items()
                if v is not None
            },
        )


class AsyncNotificationsResource(AsyncBaseResource):
    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, "/api/v2/notifications")

    async def list(self, *, unread_only: bool | None = None, limit: int | None = None) -> Any:
        return await self._get(params={"unreadOnly": unread_only, "limit": limit})

    async def mark_read(self, notification_id: str) -> Any:
        return await self._patch(f"/{notification_id}/read")

    async def mark_all_read(self) -> Any:
        return await self._patch("/read-all")

    async def delete(self, notification_id: str) -> Any:
        return await self._delete(f"/{notification_id}")

    async def preferences(self) -> Any:
        return await self._get("/preferences")

    async def my_preferences(self) -> Any:
        """Your own preferences. Needs a user (an OAuth connection), not an API key."""
        return await self._get("/preferences/me")

    async def update_my_preferences(self, *, muted_types: Sequence[str]) -> Any:
        """Replace the types left out of your own list and unread count.

        Delivery to email, Slack, Discord and the webhook is unaffected, and so is
        every other member's list. An empty sequence mutes nothing.
        """
        return await self._patch("/preferences/me", body={"mutedTypes": list(muted_types)})

    async def update_preferences(self, **values: Any) -> Any:
        return await self._patch("/preferences", body=_preferences(**values))

    async def unread_count(self) -> Any:
        return await self._get("/unread-count")

    async def test_webhook(self, *, webhook_url: str, webhook_secret: str | None = None) -> Any:
        return await self._post(
            "/preferences/test-webhook",
            body={
                k: v
                for k, v in {"webhookUrl": webhook_url, "webhookSecret": webhook_secret}.items()
                if v is not None
            },
        )
