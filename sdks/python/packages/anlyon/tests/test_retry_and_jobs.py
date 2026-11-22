"""
Retry behavior, client config and env fallbacks, exercised through a kept
resource (``runs.start``, a POST like any other mutation).

The job-polling tests that used to live here exercised ``memory.wait_for_job``,
which went with the memory API; no other resource polls a job.
"""

import httpx
import pytest
import respx

from anlyon import AnlyonError, Client, RateLimitError, RetryConfig

BASE_URL = "https://api.anlyon.com"

FAST_RETRY = RetryConfig(max_attempts=3, initial_delay=0.001, max_delay=0.01, jitter=False)


@respx.mock
def test_retries_on_429_then_succeeds():
    route = respx.post(f"{BASE_URL}/api/v2/runs").mock(
        side_effect=[
            httpx.Response(
                429,
                json={
                    "success": False,
                    "error": {"code": "RATE_LIMIT_EXCEEDED", "message": "slow down"},
                },
                headers={"Retry-After": "0.001"},
            ),
            httpx.Response(201, json={"success": True, "data": {"id": "run_1"}}),
        ]
    )
    with Client(api_key="anlyon_live_test", retry=FAST_RETRY) as client:
        result = client.runs.start(name="nightly")
    assert result["id"] == "run_1"
    assert route.call_count == 2


@respx.mock
def test_raises_after_max_attempts():
    route = respx.post(f"{BASE_URL}/api/v2/runs").mock(
        return_value=httpx.Response(
            429,
            json={
                "success": False,
                "error": {"code": "RATE_LIMIT_EXCEEDED", "message": "slow down"},
            },
        )
    )
    with (
        Client(api_key="anlyon_live_test", retry=FAST_RETRY) as client,
        pytest.raises(RateLimitError),
    ):
        client.runs.start(name="nightly")
    assert route.call_count == 3


@respx.mock
def test_custom_retryable_statuses_respected():
    route = respx.post(f"{BASE_URL}/api/v2/runs").mock(
        return_value=httpx.Response(
            429,
            json={
                "success": False,
                "error": {"code": "RATE_LIMIT_EXCEEDED", "message": "slow down"},
            },
        )
    )
    retry = RetryConfig(max_attempts=3, initial_delay=0.001, retryable_statuses=[503])
    with (
        Client(api_key="anlyon_live_test", retry=retry) as client,
        pytest.raises(RateLimitError),
    ):
        client.runs.start(name="nightly")
    assert route.call_count == 1


def test_missing_api_key_raises(monkeypatch):
    monkeypatch.delenv("ANLYON_API_KEY", raising=False)
    with pytest.raises(AnlyonError) as exc_info:
        Client()
    assert exc_info.value.code == "MISSING_API_KEY"


@respx.mock
def test_env_var_fallbacks(monkeypatch):
    monkeypatch.setenv("ANLYON_API_KEY", "anlyon_live_env")
    monkeypatch.setenv("ANLYON_BASE_URL", "http://localhost:4000")
    route = respx.post("http://localhost:4000/api/v2/runs").mock(
        return_value=httpx.Response(201, json={"success": True, "data": {"id": "run_env"}})
    )
    with Client() as client:
        result = client.runs.start(name="nightly")
    assert result["id"] == "run_env"
    assert route.calls.last.request.headers["Authorization"] == "Bearer anlyon_live_env"
