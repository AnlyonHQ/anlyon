"""
Error hierarchy  mirrors the TS SDK (src/core/errors.ts).

All errors extend AnlyonError. The create_error_from_response factory
maps HTTP status + error code to the right subclass.
"""

from __future__ import annotations

from typing import Any


def parse_error_fix(value: Any) -> dict[str, str] | None:
    """Read the API's optional ``error.fix``: ``{summary, command?, url?, docs?}``.

    Anything that is not that shape is dropped, so a malformed field never breaks error handling.
    """
    if not isinstance(value, dict):
        return None
    summary = value.get("summary")
    if not isinstance(summary, str) or not summary:
        return None
    fix = {"summary": summary}
    for key in ("command", "url", "docs"):
        item = value.get(key)
        if isinstance(item, str) and item:
            fix[key] = item
    return fix


class AnlyonError(Exception):
    """Base error for all Anlyon SDK failures.

    ``fix`` is what the API says to do about the error, when it says: a one-sentence
    ``summary``, and optionally the exact CLI ``command``, a console ``url`` and a ``docs`` link.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str = "UNKNOWN_ERROR",
        status: int | None = None,
        details: Any = None,
        request_id: str | None = None,
        retry_after: float | None = None,
        fix: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details
        self.request_id = request_id
        self.retry_after = retry_after
        self.fix = fix

    @property
    def is_retryable(self) -> bool:
        return self.code in ("RATE_LIMIT_EXCEEDED", "NETWORK_ERROR", "TIMEOUT_ERROR")

    @property
    def is_auth_error(self) -> bool:
        return self.code == "AUTHENTICATION_FAILED"

    @property
    def is_validation_error(self) -> bool:
        return self.code == "VALIDATION_ERROR"

    @property
    def is_not_found(self) -> bool:
        return self.code == "NOT_FOUND"

    def __str__(self) -> str:
        extras = []
        if self.status:
            extras.append(f"status={self.status}")
        if self.request_id:
            extras.append(f"request_id={self.request_id}")
        base = f"{self.code}: {self.args[0]}"
        return f"{base} [{', '.join(extras)}]" if extras else base


class AuthenticationError(AnlyonError):
    def __init__(self, message: str = "Authentication failed", **kwargs: Any) -> None:
        kwargs.setdefault("status", 401)
        super().__init__(message, code="AUTHENTICATION_FAILED", **kwargs)


class RateLimitError(AnlyonError):
    def __init__(
        self,
        message: str = "Rate limit exceeded",
        *,
        retry_after: float | None = None,
        **kwargs: Any,
    ) -> None:
        kwargs.setdefault("status", 429)
        super().__init__(message, code="RATE_LIMIT_EXCEEDED", retry_after=retry_after, **kwargs)


class QuotaExceededError(AnlyonError):
    def __init__(self, message: str = "Quota exceeded", **kwargs: Any) -> None:
        kwargs.setdefault("status", 402)
        super().__init__(message, code="QUOTA_EXCEEDED", **kwargs)


class ValidationError(AnlyonError):
    def __init__(self, message: str = "Validation error", **kwargs: Any) -> None:
        kwargs.setdefault("status", 400)
        super().__init__(message, code="VALIDATION_ERROR", **kwargs)


class NotFoundError(AnlyonError):
    def __init__(self, message: str = "Not found", **kwargs: Any) -> None:
        kwargs.setdefault("status", 404)
        super().__init__(message, code="NOT_FOUND", **kwargs)


class FeatureNotAvailableError(AnlyonError):
    def __init__(self, message: str = "Feature not available", **kwargs: Any) -> None:
        kwargs.setdefault("status", 402)
        super().__init__(message, code="FEATURE_NOT_AVAILABLE", **kwargs)


class NetworkError(AnlyonError):
    def __init__(
        self, message: str = "Network error", *, cause: Exception | None = None, **kwargs: Any
    ) -> None:
        super().__init__(message, code="NETWORK_ERROR", **kwargs)
        self.__cause__ = cause


class TimeoutError(AnlyonError):
    def __init__(
        self, message: str = "Request timeout", *, timeout: float | None = None, **kwargs: Any
    ) -> None:
        kwargs.setdefault("details", {"timeout": timeout} if timeout else None)
        super().__init__(message, code="TIMEOUT_ERROR", **kwargs)


class ApprovalDeniedError(AnlyonError):
    """A human denied (or let expire) an approval created by ``approvals.gate()``.

    Carries the decided approval on ``.approval`` so callers can read the
    decision note and audit trail.
    """

    def __init__(self, approval: Any, **kwargs: Any) -> None:
        status = approval.get("status") if hasattr(approval, "get") else "denied"
        title = approval.get("title") if hasattr(approval, "get") else ""
        super().__init__(f"Approval {status}: {title}", code="APPROVAL_DENIED", **kwargs)
        self.approval = approval


class ApprovalPendingError(AnlyonError):
    """The ``approvals.gate()`` wait elapsed with the approval still pending.

    The gated function did NOT run; the approval on ``.approval`` can still be
    decided  poll it with ``approvals.wait_for_decision()``.
    """

    def __init__(self, approval: Any, **kwargs: Any) -> None:
        title = approval.get("title") if hasattr(approval, "get") else ""
        super().__init__(
            f"Approval still pending after the wait: {title}", code="APPROVAL_PENDING", **kwargs
        )
        self.approval = approval


class SignOffRequiredError(AnlyonError):
    """``202`` with ``signOffRequired: true``: the change loosens a guardrail, and the credential
    that asked (an API key, a CLI login or an MCP session) may not loosen its own guardrails.

    Nothing was applied. The API stored the change as a sign-off request that a workspace admin
    approves or rejects at ``sign_off_url``. No API key can approve it. The SDK raises rather than
    returns, so code that assumed the change applied never treats a pending request as the
    updated object. Follow it with ``client.sign_offs.wait(error.sign_off_id)``::

        try:
            client.impact_limits.update(limit_id, amount=200_000)
        except SignOffRequiredError as error:
            print(f"Ask an admin to approve: {error.sign_off_url}")
            decided = client.sign_offs.wait(error.sign_off_id)
            if decided["status"] == "applied":
                print(decided["result"])
    """

    def __init__(self, sign_off: dict[str, Any], **kwargs: Any) -> None:
        url = sign_off.get("signOffUrl") or ""
        kwargs.setdefault("status", 202)
        kwargs.setdefault("details", sign_off)
        super().__init__(
            f"A human must approve this change before it applies. Give them this link: {url}",
            code="SIGN_OFF_REQUIRED",
            **kwargs,
        )
        self.sign_off = sign_off
        self.sign_off_url: str = url
        self.sign_off_id: str = sign_off.get("id") or ""


def is_sign_off_required_body(body: Any) -> bool:
    """True when a response body is the 202 that holds a pending sign-off request."""
    if not isinstance(body, dict) or body.get("signOffRequired") is not True:
        return False
    data = body.get("data")
    return isinstance(data, dict) and isinstance(data.get("id"), str)


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


class EndUserConnectionRequiredError(AnlyonError):
    """The end user has no working connection for the integration an action needs.

    The base class of :class:`EndUserNotConnectedError` and
    :class:`EndUserReconnectRequiredError`. Catch it to handle both the same way: send the end
    user to ``connect_url``. Nothing was sent to the provider.

    ``integration``, ``end_user_id``, ``connect_url`` and ``expires_at`` come from the error's
    details. ``connect_url`` is a fresh connect link that works once, for ten minutes. It is
    ``None`` when the environment has no default redirect URL: then make one with
    ``end_users.create_connect_link()`` and your own ``redirect_url``.
    """

    def __init__(
        self,
        message: str = "The end user has to connect first",
        *,
        code: str = "END_USER_NOT_CONNECTED",
        **kwargs: Any,
    ) -> None:
        kwargs.setdefault("status", 409)
        super().__init__(message, code=code, **kwargs)
        details = self.details if isinstance(self.details, dict) else {}
        self.integration: str = _text(details.get("integration")) or ""
        self.end_user_id: str = _text(details.get("endUserId")) or ""
        self.connect_url: str | None = _text(details.get("connectUrl"))
        self.expires_at: str | None = _text(details.get("expiresAt"))


class EndUserNotConnectedError(EndUserConnectionRequiredError):
    """``409 END_USER_NOT_CONNECTED``: the end user has not connected the integration.

    Show them a "Connect" button that opens ``connect_url``, then call again::

        try:
            client.for_user(user.id).actions.invoke("gmail-send-email", payload)
        except EndUserNotConnectedError as error:
            if error.connect_url:
                return redirect(error.connect_url)
            raise
    """

    def __init__(self, message: str = "The end user has not connected", **kwargs: Any) -> None:
        super().__init__(message, code="END_USER_NOT_CONNECTED", **kwargs)


class EndUserReconnectRequiredError(EndUserConnectionRequiredError):
    """``409 END_USER_RECONNECT_REQUIRED``: the end user's connection was revoked at the
    provider, or its token could not be refreshed. Send them to ``connect_url`` to connect again.
    """

    def __init__(self, message: str = "The end user has to reconnect", **kwargs: Any) -> None:
        super().__init__(message, code="END_USER_RECONNECT_REQUIRED", **kwargs)


class EndUserRequiredError(AnlyonError):
    """``400 END_USER_REQUIRED``: the API key requires an end user, and the call named none.

    Make the call with a client from ``client.for_user(end_user_id)``. Such a key never falls back
    to a workspace connection.
    """

    def __init__(self, message: str = "This API key requires an end user", **kwargs: Any) -> None:
        kwargs.setdefault("status", 400)
        super().__init__(message, code="END_USER_REQUIRED", **kwargs)


class EndUserMismatchError(AnlyonError):
    """``403 END_USER_MISMATCH`` from ``end_users.confirm_connection()``.

    The connect flow was started for a different end user than the one confirming it, and nothing
    was connected. This is the check that stops a link sent to someone else from attaching their
    account to your user: confirm with the end user from your own session, never one read from the
    redirect.
    """

    def __init__(self, message: str = "The flow belongs to another end user", **kwargs: Any) -> None:
        kwargs.setdefault("status", 403)
        super().__init__(message, code="END_USER_MISMATCH", **kwargs)


class RedirectUrlRequiredError(AnlyonError):
    """``400 REDIRECT_URL_REQUIRED`` from ``end_users.create_connect_link()``.

    The request named no ``redirect_url`` and the environment has no default. A connect flow has
    to come back to your server to be confirmed: pass one of the environment's allowed redirect
    URLs, or set a default in the console.
    """

    def __init__(self, message: str = "A redirect URL is required", **kwargs: Any) -> None:
        kwargs.setdefault("status", 400)
        super().__init__(message, code="REDIRECT_URL_REQUIRED", **kwargs)


_ERROR_CODE_MAP: dict[str, type[AnlyonError]] = {
    "AUTHENTICATION_FAILED": AuthenticationError,
    "RATE_LIMIT_EXCEEDED": RateLimitError,
    "QUOTA_EXCEEDED": QuotaExceededError,
    "VALIDATION_ERROR": ValidationError,
    "NOT_FOUND": NotFoundError,
    "FEATURE_NOT_AVAILABLE": FeatureNotAvailableError,
    "END_USER_NOT_CONNECTED": EndUserNotConnectedError,
    "END_USER_RECONNECT_REQUIRED": EndUserReconnectRequiredError,
    "END_USER_REQUIRED": EndUserRequiredError,
    "END_USER_MISMATCH": EndUserMismatchError,
    "REDIRECT_URL_REQUIRED": RedirectUrlRequiredError,
}


def create_error_from_response(
    status: int,
    body: dict[str, Any],
    request_id: str | None = None,
    retry_after: float | None = None,
) -> AnlyonError:
    """Map an HTTP error response to the right AnlyonError subclass."""
    error = body.get("error") or {}
    code = error.get("code", "UNKNOWN_ERROR")
    message = error.get("message", "Unknown error occurred")
    details = error.get("details")
    fix = parse_error_fix(error.get("fix"))

    cls = _ERROR_CODE_MAP.get(code)
    if cls is not None and issubclass(cls, EndUserConnectionRequiredError):
        merged = {k: v for k, v in error.items() if k not in ("code", "message", "details", "fix")}
        if isinstance(details, dict):
            merged.update(details)
        details = merged
    if cls:
        return cls(
            message,
            status=status,
            details=details,
            request_id=request_id,
            retry_after=retry_after,
            fix=fix,
        )

    return AnlyonError(
        message,
        code=code,
        status=status,
        details=details,
        request_id=request_id,
        retry_after=retry_after,
        fix=fix,
    )


class ScopeCheckError(AnlyonError):
    """The credential does not hold what the application needs, or holds something it should not.

    Raised by ``client.auth.require_scopes()``. It names scopes only, never anything about the key itself.
    """

    def __init__(self, missing: list[str], forbidden: list[str]) -> None:
        parts = []
        if missing:
            parts.append(f"missing scopes: {', '.join(missing)}")
        if forbidden:
            parts.append(f"holds scopes it must not: {', '.join(forbidden)}")
        super().__init__(
            f"This credential {'; '.join(parts)}",
            code="AUTHORIZATION_ERROR",
            details={"missing": missing, "forbidden": forbidden},
        )
        self.missing = missing
        self.forbidden = forbidden
