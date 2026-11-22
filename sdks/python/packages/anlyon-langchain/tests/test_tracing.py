from types import SimpleNamespace
from uuid import UUID

from anlyon_langchain import AnlyonTracer


class _Runs:
    def __init__(self) -> None:
        self.started: list[dict] = []
        self.spans: list[tuple[str, list[dict]]] = []
        self.ended: list[tuple[str, dict]] = []

    def start(self, **kwargs):
        self.started.append(kwargs)
        return SimpleNamespace(data={"id": "run_langchain"})

    def ingest_spans(self, run_id, spans):
        self.spans.append((run_id, spans))

    def end(self, run_id, **kwargs):
        self.ended.append((run_id, kwargs))


class _Client:
    def __init__(self) -> None:
        self.runs = _Runs()


def test_tracer_creates_a_run_and_parent_linked_chain_llm_tool_spans() -> None:
    client = _Client()
    tracer = AnlyonTracer(client, application="support-agent")
    root = UUID("00000000-0000-0000-0000-000000000001")
    llm = UUID("00000000-0000-0000-0000-000000000002")
    tool = UUID("00000000-0000-0000-0000-000000000003")

    tracer.on_chain_start({"name": "agent"}, {"question": "Where is my order?"}, run_id=root, tags=["prod"])
    tracer.on_llm_start({"name": "gpt"}, ["answer"], run_id=llm, parent_run_id=root)
    tracer.on_llm_end(SimpleNamespace(llm_output={"model": "gpt"}), run_id=llm)
    tracer.on_tool_start({"name": "lookup_order"}, "123", run_id=tool, parent_run_id=root)
    tracer.on_tool_end({"state": "shipped"}, run_id=tool)
    tracer.on_chain_end({"answer": "shipped"}, run_id=root)

    assert client.runs.started == [{"name": "LangChain run", "application": "support-agent", "tags": ["prod"], "metadata": {"framework": "langchain"}}]
    written = [batch[0] for _, batch in client.runs.spans]
    created = [span for span in written if "endedAt" not in span]
    completed = [span for span in written if "endedAt" in span]
    assert [span["type"] for span in created] == ["workflow_step", "model_call", "tool_call"]
    assert created[1]["parentId"] == "lc_00000000000000000000000000000001"
    assert created[2]["parentId"] == "lc_00000000000000000000000000000001"
    assert completed[0]["type"] == "model_call"
    assert completed[0]["startedAt"] == created[1]["startedAt"]
    assert client.runs.ended == [("run_langchain", {"status": "succeeded", "output": {"answer": "shipped"}})]


def test_tracer_captures_openai_style_token_usage_and_model() -> None:
    client = _Client()
    tracer = AnlyonTracer(client)
    llm = UUID("00000000-0000-0000-0000-000000000002")

    tracer.on_llm_start({"name": "gpt"}, ["hi"], run_id=llm)
    tracer.on_llm_end(
        SimpleNamespace(
            llm_output={
                "model_name": "gpt-4o",
                "token_usage": {"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150},
            }
        ),
        run_id=llm,
    )

    completed = [span for _, batch in client.runs.spans for span in batch if "endedAt" in span]
    assert completed[0]["tokens"] == {"input": 120, "output": 30, "total": 150}
    assert completed[0]["model"] == "gpt-4o"


def test_tracer_captures_usage_metadata_from_generations() -> None:
    client = _Client()
    tracer = AnlyonTracer(client)
    llm = UUID("00000000-0000-0000-0000-000000000003")

    tracer.on_llm_start({"name": "claude"}, ["hi"], run_id=llm)
    generation = SimpleNamespace(
        message=SimpleNamespace(usage_metadata={"input_tokens": 200, "output_tokens": 45, "total_tokens": 245})
    )
    tracer.on_llm_end(
        SimpleNamespace(llm_output=None, generations=[[generation]]),
        run_id=llm,
    )

    completed = [span for _, batch in client.runs.spans for span in batch if "endedAt" in span]
    assert completed[0]["tokens"] == {"input": 200, "output": 45, "total": 245}


def test_tracer_omits_tokens_when_provider_reports_none() -> None:
    client = _Client()
    tracer = AnlyonTracer(client)
    llm = UUID("00000000-0000-0000-0000-000000000004")

    tracer.on_llm_start({"name": "gpt"}, ["hi"], run_id=llm)
    tracer.on_llm_end(SimpleNamespace(llm_output={"model": "gpt"}), run_id=llm)

    completed = [span for _, batch in client.runs.spans for span in batch if "endedAt" in span]
    assert "tokens" not in completed[0]
    assert completed[0]["model"] == "gpt"


def test_tracer_swallows_observability_failures() -> None:
    class FailingRuns(_Runs):
        def start(self, **kwargs):
            raise RuntimeError("network unavailable")

    client = _Client()
    client.runs = FailingRuns()
    tracer = AnlyonTracer(client)
    tracer.on_chain_start({"name": "agent"}, {}, run_id=UUID("00000000-0000-0000-0000-000000000001"))
