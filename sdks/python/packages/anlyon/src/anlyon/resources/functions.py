"""
Functions: your code, hosted by Anlyon, calling your actions under the same governance.

Mirrors src/resources/functions.ts in the TS SDK.

Publish a JavaScript or Python module and name the actions it may call. A run calls them through
``anlyon.invoke`` and ``anlyon.read``, with no network, environment variables or secrets of its
own.

- Plan: ``run(name, input)`` runs the reads for real and records each write without sending it. A
  run with writes ends ``awaiting_approval``, with one approval in ``run["plan"]["approval"]``.
- Approve: the team decides it with ``approvals``, or the end user with
  ``end_users.approvals.decide`` when every write's policy is decided by the end user.
- Apply: ``run(name, input, mode="apply", plan_run_id=...)`` carries out the approved plan, once.
  A write that differs from the plan ends the run ``diverged`` before it is sent.

A client from ``for_user()`` runs functions for that end user: every call the run makes carries
the end user. Needs the ``functions:read``, ``functions:write`` or ``functions:run`` scope (a run
needs ``actions:invoke`` as well).

Responses are returned as the API sends them, in camelCase.
"""

from __future__ import annotations

import builtins
from typing import TYPE_CHECKING, Any, Literal, TypedDict
from urllib.parse import quote

from ..errors import AnlyonError
from .base import AsyncBaseResource, BaseResource

if TYPE_CHECKING:
    from ..http import AsyncHttpClient, HttpClient

_BASE = "/api/v2/functions"
_RUNS_BASE = "/api/v2/function-runs"

FunctionLanguage = Literal["javascript", "python"]
FunctionRunMode = Literal["plan", "apply", "straight_through"]
"""What a run does with writes (calls to an action that is not a GET).

``plan`` records them for approval, ``apply`` carries out an approved plan, ``straight_through``
sends them under the version's straight-through policy.
"""
FunctionRunStatus = Literal[
    "running",
    "succeeded",
    "failed",
    "budget_exceeded",
    "planned",
    "awaiting_approval",
    "diverged",
]


class FunctionBudgets(TypedDict, total=False):
    """Per-run budgets. A budget left out takes the API's default.

    When one runs out the run ends ``budget_exceeded``, with ``budget`` naming it.
    """

    max_action_calls: int
    max_cpu_ms: int
    max_subrequests: int
    timeout_ms: int


class FunctionStraightThroughPolicy(TypedDict):
    """Writes a straight-through run may make without a plan, still governed and receipted.

    ``actions`` must each be in ``allowed_actions``. ``max_writes`` is per run.
    """

    actions: builtins.list[str]
    max_writes: int


_BUDGET_KEYS = {
    "max_action_calls": "maxActionCalls",
    "max_cpu_ms": "maxCpuMs",
    "max_subrequests": "maxSubrequests",
    "timeout_ms": "timeoutMs",
}

_UNSET: Any = object()


def _required(value: Any, what: str) -> str:
    if not isinstance(value, str) or not value:
        raise AnlyonError(f"{what} is required.", code="VALIDATION_ERROR")
    return value


def _segment(value: Any, what: str) -> str:
    return quote(_required(value, what), safe="")


def _create_body(name: str, description: str | None) -> dict[str, Any]:
    body: dict[str, Any] = {"name": _required(name, "name")}
    if description is not None:
        body["description"] = description
    return body


def _publish_body(
    language: FunctionLanguage,
    source: str,
    allowed_actions: builtins.list[str] | None,
    input_schema: dict[str, Any] | None,
    budgets: FunctionBudgets | None,
    straight_through: FunctionStraightThroughPolicy | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"language": language, "source": source}
    if allowed_actions is not None:
        body["allowedActions"] = allowed_actions
    if input_schema is not None:
        body["inputSchema"] = input_schema
    if budgets is not None:
        body["budgets"] = {_BUDGET_KEYS.get(k, k): v for k, v in budgets.items()}
    if straight_through is None:
        body["straightThrough"] = None
    elif straight_through is not _UNSET:
        body["straightThrough"] = {
            "actions": straight_through["actions"],
            "maxWrites": straight_through["max_writes"],
        }
    return body


