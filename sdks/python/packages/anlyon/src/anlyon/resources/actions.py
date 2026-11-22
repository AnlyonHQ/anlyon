"""
Actions resource  hosted tools an agent invokes by name.

You define the HTTP call once (URL/headers may reference vaulted secrets); the
agent just sends `input`. Anlyon validates the input, fills in the credentials,
and makes the call. Actions marked `requires_approval` park behind a human
decision instead of firing.

An action may also carry declarations. ``impact`` says how much one invocation
changes. ``verify`` is a read-back that confirms the write. Either one makes the
action governed, and every effect then returns a receipt ``grade``.
"""

from __future__ import annotations

import builtins
from typing import TYPE_CHECKING, Any, Literal, TypedDict

from .base import AsyncBaseResource, BaseResource, always_idempotency_headers

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_BASE = "/api/v2/actions"


InvocationOutcome = Literal["succeeded", "failed"]
InvocationStatus = Literal["pending_approval", "running", "succeeded", "failed", "unknown", "denied", "expired"]
EffectOutcome = Literal["not_dispatched", "pending", "succeeded", "failed", "unknown"]
EffectStage = Literal["awaiting_approval", "ready", "dispatching", "reconciling", "settled", "rejected"]
PartialEffect = Literal["none", "possible", "confirmed"]
EffectGrade = Literal["confirmed", "acknowledged", "unknown", "failed", "refused", "denied", "pending"]
ActingFor = Literal["workspace", "end_users"]
"""The receipt grade of an effect. The API derives it and returns it on every effect.

- ``confirmed``: the outcome is ``succeeded`` and a read-back matched, or an adapter read the
  provider's own record.
- ``acknowledged``: the provider answered 2xx and no read-back has matched. An operator's manual
  ``succeeded`` grades here too.
- ``unknown``: no usable response. Reconcile before you retry.
- ``failed``: the provider rejected the request, or the request provably never left Anlyon.
- ``refused``: Anlyon refused at dispatch, for example on an exhausted or unbounded limit.
- ``denied``: the approval was denied.
- ``pending``: no receipt yet.
"""
EFFECT_GRADES: tuple[EffectGrade, ...] = (
    "confirmed",
    "acknowledged",
    "unknown",
    "failed",
    "refused",
    "denied",
    "pending",
)

ImpactDimension = Literal["money", "resource_mutations"] | str
"""``money``, ``resource_mutations``, or a workspace-declared unit such as ``emails``.
A declared unit matches ``^[a-z][a-z0-9_]{0,31}$``."""
ImpactBound = Literal["exact", "upper_bound"]


class _ActionImpactRequired(TypedDict):
    dimension: ImpactDimension
    amount: str
    bound: ImpactBound


class ActionImpactDeclaration(_ActionImpactRequired, total=False):
    """How much one invocation changes. Declaring it makes the action governed.

    ``amount`` is an expression over the input, evaluated before dispatch: an integer,
    ``input.<path>`` or ``count(input.<path>)``, with one optional ``* <integer>``. An amount that
    reads an input the caller left out gives no quantity, and an applicable limit then refuses the
    effect. ``unit`` is the currency for ``money``, for example ``usd``, and is required there. For
    every other dimension it is the dimension name and may be left out.
    """

    unit: str


class _ActionVerifyMatchRequired(TypedDict):
    path: str
    equals: str | int | float | bool | None


class ActionVerifyMatch(_ActionVerifyMatchRequired, total=False):
    """One JSON path equality check on the read-back body.

    ``path`` is a dotted path such as ``data.status``; a ``*`` segment stands for any item of a list
    (``labels.*.name``). ``equals`` is a literal, or exactly one ``{{input.field}}`` or
    ``{{response.field}}``. ``absent=True`` holds only when no value at the path equals it, which is
    how a removal is read back.
    """

    absent: bool


class _ActionVerifyRequired(TypedDict):
    url: str
    status: int


class ActionVerifyDeclaration(_ActionVerifyRequired, total=False):
    """A read-back that confirms a write: a ``GET`` on the action's own host and what it must answer.

    A match grades the effect ``confirmed``. Without one a 2xx grades ``acknowledged``. ``url`` may
    reference ``{{input.field}}``, ``{{response.field}}`` and ``{{secret:NAME}}``. ``match`` holds
    at most 10 checks and may be left out.
    """

    match: builtins.list[ActionVerifyMatch]


