"""
Base resource  mirrors src/resources/base.ts in the TS SDK.
All resources extend this and share the _get/_post/_patch/_delete helpers.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient


def idempotency_headers(idempotency_key: str | None) -> dict[str, str] | None:
    """
    Translate an idempotency key into the header the API expects.

    Replaying a request with the same key returns the original result instead of
    repeating the side effect. Reusing a key with a different payload is a conflict.
    """
    return {"Idempotency-Key": idempotency_key} if idempotency_key else None


def always_idempotency_headers(idempotency_key: str | None = None) -> dict[str, str]:
    """
    Always send an idempotency key. The caller's key is used as is. Without one, a UUID is
    generated here, once per call and before the first attempt.

    The HTTP client builds its headers once per call, so every transport retry of that call
    carries the same key and the API answers a resend from the recorded result.
    """
    return {"Idempotency-Key": idempotency_key or str(uuid.uuid4())}


class BaseResource:
    """Synchronous base resource."""

    def __init__(self, http: HttpClient, base_path: str) -> None:
        self._http = http
        self._base_path = base_path

    def _build_path(self, path: str = "") -> str:
        if not path:
            return self._base_path
        return f"{self._base_path}{path if path.startswith('/') else f'/{path}'}"

    def _get(
        self,
        path: str = "",
        *,
        params: dict[str, Any] | None = None,
        timeout: float | None = None,
        response_type: str = "json",
    ) -> Any:
        return self._http.get(
            self._build_path(path), params=params, timeout=timeout, response_type=response_type
        )

    def _post(
        self, path: str = "", *, body: Any = None, headers: dict[str, Any] | None = None
    ) -> Any:
        return self._http.post(self._build_path(path), body=body, headers=headers)

    def _post_multipart(
        self,
        path: str = "",
        *,
        files: Any,
        data: dict[str, Any] | None = None,
        headers: dict[str, Any] | None = None,
    ) -> Any:
        return self._http.post_multipart(
            self._build_path(path), files=files, data=data, headers=headers
        )

    def _put(
        self, path: str = "", *, body: Any = None, headers: dict[str, Any] | None = None
    ) -> Any:
        return self._http.put(self._build_path(path), body=body, headers=headers)

    def _patch(
        self, path: str = "", *, body: Any = None, headers: dict[str, Any] | None = None
    ) -> Any:
        return self._http.patch(self._build_path(path), body=body, headers=headers)

    def _delete(self, path: str = "", *, headers: dict[str, Any] | None = None) -> Any:
        return self._http.delete(self._build_path(path), headers=headers)


class AsyncBaseResource:
    """Asynchronous base resource."""

    def __init__(self, http: AsyncHttpClient, base_path: str) -> None:
        self._http = http
        self._base_path = base_path

    def _build_path(self, path: str = "") -> str:
        if not path:
            return self._base_path
        return f"{self._base_path}{path if path.startswith('/') else f'/{path}'}"

    async def _get(
        self,
        path: str = "",
        *,
        params: dict[str, Any] | None = None,
        timeout: float | None = None,
        response_type: str = "json",
    ) -> Any:
        return await self._http.get(
            self._build_path(path), params=params, timeout=timeout, response_type=response_type
        )

    async def _post(
        self, path: str = "", *, body: Any = None, headers: dict[str, Any] | None = None
    ) -> Any:
        return await self._http.post(self._build_path(path), body=body, headers=headers)

    async def _post_multipart(
        self,
        path: str = "",
        *,
        files: Any,
        data: dict[str, Any] | None = None,
        headers: dict[str, Any] | None = None,
    ) -> Any:
        return await self._http.post_multipart(
            self._build_path(path), files=files, data=data, headers=headers
        )

    async def _put(
        self, path: str = "", *, body: Any = None, headers: dict[str, Any] | None = None
    ) -> Any:
        return await self._http.put(self._build_path(path), body=body, headers=headers)

    async def _patch(
        self, path: str = "", *, body: Any = None, headers: dict[str, Any] | None = None
    ) -> Any:
        return await self._http.patch(self._build_path(path), body=body, headers=headers)

    async def _delete(self, path: str = "", *, headers: dict[str, Any] | None = None) -> Any:
        return await self._http.delete(self._build_path(path), headers=headers)
