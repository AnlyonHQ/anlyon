"""Webhook signature verification.

When a signing secret is configured, Anlyon signs webhook deliveries (queue
messages and event subscriptions alike) with a Stripe-style header::

    Anlyon-Signature: t=<unix-timestamp>,v1=<hex hmac-sha256>

The signature is an HMAC-SHA256 of ``f"{timestamp}.{raw_body}"`` keyed with
your signing secret (the workspace delivery secret, or the per-subscription
``whsec_`` secret for event subscriptions created with ``generate_secret``).
Receivers configured with ``expected_environment_id`` instead require an
``env`` attribution and a ``v2`` HMAC over
``f"anlyon-delivery-v2.{timestamp}.{environment_id}.{raw_body}"``.

    from anlyon import Receiver

    receiver = Receiver(signing_secret=os.environ["ANLYON_SIGNING_SECRET"])

    if receiver.verify(signature=request.headers["Anlyon-Signature"], body=raw_body):
        ...  # authentic

    receiver.verify_or_throw(signature=signature, body=raw_body)
"""

from __future__ import annotations

import hashlib
import hmac
import re
import time


class SignatureVerificationError(Exception):
    """Raised by :meth:`Receiver.verify_or_throw` when verification fails."""


_HEX_SIGNATURE = re.compile(r"[0-9a-f]{64}\Z")
_ENVIRONMENT_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")


def _parse_signature_header(
    header: str,
) -> tuple[int, list[str], list[str], list[str]] | None:
    timestamps: list[str] = []
    signatures: list[str] = []
    environment_ids: list[str] = []
    environment_signatures: list[str] = []

    for part in header.split(","):
        if part.count("=") != 1:
            return None
        key, _, value = part.partition("=")
        if not key:
            return None
        if key == "t":
            timestamps.append(value)
        elif key == "v1":
            signatures.append(value)
        elif key == "env":
            environment_ids.append(value)
        elif key == "v2":
            environment_signatures.append(value)

    if len(timestamps) != 1 or len(environment_ids) > 1:
        return None

    timestamp_value = timestamps[0]
    if not timestamp_value.isascii() or not timestamp_value.isdigit():
        return None
    try:
        timestamp = int(timestamp_value)
    except ValueError:
        return None
    if str(timestamp) != timestamp_value:
        return None

    if any(_HEX_SIGNATURE.fullmatch(signature) is None for signature in signatures):
        return None
    if any(_HEX_SIGNATURE.fullmatch(signature) is None for signature in environment_signatures):
        return None
    if any(_ENVIRONMENT_ID.fullmatch(environment_id) is None for environment_id in environment_ids):
        return None

    return timestamp, signatures, environment_ids, environment_signatures


def _compute_signature(body: str, timestamp: int, secret: str) -> str:
    signed_payload = f"{timestamp}.{body}"
    return hmac.new(secret.encode(), signed_payload.encode(), hashlib.sha256).hexdigest()


def _compute_environment_signature(
    body: str, timestamp: int, environment_id: str, secret: str
) -> str:
    signed_payload = f"anlyon-delivery-v2.{timestamp}.{environment_id}.{body}"
    return hmac.new(secret.encode(), signed_payload.encode(), hashlib.sha256).hexdigest()


class Receiver:
    """Verifies Anlyon webhook signatures.

    Args:
        signing_secret: The secret the delivery was signed with.
        clock_tolerance: Maximum allowed skew, in seconds, between the
            signature timestamp and now (replay protection). Defaults to 300.
        expected_environment_id: When set, require signed attribution for this
            environment. Leave unset while accepting legacy v1 signatures.
    """

    def __init__(
        self,
        signing_secret: str,
        *,
        clock_tolerance: int = 300,
        expected_environment_id: str | None = None,
    ) -> None:
        if not signing_secret:
            raise ValueError("signing_secret is required")
        if expected_environment_id == "":
            raise ValueError("expected_environment_id must not be empty")
        self._signing_secret = signing_secret
        self._clock_tolerance = clock_tolerance
        self._expected_environment_id = expected_environment_id

    def verify(self, *, signature: str | None, body: str) -> bool:
        """Return True when ``signature`` is valid for ``body``."""
        try:
            self.verify_or_throw(signature=signature, body=body)
        except SignatureVerificationError:
            return False
        return True

    def verify_or_throw(self, *, signature: str | None, body: str) -> None:
        """Raise :class:`SignatureVerificationError` unless the signature is valid."""
        if not isinstance(signature, str) or not signature:
            raise SignatureVerificationError("Missing signature header")
        if not isinstance(body, str):
            raise SignatureVerificationError("Missing request body")

        parsed = _parse_signature_header(signature)
        if parsed is None:
            raise SignatureVerificationError("Invalid signature header format")
        timestamp, signatures, environment_ids, environment_signatures = parsed

        difference = abs(int(time.time()) - timestamp)
        if difference > self._clock_tolerance:
            raise SignatureVerificationError(
                f"Timestamp outside tolerance window ({difference}s > {self._clock_tolerance}s)"
            )

        if self._expected_environment_id is not None:
            if not environment_ids or not environment_signatures:
                raise SignatureVerificationError("Missing signed environment attribution")
            if environment_ids[0] != self._expected_environment_id:
                raise SignatureVerificationError("Delivery environment mismatch")

            expected = _compute_environment_signature(
                body,
                timestamp,
                self._expected_environment_id,
                self._signing_secret,
            )
            for candidate in environment_signatures:
                if hmac.compare_digest(candidate, expected):
                    return
            raise SignatureVerificationError("Environment signature mismatch")

        if not signatures:
            raise SignatureVerificationError("Missing v1 signature")

        expected = _compute_signature(body, timestamp, self._signing_secret)
        for candidate in signatures:
            if hmac.compare_digest(candidate, expected):
                return

        raise SignatureVerificationError("Signature mismatch")
