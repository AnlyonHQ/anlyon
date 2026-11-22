"""
End users: the people using your product, and the accounts they connect.

Mirrors src/resources/end-users.ts in the TS SDK.

Your server names the end user. Anlyon stores the id as given and never runs their login. Each
end user connects their own Gmail, HubSpot or Slack, and every action your agent takes in those
accounts is limited, approved and receipted for that end user.

- Connect: ``create_connect_link`` for any integration (send the end user to ``url``, then
  ``confirm_connection`` when they come back), or ``set_connection`` when your app already holds
  the end user's own key for an API-key integration.
- Act: invoke actions with a client from ``client.for_user(end_user_id)``. An end user with no
  connection gets ``EndUserNotConnectedError``, which carries a ``connect_url``.
- Approve: an approval policy decided by the end user puts its approvals here, not in your team's
  inbox. List them with ``approvals.list`` and decide with ``approvals.decide`` in your app.
- Front end: ``create_session`` mints a short-lived token for one end user, for the prebuilt
  components in ``@anlyonhq/react``.
- Erase: ``erase`` removes every connection, limit counter and pending approval of an end user.

Needs the ``end-users:read``, ``end-users:write`` or ``end-users:approvals`` scope.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal
from urllib.parse import quote

from ..end_user import check_end_user_id
from ..errors import AnlyonError

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_BASE = "/api/v2/end-users"

Decision = Literal["approve", "deny"]


def _user_path(end_user_id: str, rest: str = "") -> str:
    return f"{_BASE}/{quote(check_end_user_id(end_user_id), safe='')}{rest}"


def _required(value: Any, what: str) -> str:
    if not isinstance(value, str) or not value:
        raise AnlyonError(f"{what} is required.", code="VALIDATION_ERROR")
    return value


def _segment(value: Any, what: str) -> str:
    return quote(_required(value, what), safe="")


def _key_body(token: str | None, fields: dict[str, str] | None) -> dict[str, Any]:
    """`token` for a one-value key, `fields` for an integration that lists `auth.fields`. One or the other."""
    if fields is not None:
        if token is not None:
            raise AnlyonError("Send token or fields, not both.", code="VALIDATION_ERROR")
        if not isinstance(fields, dict) or not fields:
            raise AnlyonError("fields is required.", code="VALIDATION_ERROR")
        return {"fields": {name: _required(value, name) for name, value in fields.items()}}
    return {"token": _required(token, "token")}


def _link_body(integration: str, redirect_url: str | None) -> dict[str, Any]:
    body: dict[str, Any] = {"integration": _required(integration, "integration")}
    if redirect_url is not None:
        body["redirectUrl"] = redirect_url
    return body


def _decision_body(decision: Any, reason: str | None) -> dict[str, Any]:
    if decision not in ("approve", "deny"):
        raise AnlyonError('decision is "approve" or "deny".', code="VALIDATION_ERROR")
    body: dict[str, Any] = {"decision": decision}
    if reason is not None:
        body["reason"] = reason
    return body


def _session_body(ttl_seconds: int | None) -> dict[str, Any]:
    """A session's lifetime: 60 to 3600 seconds, 900 when left out."""
    if ttl_seconds is None:
        return {}
    if (
        isinstance(ttl_seconds, bool)
        or not isinstance(ttl_seconds, int)
        or not 60 <= ttl_seconds <= 3600
    ):
        raise AnlyonError("ttl_seconds is a whole number from 60 to 3600.", code="VALIDATION_ERROR")
    return {"ttlSeconds": ttl_seconds}


def _list_params(cursor: str | None, limit: int | None) -> dict[str, Any] | None:
    params = {k: v for k, v in (("cursor", cursor), ("limit", limit)) if v is not None}
    return params or None


def _refuse_list_when_bound(end_user_id: str | None) -> None:
    if end_user_id is not None:
        raise AnlyonError(
            "This client acts for one end user and cannot list the others. "
            "Use the client it was built from.",
            code="VALIDATION_ERROR",
        )


