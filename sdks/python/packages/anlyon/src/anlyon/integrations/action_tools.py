"""
What a framework adapter needs to present an action as a tool.

Framework-neutral and dependency-free. ``anlyon-langchain`` and
``anlyon-llamaindex`` both build on these three functions, so a tool reads the
same in either framework.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

_LIMIT_SENTENCE = "Each call counts toward any shared limit set for this environment."
_EMPTY_INPUT_SCHEMA: dict[str, Any] = {"type": "object", "properties": {}}


def impact_sentence(impact: Mapping[str, Any] | None) -> str | None:
    """Say what an action's declared impact is, in a form a model can read.

    Returns ``None`` when the action declares no impact.

        impact_sentence({"dimension": "emails", "unit": "emails", "amount": "count(input.to)", "bound": "exact"})
        # "Declared impact: emails. Each call counts toward any shared limit set for this environment."
    """
    if not impact:
        return None
    dimension = impact.get("dimension")
    if not isinstance(dimension, str) or not dimension:
        return None
    if dimension == "money":
        unit = impact.get("unit")
        label = f"money in {unit.upper()}" if isinstance(unit, str) and unit else "money"
    else:
        label = dimension.replace("_", " ")
    return f"Declared impact: {label}. {_LIMIT_SENTENCE}"


def action_tool_description(action: Mapping[str, Any]) -> str:
    """The tool description for an action: its own description, then its declared impact."""
    description = action.get("description")
    parts = [description.strip()] if isinstance(description, str) and description.strip() else []
    if not parts:
        parts.append(f"Invoke the Anlyon action {action.get('name')}.")
    sentence = impact_sentence(action.get("impact"))
    if sentence:
        parts.append(sentence)
    return " ".join(parts)


def action_tool_input_schema(action: Mapping[str, Any]) -> dict[str, Any]:
    """The action's input schema as a JSON Schema object. An action with none takes no input."""
    schema = action.get("inputSchema")
    if isinstance(schema, Mapping) and schema.get("type") == "object":
        return dict(schema)
    return dict(_EMPTY_INPUT_SCHEMA)


_CONNECT_STATUSES = {
    "END_USER_NOT_CONNECTED": "connect_required",
    "END_USER_RECONNECT_REQUIRED": "reconnect_required",
}


def connect_required_result(error: BaseException) -> dict[str, Any] | None:
    """The tool result for an error that means the end user has to connect, or connect again.

    Returns ``None`` for any other error, which the caller should re-raise. A tool built on a
    ``client.for_user(end_user_id)`` client returns this instead of raising, so the model can tell
    the user and your app can render ``connectUrl`` as a "Connect" button::

        {"status": "connect_required", "integration": "gmail",
         "connectUrl": "https://...", "message": "The user has not connected gmail yet, ..."}

    ``status`` is ``reconnect_required`` for a connection the provider revoked. ``connectUrl`` is
    ``None`` when the environment has no default redirect URL. Nothing was sent to the provider.
    """
    status = _CONNECT_STATUSES.get(str(getattr(error, "code", "")))
    if status is None:
        return None
    details = getattr(error, "details", None)
    details = details if isinstance(details, Mapping) else {}
    integration = getattr(error, "integration", None) or details.get("integration") or ""
    connect_url = getattr(error, "connect_url", None) or details.get("connectUrl") or None
    named = integration or "the account this needs"
    if status == "connect_required":
        message = (
            f"The user has not connected {named} yet, so nothing was done. "
            "Ask them to connect it, then try again."
        )
    else:
        message = (
            f"The user's {named} connection has stopped working, so nothing was done. "
            "Ask them to reconnect it, then try again."
        )
    return {
        "status": status,
        "integration": integration,
        "connectUrl": connect_url,
        "message": message,
    }


def invocation_tool_result(data: Mapping[str, Any] | None) -> dict[str, Any]:
    """The invocation as a tool result. ``grade`` is always present.

    A governed action answers with a receipt grade. A template action with no declaration creates
    no effect, so its grade is ``None``.
    """
    result = dict(data or {})
    result.setdefault("grade", None)
    return result
