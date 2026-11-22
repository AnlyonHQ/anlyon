"""Secret stores and external secrets (Enterprise): request shapes."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
import respx

from anlyon import AsyncClient, Client

BASE_URL = "https://api.anlyon.com"
STORES = f"{BASE_URL}/api/v2/secret-stores"
SECRETS = f"{BASE_URL}/api/v2/secrets"


def _ok(data: Any) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": data})


@respx.mock
def test_sync_store_lifecycle() -> None:
    created = respx.post(STORES).mock(return_value=_ok({"name": "prod-vault"}))
    listed = respx.get(STORES).mock(return_value=_ok([]))
    got = respx.get(f"{STORES}/prod-vault").mock(return_value=_ok({"name": "prod-vault"}))
    patched = respx.patch(f"{STORES}/prod-vault").mock(return_value=_ok({"name": "prod-vault"}))
    checked = respx.post(f"{STORES}/prod-vault/check").mock(return_value=_ok({"name": "prod-vault"}))
    deleted = respx.delete(f"{STORES}/prod-vault").mock(return_value=_ok({"deleted": True}))
    client = Client(api_key="test-key", base_url=BASE_URL)

    client.secret_stores.create(
        name="prod-vault",
        type="hashicorp_vault",
        config={"address": "https://vault.example.com", "auth": "token"},
        credential={"token": "<your-vault-token>"},
        cache_ttl_seconds=0,
    )
    client.secret_stores.list()
    client.secret_stores.get("prod-vault")
    client.secret_stores.update("prod-vault", allowed_paths=["payments"], confirm_protected=True)
    client.secret_stores.check("prod-vault")
    client.secret_stores.delete("prod-vault", confirm_protected=True)

    assert json.loads(created.calls[0].request.content) == {
        "name": "prod-vault",
        "type": "hashicorp_vault",
        "config": {"address": "https://vault.example.com", "auth": "token"},
        "credential": {"token": "<your-vault-token>"},
        "cacheTtlSeconds": 0,
    }
    assert listed.called and got.called and checked.called
    assert json.loads(patched.calls[0].request.content) == {"allowedPaths": ["payments"]}
    assert patched.calls[0].request.url.params["confirmProtected"] == "true"
    assert deleted.calls[0].request.url.params["confirmProtected"] == "true"


@respx.mock
def test_sync_external_secret() -> None:
    put = respx.put(f"{SECRETS}/STRIPE_KEY").mock(return_value=_ok({"name": "STRIPE_KEY", "kind": "external"}))
    check = respx.post(f"{SECRETS}/STRIPE_KEY/check").mock(return_value=_ok({"name": "STRIPE_KEY"}))
    client = Client(api_key="test-key", base_url=BASE_URL)

    client.secrets.put_external(
        "STRIPE_KEY", store="prod-vault", path="payments/stripe", key="apiKey", allowed_hosts=["api.stripe.com"]
    )
    client.secrets.check("STRIPE_KEY")

    assert json.loads(put.calls[0].request.content) == {
        "external": {"store": "prod-vault", "path": "payments/stripe", "key": "apiKey"},
        "allowedHosts": ["api.stripe.com"],
    }
    assert check.called


@pytest.mark.asyncio
@respx.mock
async def test_async_external_secret_and_store() -> None:
    put = respx.put(f"{SECRETS}/DB_PASSWORD").mock(return_value=_ok({"name": "DB_PASSWORD"}))
    created = respx.post(STORES).mock(return_value=_ok({"name": "aws"}))
    client = AsyncClient(api_key="test-key", base_url=BASE_URL)

    await client.secret_stores.create(
        name="aws",
        type="aws_secrets_manager",
        config={"region": "eu-west-1", "auth": "access_key"},
        credential={"accessKeyId": "<your-access-key-id>", "secretAccessKey": "<your-secret-access-key>"},
    )
    await client.secrets.put_external("DB_PASSWORD", store="aws", path="prod/db", version="AWSPREVIOUS")

    assert json.loads(created.calls[0].request.content)["type"] == "aws_secrets_manager"
    assert json.loads(put.calls[0].request.content) == {
        "external": {"store": "aws", "path": "prod/db", "version": "AWSPREVIOUS"}
    }