def _run_body(
    input: dict[str, Any] | None, mode: FunctionRunMode | None, plan_run_id: str | None
) -> dict[str, Any]:
    if (mode == "apply") != (plan_run_id is not None):
        message = (
            'plan_run_id is required with mode "apply".'
            if mode == "apply"
            else 'plan_run_id goes with mode "apply" and no other mode.'
        )
        raise AnlyonError(message, code="VALIDATION_ERROR")
    body: dict[str, Any] = {}
    if input is not None:
        body["input"] = input
    if mode is not None:
        body["mode"] = mode
    if plan_run_id is not None:
        body["planRunId"] = _required(plan_run_id, "plan_run_id")
    return body


def _version_segment(version: Any) -> str:
    if version == "current":
        return "current"
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise AnlyonError('version is a number from 1, or "current".', code="VALIDATION_ERROR")
    return str(version)


def _runs_query(limit: int | None, end_user_id: str | None) -> dict[str, Any] | None:
    params: dict[str, Any] = {}
    if limit is not None:
        params["limit"] = limit
    if end_user_id is not None:
        params["endUserId"] = end_user_id
    return params or None


class FunctionRunsResource(BaseResource):
    """Function runs, read by id (sync)."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _RUNS_BASE)

    def get(self, run_id: str) -> Any:
        """One run with every call it made, refused ones included, and its receipt.

        A plan run carries its plan and the plan's approval.
        """
        return self._get(f"/{_segment(run_id, 'run_id')}")


class FunctionsResource(BaseResource):
    """Hosted functions (sync)."""

    def __init__(self, http: HttpClient) -> None:
        super().__init__(http, _BASE)
        self._runs: FunctionRunsResource | None = None

    @property
    def runs(self) -> FunctionRunsResource:
        """Function runs, read by id. Agent runs stay on ``client.runs``."""
        if self._runs is None:
            self._runs = FunctionRunsResource(self._http)
        return self._runs

    def create(self, *, name: str, description: str | None = None) -> Any:
        """Create a function. It runs nothing until a version is published."""
        return self._post("", body=_create_body(name, description))

    def list(self) -> Any:
        """Every function in the key's environment, with its current version. Never the source."""
        return self._get("")

    def delete(self, name: str) -> Any:
        """Delete a function. It leaves the list and refuses new runs; its versions and runs stay,
        and its name is free to use again."""
        return self._delete(f"/{_segment(name, 'name')}")

    def publish(
        self,
        name: str,
        *,
        language: FunctionLanguage,
        source: str,
        allowed_actions: builtins.list[str] | None = None,
        input_schema: dict[str, Any] | None = None,
        budgets: FunctionBudgets | None = None,
        straight_through: FunctionStraightThroughPolicy | None = _UNSET,
    ) -> Any:
        """Publish ``source`` as the function's new current version: ``{"function", "version"}``.

        JavaScript: an ES module whose default export is ``async function run(input, anlyon)``.
        Python: a module that defines ``run(input, anlyon)``. A call to an action not in
        ``allowed_actions`` is refused; left out, the list is read from the source's literal calls.
        ``straight_through=None`` sends ``null``: a
        straight-through run may then read and not write.
        """
        body = _publish_body(
            language, source, allowed_actions, input_schema, budgets, straight_through
        )
        return self._post(f"/{_segment(name, 'name')}/versions", body=body)

    def list_versions(self, name: str) -> Any:
        """Every published version, newest first, without sources.

        ``current`` marks the one runs use.
        """
        return self._get(f"/{_segment(name, 'name')}/versions")

    def get_version(self, name: str, version: int | Literal["current"]) -> Any:
        """One version with its source: a version number, or ``"current"``."""
        return self._get(f"/{_segment(name, 'name')}/versions/{_version_segment(version)}")

    def list_runs(
        self, name: str, *, limit: int | None = None, end_user_id: str | None = None
    ) -> Any:
        """The function's runs, newest first, without their calls.

        ``limit`` is 1 to 100 (default 50). ``end_user_id`` narrows to one end user's runs; a key
        created with ``end_user_required`` sees only its own.
        """
        return self._get(f"/{_segment(name, 'name')}/runs", params=_runs_query(limit, end_user_id))

    def run(
        self,
        name: str,
        input: dict[str, Any] | None = None,
        *,
        mode: FunctionRunMode | None = None,
        plan_run_id: str | None = None,
    ) -> Any:
        """Run the function once and answer when it ends.

        ``mode`` defaults to ``plan``. A plan run with writes ends ``awaiting_approval``; once its
        approval is approved, run again with ``mode="apply"`` and ``plan_run_id``. Raises a
        ``VALIDATION_ERROR`` before sending when ``apply`` comes without ``plan_run_id``, or
        ``plan_run_id`` with another mode.

            plan = client.functions.run("refund-with-checks", {"order": "ord_123"})
            if plan.data["status"] == "awaiting_approval":
                # The team approves plan.data["plan"]["approval"]["id"], or the end user.
                client.functions.run(
                    "refund-with-checks",
                    {"order": "ord_123"},
                    mode="apply",
                    plan_run_id=plan.data["id"],
                )
        """
        body = _run_body(input, mode, plan_run_id)
        return self._post(f"/{_segment(name, 'name')}/runs", body=body)