_UNSET: Any = object()


def _drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}


def _build_action_body(
    name: str | None,
    description: str | None,
    method: str | None,
    url_template: str | None,
    headers: dict[str, str] | None,
    body_template: dict[str, Any] | None,
    input_schema: dict[str, Any] | None,
    requires_approval: bool | None,
    enabled: bool | None,
    adapter: dict[str, Any] | None = None,
    impact: ActionImpactDeclaration | None = _UNSET,
    verify: ActionVerifyDeclaration | None = _UNSET,
    governed: bool | None = None,
) -> dict[str, Any]:
    body = _drop_none(
        {
            "name": name,
            "description": description,
            "method": method,
            "urlTemplate": url_template,
            "headers": headers,
            "bodyTemplate": body_template,
            "inputSchema": input_schema,
            "requiresApproval": requires_approval,
            "enabled": enabled,
            "adapter": adapter,
        }
    )
    body.update(_build_declarations_body(impact, verify, governed))
    return body


def _build_declarations_body(
    impact: ActionImpactDeclaration | None,
    verify: ActionVerifyDeclaration | None,
    governed: bool | None,
) -> dict[str, Any]:
    """``None`` is sent as null, which removes a declaration. A field left out is not sent."""
    body: dict[str, Any] = {}
    if impact is not _UNSET:
        body["impact"] = impact
    if verify is not _UNSET:
        body["verify"] = verify
    if governed is not None:
        body["governed"] = governed
    return body


def _build_invoke_body(
    input: dict[str, Any] | None,
    run_id: str | None,
    parent_span_id: str | None,
    retry_of: str | None,
    operation_key: str | None,
    preview_id: str | None,
    depends_on: list[dict[str, str]] | None,
    compensates: str | None,
) -> dict[str, Any]:
    return _drop_none(
        {
            "input": input or {},
            "runId": run_id,
            "parentSpanId": parent_span_id,
            "retryOf": retry_of,
            "operationKey": operation_key,
            "previewId": preview_id,
            "dependsOn": depends_on,
            "compensates": compensates,
        }
    )


def _build_effects_params(
    action: str | None,
    outcome: str | None,
    stage: str | None,
    unresolved: bool | None,
    limit: int | None,
    offset: int | None,
    grade: str | None = None,
    end_user_id: str | None = None,
    acting_for: str | None = None,
) -> dict[str, Any]:
    return _drop_none(
        {
            "action": action,
            "outcome": outcome,
            "stage": stage,
            "grade": grade,
            "unresolved": None if unresolved is None else ("true" if unresolved else "false"),
            "endUserId": end_user_id,
            "actingFor": acting_for,
            "limit": limit,
            "offset": offset,
        }
    )


def _build_resolve_effect_body(
    outcome: InvocationOutcome,
    reason: str,
    partial_effect: str | None,
    actual_impact: list[dict[str, Any]] | None,
    external_reference: str | None,
) -> dict[str, Any]:
    return _drop_none(
        {
            "outcome": outcome,
            "reason": reason,
            "partialEffect": partial_effect,
            "actualImpact": actual_impact,
            "externalReference": external_reference,
        }
    )


def _require_request_shape(url_template: str | None, adapter: dict[str, Any] | None) -> None:
    if url_template is None and adapter is None:
        raise ValueError("An action needs either url_template (a template action) or adapter (a governed effect).")


def _build_invocations_params(
    action: str | None,
    limit: int | None,
    offset: int | None,
    status: str | None = None,
    end_user_id: str | None = None,
    acting_for: str | None = None,
) -> dict[str, Any]:
    return _drop_none(
        {
            "action": action,
            "status": status,
            "endUserId": end_user_id,
            "actingFor": acting_for,
            "limit": limit,
            "offset": offset,
        }
    )


def _build_resolve_body(
    outcome: InvocationOutcome, evidence: str, external_reference: str | None
) -> dict[str, Any]:
    return _drop_none({"outcome": outcome, "evidence": evidence, "externalReference": external_reference})


