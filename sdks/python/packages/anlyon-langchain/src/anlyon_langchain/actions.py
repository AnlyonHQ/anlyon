"""
Anlyon actions as LangChain tools.

One StructuredTool per enabled action. The tool calls client.actions.invoke(),
so Anlyon holds the credential, evaluates policy and makes the call.

Thin wrapper. It calls the SDK and never re-implements API logic.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from langchain_core.tools import StructuredTool

from anlyon import AnlyonError, Client
from anlyon.integrations.action_tools import (
    action_tool_description,
    action_tool_input_schema,
    connect_required_result,
    invocation_tool_result,
)


def _action_tool(client: Client, action: dict[str, Any]) -> StructuredTool:
    name: str = action["name"]

    def invoke(**tool_input: Any) -> dict[str, Any]:
        try:
            return invocation_tool_result(client.actions.invoke(name, tool_input).data)
        except AnlyonError as error:
            connect = connect_required_result(error)
            if connect is None:
                raise
            return connect

    return StructuredTool.from_function(
        func=invoke,
        name=name,
        description=action_tool_description(action),
        args_schema=action_tool_input_schema(action),
        infer_schema=False,
    )


def action_tools(client: Client, *, names: Sequence[str] | None = None) -> list[StructuredTool]:
    """Build one LangChain tool per enabled Anlyon action.

    The description is the action's own, followed by its declared impact when it declares one.
    The tool returns the invocation as a dict. ``grade`` is the receipt grade of a governed
    action, and ``None`` for an action with no declaration. A gated action comes back with
    ``pendingApproval`` and an ``approvalId``.

    ``names`` keeps the named actions and drops the rest.

    Pass ``client.for_user(end_user_id)`` to act for one of your users. When that end user has
    not connected the integration an action needs, the tool returns
    ``{"status": "connect_required", "integration", "connectUrl", "message"}`` (or
    ``reconnect_required``) instead of raising. No tool's input schema has an end-user field.
    """
    wanted = set(names) if names is not None else None
    return [
        _action_tool(client, action)
        for action in client.actions.list().data
        if action.get("enabled", True) and (wanted is None or action["name"] in wanted)
    ]
