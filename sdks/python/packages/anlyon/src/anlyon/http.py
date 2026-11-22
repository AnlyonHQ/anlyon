"""
HTTP client  sync (httpx.Client) and async (httpx.AsyncClient).
Mirrors src/core/http-client.ts in the TS SDK.

Handles: base URL, Bearer auth, JSON body, timeout, retry with exponential
backoff + jitter, error parsing via create_error_from_response, and unwrapping
the API's { success, data } envelope so callers get `data` directly.
"""

from __future__ import annotations

import asyncio
import random
import sys
import time
from typing import Any

if sys.version_info >= (3, 11):
    from typing import Self
else:  # pragma: no cover - typing-extensions is a dependency below 3.11
    from typing_extensions import Self

import httpx

from .config import AnlyonClientConfig
from .end_user import END_USER_HEADER, check_end_user_id, names_end_user
from .errors import (
    AnlyonError,
    NetworkError,
    SignOffRequiredError,
    create_error_from_response,
    is_sign_off_required_body,
)
from .errors import (
    TimeoutError as AnlyonTimeoutError,
)
from .response import ApiResponse


class _HttpClientBase:
    """Shared logic for sync and async HTTP clients."""

    def __init__(self, config: AnlyonClientConfig) -> None:
        if names_end_user(config.default_headers):
            raise AnlyonError(
                f"Do not set {END_USER_HEADER} in default_headers. Use client.for_user(end_user_id), "
                "which checks the id and binds it for good.",
                code="VALIDATION_ERROR",
            )
        self._config = config
        self._owns_transport = True
        self.__end_user_id: str | None = None
        self._base_url = config.base_url.rstrip("/")
        self._api_key = config.api_key
        self._timeout = config.timeout
        self._retry = config.retry
        self._retryable_statuses = set(config.retry.retryable_statuses)
        self._default_headers = config.default_headers or {}

    @property
    def end_user_id(self) -> str | None:
        """The end user every request acts for, or ``None`` for a workspace client."""
        return self.__end_user_id

    def _bind(self, end_user_id: str) -> None:
        """Bind a fresh copy to an end user. Called once, by ``for_end_user`` only."""
        if self.__end_user_id is not None:
            raise AnlyonError("This client already acts for an end user.", code="VALIDATION_ERROR")
        self.__end_user_id = check_end_user_id(end_user_id)

    def _build_headers(
        self,
        extra: dict[str, str] | None = None,
        *,
        multipart: bool = False,
        end_user_id: str | None = None,
    ) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._api_key}",
        }
        if not multipart:
            headers["Content-Type"] = "application/json"
        headers.update(self._default_headers)
        if extra:
            headers.update(extra)
        for name in [n for n in headers if n.lower() == END_USER_HEADER.lower()]:
            del headers[name]
        if end_user_id is not None:
            check_end_user_id(end_user_id)
        bound = self.__end_user_id
        if bound is not None and end_user_id is not None and end_user_id != bound:
            raise AnlyonError(
                "This client acts for a different end user. Use a client from for_user() for "
                "that end user.",
                code="VALIDATION_ERROR",
            )
        if bound is not None or end_user_id is not None:
            headers[END_USER_HEADER] = bound if bound is not None else str(end_user_id)
        if multipart:
            headers.pop("Content-Type", None)
        return headers

    def _build_url(self, path: str) -> str:
        return f"{self._base_url}{path if path.startswith('/') else f'/{path}'}"

    def _get_retry_delay(self, attempt: int, retry_after: float | None) -> float:
        if retry_after:
            return min(retry_after, self._retry.max_delay)
        delay = min(
            self._retry.initial_delay * (self._retry.backoff_multiplier ** (attempt - 1)),
            self._retry.max_delay,
        )
        if self._retry.jitter:
            delay = random.uniform(0, delay)
        return delay

    @staticmethod
    def _parse_retry_after(response: httpx.Response) -> float | None:
        value = response.headers.get("retry-after")
        if not value:
            return None
        try:
            return float(value)
        except ValueError:
            return None

    def _process_response(self, response: httpx.Response, response_type: str = "json") -> Any:
        """Raise a typed error on failure, otherwise return the unwrapped `data`."""
        if not response.is_success:
            raise self._error_from(response)
        if response_type == "text":
            return response.text
        try:
            body = response.json()
        except Exception as e:
            raise AnlyonError(
                response.text or "Empty response",
                code="PARSE_ERROR",
                status=response.status_code,
                request_id=response.headers.get("x-request-id"),
            ) from e
        if response.status_code == 202 and is_sign_off_required_body(body):
            raise SignOffRequiredError(body["data"], request_id=response.headers.get("x-request-id"))
        if isinstance(body, dict) and "success" in body:
            if not body.get("success"):
                raise create_error_from_response(
                    status=response.status_code,
                    body=body,
                    request_id=response.headers.get("x-request-id"),
                )
            return ApiResponse(
                success=True,
                data=body.get("data"),
                pagination=body.get("pagination"),
                stats=body.get("stats"),
                request_id=response.headers.get("x-request-id"),
            )
        return body

    def _error_from(self, response: httpx.Response) -> AnlyonError:
        try:
            body = response.json()
        except ValueError:
            body = {
                "error": {
                    "code": "PARSE_ERROR",
                    "message": response.text or f"HTTP {response.status_code}",
                }
            }
        error = create_error_from_response(
            status=response.status_code,
            body=body if isinstance(body, dict) else {},
            request_id=response.headers.get("x-request-id"),
            retry_after=self._parse_retry_after(response),
        )
        return self._name_idempotency_key(error, response)

    @staticmethod
    def _name_idempotency_key(error: AnlyonError, response: httpx.Response) -> AnlyonError:
        """Name the key on a 409 ``idempotency_request_in_progress``.

        The original request is still running. Only a call with the same key reaches it, and a
        key the SDK generated is otherwise invisible to the caller.
        """
        if error.status != 409 or error.code != "idempotency_request_in_progress":
            return error
        try:
            key = response.request.headers.get("Idempotency-Key")
        except RuntimeError:
            key = None
        if not key:
            return error
        return AnlyonError(
            "The original request is still running and this call did not start a second one. "
            f"Its Idempotency-Key is {key}. Call again with that idempotency_key to get the "
            "result of the original. A call without it is a new request.",
            code=error.code,
            status=error.status,
            details={"idempotency_key": key},
            request_id=error.request_id,
            retry_after=error.retry_after,
        )