class EndUserApprovalsResource:
    """Approvals that belong to an end user (sync).

    Those a policy with ``decidedBy: "end_user"`` created. They are not shown in your team's
    inbox: show them in your app, and let the end user decide. An approval of another end user
    answers ``404``.
    """

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self, end_user_id: str, *, status: str | None = None) -> Any:
        """The end user's approvals. Pass ``status="pending"`` for what still needs a decision."""
        return self._http.get(
            _user_path(end_user_id, "/approvals"),
            params={"status": status} if status else None,
            end_user_id=end_user_id,
        )

    def decide(
        self,
        end_user_id: str,
        approval_id: str,
        *,
        decision: Decision,
        reason: str | None = None,
    ) -> Any:
        """Record the end user's decision. Approving an action's approval runs it."""
        path = _user_path(end_user_id, f"/approvals/{_segment(approval_id, 'approval_id')}/decide")
        return self._http.post(path, body=_decision_body(decision, reason), end_user_id=end_user_id)


class EndUsersResource:
    """End users and their connections (sync)."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http
        self._approvals: EndUserApprovalsResource | None = None

    @property
    def approvals(self) -> EndUserApprovalsResource:
        """Approvals the end user decides in your app."""
        if self._approvals is None:
            self._approvals = EndUserApprovalsResource(self._http)
        return self._approvals

    def create_connect_link(
        self, *, end_user_id: str, integration: str, redirect_url: str | None = None
    ) -> Any:
        """A connect link for any integration: ``{"url", "expiresAt", "integration"}``.

        Send the end user to ``url``. It works once, for ten minutes: the provider's sign-in, or,
        for an API-key integration, a hosted form where they paste their own key. They come back to
        ``redirect_url`` (which must match one of the environment's allowed redirect URLs, or the
        default is used), where your server calls :meth:`confirm_connection`. Without either,
        raises ``RedirectUrlRequiredError``, unless the environment's connect confirmation is off.
        """
        path = _user_path(end_user_id, "/connect-links")
        return self._http.post(
            path, body=_link_body(integration, redirect_url), end_user_id=end_user_id
        )

    def confirm_connection(self, end_user_id: str, flow_id: str) -> Any:
        """Finish a connect flow: ``{"integration", "status": "active"}``.

        Call it from the route ``redirect_url`` points at, with the end user from your own session
        and the ``flow_id`` from :func:`anlyon.parse_connect_redirect`. Until then the connection
        does not exist. A flow started for a different end user raises ``EndUserMismatchError``
        and connects nothing.
        """
        path = _user_path(end_user_id, "/connections/confirm")
        body = {"flowId": _required(flow_id, "flow_id")}
        return self._http.post(path, body=body, end_user_id=end_user_id)

    def set_connection(
        self,
        end_user_id: str,
        integration: str,
        *,
        token: str | None = None,
        fields: dict[str, str] | None = None,
    ) -> Any:
        """Store the end user's own key for an API-key integration. Never returned.

        Pass ``token`` for a one-value key, or ``fields`` for an integration whose key is several
        values or has a per-account host (Jira: ``{"site": ..., "email": ..., "apiToken": ...}``).
        """
        path = _user_path(end_user_id, f"/connections/{_segment(integration, 'integration')}")
        return self._http.put(path, body=_key_body(token, fields), end_user_id=end_user_id)

    def list_connections(self, end_user_id: str) -> Any:
        """The end user's connections: integration, status, scopes and timestamps. No tokens."""
        return self._http.get(_user_path(end_user_id, "/connections"), end_user_id=end_user_id)

    def delete_connection(self, end_user_id: str, integration: str) -> Any:
        """Revoke the connection at the provider when it supports that, then delete it."""
        path = _user_path(end_user_id, f"/connections/{_segment(integration, 'integration')}")
        return self._http.delete(path, end_user_id=end_user_id)

    def create_session(self, end_user_id: str, *, ttl_seconds: int | None = None) -> Any:
        """A short-lived session token for this end user's browser: ``{"token", "expiresAt", ...}``.

        For the prebuilt components in ``@anlyonhq/react``. The token can list, connect and
        disconnect the end user's accounts and, when this key has ``end-users:approvals``, list and
        decide their own approvals. Nothing else, and it cannot confirm a connection. Lasts 15
        minutes unless ``ttl_seconds`` (60 to 3600) says otherwise. Call it from a route that knows
        who is signed in, and only for that user. API keys only.
        """
        path = _user_path(end_user_id, "/sessions")
        return self._http.post(path, body=_session_body(ttl_seconds), end_user_id=end_user_id)

    def erase(self, end_user_id: str) -> Any:
        """Erase the end user: connections, limit counters and pending approvals (cancelled).

        Receipts are kept, with the id replaced by a one-way hash. Returns
        ``{"connectionsDeleted", "approvalsCancelled", "countersCleared", "erasedAs"}``: the
        counts of what was removed, and the hash the kept records now carry.
        """
        return self._http.delete(_user_path(end_user_id), end_user_id=end_user_id)

    def list(self, *, cursor: str | None = None, limit: int | None = None) -> Any:
        """End users with connections or activity, with counts.

        Pass ``response.pagination["nextCursor"]`` as ``cursor`` for the next page. A client from
        ``for_user()`` acts for one end user and cannot list the others.
        """
        _refuse_list_when_bound(self._http.end_user_id)
        return self._http.get(_BASE, params=_list_params(cursor, limit))


