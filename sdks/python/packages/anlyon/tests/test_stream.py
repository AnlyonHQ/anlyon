"""Realtime event stream helper (item 3)."""

from __future__ import annotations

import json

import httpx
import respx

from anlyon import Client

BASE_URL = "https://api.anlyon.com"


def _evt(event_id: str, event_type: str, data: dict) -> str:
    payload = {"id": event_id, "v": 1, "type": event_type, "environmentId": None, "data": data, "ts": 1}
    return f"id: {event_id}\nevent: {event_type}\ndata: {json.dumps(payload)}\n\n"


@respx.mock
def test_stream_yields_typed_events_and_skips_control_frames() -> None:
    body = (
        "event: ready\ndata: {\"v\":1}\n\n"
        + _evt("1-0", "run.started", {"runId": "run_1"})
        + ":heartbeat\n\n"
        + _evt("2-0", "run.ended", {"runId": "run_1"})
    )
    respx.get(f"{BASE_URL}/api/v2/stream").mock(
        return_value=httpx.Response(200, headers={"content-type": "text/event-stream"}, text=body)
    )

    received = []
    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        for event in client.stream():
            received.append(event["type"])
            if len(received) == 2:
                break

    assert received == ["run.started", "run.ended"]


@respx.mock
def test_stream_sends_accept_and_resume_cursor() -> None:
    route = respx.get(f"{BASE_URL}/api/v2/stream").mock(
        return_value=httpx.Response(200, headers={"content-type": "text/event-stream"}, text=_evt("5-0", "ping", {}))
    )

    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        for _event in client.stream(cursor="4-0"):
            break

    request = route.calls[0].request
    assert request.headers.get("accept") == "text/event-stream"
    assert request.headers.get("last-event-id") == "4-0"


@respx.mock
def test_stream_parses_event_payload() -> None:
    respx.get(f"{BASE_URL}/api/v2/stream").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            text=_evt("7-0", "approval.requested", {"approvalId": "apr_1"}),
        )
    )
    with Client(api_key="anlyon_live_test", base_url=BASE_URL) as client:
        for event in client.stream():
            assert event["type"] == "approval.requested"
            assert event["data"]["approvalId"] == "apr_1"
            assert event["v"] == 1
            break
