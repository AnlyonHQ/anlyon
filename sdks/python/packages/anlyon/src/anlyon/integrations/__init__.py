"""
Integrations with agent frameworks.

Each module here is duck-typed against a framework's protocol and imports
nothing from it  installing `anlyon` never drags in an agent framework, and
these modules import cleanly whether or not the framework is present.

``action_tools`` holds what a framework adapter needs to present an action as a
tool; ``anlyon-langchain`` and ``anlyon-llamaindex`` build on it. Version 0.10
removed ``AnlyonSession`` (the OpenAI Agents SDK session over the retired
sessions API).
"""

__all__: list[str] = []