class AsyncEndUserApprovalsResource:
    """Approvals that belong to an end user (async)."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def list(self, end_user_id: str, *, status: str | None = None) -> Any:
        """The end user's approvals. Pass ``status="pending"`` for what still needs a decision."""
        return await self._http.get(
            _user_path(end_user_id, "/approvals"),
            params={"status": status} if status else None,
            end_user_id=end_user_id,
        )

    async def decide(
        self,
        end_user_id: str,
        approval_id: str,
        *,
        decision: Decision,
        reason: str | None = None,
    ) -> Any:
        """Record the end user's decision. Approving an action's approval runs it."""
        path = _user_path(end_user_id, f"/approvals/{_segment(approval_id, 'approval_id')}/decide")
        return await self._http.post(
            path, body=_decision_body(decision, reason), end_user_id=end_user_id
        )


class AsyncEndUsersResource:
    """End users and their connections (async). See :class:`EndUsersResource`."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http
        self._approvals: AsyncEndUserApprovalsResource | None = None

    @property
    def approvals(self) -> AsyncEndUserApprovalsResource:
        """Approvals the end user decides in your app."""
        if self._approvals is None:
            self._approvals = AsyncEndUserApprovalsResource(self._http)
        return self._approvals

    async def create_connect_link(
        self, *, end_user_id: str, integration: str, redirect_url: str | None = None
    ) -> Any:
        """A connect link for any integration. See the sync twin."""
        path = _user_path(end_user_id, "/connect-links")
        return await self._http.post(
            path, body=_link_body(integration, redirect_url), end_user_id=end_user_id
        )

    async def confirm_connection(self, end_user_id: str, flow_id: str) -> Any:
        """Finish a connect flow. See the sync twin."""
        path = _user_path(end_user_id, "/connections/confirm")
        body = {"flowId": _required(flow_id, "flow_id")}
        return await self._http.post(path, body=body, end_user_id=end_user_id)

    async def set_connection(
        self,
        end_user_id: str,
        integration: str,
        *,
        token: str | None = None,
        fields: dict[str, str] | None = None,
    ) -> Any:
        """Store the end user's own key for an API-key integration. Never returned."""
        path = _user_path(end_user_id, f"/connections/{_segment(integration, 'integration')}")
        return await self._http.put(path, body=_key_body(token, fields), end_user_id=end_user_id)

    async def list_connections(self, end_user_id: str) -> Any:
        """The end user's connections. No tokens."""
        return await self._http.get(
            _user_path(end_user_id, "/connections"), end_user_id=end_user_id
        )

    async def delete_connection(self, end_user_id: str, integration: str) -> Any:
        """Revoke the connection at the provider when it supports that, then delete it."""
        path = _user_path(end_user_id, f"/connections/{_segment(integration, 'integration')}")
        return await self._http.delete(path, end_user_id=end_user_id)

    async def create_session(self, end_user_id: str, *, ttl_seconds: int | None = None) -> Any:
        """A short-lived session token for this end user's browser. See the sync twin."""
        path = _user_path(end_user_id, "/sessions")
        return await self._http.post(path, body=_session_body(ttl_seconds), end_user_id=end_user_id)

    async def erase(self, end_user_id: str) -> Any:
        """Erase the end user. Receipts are kept, with the id replaced by a one-way hash.

        Returns ``{"connectionsDeleted", "approvalsCancelled", "countersCleared", "erasedAs"}``.
        """
        return await self._http.delete(_user_path(end_user_id), end_user_id=end_user_id)

    async def list(self, *, cursor: str | None = None, limit: int | None = None) -> Any:
        """End users with connections or activity, with counts."""
        _refuse_list_when_bound(self._http.end_user_id)
        return await self._http.get(_BASE, params=_list_params(cursor, limit))
