"""LangChain callback adapter for the Anlyon run/span trace model.

The handler is deliberately best-effort: observability must never change the
result of an agent run. It maps LangChain run UUIDs to Anlyon span IDs and uses
the parent UUID supplied by LangChain to preserve nesting.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from threading import RLock
from typing import Any, Optional
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler

from anlyon import Client


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _span_id(run_id: UUID) -> str:
    return f"lc_{run_id.hex}"


def _safe_value(value: Any) -> Any:
    """Keep callback payloads JSON-compatible before SDK serialization."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _safe_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_safe_value(item) for item in value]
    return str(value)


def _extract_llm_usage(response: Any) -> tuple[Optional[dict[str, int]], Optional[str]]:
    """Pull token usage and model name from an LLMResult, best-effort.

    Providers report usage in two places: ``llm_output["token_usage"]``
    (OpenAI-style ``prompt_tokens``/``completion_tokens``/``total_tokens``) and
    the newer per-generation ``message.usage_metadata`` (``input_tokens``/
    ``output_tokens``/``total_tokens``). Both normalize to the Anlyon span
    convention: ``{"input": ..., "output": ..., "total": ...}``.
    """
    tokens: Optional[dict[str, int]] = None
    model: Optional[str] = None

    llm_output = getattr(response, "llm_output", None)
    if isinstance(llm_output, dict):
        model = llm_output.get("model_name") or llm_output.get("model")
        usage = llm_output.get("token_usage") or llm_output.get("usage")
        if isinstance(usage, dict):
            normalized = {
                "input": usage.get("prompt_tokens", usage.get("input_tokens")),
                "output": usage.get("completion_tokens", usage.get("output_tokens")),
                "total": usage.get("total_tokens"),
            }
            tokens = {k: int(v) for k, v in normalized.items() if isinstance(v, (int, float))}

    if tokens is None:
        for generations in getattr(response, "generations", []) or []:
            for generation in generations:
                usage = getattr(getattr(generation, "message", None), "usage_metadata", None)
                if isinstance(usage, dict) and usage:
                    tokens = {
                        k: int(v)
                        for k, v in {
                            "input": usage.get("input_tokens"),
                            "output": usage.get("output_tokens"),
                            "total": usage.get("total_tokens"),
                        }.items()
                        if isinstance(v, (int, float))
                    }
                    break
            if tokens:
                break

    return (tokens or None), model


@dataclass
class _TraceState:
    run_id: str
    root_langchain_id: UUID
    spans: dict[UUID, "_TrackedSpan"] = field(default_factory=dict)


@dataclass
class _TrackedSpan:
    id: str
    name: str
    type: str
    parent_id: Optional[str]
    started_at: str
    input: Any
    attributes: dict[str, Any]