def _parse_sse_block(block: str) -> dict[str, Any] | None:
    """Parse one SSE message block into {id?, event?, data}."""
    event_id = None
    event = None
    data_lines = []
    for line in block.split("\n"):
        if not line or line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if field == "id":
            event_id = value
        elif field == "event":
            event = value
        elif field == "data":
            data_lines.append(value)
    if not data_lines and not event:
        return None
    return {"id": event_id, "event": event, "data": "\n".join(data_lines)}


class HttpClient(_HttpClientBase):
    """Synchronous HTTP client wrapping httpx.Client."""

    def __init__(self, config: AnlyonClientConfig) -> None:
        super().__init__(config)
        self._client = httpx.Client(timeout=config.timeout)

    def for_end_user(self, end_user_id: str) -> HttpClient:
        """A client with the same transport whose every request carries ``Anlyon-End-User``.

        This client is unchanged. The copy does not close the shared transport.
        """
        bound = HttpClient.__new__(HttpClient)
        bound.__dict__.update(self.__dict__)
        bound._owns_transport = False
        bound._bind(end_user_id)
        return bound

    def close(self) -> None:
        if self._owns_transport:
            self._client.close()

    def stream_sse(
        self, path: str, *, params: dict[str, Any] | None = None, last_event_id: str | None = None
    ) -> Any:
        """
        Consume a Server-Sent Events endpoint, reconnecting with Last-Event-ID so
        a dropped connection resumes without a gap. Yields raw {id, event, data}
        messages (control frames  ready/heartbeat  are skipped). Iterate until
        you break out; the reconnect loop runs until then.
        """
        import time

        cursor = last_event_id
        backoff = 0.5
        while True:
            extra = {"Accept": "text/event-stream"}
            if cursor:
                extra["Last-Event-ID"] = cursor
            headers = self._build_headers(extra)
            headers.pop("Content-Type", None)
            try:
                with self._client.stream(
                    "GET", self._build_url(path), params=params, headers=headers, timeout=None
                ) as response:
                    if response.status_code in (401, 403):
                        response.read()
                        raise self._error_from(response)
                    if response.status_code >= 400:
                        time.sleep(backoff)
                        backoff = min(backoff * 2, 10.0)
                        continue
                    backoff = 0.5
                    buffer = ""
                    for chunk in response.iter_text():
                        buffer += chunk
                        while "\n\n" in buffer:
                            block, buffer = buffer.split("\n\n", 1)
                            message = _parse_sse_block(block)
                            if message is None:
                                continue
                            if message["id"]:
                                cursor = message["id"]
                            if message["event"] not in ("heartbeat", "ready"):
                                yield message
            except (httpx.TimeoutException, httpx.NetworkError):
                time.sleep(backoff)
                backoff = min(backoff * 2, 10.0)
                continue
            time.sleep(1.0)

    def get(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, Any] | None = None,
        timeout: float | None = None,
        response_type: str = "json",
        end_user_id: str | None = None,
    ) -> Any:
        return self._request(
            "GET",
            path,
            params=params,
            headers=headers,
            timeout=timeout,
            response_type=response_type,
            end_user_id=end_user_id,
        )

    def post(
        self,
        path: str,
        *,
        body: Any = None,
        headers: dict[str, Any] | None = None,
        end_user_id: str | None = None,
    ) -> Any:
        return self._request(
            "POST", path, json_body=body, headers=headers, end_user_id=end_user_id
        )

    def post_multipart(
        self,
        path: str,
        *,
        files: Any,
        data: dict[str, Any] | None = None,
        headers: dict[str, Any] | None = None,
    ) -> Any:
        return self._request("POST", path, files=files, form_data=data, headers=headers)

    def put(
        self,
        path: str,
        *,
        body: Any = None,
        headers: dict[str, Any] | None = None,
        end_user_id: str | None = None,
    ) -> Any:
        return self._request(
            "PUT", path, json_body=body, headers=headers, end_user_id=end_user_id
        )

    def patch(
        self,
        path: str,
        *,
        body: Any = None,
        headers: dict[str, Any] | None = None,
        end_user_id: str | None = None,
    ) -> Any:
        return self._request(
            "PATCH", path, json_body=body, headers=headers, end_user_id=end_user_id
        )

    def delete(
        self,
        path: str,
        *,
        headers: dict[str, Any] | None = None,
        end_user_id: str | None = None,
    ) -> Any:
        return self._request(
            "DELETE", path, headers=headers, end_user_id=end_user_id
        )

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any = None,
        files: Any = None,
        form_data: dict[str, Any] | None = None,
        headers: dict[str, Any] | None = None,
        timeout: float | None = None,
        response_type: str = "json",
        end_user_id: str | None = None,
    ) -> Any:
        url = self._build_url(path)
        multipart = files is not None
        req_headers = self._build_headers(headers, multipart=multipart, end_user_id=end_user_id)
        clean_params = (
            {k: v for k, v in (params or {}).items() if v is not None} if params else None
        )
        req_timeout: Any = timeout if timeout is not None else self._timeout

        attempt = 0
        while True:
            attempt += 1
            try:
                if multipart:
                    response = self._client.request(
                        method,
                        url,
                        params=clean_params,
                        files=files,
                        data=form_data,
                        headers=req_headers,
                        timeout=req_timeout,
                    )
                else:
                    response = self._client.request(
                        method,
                        url,
                        params=clean_params,
                        json=json_body if json_body is not None else None,
                        headers=req_headers,
                        timeout=req_timeout,
                    )
            except (httpx.TimeoutException, httpx.NetworkError) as e:
                if attempt < self._retry.max_attempts:
                    time.sleep(self._get_retry_delay(attempt, None))
                    continue
                if isinstance(e, httpx.TimeoutException):
                    raise AnlyonTimeoutError(
                        f"Request timeout after {self._timeout}s", timeout=self._timeout
                    ) from e
                raise NetworkError(str(e), cause=e) from e
            if (
                response.status_code in self._retryable_statuses
                and attempt < self._retry.max_attempts
            ):
                time.sleep(self._get_retry_delay(attempt, self._parse_retry_after(response)))
                continue
            return self._process_response(response, response_type)


