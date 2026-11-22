"""
Connected accounts.

A connected account is a secret bound to one integration's API hosts. An
integration is connected one of two ways, named by its ``auth.kind``:

- ``oauth``: you sign in at the provider (HubSpot, Slack, ...). The secret's value
  is an access token fetched at dispatch. Use ``create_session`` and ``complete``.
- ``api_key``: you create a key in the provider's own settings (GitHub, Notion,
  ...). Anlyon checks it with the provider and stores it. Use
  ``connect_with_api_key``.

Either way neither the agent nor this client ever reads the credential back:
actions reference it as ``{{secret:NAME}}`` like any secret. Delete one with
``secrets.delete(name)``, which for a signed-in account also revokes the access.

Whether an account still works is one question for both kinds, answered in the
secret's ``health``: ``check(name)`` asks the provider now, and ``reconnect(name)``
makes a ``needs_reauth`` account work again the way it was connected (a new key,
or the consent page again), under the same name.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from ..errors import AnlyonError
from .base import AsyncBaseResource, BaseResource
from .end_users import AsyncEndUsersResource, EndUsersResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_BASE = "/api/v2/connections"


def _session_body(integration_id: str, secret_name: str, description: str | None) -> dict[str, Any]:
    body: dict[str, Any] = {"integrationId": integration_id, "secretName": secret_name}
    if description is not None:
        body["description"] = description
    return body


def _credential(api_key: str | None, fields: dict[str, str] | None) -> dict[str, Any]:
    """``apiKey`` for a one-value key, ``fields`` for an integration that lists ``auth.fields``."""
    if fields is not None:
        if api_key is not None:
            raise AnlyonError("Send api_key or fields, not both.", code="VALIDATION_ERROR")
        if not isinstance(fields, dict) or not fields:
            raise AnlyonError("fields is required.", code="VALIDATION_ERROR")
        return {"fields": dict(fields)}
    if not api_key:
        raise AnlyonError("api_key or fields is required.", code="VALIDATION_ERROR")
    return {"apiKey": api_key}


def _key_body(
    integration_id: str,
    secret_name: str,
    api_key: str | None,
    fields: dict[str, str] | None,
    description: str | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "integrationId": integration_id,
        "secretName": secret_name,
        **_credential(api_key, fields),
    }
    if description is not None:
        body["description"] = description
    return body


def _complete_path(session_id: str) -> str:
    return f"/sessions/{quote(session_id, safe='')}/complete"


def _account_path(secret_name: str, verb: str) -> str:
    return f"/{quote(secret_name, safe='')}/{verb}"


def _reconnect_body(api_key: str | None, fields: dict[str, str] | None) -> dict[str, Any]:
    if fields is None and not api_key:
        return {}
    return _credential(api_key, fields)


def _bound_end_user(end_user_id: str | None) -> str:
    if end_user_id is None:
        raise AnlyonError(
            "connections.confirm() confirms for the end user of a for_user() client. "
            "Use end_users.confirm_connection(end_user_id, flow_id) here.",
            code="VALIDATION_ERROR",
        )
    return end_user_id


class ConnectionsResource(BaseResource):
    """Connected accounts (sync)."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _BASE)

    def integrations(self) -> Any:
        """The integrations an account can be connected for."""
        return self._get("/integrations")

    def find_route(self, name: str) -> Any:
        """The best way to act in an app, whether or not Anlyon has an integration for it. It only suggests."""
        return self._get("/integrations/find", params={"name": name})

    def list(self) -> Any:
        """Connected accounts in the key's environment: every secret with an ``integrationId``."""
        return self._get("")

    def connect_with_api_key(
        self,
        *,
        integration_id: str,
        secret_name: str,
        api_key: str | None = None,
        fields: dict[str, str] | None = None,
        description: str | None = None,
    ) -> Any:
        """Connect an ``api_key`` integration. Anlyon checks the key with the provider
        first: a key the provider refuses is not stored (``CONNECTION_KEY_REJECTED``),
        and neither is one that could not be checked (``CONNECTION_KEY_CHECK_FAILED``).

        Pass ``api_key`` for a one-value key, or ``fields`` for an integration whose
        ``auth.fields`` is set (Jira: ``{"site": ..., "email": ..., "apiToken": ...}``)."""
        return self._post(
            "/keys", body=_key_body(integration_id, secret_name, api_key, fields, description)
        )

    def create_session(
        self, *, integration_id: str, secret_name: str, description: str | None = None
    ) -> Any:
        """Start a consent flow. Open ``connectUrl`` in a browser, then call
        :meth:`complete` until it reports ``completed``. Expires after 15 minutes."""
        return self._post("/sessions", body=_session_body(integration_id, secret_name, description))

    def complete(self, session_id: str, *, reference: str | None = None) -> Any:
        """Record the connected account. Without ``reference`` the call answers
        ``pending`` until Anlyon has been told the consent finished. Idempotent."""
        return self._post(_complete_path(session_id), body={"reference": reference} if reference else {})

    def confirm(self, flow_id: str) -> Any:
        """Finish an end user's connect flow, on a client from ``client.for_user(end_user_id)``.

        The same as ``end_users.confirm_connection(end_user_id, flow_id)`` for the bound end user.
        A workspace client has no end user to confirm for, and raises.
        """
        end_user_id = _bound_end_user(self._http.end_user_id)
        return EndUsersResource(self._http).confirm_connection(end_user_id, flow_id)

    def check(self, secret_name: str) -> Any:
        """Ask the provider whether a connected account still works, and record the
        answer in the secret's ``health``. The same call for a pasted key and a
        signed-in account. An account that does not work is an answer, not an
        error: ``health.status`` is ``needs_reauth`` with a ``reason``."""
        return self._post(_account_path(secret_name, "check"), body={})

    def reconnect(
        self,
        secret_name: str,
        *,
        api_key: str | None = None,
        fields: dict[str, str] | None = None,
    ) -> Any:
        """Make a connected account work again, the way it was connected, under the
        same name. For an ``api_key`` integration pass the new key, or ``fields`` again
        for one with ``auth.fields`` (the same account): the call checks it with the
        provider and answers ``completed``. For an ``oauth`` integration pass nothing:
        the call answers ``pending`` with a consent session to open and
        :meth:`complete`, exactly as for a first connect."""
        return self._post(
            _account_path(secret_name, "reconnect"), body=_reconnect_body(api_key, fields)
        )