class AnlyonTracer(BaseCallbackHandler):
    """Emit a run and nested spans for LangChain chain, LLM, and tool callbacks.

    Attach one instance to a LangChain invocation with ``callbacks=[tracer]``.
    The adapter keeps only in-flight UUID mappings in memory and is safe to
    share across concurrent invocations.
    """

    raise_error = False

    def __init__(self, client: Client, *, application: str = "langchain", run_name: str = "LangChain run") -> None:
        super().__init__()
        self.client = client
        self.application = application
        self.run_name = run_name
        self._states: dict[UUID, _TraceState] = {}
        self._lock = RLock()

    def _start(
        self,
        kind: str,
        run_id: UUID,
        parent_run_id: Optional[UUID],
        name: str,
        input: Any = None,
        tags: Optional[list[str]] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        try:
            with self._lock:
                state = self._states.get(parent_run_id) if parent_run_id else None
                if state is None:
                    started = self.client.runs.start(
                        name=self.run_name,
                        application=self.application,
                        tags=tags,
                        metadata={"framework": "langchain", **(metadata or {})},
                    )
                    state = _TraceState(run_id=started.data["id"], root_langchain_id=run_id)
                parent_id = state.spans.get(parent_run_id).id if parent_run_id in state.spans else None
                started_at = _now()
                span = _TrackedSpan(
                    id=_span_id(run_id),
                    name=name,
                    type=kind,
                    parent_id=parent_id,
                    started_at=started_at,
                    input=_safe_value(input),
                    attributes={
                        "langchain.run_id": str(run_id),
                        "langchain.parent_run_id": str(parent_run_id) if parent_run_id else None,
                        "langchain.kind": kind,
                    },
                )
                state.spans[run_id] = span
                self._states[run_id] = state

            self.client.runs.ingest_spans(
                state.run_id,
                [{
                    "id": span.id,
                    **({"parentId": parent_id} if parent_id else {}),
                    "name": span.name,
                    "type": span.type,
                    "startedAt": span.started_at,
                    **({"input": span.input} if input is not None else {}),
                    "attributes": span.attributes,
                }],
            )
        except Exception:
            return

    def _finish(
        self,
        run_id: UUID,
        *,
        error: Optional[BaseException] = None,
        output: Any = None,
        tokens: Optional[dict[str, int]] = None,
        model: Optional[str] = None,
    ) -> None:
        try:
            with self._lock:
                state = self._states.get(run_id)
                if state is None:
                    return
                is_root = state.root_langchain_id == run_id
                span = state.spans[run_id]
            status = "failed" if error else "succeeded"
            self.client.runs.ingest_spans(
                state.run_id,
                [{
                    "id": span.id,
                    **({"parentId": span.parent_id} if span.parent_id else {}),
                    "name": span.name,
                    "type": span.type,
                    "status": status,
                    "startedAt": span.started_at,
                    "endedAt": _now(),
                    **({"tokens": tokens} if tokens else {}),
                    **({"model": model} if model else {}),
                    **({"input": span.input} if span.input is not None else {}),
                    **({"output": _safe_value(output)} if output is not None else {}),
                    **({"error": {"message": str(error)}} if error else {}),
                    "attributes": span.attributes,
                }],
            )
            if is_root:
                self.client.runs.end(state.run_id, status=status, **({"output": _safe_value(output)} if output is not None else {}))
                with self._lock:
                    for langchain_id, mapped in list(self._states.items()):
                        if mapped is state:
                            del self._states[langchain_id]
        except Exception:
            return

    def on_chain_start(self, serialized: dict[str, Any], inputs: dict[str, Any], *, run_id: UUID, parent_run_id: Optional[UUID] = None, tags: Optional[list[str]] = None, metadata: Optional[dict[str, Any]] = None, **_: Any) -> None:
        self._start("workflow_step", run_id, parent_run_id, serialized.get("name", "chain"), inputs, tags, metadata)

    def on_chain_end(self, outputs: dict[str, Any], *, run_id: UUID, **_: Any) -> None:
        self._finish(run_id, output=outputs)

    def on_chain_error(self, error: BaseException, *, run_id: UUID, **_: Any) -> None:
        self._finish(run_id, error=error)

    def on_llm_start(self, serialized: dict[str, Any], prompts: list[str], *, run_id: UUID, parent_run_id: Optional[UUID] = None, tags: Optional[list[str]] = None, metadata: Optional[dict[str, Any]] = None, **_: Any) -> None:
        self._start("model_call", run_id, parent_run_id, serialized.get("name", "llm"), {"prompts": prompts}, tags, metadata)

    def on_llm_end(self, response: Any, *, run_id: UUID, **_: Any) -> None:
        tokens, model = _extract_llm_usage(response)
        self._finish(run_id, output=getattr(response, "llm_output", None), tokens=tokens, model=model)

    def on_llm_error(self, error: BaseException, *, run_id: UUID, **_: Any) -> None:
        self._finish(run_id, error=error)

    def on_tool_start(self, serialized: dict[str, Any], input_str: str, *, run_id: UUID, parent_run_id: Optional[UUID] = None, tags: Optional[list[str]] = None, metadata: Optional[dict[str, Any]] = None, **_: Any) -> None:
        self._start("tool_call", run_id, parent_run_id, serialized.get("name", "tool"), input_str, tags, metadata)

    def on_tool_end(self, output: Any, *, run_id: UUID, **_: Any) -> None:
        self._finish(run_id, output=output)

    def on_tool_error(self, error: BaseException, *, run_id: UUID, **_: Any) -> None:
        self._finish(run_id, error=error)