class AsyncHttpClient(_HttpClientBase):
    """Asynchronous HTTP client wrapping httpx.AsyncClient."""

    def __init__(self, config: AnlyonClientConfig) -> None:
        super().__init__(config)
        self._client = httpx.AsyncClient(timeout=config.timeout)

    def for_end_user(self, end_user_id: str) -> AsyncHttpClient:
        """Async twin of ``HttpClient.for_end_user``."""
        bound = AsyncHttpClient.__new__(AsyncHttpClient)
        bound.__dict__.update(self.__dict__)
        bound._owns_transport = False
        bound._bind(end_user_id)
        return bound

    async def close(self) -> None:
        if self._owns_transport:
            await self._client.aclose()

    async def stream_sse(
        self, path: str, *, params: dict[str, Any] | None = None, last_event_id: str | None = None
    ) -> Any:
        """Async twin of HttpClient.stream_sse  see that docstring."""
        import asyncio

        cursor = last_event_id
        backoff = 0.5
        while True:
            extra = {"Accept": "text/event-stream"}
            if cursor:
                extra["Last-Event-ID"] = cursor
            headers = self._build_headers(extra)
            headers.pop("Content-Type", None)
            try:
                async with self._client.stream(
                    "GET", self._build_url(path), params=params, headers=headers, timeout=None
                ) as response:
                    if response.status_code in (401, 403):
                        await response.aread()
                        raise self._error_from(response)
                    if response.status_code >= 400:
                        await asyncio.sleep(backoff)
                        backoff = min(backoff * 2, 10.0)
                        continue
                    backoff = 0.5
                    buffer = ""
                    async for chunk in response.aiter_text():
                        buffer += chunk
                        while "\n\n" in buffer:
                            block, buffer = buffer.split("\n\n", 1)
                            message = _parse_sse_block(block)
                            if message is None:
                                continue
                            if message["id"]:
                                cursor = message["id"]
                            if message["event"] not in ("heartbeat", "ready"):
                                yield message
            except (httpx.TimeoutException, httpx.NetworkError):
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 10.0)
                continue
            await asyncio.sleep(1.0)

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    async def get(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, Any] | None = None,
        timeout: float | None = None,
        response_type: str = "json",
        end_user_id: str | None = None,
    ) -> Any:
        return await self._request(
            "GET",
            path,
            params=params,
            headers=headers,
            timeout=timeout,
            response_type=response_type,
            end_user_id=end_user_id,
        )

    async def post(
        self,
        path: str,
        *,
        body: Any = None,
        headers: dict[str, Any] | None = None,
        end_user_id: str | None = None,
    ) -> Any:
        return await self._request(
            "POST", path, json_body=body, headers=headers, end_user_id=end_user_id
        )

    async def post_multipart(
        self,
        path: str,
        *,
        files: Any,
        data: dict[str, Any] | None = None,
        headers: dict[str, Any] | None = None,
    ) -> Any:
        return await self._request("POST", path, files=files, form_data=data, headers=headers)

    async def put(
        self,
        path: str,
        *,
        body: Any = None,
        headers: dict[str, Any] | None = None,
        end_user_id: str | None = None,
    ) -> Any:
        return await self._request(
            "PUT", path, json_body=body, headers=headers, end_user_id=end_user_id
        )

    async def patch(
        self,
        path: str,
        *,
        body: Any = None,
        headers: dict[str, Any] | None = None,
        end_user_id: str | None = None,
    ) -> Any:
        return await self._request(
            "PATCH", path, json_body=body, headers=headers, end_user_id=end_user_id
        )

    async def delete(
        self,
        path: str,
        *,
        headers: dict[str, Any] | None = None,
        end_user_id: str | None = None,
    ) -> Any:
        return await self._request(
            "DELETE", path, headers=headers, end_user_id=end_user_id
        )

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any = None,
        files: Any = None,
        form_data: dict[str, Any] | None = None,
        headers: dict[str, Any] | None = None,
        timeout: float | None = None,
        response_type: str = "json",
        end_user_id: str | None = None,
    ) -> Any:
        url = self._build_url(path)
        multipart = files is not None
        req_headers = self._build_headers(headers, multipart=multipart, end_user_id=end_user_id)
        clean_params = (
            {k: v for k, v in (params or {}).items() if v is not None} if params else None
        )
        req_timeout: Any = timeout if timeout is not None else self._timeout

        attempt = 0
        while True:
            attempt += 1
            try:
                if multipart:
                    response = await self._client.request(
                        method,
                        url,
                        params=clean_params,
                        files=files,
                        data=form_data,
                        headers=req_headers,
                        timeout=req_timeout,
                    )
                else:
                    response = await self._client.request(
                        method,
                        url,
                        params=clean_params,
                        json=json_body if json_body is not None else None,
                        headers=req_headers,
                        timeout=req_timeout,
                    )
            except (httpx.TimeoutException, httpx.NetworkError) as e:
                if attempt < self._retry.max_attempts:
                    await asyncio.sleep(self._get_retry_delay(attempt, None))
                    continue
                if isinstance(e, httpx.TimeoutException):
                    raise AnlyonTimeoutError(
                        f"Request timeout after {self._timeout}s", timeout=self._timeout
                    ) from e
                raise NetworkError(str(e), cause=e) from e
            if (
                response.status_code in self._retryable_statuses
                and attempt < self._retry.max_attempts
            ):
                await asyncio.sleep(
                    self._get_retry_delay(attempt, self._parse_retry_after(response))
                )
                continue
            return self._process_response(response, response_type)