class AsyncConnectionsResource(AsyncBaseResource):
    """Connected accounts (async)."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _BASE)

    async def integrations(self) -> Any:
        """The integrations an account can be connected for."""
        return await self._get("/integrations")

    async def find_route(self, name: str) -> Any:
        """The best way to act in an app, whether or not Anlyon has an integration for it. It only suggests."""
        return await self._get("/integrations/find", params={"name": name})

    async def list(self) -> Any:
        """Connected accounts in the key's environment."""
        return await self._get("")

    async def connect_with_api_key(
        self,
        *,
        integration_id: str,
        secret_name: str,
        api_key: str | None = None,
        fields: dict[str, str] | None = None,
        description: str | None = None,
    ) -> Any:
        """Connect an ``api_key`` integration. See
        :meth:`ConnectionsResource.connect_with_api_key`."""
        return await self._post(
            "/keys", body=_key_body(integration_id, secret_name, api_key, fields, description)
        )

    async def create_session(
        self, *, integration_id: str, secret_name: str, description: str | None = None
    ) -> Any:
        """Start a consent flow. See :meth:`ConnectionsResource.create_session`."""
        return await self._post(
            "/sessions", body=_session_body(integration_id, secret_name, description)
        )

    async def complete(self, session_id: str, *, reference: str | None = None) -> Any:
        """Record the connected account. See :meth:`ConnectionsResource.complete`."""
        return await self._post(
            _complete_path(session_id), body={"reference": reference} if reference else {}
        )

    async def confirm(self, flow_id: str) -> Any:
        """Finish an end user's connect flow, on a client from ``for_user()``."""
        end_user_id = _bound_end_user(self._http.end_user_id)
        return await AsyncEndUsersResource(self._http).confirm_connection(end_user_id, flow_id)

    async def check(self, secret_name: str) -> Any:
        """Ask whether a connected account still works. See :meth:`ConnectionsResource.check`."""
        return await self._post(_account_path(secret_name, "check"), body={})

    async def reconnect(
        self,
        secret_name: str,
        *,
        api_key: str | None = None,
        fields: dict[str, str] | None = None,
    ) -> Any:
        """Make a connected account work again. See :meth:`ConnectionsResource.reconnect`."""
        return await self._post(
            _account_path(secret_name, "reconnect"), body=_reconnect_body(api_key, fields)
        )
