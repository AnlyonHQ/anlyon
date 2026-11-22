"""
Client configuration  mirrors src/types/config.ts in the TS SDK.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class RetryConfig(BaseModel):
    max_attempts: int = 3
    initial_delay: float = 0.1
    max_delay: float = 10.0
    backoff_multiplier: float = 2.0
    jitter: bool = True
    retryable_statuses: list[int] = Field(default_factory=lambda: [429, 500, 502, 503, 504])


class AnlyonClientConfig(BaseModel):
    api_key: str
    base_url: str = "https://api.anlyon.com"
    timeout: float = 30.0
    retry: RetryConfig = Field(default_factory=RetryConfig)
    default_headers: dict[str, str] | None = None