class AsyncFunctionRunsResource(AsyncBaseResource):
    """Function runs, read by id (async)."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _RUNS_BASE)

    async def get(self, run_id: str) -> Any:
        """One run with every call it made and its receipt. See the sync twin."""
        return await self._get(f"/{_segment(run_id, 'run_id')}")


class AsyncFunctionsResource(AsyncBaseResource):
    """Hosted functions (async). See :class:`FunctionsResource`."""

    def __init__(self, http: AsyncHttpClient) -> None:
        super().__init__(http, _BASE)
        self._runs: AsyncFunctionRunsResource | None = None

    @property
    def runs(self) -> AsyncFunctionRunsResource:
        """Function runs, read by id. Agent runs stay on ``client.runs``."""
        if self._runs is None:
            self._runs = AsyncFunctionRunsResource(self._http)
        return self._runs

    async def create(self, *, name: str, description: str | None = None) -> Any:
        """Create a function. It runs nothing until a version is published."""
        return await self._post("", body=_create_body(name, description))

    async def list(self) -> Any:
        """Every function in the key's environment, with its current version. Never the source."""
        return await self._get("")

    async def delete(self, name: str) -> Any:
        """Delete a function. It leaves the list and refuses new runs; its versions and runs stay,
        and its name is free to use again."""
        return await self._delete(f"/{_segment(name, 'name')}")

    async def publish(
        self,
        name: str,
        *,
        language: FunctionLanguage,
        source: str,
        allowed_actions: builtins.list[str] | None = None,
        input_schema: dict[str, Any] | None = None,
        budgets: FunctionBudgets | None = None,
        straight_through: FunctionStraightThroughPolicy | None = _UNSET,
    ) -> Any:
        """Publish ``source`` as the function's new current version. See the sync twin."""
        body = _publish_body(
            language, source, allowed_actions, input_schema, budgets, straight_through
        )
        return await self._post(f"/{_segment(name, 'name')}/versions", body=body)

    async def list_versions(self, name: str) -> Any:
        """Every published version, newest first, without sources. See the sync twin."""
        return await self._get(f"/{_segment(name, 'name')}/versions")

    async def get_version(self, name: str, version: int | Literal["current"]) -> Any:
        """One version with its source. See the sync twin."""
        return await self._get(f"/{_segment(name, 'name')}/versions/{_version_segment(version)}")

    async def list_runs(
        self, name: str, *, limit: int | None = None, end_user_id: str | None = None
    ) -> Any:
        """The function's runs, newest first, without their calls. See the sync twin."""
        return await self._get(
            f"/{_segment(name, 'name')}/runs", params=_runs_query(limit, end_user_id)
        )

    async def run(
        self,
        name: str,
        input: dict[str, Any] | None = None,
        *,
        mode: FunctionRunMode | None = None,
        plan_run_id: str | None = None,
    ) -> Any:
        """Run the function once and answer when it ends. See the sync twin."""
        body = _run_body(input, mode, plan_run_id)
        return await self._post(f"/{_segment(name, 'name')}/runs", body=body)
