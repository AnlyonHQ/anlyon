"""
Anlyon actions as LlamaIndex tools.

One FunctionTool per enabled action. The tool calls client.actions.invoke(),
so Anlyon holds the credential, evaluates policy and makes the call.

Thin wrapper. It calls the SDK and never re-implements API logic.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from llama_index.core.tools import FunctionTool, ToolMetadata

from anlyon import AnlyonError, Client
from anlyon.integrations.action_tools import (
    action_tool_description,
    action_tool_input_schema,
    connect_required_result,
    invocation_tool_result,
)


@dataclass
class _ActionToolMetadata(ToolMetadata):
    """Tool metadata whose parameters are the action's own input schema."""

    parameters: dict[str, Any] = field(default_factory=dict)

    def get_parameters_dict(self) -> dict[str, Any]:
        return self.parameters


def _action_tool(client: Client, action: dict[str, Any]) -> FunctionTool:
    name: str = action["name"]

    def invoke(**tool_input: Any) -> dict[str, Any]:
        try:
            return invocation_tool_result(client.actions.invoke(name, tool_input).data)
        except AnlyonError as error:
            connect = connect_required_result(error)
            if connect is None:
                raise
            return connect

    metadata = _ActionToolMetadata(
        name=name,
        description=action_tool_description(action),
        fn_schema=None,
        parameters=action_tool_input_schema(action),
    )
    return FunctionTool.from_defaults(fn=invoke, tool_metadata=metadata)


def action_tools(client: Client, *, names: Sequence[str] | None = None) -> list[FunctionTool]:
    """Build one LlamaIndex tool per enabled Anlyon action.

    The description is the action's own, followed by its declared impact when it declares one.
    The tool's raw output is the invocation as a dict. ``grade`` is the receipt grade of a
    governed action, and ``None`` for an action with no declaration. A gated action comes back
    with ``pendingApproval`` and an ``approvalId``.

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
