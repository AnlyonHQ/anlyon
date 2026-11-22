"""Dead-letter queue operations (sync and async)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient


class DlqResource(BaseResource):
    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, "/api/v2/dlq")

    def list(self, *, page: int | None = None, limit: int | None = None) -> Any:
        return self._get(
            params={k: v for k, v in {"page": page, "limit": limit}.items() if v is not None}
        )

    def stats(self) -> Any:
        return self._get("/stats")

    def get(self, message_id: str) -> Any:
        return self._get(f"/{message_id}")

    def retry(self, message_id: str) -> Any:
        return self._post(f"/{message_id}/retry")

    def retry_all(self) -> Any:
        return self._post("/retry-all")

    def delete(self, message_id: str) -> Any:
        return self._delete(f"/{message_id}")

    def clear(self) -> Any:
        return self._delete()


class AsyncDlqResource(AsyncBaseResource):
    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, "/api/v2/dlq")

    async def list(self, *, page: int | None = None, limit: int | None = None) -> Any:
        return await self._get(
            params={k: v for k, v in {"page": page, "limit": limit}.items() if v is not None}
        )

    async def stats(self) -> Any:
        return await self._get("/stats")

    async def get(self, message_id: str) -> Any:
        return await self._get(f"/{message_id}")

    async def retry(self, message_id: str) -> Any:
        return await self._post(f"/{message_id}/retry")

    async def retry_all(self) -> Any:
        return await self._post("/retry-all")

    async def delete(self, message_id: str) -> Any:
        return await self._delete(f"/{message_id}")

    async def clear(self) -> Any:
        return await self._delete()
