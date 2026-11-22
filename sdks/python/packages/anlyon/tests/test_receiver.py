"""Receiver webhook-signature verification tests."""

import hashlib
import hmac
import time

import pytest

from anlyon import Receiver, SignatureVerificationError

SECRET = "whsec_test_secret"
BODY = '{"id":"evt_123","topic":"orders","type":"order.created","data":{}}'
ENVIRONMENT_ID = "env_production"


def sign(body: str, secret: str = SECRET, timestamp: int | None = None) -> str:
    ts = timestamp if timestamp is not None else int(time.time())
    digest = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    return f"t={ts},v1={digest}"


def sign_for_environment(
    body: str,
    environment_id: str = ENVIRONMENT_ID,
    secret: str = SECRET,
    timestamp: int | None = None,
) -> str:
    ts = timestamp if timestamp is not None else int(time.time())
    v1 = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    v2_payload = f"anlyon-delivery-v2.{ts}.{environment_id}.{body}"
    v2 = hmac.new(secret.encode(), v2_payload.encode(), hashlib.sha256).hexdigest()
    return f"t={ts},v1={v1},env={environment_id},v2={v2}"


def test_valid_signature_verifies() -> None:
    receiver = Receiver(signing_secret=SECRET)
    assert receiver.verify(signature=sign(BODY), body=BODY) is True


def test_valid_v1_signature_verifies_empty_raw_body() -> None:
    receiver = Receiver(signing_secret=SECRET)
    assert receiver.verify(signature=sign(""), body="") is True


def test_valid_v2_signature_verifies_empty_raw_body() -> None:
    receiver = Receiver(signing_secret=SECRET, expected_environment_id=ENVIRONMENT_ID)
    assert receiver.verify(signature=sign_for_environment(""), body="") is True


def test_verify_or_throw_passes_on_valid() -> None:
    receiver = Receiver(signing_secret=SECRET)
    receiver.verify_or_throw(signature=sign(BODY), body=BODY)


def test_wrong_secret_fails() -> None:
    receiver = Receiver(signing_secret="whsec_other")
    assert receiver.verify(signature=sign(BODY), body=BODY) is False


def test_tampered_body_fails() -> None:
    receiver = Receiver(signing_secret=SECRET)
    assert receiver.verify(signature=sign(BODY), body=BODY + "x") is False


def test_missing_signature_fails() -> None:
    receiver = Receiver(signing_secret=SECRET)
    assert receiver.verify(signature=None, body=BODY) is False
    with pytest.raises(SignatureVerificationError, match="Missing signature"):
        receiver.verify_or_throw(signature=None, body=BODY)


def test_missing_signature_fails_for_empty_raw_body() -> None:
    receiver = Receiver(signing_secret=SECRET)
    assert receiver.verify(signature=None, body="") is False


def test_non_string_runtime_inputs_fail_with_verification_error() -> None:
    receiver = Receiver(signing_secret=SECRET)
    with pytest.raises(SignatureVerificationError, match="Missing signature"):
        receiver.verify_or_throw(signature=123, body=BODY)  # type: ignore[arg-type]
    with pytest.raises(SignatureVerificationError, match="Missing request body"):
        receiver.verify_or_throw(signature=sign(BODY), body=None)  # type: ignore[arg-type]


def test_malformed_header_fails() -> None:
    receiver = Receiver(signing_secret=SECRET)
    assert receiver.verify(signature="not-a-signature", body=BODY) is False
    assert receiver.verify(signature="t=abc,v1=def", body=BODY) is False


def test_stale_timestamp_fails() -> None:
    receiver = Receiver(signing_secret=SECRET)
    stale = sign(BODY, timestamp=int(time.time()) - 3600)
    assert receiver.verify(signature=stale, body=BODY) is False
    with pytest.raises(SignatureVerificationError, match="tolerance"):
        receiver.verify_or_throw(signature=stale, body=BODY)


def test_clock_tolerance_override() -> None:
    receiver = Receiver(signing_secret=SECRET, clock_tolerance=7200)
    old = sign(BODY, timestamp=int(time.time()) - 3600)
    assert receiver.verify(signature=old, body=BODY) is True


def test_multiple_v1_signatures_any_match() -> None:
    receiver = Receiver(signing_secret=SECRET)
    ts = int(time.time())
    good = sign(BODY, timestamp=ts).split("v1=")[1]
    header = f"t={ts},v1={'0' * 64},v1={good}"
    assert receiver.verify(signature=header, body=BODY) is True


def test_environment_bound_signature_verifies() -> None:
    receiver = Receiver(signing_secret=SECRET, expected_environment_id=ENVIRONMENT_ID)
    assert receiver.verify(signature=sign_for_environment(BODY), body=BODY) is True


def test_environment_bound_signature_does_not_require_legacy_v1() -> None:
    receiver = Receiver(signing_secret=SECRET, expected_environment_id=ENVIRONMENT_ID)
    header = sign_for_environment(BODY)
    v2_only = ",".join(part for part in header.split(",") if not part.startswith("v1="))
    assert receiver.verify(signature=v2_only, body=BODY) is True


def test_environment_bound_receiver_rejects_cross_environment_delivery() -> None:
    receiver = Receiver(signing_secret=SECRET, expected_environment_id=ENVIRONMENT_ID)
    header = sign_for_environment(BODY, environment_id="env_staging")
    assert receiver.verify(signature=header, body=BODY) is False


