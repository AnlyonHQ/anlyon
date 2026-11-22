"""
Secrets resource  a write-only vault.

There is deliberately no method that reads a secret value: values are only ever
decrypted inside action execution, on Anlyon's side. The agent that invokes an
action never sees the credential it uses.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_BASE = "/api/v2/secrets"


class _Unset:
    """An argument the caller did not pass.

    For the destination policy, ``None`` means "clear the restriction", so it
    cannot also mean "leave it alone": omitting ``allowed_hosts`` on a rotation
    keeps the existing list, and rotating a secret never widens where it may go.
    """

    def __repr__(self) -> str:
        return "UNSET"


UNSET: Any = _Unset()


def _build_put_body(
    value: str,
    description: str | None,
    allowed_hosts: list[str] | None,
    allowed_placements: list[str] | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"value": value}
    if description is not None:
        body["description"] = description
    if allowed_hosts is not UNSET:
        body["allowedHosts"] = allowed_hosts
    if allowed_placements is not UNSET:
        body["allowedPlacements"] = allowed_placements
    return body


def _build_external_body(
    store: str,
    path: str,
    key: str | None,
    version: str | None,
    description: str | None,
    allowed_hosts: list[str] | None,
    allowed_placements: list[str] | None,
) -> dict[str, Any]:
    external: dict[str, Any] = {"store": store, "path": path}
    if key is not None:
        external["key"] = key
    if version is not None:
        external["version"] = version
    body: dict[str, Any] = {"external": external}
    if description is not None:
        body["description"] = description
    if allowed_hosts is not UNSET:
        body["allowedHosts"] = allowed_hosts
    if allowed_placements is not UNSET:
        body["allowedPlacements"] = allowed_placements
    return body


class SecretsResource(BaseResource):
    """Secrets vault (sync). Write-only."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _BASE)

    def put(
        self,
        name: str,
        *,
        value: str,
        description: str | None = None,
        allowed_hosts: list[str] | None = UNSET,
        allowed_placements: list[str] | None = UNSET,
    ) -> Any:
        """Create or rotate a secret. Names are ^[A-Z0-9_]+$ and are referenced
        from action templates as {{secret:NAME}}.

        ``allowed_hosts`` limits where the secret may be sent (a leading dot
        matches subdomains); ``allowed_placements`` limits where in the request
        it may appear (``"url"``, ``"header"``, ``"body"``). Pass ``None`` to
        clear a restriction; omit to leave it as it is."""
        return self._put(
            f"/{name}",
            body=_build_put_body(value, description, allowed_hosts, allowed_placements),
        )

    def put_external(
        self,
        name: str,
        *,
        store: str,
        path: str,
        key: str | None = None,
        version: str | None = None,
        description: str | None = None,
        allowed_hosts: list[str] | None = UNSET,
        allowed_placements: list[str] | None = UNSET,
    ) -> Any:
        """Enterprise. Create or repoint a secret read at dispatch from one of the
        environment's secret stores (see ``secret_stores``). Anlyon does not store
        its value. ``key`` picks one key of the secret (required for Vault);
        ``version`` pins a version. The value is read once and dropped; if the
        store cannot produce it yet, the secret is still saved as ``unreachable``
        and the response carries a ``warning``. Calls that use it fail before
        anything is sent until the store can."""
        return self._put(
            f"/{name}",
            body=_build_external_body(store, path, key, version, description, allowed_hosts, allowed_placements),
        )

    def check(self, name: str) -> Any:
        """Enterprise. Whether an external secret can be read from its store now,
        recorded as its ``health``. Never returns the value."""
        return self._post(f"/{name}/check", body={})

    def list(self) -> Any:
        """Names + metadata. Never values."""
        return self._get("")

    def get(self, name: str) -> Any:
        """Metadata for one secret. Never the value."""
        return self._get(f"/{name}")

    def delete(self, name: str) -> Any:
        return self._delete(f"/{name}")


class AsyncSecretsResource(AsyncBaseResource):
    """Secrets vault (async). Write-only."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _BASE)

    async def put(
        self,
        name: str,
        *,
        value: str,
        description: str | None = None,
        allowed_hosts: list[str] | None = UNSET,
        allowed_placements: list[str] | None = UNSET,
    ) -> Any:
        """Create or rotate a secret. See :meth:`SecretsResource.put`."""
        return await self._put(
            f"/{name}",
            body=_build_put_body(value, description, allowed_hosts, allowed_placements),
        )

    async def put_external(
        self,
        name: str,
        *,
        store: str,
        path: str,
        key: str | None = None,
        version: str | None = None,
        description: str | None = None,
        allowed_hosts: list[str] | None = UNSET,
        allowed_placements: list[str] | None = UNSET,
    ) -> Any:
        """Enterprise. See :meth:`SecretsResource.put_external`."""
        return await self._put(
            f"/{name}",
            body=_build_external_body(store, path, key, version, description, allowed_hosts, allowed_placements),
        )

    async def check(self, name: str) -> Any:
        """Enterprise. See :meth:`SecretsResource.check`."""
        return await self._post(f"/{name}/check", body={})

    async def list(self) -> Any:
        """Names + metadata. Never values."""
        return await self._get("")

    async def get(self, name: str) -> Any:
        """Metadata for one secret. Never the value."""
        return await self._get(f"/{name}")

    async def delete(self, name: str) -> Any:
        return await self._delete(f"/{name}")