def _build_import_body(
    spec: dict[str, Any],
    base_url: str | None,
    auth: dict[str, str] | None,
    requires_approval: bool | None,
    dry_run: bool | None,
    only: list[str] | None,
    governed: bool | None = None,
    operations: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return _drop_none(
        {
            "spec": spec,
            "baseUrl": base_url,
            "auth": auth,
            "requiresApproval": requires_approval,
            "dryRun": dry_run,
            "only": only,
            "governed": governed,
            "operations": operations,
        }
    )


class ActionsResource(BaseResource):
    """Hosted actions (sync)."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _BASE)

    def create(
        self,
        *,
        name: str,
        url_template: str | None = None,
        adapter: dict[str, Any] | None = None,
        description: str | None = None,
        method: str | None = None,
        headers: dict[str, str] | None = None,
        body_template: dict[str, Any] | None = None,
        input_schema: dict[str, Any] | None = None,
        requires_approval: bool | None = None,
        enabled: bool | None = None,
        impact: ActionImpactDeclaration | None = None,
        verify: ActionVerifyDeclaration | None = None,
        governed: bool | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Define a hosted tool.

        A template action takes ``url_template``/``headers`` with {{input.x}} and {{secret:NAME}}.
        An adapter action takes ``adapter`` instead, e.g.
        ``{"type": "stripe.refund", "config": {"account": "acct_1", "mode": "test", "currency": "usd"},
        "credentialSecret": "STRIPE_TEST_KEY"}``: every invocation then becomes a governed effect.

        A template action becomes governed when it declares ``impact``, ``verify`` or
        ``governed=True``. It must then call an https URL with a fixed host. An adapter action
        accepts none of the three.
        """
        _require_request_shape(url_template, adapter)
        body = _build_action_body(
            name,
            description,
            method,
            url_template,
            headers,
            body_template,
            input_schema,
            requires_approval,
            enabled,
            adapter,
            _UNSET if impact is None else impact,
            _UNSET if verify is None else verify,
            governed,
        )
        return self._post("", body=body, headers=always_idempotency_headers(idempotency_key))

    def import_openapi(
        self,
        spec: dict[str, Any],
        *,
        base_url: str | None = None,
        auth: dict[str, str] | None = None,
        requires_approval: bool | None = None,
        dry_run: bool | None = None,
        only: builtins.list[str] | None = None,
        governed: bool | None = None,
        operations: dict[str, dict[str, Any]] | None = None,
    ) -> Any:
        """
        Import a whole API at once from its OpenAPI 3.x spec.

        Operations Anlyon cannot express faithfully are **skipped with a reason**
        rather than turned into an action that looks right and isn't  always
        read `["skipped"]`. Constraints that only document a value (`format`,
        `minimum`, …) are dropped and listed in each action's `warnings`.

        Every operation that is not a ``GET`` is imported **governed**: it declares
        one resource mutation, so its invocations are previewed, counted against
        impact limits and given a receipt. Money is declared only when you choose
        it in ``operations``. Where the spec has a ``GET`` that reads a write back,
        the action's ``proposedVerify`` holds a rule you can add after checking it;
        nothing applies it for you.
        ``governed=False`` imports plain template actions.

        Every operation also carries a ``suggestion``: a risk class, whether to
        require approval, and an impact, read from the spec. None is applied
        unless you name the operation in ``operations``, keyed by operationId or
        ``"METHOD /path"``: ``{"requiresApproval": ..., "impact": ...}``, where
        ``"impact": None`` imports that operation ungoverned.

        `auth` is `{"headerName": ..., "secretName": ..., "valueTemplate": ...}`,
        where `valueTemplate` may contain `{{secret}}` (e.g. `"Bearer {{secret}}"`).

        (`import` is a Python keyword, hence the name.)
        """
        body = _build_import_body(
            spec, base_url, auth, requires_approval, dry_run, only, governed, operations
        )
        return self._post("/import", body=body, headers=always_idempotency_headers())

    def list(self) -> Any:
        return self._get("")

    def get(self, ref: str) -> Any:
        """By name or act_ id."""
        return self._get(f"/{ref}")

    def versions(self, ref: str) -> Any:
        """One action's immutable versions, oldest first.

        Editing an action appends a version; nothing updates one. An agent
        version pins a version id in its ``config.actions``, which is what makes
        rolling an agent back restore the tool definitions it was published with
        rather than whatever those tools have since been edited to.
        """
        return self._get(f"/{ref}/versions")

    def update(
        self,
        ref: str,
        *,
        name: str | None = None,
        url_template: str | None = None,
        description: str | None = None,
        method: str | None = None,
        headers: dict[str, str] | None = None,
        body_template: dict[str, Any] | None = None,
        input_schema: dict[str, Any] | None = None,
        requires_approval: bool | None = None,
        enabled: bool | None = None,
        adapter: dict[str, Any] | None = None,
        impact: ActionImpactDeclaration | None = _UNSET,
        verify: ActionVerifyDeclaration | None = _UNSET,
        governed: bool | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Edit an action. A field you leave out is unchanged.

        For ``impact`` and ``verify``, ``None`` removes the declaration. ``governed=False``
        removes every declaration.
        """
        body = _build_action_body(
            name,
            description,
            method,
            url_template,
            headers,
            body_template,
            input_schema,
            requires_approval,
            enabled,
            adapter,
            impact,
            verify,
            governed,
        )
        return self._patch(f"/{ref}", body=body, headers=always_idempotency_headers(idempotency_key))

    def declare(
        self,
        ref: str,
        *,
        impact: ActionImpactDeclaration | None = _UNSET,
        verify: ActionVerifyDeclaration | None = _UNSET,
        governed: bool | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Set or remove what an action declares. This PATCHes the action with these fields alone.

        ``impact`` is how much one invocation changes. ``verify`` is a read-back that confirms the
        write. Either one makes the action governed. ``None`` removes a declaration. A field you
        leave out keeps what is there. ``governed=False`` removes every declaration. Changing what
        a governed action already declares needs ``actions:govern``.

            client.actions.declare(
                "send-email",
                impact={"dimension": "emails", "amount": "count(input.to)", "bound": "exact"},
                verify={"url": "https://api.example.com/v1/messages/{{response.id}}", "status": 200},
            )
            client.actions.declare("send-email", verify=None)  # remove the read-back
        """
        return self._patch(
            f"/{ref}",
            body=_build_declarations_body(impact, verify, governed),
            headers=always_idempotency_headers(idempotency_key),
        )

    def delete(self, ref: str, *, idempotency_key: str | None = None) -> Any:
        return self._delete(
            f"/{ref}",
            headers=always_idempotency_headers(idempotency_key),
        )

    def invoke(
        self,
        ref: str,
        input: dict[str, Any] | None = None,
        *,
        run_id: str | None = None,
        parent_span_id: str | None = None,
        idempotency_key: str | None = None,
        retry_of: str | None = None,
        operation_key: str | None = None,
        preview_id: str | None = None,
        depends_on: builtins.list[dict[str, str]] | None = None,
        compensates: str | None = None,
    ) -> Any:
        """Call the tool. Gated actions come back with pendingApproval=True.

        Every invoke carries an ``Idempotency-Key``. Pass ``idempotency_key`` to choose it. Without
        one the SDK generates a key once per call and sends the same key on each transport retry of
        that call, so a resend is answered from the recorded invocation and is not executed again.
        Two calls to ``invoke`` without a key are two invocations.

        A governed action answers with a receipt ``grade`` (see ``EffectGrade``). A template
        action with no declaration creates no effect and has no grade.

        For adapter actions: ``operation_key`` is the stable operation identity (same key and
        request return the existing effect; a different request is refused), ``preview_id`` binds
        the call to a reviewed preview, ``depends_on`` names effects that must already hold an
        outcome (pending and unknown never satisfy one), and ``compensates`` marks a compensation.
        """
        return self._post(
            f"/{ref}/invoke",
            body=_build_invoke_body(
                input, run_id, parent_span_id, retry_of, operation_key, preview_id, depends_on, compensates
            ),
            headers=always_idempotency_headers(idempotency_key),
        )

    def invocations(
        self,
        *,
        action: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
        status: InvocationStatus | None = None,
        end_user_id: str | None = None,
        acting_for: ActingFor | None = None,
    ) -> Any:
        """The invocation log. ``status="unknown"`` lists calls waiting for an operator to confirm.

        ``end_user_id`` lists the calls made for one end user. ``acting_for="workspace"`` lists only
        calls made with the workspace's own accounts, ``"end_users"`` only calls made for an end user.
        """
        return self._get(
            "/invocations",
            params=_build_invocations_params(action, limit, offset, status, end_user_id, acting_for),
        )

    def invocation(self, invocation_id: str) -> Any:
        """One invocation. It carries ``grade`` when the invocation created a governed effect."""
        return self._get(f"/invocations/{invocation_id}")

    def resolve_invocation(
        self,
        invocation_id: str,
        *,
        outcome: InvocationOutcome,
        evidence: str,
        external_reference: str | None = None,
    ) -> Any:
        """Record what the destination confirms happened to an ``unknown`` invocation.

        Sends nothing to the destination. ``failed`` releases the reserved usage and refunds the
        budget; ``succeeded`` is billed. Needs ``actions:resolve``; the key that made the call can
        never resolve it. To run the action again, invoke with a new idempotency key and
        ``retry_of``.
        """
        return self._post(
            f"/invocations/{invocation_id}/resolve",
            body=_build_resolve_body(outcome, evidence, external_reference),
            headers=always_idempotency_headers(),
        )

    def invocations_for(
        self,
        ref: str,
        *,
        limit: int | None = None,
        offset: int | None = None,
        status: InvocationStatus | None = None,
        end_user_id: str | None = None,
        acting_for: ActingFor | None = None,
    ) -> Any:
        """One action's invocation log, with the same filters as ``invocations``."""
        return self._get(
            f"/{ref}/invocations",
            params=_build_invocations_params(None, limit, offset, status, end_user_id, acting_for),
        )


    def preview(
        self,
        ref: str,
        input: dict[str, Any] | None = None,
        *,
        ttl_seconds: int | None = None,
        run_id: str | None = None,
    ) -> Any:
        """Prepare an execution-bound preview: exact change, impact against limits, preconditions,
        expiry and guarantees. Reads the provider; writes nothing. Invoke with ``preview_id``."""
        return self._post(
            f"/{ref}/previews",
            body=_drop_none({"input": input or {}, "ttlSeconds": ttl_seconds, "runId": run_id}),
            headers=always_idempotency_headers(),
        )

    def get_preview(self, preview_id: str) -> Any:
        return self._get(f"/previews/{preview_id}")

    def refresh_preview(self, preview_id: str, *, ttl_seconds: int | None = None) -> Any:
        """Re-read the provider into a NEW preview; an approval of the old one never carries over."""
        return self._post(
            f"/previews/{preview_id}/refresh",
            body=_drop_none({"ttlSeconds": ttl_seconds}),
            headers=always_idempotency_headers(),
        )

    def effects(
        self,
        *,
        action: str | None = None,
        outcome: EffectOutcome | None = None,
        stage: EffectStage | None = None,
        unresolved: bool | None = None,
        limit: int | None = None,
        offset: int | None = None,
        grade: EffectGrade | None = None,
        end_user_id: str | None = None,
        acting_for: ActingFor | None = None,
    ) -> Any:
        """Effects, filterable by action, outcome, stage, grade and unresolved exposure.

        Every effect carries ``grade``, including one that has not run. ``end_user_id`` lists one
        end user's effects; ``acting_for`` is ``"workspace"`` or ``"end_users"``.
        """
        return self._get("/effects", params=_build_effects_params(action, outcome, stage, unresolved, limit, offset, grade, end_user_id, acting_for))

    def effect(self, effect_id: str) -> Any:
        """One effect with its grade, attempts, append-only evidence, reservations and bound preview."""
        return self._get(f"/effects/{effect_id}")

    def reconcile_effect(self, effect_id: str) -> Any:
        """Ask the provider, read-only, what happened to a pending or unknown effect."""
        return self._post(f"/effects/{effect_id}/reconcile", headers=always_idempotency_headers())

    def add_effect_note(self, effect_id: str, note: str) -> Any:
        """Append an investigation note to the evidence. Needs ``actions:resolve``."""
        return self._post(
            f"/effects/{effect_id}/notes", body={"note": note}, headers=always_idempotency_headers()
        )

    def resolve_effect(
        self,
        effect_id: str,
        *,
        outcome: InvocationOutcome,
        reason: str,
        partial_effect: PartialEffect | None = None,
        actual_impact: builtins.list[dict[str, Any]] | None = None,
        external_reference: str | None = None,
    ) -> Any:
        """Record a reasoned manual resolution, labelled ``manual`` (never provider verification)."""
        return self._post(
            f"/effects/{effect_id}/resolve",
            body=_build_resolve_effect_body(outcome, reason, partial_effect, actual_impact, external_reference),
            headers=always_idempotency_headers(),
        )

    def replay_effect(self, effect_id: str) -> Any:
        """Repeat a lost write under the same provider identity: a governed write, never a new effect."""
        return self._post(f"/effects/{effect_id}/replay", headers=always_idempotency_headers())


class AsyncActionsResource(AsyncBaseResource):
    """Hosted actions (async)."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _BASE)

    async def create(
        self,
        *,
        name: str,
        url_template: str | None = None,
        adapter: dict[str, Any] | None = None,
        description: str | None = None,
        method: str | None = None,
        headers: dict[str, str] | None = None,
        body_template: dict[str, Any] | None = None,
        input_schema: dict[str, Any] | None = None,
        requires_approval: bool | None = None,
        enabled: bool | None = None,
        impact: ActionImpactDeclaration | None = None,
        verify: ActionVerifyDeclaration | None = None,
        governed: bool | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Define a hosted tool.

        A template action takes ``url_template``/``headers`` with {{input.x}} and {{secret:NAME}}.
        An adapter action takes ``adapter`` instead, e.g.
        ``{"type": "stripe.refund", "config": {"account": "acct_1", "mode": "test", "currency": "usd"},
        "credentialSecret": "STRIPE_TEST_KEY"}``: every invocation then becomes a governed effect.

        A template action becomes governed when it declares ``impact``, ``verify`` or
        ``governed=True``. It must then call an https URL with a fixed host. An adapter action
        accepts none of the three.
        """
        _require_request_shape(url_template, adapter)
        body = _build_action_body(
            name,
            description,
            method,
            url_template,
            headers,
            body_template,
            input_schema,
            requires_approval,
            enabled,
            adapter,
            _UNSET if impact is None else impact,
            _UNSET if verify is None else verify,
            governed,
        )
        return await self._post("", body=body, headers=always_idempotency_headers(idempotency_key))

    async def import_openapi(
        self,
        spec: dict[str, Any],
        *,
        base_url: str | None = None,
        auth: dict[str, str] | None = None,
        requires_approval: bool | None = None,
        dry_run: bool | None = None,
        only: builtins.list[str] | None = None,
        governed: bool | None = None,
        operations: dict[str, dict[str, Any]] | None = None,
    ) -> Any:
        """Import an OpenAPI 3.x spec as actions (see the sync twin)."""
        body = _build_import_body(
            spec, base_url, auth, requires_approval, dry_run, only, governed, operations
        )
        return await self._post("/import", body=body, headers=always_idempotency_headers())

    async def list(self) -> Any:
        return await self._get("")

    async def get(self, ref: str) -> Any:
        """By name or act_ id."""
        return await self._get(f"/{ref}")

    async def versions(self, ref: str) -> Any:
        """One action's immutable versions, oldest first.

        Editing an action appends a version; nothing updates one. An agent
        version pins a version id in its ``config.actions``, which is what makes
        rolling an agent back restore the tool definitions it was published with
        rather than whatever those tools have since been edited to.
        """
        return await self._get(f"/{ref}/versions")

    async def update(
        self,
        ref: str,
        *,
        name: str | None = None,
        url_template: str | None = None,
        description: str | None = None,
        method: str | None = None,
        headers: dict[str, str] | None = None,
        body_template: dict[str, Any] | None = None,
        input_schema: dict[str, Any] | None = None,
        requires_approval: bool | None = None,
        enabled: bool | None = None,
        adapter: dict[str, Any] | None = None,
        impact: ActionImpactDeclaration | None = _UNSET,
        verify: ActionVerifyDeclaration | None = _UNSET,
        governed: bool | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Edit an action. A field you leave out is unchanged.

        For ``impact`` and ``verify``, ``None`` removes the declaration. ``governed=False``
        removes every declaration.
        """
        body = _build_action_body(
            name,
            description,
            method,
            url_template,
            headers,
            body_template,
            input_schema,
            requires_approval,
            enabled,
            adapter,
            impact,
            verify,
            governed,
        )
        return await self._patch(f"/{ref}", body=body, headers=always_idempotency_headers(idempotency_key))

    async def declare(
        self,
        ref: str,
        *,
        impact: ActionImpactDeclaration | None = _UNSET,
        verify: ActionVerifyDeclaration | None = _UNSET,
        governed: bool | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Set or remove what an action declares. This PATCHes the action with these fields alone.

        ``impact`` is how much one invocation changes. ``verify`` is a read-back that confirms the
        write. Either one makes the action governed. ``None`` removes a declaration. A field you
        leave out keeps what is there. ``governed=False`` removes every declaration. Changing what
        a governed action already declares needs ``actions:govern``.

            client.actions.declare(
                "send-email",
                impact={"dimension": "emails", "amount": "count(input.to)", "bound": "exact"},
                verify={"url": "https://api.example.com/v1/messages/{{response.id}}", "status": 200},
            )
            client.actions.declare("send-email", verify=None)  # remove the read-back
        """
        return await self._patch(
            f"/{ref}",
            body=_build_declarations_body(impact, verify, governed),
            headers=always_idempotency_headers(idempotency_key),
        )

    async def delete(self, ref: str, *, idempotency_key: str | None = None) -> Any:
        return await self._delete(
            f"/{ref}",
            headers=always_idempotency_headers(idempotency_key),
        )

    async def invoke(
        self,
        ref: str,
        input: dict[str, Any] | None = None,
        *,
        run_id: str | None = None,
        parent_span_id: str | None = None,
        idempotency_key: str | None = None,
        retry_of: str | None = None,
        operation_key: str | None = None,
        preview_id: str | None = None,
        depends_on: builtins.list[dict[str, str]] | None = None,
        compensates: str | None = None,
    ) -> Any:
        """Call the tool. Gated actions come back with pendingApproval=True.

        Every invoke carries an ``Idempotency-Key``. Pass ``idempotency_key`` to choose it. Without
        one the SDK generates a key once per call and sends the same key on each transport retry of
        that call, so a resend is answered from the recorded invocation and is not executed again.
        Two calls to ``invoke`` without a key are two invocations.

        A governed action answers with a receipt ``grade`` (see ``EffectGrade``). A template
        action with no declaration creates no effect and has no grade.

        For adapter actions: ``operation_key`` is the stable operation identity (same key and
        request return the existing effect; a different request is refused), ``preview_id`` binds
        the call to a reviewed preview, ``depends_on`` names effects that must already hold an
        outcome (pending and unknown never satisfy one), and ``compensates`` marks a compensation.
        """
        return await self._post(
            f"/{ref}/invoke",
            body=_build_invoke_body(
                input, run_id, parent_span_id, retry_of, operation_key, preview_id, depends_on, compensates
            ),
            headers=always_idempotency_headers(idempotency_key),
        )

    async def invocations(
        self,
        *,
        action: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
        status: InvocationStatus | None = None,
        end_user_id: str | None = None,
        acting_for: ActingFor | None = None,
    ) -> Any:
        """The invocation log; see the sync twin for the filters."""
        return await self._get(
            "/invocations",
            params=_build_invocations_params(action, limit, offset, status, end_user_id, acting_for),
        )

    async def invocation(self, invocation_id: str) -> Any:
        """One invocation. It carries ``grade`` when the invocation created a governed effect."""
        return await self._get(f"/invocations/{invocation_id}")

    async def resolve_invocation(
        self,
        invocation_id: str,
        *,
        outcome: InvocationOutcome,
        evidence: str,
        external_reference: str | None = None,
    ) -> Any:
        """Record what the destination confirms happened to an ``unknown`` invocation."""
        return await self._post(
            f"/invocations/{invocation_id}/resolve",
            body=_build_resolve_body(outcome, evidence, external_reference),
            headers=always_idempotency_headers(),
        )

    async def invocations_for(
        self,
        ref: str,
        *,
        limit: int | None = None,
        offset: int | None = None,
        status: InvocationStatus | None = None,
        end_user_id: str | None = None,
        acting_for: ActingFor | None = None,
    ) -> Any:
        """One action's invocation log, with the same filters as ``invocations``."""
        return await self._get(
            f"/{ref}/invocations",
            params=_build_invocations_params(None, limit, offset, status, end_user_id, acting_for),
        )

    async def preview(
        self,
        ref: str,
        input: dict[str, Any] | None = None,
        *,
        ttl_seconds: int | None = None,
        run_id: str | None = None,
    ) -> Any:
        """Prepare an execution-bound preview: exact change, impact against limits, preconditions,
        expiry and guarantees. Reads the provider; writes nothing. Invoke with ``preview_id``."""
        return await self._post(
            f"/{ref}/previews",
            body=_drop_none({"input": input or {}, "ttlSeconds": ttl_seconds, "runId": run_id}),
            headers=always_idempotency_headers(),
        )

    async def get_preview(self, preview_id: str) -> Any:
        return await self._get(f"/previews/{preview_id}")

    async def refresh_preview(self, preview_id: str, *, ttl_seconds: int | None = None) -> Any:
        """Re-read the provider into a NEW preview; an approval of the old one never carries over."""
        return await self._post(
            f"/previews/{preview_id}/refresh",
            body=_drop_none({"ttlSeconds": ttl_seconds}),
            headers=always_idempotency_headers(),
        )

    async def effects(
        self,
        *,
        action: str | None = None,
        outcome: EffectOutcome | None = None,
        stage: EffectStage | None = None,
        unresolved: bool | None = None,
        limit: int | None = None,
        offset: int | None = None,
        grade: EffectGrade | None = None,
        end_user_id: str | None = None,
        acting_for: ActingFor | None = None,
    ) -> Any:
        """Effects, filterable by action, outcome, stage, grade and unresolved exposure.

        Every effect carries ``grade``, including one that has not run. ``end_user_id`` lists one
        end user's effects; ``acting_for`` is ``"workspace"`` or ``"end_users"``.
        """
        return await self._get("/effects", params=_build_effects_params(action, outcome, stage, unresolved, limit, offset, grade, end_user_id, acting_for))

    async def effect(self, effect_id: str) -> Any:
        """One effect with its grade, attempts, append-only evidence, reservations and bound preview."""
        return await self._get(f"/effects/{effect_id}")

    async def reconcile_effect(self, effect_id: str) -> Any:
        """Ask the provider, read-only, what happened to a pending or unknown effect."""
        return await self._post(f"/effects/{effect_id}/reconcile", headers=always_idempotency_headers())

    async def add_effect_note(self, effect_id: str, note: str) -> Any:
        """Append an investigation note to the evidence. Needs ``actions:resolve``."""
        return await self._post(
            f"/effects/{effect_id}/notes", body={"note": note}, headers=always_idempotency_headers()
        )

    async def resolve_effect(
        self,
        effect_id: str,
        *,
        outcome: InvocationOutcome,
        reason: str,
        partial_effect: PartialEffect | None = None,
        actual_impact: builtins.list[dict[str, Any]] | None = None,
        external_reference: str | None = None,
    ) -> Any:
        """Record a reasoned manual resolution, labelled ``manual`` (never provider verification)."""
        return await self._post(
            f"/effects/{effect_id}/resolve",
            body=_build_resolve_effect_body(outcome, reason, partial_effect, actual_impact, external_reference),
            headers=always_idempotency_headers(),
        )

    async def replay_effect(self, effect_id: str) -> Any:
        """Repeat a lost write under the same provider identity: a governed write, never a new effect."""
        return await self._post(f"/effects/{effect_id}/replay", headers=always_idempotency_headers())
