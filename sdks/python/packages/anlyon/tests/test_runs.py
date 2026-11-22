"""Runs resource  the agent trace model."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from anlyon import AsyncClient, Client

BASE_URL = "https://api.anlyon.com"


def _ok(data: object) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": data})


@respx.mock
def test_start_run_posts_to_runs() -> None:
    route = respx.post(f"{BASE_URL}/api/v2/runs").mock(return_value=_ok({"id": "run_1"}))
    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        result = client.runs.start(name="nightly", agent_id="agt_1")
    assert result.data["id"] == "run_1"
    body = json.loads(route.calls[0].request.content)
    assert body == {"name": "nightly", "agentId": "agt_1"}


@respx.mock
def test_start_run_sends_idempotency_key() -> None:
    route = respx.post(f"{BASE_URL}/api/v2/runs").mock(return_value=_ok({"id": "run_1"}))
    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        client.runs.start(name="x", idempotency_key="k1")
    assert route.calls[0].request.headers.get("idempotency-key") == "k1"


@respx.mock
def test_list_runs_passes_filters() -> None:
    route = respx.get(f"{BASE_URL}/api/v2/runs").mock(return_value=_ok([]))
    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        client.runs.list(search="billing", status="failed", limit=10)
    url = str(route.calls[0].request.url)
    assert "search=billing" in url and "status=failed" in url and "limit=10" in url


@respx.mock
def test_get_run_returns_span_tree() -> None:
    respx.get(f"{BASE_URL}/api/v2/runs/run_1").mock(
        return_value=_ok({"id": "run_1", "spans": [{"id": "span_a", "children": []}]})
    )
    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        result = client.runs.get("run_1")
    assert result.data["spans"][0]["id"] == "span_a"


@respx.mock
def test_export_run_trace() -> None:
    route = respx.get(f"{BASE_URL}/api/v2/runs/run_1/export").mock(return_value=_ok({"resourceSpans": []}))
    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        result = client.runs.export_trace("run_1")
    assert result.data["resourceSpans"] == []
    assert route.called


@respx.mock
def test_import_run_trace() -> None:
    route = respx.post(f"{BASE_URL}/api/v2/runs/import").mock(return_value=httpx.Response(201, json={"success": True, "data": {"id": "run_imported"}}))
    trace = {"resourceSpans": [{"scopeSpans": [{"spans": [{"spanId": "a", "name": "root", "startTimeUnixNano": "1"}]}]}]}
    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        result = client.runs.import_trace(trace, idempotency_key="import-1")
    assert result.data["id"] == "run_imported"
    assert json.loads(route.calls[0].request.content) == trace
    assert route.calls[0].request.headers.get("idempotency-key") == "import-1"


@respx.mock
def test_end_run_patches() -> None:
    route = respx.patch(f"{BASE_URL}/api/v2/runs/run_1").mock(
        return_value=_ok({"id": "run_1", "status": "succeeded"})
    )
    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        client.runs.end("run_1", status="succeeded", output={"ok": True})
    body = json.loads(route.calls[0].request.content)
    assert body == {"status": "succeeded", "output": {"ok": True}}


@respx.mock
def test_ingest_spans_wraps_in_envelope() -> None:
    route = respx.post(f"{BASE_URL}/api/v2/runs/run_1/spans").mock(return_value=_ok({"ingested": 2}))
    spans = [
        {"id": "span_a", "name": "plan", "type": "model_call", "startedAt": "2026-07-15T00:00:00Z"},
        {"id": "span_b", "name": "call", "type": "tool_call", "startedAt": "2026-07-15T00:00:01Z"},
    ]
    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        result = client.runs.ingest_spans("run_1", spans)
    assert result.data["ingested"] == 2
    body = json.loads(route.calls[0].request.content)
    assert len(body["spans"]) == 2


@respx.mock
def test_add_feedback() -> None:
    route = respx.post(f"{BASE_URL}/api/v2/runs/run_1/feedback").mock(return_value=_ok({"id": "fbk_1"}))
    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        result = client.runs.add_feedback("run_1", label="thumbs_up", rating=1)
    assert result.data["id"] == "fbk_1"
    body = json.loads(route.calls[0].request.content)
    assert body == {"label": "thumbs_up", "rating": 1}


@respx.mock
def test_list_feedback() -> None:
    respx.get(f"{BASE_URL}/api/v2/runs/run_1/feedback").mock(return_value=_ok([{"id": "fbk_1"}]))
    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        result = client.runs.list_feedback("run_1")
    assert result.data[0]["id"] == "fbk_1"


@pytest.mark.asyncio
@respx.mock
async def test_async_run_lifecycle() -> None:
    respx.post(f"{BASE_URL}/api/v2/runs").mock(return_value=_ok({"id": "run_1"}))
    respx.patch(f"{BASE_URL}/api/v2/runs/run_1").mock(return_value=_ok({"id": "run_1", "status": "succeeded"}))
    async with AsyncClient(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        started = await client.runs.start(name="async")
        ended = await client.runs.end("run_1", status="succeeded")
    assert started.data["id"] == "run_1"
    assert ended.data["status"] == "succeeded"