@pytest.mark.parametrize(
    "header",
    [
        sign(BODY),
        f"{sign(BODY)},env={ENVIRONMENT_ID}",
        f"{sign(BODY)},v2={'0' * 64}",
    ],
)
def test_environment_bound_receiver_rejects_missing_attribution(header: str) -> None:
    receiver = Receiver(signing_secret=SECRET, expected_environment_id=ENVIRONMENT_ID)
    assert receiver.verify(signature=header, body=BODY) is False


def test_environment_bound_receiver_rejects_tampered_environment() -> None:
    receiver = Receiver(
        signing_secret=SECRET,
        expected_environment_id="env_tampered",
    )
    header = sign_for_environment(BODY).replace(f"env={ENVIRONMENT_ID}", "env=env_tampered")
    assert receiver.verify(signature=header, body=BODY) is False


def test_multiple_v2_signatures_support_secret_rotation() -> None:
    receiver = Receiver(signing_secret=SECRET, expected_environment_id=ENVIRONMENT_ID)
    header = f"{sign_for_environment(BODY)},v2={'0' * 64}"
    assert receiver.verify(signature=header, body=BODY) is True


def test_legacy_receiver_accepts_environment_bound_header_via_v1() -> None:
    receiver = Receiver(signing_secret=SECRET)
    assert receiver.verify(signature=sign_for_environment(BODY), body=BODY) is True


def test_v1_signing_oracle_cannot_forge_v2_signature() -> None:
    receiver = Receiver(signing_secret=SECRET, expected_environment_id=ENVIRONMENT_ID)
    timestamp = int(time.time())
    oracle_body = f"{ENVIRONMENT_ID}.{BODY}"
    oracle_signature = sign(oracle_body, timestamp=timestamp).split("v1=")[1]
    forged = f"t={timestamp},v1={oracle_signature},env={ENVIRONMENT_ID},v2={oracle_signature}"
    assert receiver.verify(signature=forged, body=BODY) is False


def test_environment_signature_uses_raw_utf8_body() -> None:
    body = '{"message":"café ☕","emoji":"🚀"}'
    receiver = Receiver(signing_secret=SECRET, expected_environment_id=ENVIRONMENT_ID)
    assert receiver.verify(signature=sign_for_environment(body), body=body) is True
    assert receiver.verify(signature=sign_for_environment(body), body=body + " ") is False


@pytest.mark.parametrize("timestamp", ["01", "+1", "-0", "1.0", " 1"])
def test_noncanonical_timestamp_rejected(timestamp: str) -> None:
    receiver = Receiver(signing_secret=SECRET, clock_tolerance=10**10)
    assert receiver.verify(signature=f"t={timestamp},v1={'0' * 64}", body=BODY) is False


def test_duplicate_timestamp_rejected() -> None:
    receiver = Receiver(signing_secret=SECRET)
    header = f"{sign(BODY)},t={int(time.time())}"
    assert receiver.verify(signature=header, body=BODY) is False


def test_duplicate_environment_rejected() -> None:
    receiver = Receiver(signing_secret=SECRET, expected_environment_id=ENVIRONMENT_ID)
    header = f"{sign_for_environment(BODY)},env={ENVIRONMENT_ID}"
    assert receiver.verify(signature=header, body=BODY) is False


@pytest.mark.parametrize(
    "environment_id",
    ["env.production", "env production", "env=production", "a" * 129],
)
def test_noncanonical_environment_rejected(environment_id: str) -> None:
    receiver = Receiver(signing_secret=SECRET, expected_environment_id=environment_id)
    header = sign_for_environment(BODY, environment_id=environment_id)
    assert receiver.verify(signature=header, body=BODY) is False


def test_empty_environment_attribution_rejected() -> None:
    receiver = Receiver(signing_secret=SECRET, expected_environment_id=ENVIRONMENT_ID)
    header = sign_for_environment(BODY).replace(f"env={ENVIRONMENT_ID}", "env=")
    assert receiver.verify(signature=header, body=BODY) is False


def test_maximum_length_environment_verifies() -> None:
    environment_id = "a" * 128
    receiver = Receiver(signing_secret=SECRET, expected_environment_id=environment_id)
    assert (
        receiver.verify(
            signature=sign_for_environment(BODY, environment_id=environment_id),
            body=BODY,
        )
        is True
    )


@pytest.mark.parametrize(
    "header",
    [
        f"t={int(time.time())},v1=not-hex",
        f"t={int(time.time())},v1={'0' * 63}",
        f"{sign(BODY)},v2=not-hex",
        f"{sign(BODY)},v2={'0' * 65}",
    ],
)
def test_malformed_signature_hex_rejected(header: str) -> None:
    receiver = Receiver(signing_secret=SECRET)
    assert receiver.verify(signature=header, body=BODY) is False


def test_empty_secret_rejected() -> None:
    with pytest.raises(ValueError, match="signing_secret is required"):
        Receiver(signing_secret="")


def test_empty_expected_environment_rejected() -> None:
    with pytest.raises(ValueError, match="expected_environment_id must not be empty"):
        Receiver(
            signing_secret=SECRET,
            expected_environment_id="",
        )
