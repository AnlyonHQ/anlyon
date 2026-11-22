"""Slack and Discord notification integrations (sync and async)."""

from __future__ import annotations

import builtins
from typing import TYPE_CHECKING, Any

from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient


class IntegrationsResource(BaseResource):
    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, "/api/v2/integrations")

    def list(self) -> Any:
        return self._get()

    def create_discord(
        self, *, name: str, webhook_url: str, enabled_event_types: builtins.list[str] | None = None
    ) -> Any:
        return self._post(
            "/discord",
            body={
                k: v
                for k, v in {
                    "name": name,
                    "webhookUrl": webhook_url,
                    "enabledEventTypes": enabled_event_types,
                }.items()
                if v is not None
            },
        )

    def test_discord(self, integration_id: str) -> Any:
        return self._post(f"/discord/{integration_id}/test")

    def slack_channels(self, integration_id: str) -> Any:
        return self._get(f"/slack/{integration_id}/channels")

    def update_slack_channel(
        self, integration_id: str, *, channel_id: str, channel_name: str
    ) -> Any:
        return self._patch(
            f"/slack/{integration_id}/channel",
            body={"channelId": channel_id, "channelName": channel_name},
        )

    def test_slack(self, integration_id: str) -> Any:
        return self._post(f"/slack/{integration_id}/test")

    def delete(self, integration_id: str) -> Any:
        return self._delete(f"/{integration_id}")

    def toggle(self, integration_id: str, *, is_active: bool) -> Any:
        return self._patch(f"/{integration_id}/toggle", body={"isActive": is_active})

    def update_event_types(self, integration_id: str, *, enabled_event_types: builtins.list[str]) -> Any:
        return self._patch(
            f"/{integration_id}/events", body={"enabledEventTypes": enabled_event_types}
        )


class AsyncIntegrationsResource(AsyncBaseResource):
    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, "/api/v2/integrations")

    async def list(self) -> Any:
        return await self._get()

    async def create_discord(
        self, *, name: str, webhook_url: str, enabled_event_types: builtins.list[str] | None = None
    ) -> Any:
        return await self._post(
            "/discord",
            body={
                k: v
                for k, v in {
                    "name": name,
                    "webhookUrl": webhook_url,
                    "enabledEventTypes": enabled_event_types,
                }.items()
                if v is not None
            },
        )

    async def test_discord(self, integration_id: str) -> Any:
        return await self._post(f"/discord/{integration_id}/test")

    async def slack_channels(self, integration_id: str) -> Any:
        return await self._get(f"/slack/{integration_id}/channels")

    async def update_slack_channel(
        self, integration_id: str, *, channel_id: str, channel_name: str
    ) -> Any:
        return await self._patch(
            f"/slack/{integration_id}/channel",
            body={"channelId": channel_id, "channelName": channel_name},
        )

    async def test_slack(self, integration_id: str) -> Any:
        return await self._post(f"/slack/{integration_id}/test")

    async def delete(self, integration_id: str) -> Any:
        return await self._delete(f"/{integration_id}")

    async def toggle(self, integration_id: str, *, is_active: bool) -> Any:
        return await self._patch(f"/{integration_id}/toggle", body={"isActive": is_active})

    async def update_event_types(
        self, integration_id: str, *, enabled_event_types: builtins.list[str]
    ) -> Any:
        return await self._patch(
            f"/{integration_id}/events", body={"enabledEventTypes": enabled_event_types}
        )
