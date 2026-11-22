"""
MCP upstreams resource: put a remote MCP server behind Anlyon and adopt its tools as governed actions.

A credential can register a server and list its tools, and no agent can call anything until a tool is
adopted. Adopting always waits for a person: ``adopt`` raises ``SignOffRequiredError`` with the link for
a workspace admin, for a first adoption and for a re-adoption after a tool changed. Connecting an
operator's account to an OAuth server is a person's consent and happens in the console.

Remote Streamable HTTP servers only. A tool's class is a suggestion from what the server says, and
server text is untrusted. Receipts for adopted tools grade ``acknowledged``, never ``confirmed``.

Reading needs ``actions:read``; the rest needs ``actions:write``. Naming a stored secret in ``headers``
also needs ``secrets:read``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_BASE = "/api/v2/mcp-upstreams"


def _path(upstream_id: str, suffix: str = "") -> str:
    return f"/{quote(upstream_id, safe='')}{suffix}"


def _register_body(
    name: str,
    url: str,
    headers: dict[str, str] | None,
    registry_name: str | None,
    oauth: dict[str, Any] | None,
    end_user_key: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"name": name, "url": url}
    if headers is not None:
        body["headers"] = headers
    if registry_name is not None:
        body["registryName"] = registry_name
    if oauth is not None:
        body["oauth"] = oauth
    if end_user_key is not None:
        body["endUserKey"] = end_user_key
    return body


def _connect_link_body(end_user_id: str, redirect_url: str | None) -> dict[str, Any]:
    body: dict[str, Any] = {"endUserId": end_user_id}
    if redirect_url is not None:
        body["redirectUrl"] = redirect_url
    return body


class McpUpstreamsResource(BaseResource):
    """Registered MCP servers and the tools adopted from them (sync)."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _BASE)

    def list(self) -> Any:
        """The environment's registered servers, with their last listing and what was adopted."""
        return self._get("")

    def get(self, upstream_id: str) -> Any:
        return self._get(_path(upstream_id))

    def inspect(self, url: str) -> Any:
        """What a server is before you register it. Stores nothing and sends no credential."""
        return self._post("/inspect", body={"url": url})

    def register(
        self,
        name: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        registry_name: str | None = None,
        oauth: dict[str, Any] | None = None,
        end_user_key: dict[str, Any] | None = None,
    ) -> Any:
        """Register a server and list its tools. Nothing is adopted.

        ``end_user_key={"header": "Authorization"}`` is for a server that takes an API key in a
        header when each end user brings their own: the header must be one of ``headers``, holding
        your own key as one ``{{secret:NAME}}`` reference. Your key lists the tools and is used for
        calls made for no end user; a call made for an end user sends their key in its place.

        Raises ``SignOffRequiredError`` when it would send a secret that may go to any host, or the
        server signs people in with OAuth. Nothing was registered; a human approves it at the link.
        """
        return self._post("", body=_register_body(name, url, headers, registry_name, oauth, end_user_key))

    def refresh(self, upstream_id: str) -> Any:
        """List the server again. Adopted tools are never changed here."""
        return self._post(_path(upstream_id, "/refresh"), body={})

    def adopt(self, upstream_id: str, tools: dict[str, dict[str, Any]]) -> Any:
        """Adopt tools from the last listing as governed actions named ``<upstream>-<tool>``.

        Each tool maps to its ``requiresApproval``, ``impact`` and ``description``. Raises
        ``SignOffRequiredError`` from an API key or a CLI login, unless every named tool is already
        adopted and unchanged. Nothing was adopted; a human approves it at the link.
        """
        return self._post(_path(upstream_id, "/adopt"), body={"tools": tools})

    def archive(self, upstream_id: str) -> Any:
        """Archive the server and disable every action adopted from it."""
        return self._post(_path(upstream_id, "/archive"), body={})

    def create_connect_link(
        self, upstream_id: str, end_user_id: str, *, redirect_url: str | None = None
    ) -> Any:
        """A link for one end user to connect their own account: a sign-in for an OAuth server, a
        form for their own key for one registered with ``end_user_key``. Needs ``end-users:write``."""
        return self._post(
            _path(upstream_id, "/connect-links"), body=_connect_link_body(end_user_id, redirect_url)
        )


class AsyncMcpUpstreamsResource(AsyncBaseResource):
    """Registered MCP servers and the tools adopted from them (async)."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _BASE)

    async def list(self) -> Any:
        """The environment's registered servers, with their last listing and what was adopted."""
        return await self._get("")

    async def get(self, upstream_id: str) -> Any:
        return await self._get(_path(upstream_id))

    async def inspect(self, url: str) -> Any:
        """What a server is before you register it. Stores nothing and sends no credential."""
        return await self._post("/inspect", body={"url": url})

    async def register(
        self,
        name: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        registry_name: str | None = None,
        oauth: dict[str, Any] | None = None,
        end_user_key: dict[str, Any] | None = None,
    ) -> Any:
        """Register a server and list its tools. See ``McpUpstreamsResource.register``."""
        return await self._post("", body=_register_body(name, url, headers, registry_name, oauth, end_user_key))

    async def refresh(self, upstream_id: str) -> Any:
        """List the server again. Adopted tools are never changed here."""
        return await self._post(_path(upstream_id, "/refresh"), body={})

    async def adopt(self, upstream_id: str, tools: dict[str, dict[str, Any]]) -> Any:
        """Adopt tools as governed actions. See ``McpUpstreamsResource.adopt``."""
        return await self._post(_path(upstream_id, "/adopt"), body={"tools": tools})

    async def archive(self, upstream_id: str) -> Any:
        """Archive the server and disable every action adopted from it."""
        return await self._post(_path(upstream_id, "/archive"), body={})

    async def create_connect_link(
        self, upstream_id: str, end_user_id: str, *, redirect_url: str | None = None
    ) -> Any:
        """A link for one end user to connect their own account: a sign-in for an OAuth server, a
        form for their own key for one registered with ``end_user_key``. Needs ``end-users:write``."""
        return await self._post(
            _path(upstream_id, "/connect-links"), body=_connect_link_body(end_user_id, redirect_url)
        )
