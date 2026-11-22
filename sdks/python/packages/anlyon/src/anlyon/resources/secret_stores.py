"""
Secret stores (Enterprise): your own AWS Secrets Manager or HashiCorp Vault.

A secret created with ``secrets.put_external`` points into one of these and is
read at dispatch. Anlyon does not store its value. A store's credential is
write-only: no method returns it.

Scopes: ``secret-stores:read`` to list and get, ``secret-stores:write`` for
everything else. Both are privileged: no key receives them by default.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_BASE = "/api/v2/secret-stores"


def _create_body(
    name: str,
    type: str,
    config: dict[str, Any],
    credential: dict[str, Any],
    description: str | None,
    allowed_paths: list[str] | None,
    cache_ttl_seconds: int | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"name": name, "type": type, "config": config, "credential": credential}
    if description is not None:
        body["description"] = description
    if allowed_paths is not None:
        body["allowedPaths"] = allowed_paths
    if cache_ttl_seconds is not None:
        body["cacheTtlSeconds"] = cache_ttl_seconds
    return body


def _update_body(**fields: Any) -> dict[str, Any]:
    names = {"allowed_paths": "allowedPaths", "cache_ttl_seconds": "cacheTtlSeconds"}
    return {names.get(k, k): v for k, v in fields.items() if v is not None}


class SecretStoresResource(BaseResource):
    """Secret stores (sync). Enterprise."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _BASE)

    def create(
        self,
        *,
        name: str,
        type: str,
        config: dict[str, Any],
        credential: dict[str, Any],
        description: str | None = None,
        allowed_paths: list[str] | None = None,
        cache_ttl_seconds: int | None = None,
    ) -> Any:
        """Add a store. ``type`` is ``"aws_secrets_manager"`` or ``"hashicorp_vault"``.
        Anlyon authenticates to it first; if that fails nothing is saved."""
        return self._post(
            "",
            body=_create_body(name, type, config, credential, description, allowed_paths, cache_ttl_seconds),
        )

    def update(
        self,
        name: str,
        *,
        config: dict[str, Any] | None = None,
        credential: dict[str, Any] | None = None,
        description: str | None = None,
        allowed_paths: list[str] | None = None,
        cache_ttl_seconds: int | None = None,
        confirm_protected: bool = False,
    ) -> Any:
        """Change a store. New settings or a new credential are checked before they apply."""
        body = _update_body(
            config=config,
            credential=credential,
            description=description,
            allowed_paths=allowed_paths,
            cache_ttl_seconds=cache_ttl_seconds,
        )
        path = "/" + name + ("?confirmProtected=true" if confirm_protected else "")
        return self._patch(path, body=body)

    def check(self, name: str) -> Any:
        """Authenticate to the store without reading a secret, and record the answer."""
        return self._post(f"/{name}/check", body={})

    def delete(self, name: str, *, confirm_protected: bool = False) -> Any:
        """Delete a store. Refused while any secret points at it."""
        return self._delete("/" + name + ("?confirmProtected=true" if confirm_protected else ""))

    def list(self) -> Any:
        """The environment's stores, with settings and health. Never a credential."""
        return self._get("")

    def get(self, name: str) -> Any:
        return self._get(f"/{name}")


class AsyncSecretStoresResource(AsyncBaseResource):
    """Secret stores (async). Enterprise."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _BASE)

    async def create(
        self,
        *,
        name: str,
        type: str,
        config: dict[str, Any],
        credential: dict[str, Any],
        description: str | None = None,
        allowed_paths: list[str] | None = None,
        cache_ttl_seconds: int | None = None,
    ) -> Any:
        """Add a store. See :meth:`SecretStoresResource.create`."""
        return await self._post(
            "",
            body=_create_body(name, type, config, credential, description, allowed_paths, cache_ttl_seconds),
        )

    async def update(
        self,
        name: str,
        *,
        config: dict[str, Any] | None = None,
        credential: dict[str, Any] | None = None,
        description: str | None = None,
        allowed_paths: list[str] | None = None,
        cache_ttl_seconds: int | None = None,
        confirm_protected: bool = False,
    ) -> Any:
        body = _update_body(
            config=config,
            credential=credential,
            description=description,
            allowed_paths=allowed_paths,
            cache_ttl_seconds=cache_ttl_seconds,
        )
        path = "/" + name + ("?confirmProtected=true" if confirm_protected else "")
        return await self._patch(path, body=body)

    async def check(self, name: str) -> Any:
        return await self._post(f"/{name}/check", body={})

    async def delete(self, name: str, *, confirm_protected: bool = False) -> Any:
        return await self._delete("/" + name + ("?confirmProtected=true" if confirm_protected else ""))

    async def list(self) -> Any:
        return await self._get("")

    async def get(self, name: str) -> Any:
        return await self._get(f"/{name}")
