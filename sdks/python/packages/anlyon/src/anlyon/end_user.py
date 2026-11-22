"""
The end user a call acts for. Mirrors src/core/end-user.ts in the TS SDK.

The developer's server states the end user, and the model never does. A client built with
``client.for_user(end_user_id)`` sends ``Anlyon-End-User`` on every request, and nothing else in
the SDK can set or change that header.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, cast
from urllib.parse import parse_qs, urlsplit

from .errors import AnlyonError

END_USER_HEADER = "Anlyon-End-User"
"""The header that names the end user a call acts for."""

END_USER_ID_PATTERN = re.compile(r"[A-Za-z0-9._:@-]{1,128}")
"""What an end-user id may be: 1 to 128 characters from ``A-Z a-z 0-9 . _ : @ -``."""


def is_valid_end_user_id(value: Any) -> bool:
    """True when ``value`` is a well-formed end-user id."""
    return isinstance(value, str) and END_USER_ID_PATTERN.fullmatch(value) is not None


def check_end_user_id(value: Any) -> str:
    """Return ``value`` when it is a well-formed end-user id. Raise ``VALIDATION_ERROR`` if not.

    Sends nothing.
    """
    if is_valid_end_user_id(value):
        return str(value)
    got = f"{len(value)} characters" if isinstance(value, str) else type(value).__name__
    raise AnlyonError(
        f"An end-user id is 1 to 128 characters from A-Z, a-z, 0-9 and . _ : @ - (got {got}).",
        code="VALIDATION_ERROR",
    )


def names_end_user(headers: Mapping[str, Any] | None) -> bool:
    """True when a header mapping already names an end user, under any capitalisation."""
    wanted = END_USER_HEADER.lower()
    return any(name.lower() == wanted for name in (headers or {}))


ConnectRedirectStatus = Literal["pending_confirmation", "connected", "declined", "error"]

_REDIRECT_STATUSES = ("pending_confirmation", "connected", "declined", "error")


@dataclass(frozen=True)
class ConnectRedirect:
    """What :func:`parse_connect_redirect` reads from the redirect back to your app.

    ``status`` is ``pending_confirmation`` when the end user consented: call
    ``end_users.confirm_connection()`` with ``flow_id`` to finish. With ``declined`` or ``error``
    nothing was connected.
    """

    status: ConnectRedirectStatus
    flow_id: str | None
    integration: str | None


def parse_connect_redirect(url: str) -> ConnectRedirect | None:
    """Read the result of a connect flow from the URL Anlyon redirected the end user to.

    That is your ``redirect_url`` with ``anlyon_status``, ``anlyon_flow`` and ``integration``
    added. Accepts a full URL, a path with a query, or a bare query string. Returns ``None`` when it
    carries no recognisable result.

    It deliberately does not return the end user named in the URL. Anyone can edit a URL: confirm
    with the end user from your own session::

        @app.get("/connections/callback")
        def callback(request: Request, user: User = Depends(current_user)):
            result = parse_connect_redirect(str(request.url))
            if result and result.status == "pending_confirmation" and result.flow_id:
                anlyon.end_users.confirm_connection(user.id, result.flow_id)
            return RedirectResponse("/settings/connections")
    """
    if not isinstance(url, str):
        return None
    query = urlsplit(url).query if ("?" in url or "://" in url) else url.lstrip("?")
    params = parse_qs(query, keep_blank_values=True)

    def first(name: str) -> str | None:
        values = params.get(name)
        return values[0] if values and values[0] else None

    status = first("anlyon_status")
    if status not in _REDIRECT_STATUSES:
        return None
    return ConnectRedirect(
        status=cast(ConnectRedirectStatus, status),
        flow_id=first("anlyon_flow"),
        integration=first("integration"),
    )
