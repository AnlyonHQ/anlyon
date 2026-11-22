"""
Anlyon Client, the main entry point.

    client = Client(api_key="anlyon_live_xxx")
    client.actions.invoke("refund-order", {"charge": "ch_1"})
    client.close()

    # Async
    async with AsyncClient(api_key="...") as client:
        await client.actions.invoke("refund-order", {"charge": "ch_1"})

The api_key / base_url fall back to the ANLYON_API_KEY / ANLYON_BASE_URL
environment variables when not passed explicitly.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import AsyncIterator
from typing import Any

if sys.version_info >= (3, 11):
    from typing import Self
else:  # pragma: no cover - typing-extensions is a dependency below 3.11
    from typing_extensions import Self

from .config import AnlyonClientConfig, RetryConfig
from .end_user import check_end_user_id
from .errors import AnlyonError
from .http import AsyncHttpClient, HttpClient
from .resources.actions import ActionsResource, AsyncActionsResource
from .resources.analytics import AnalyticsResource, AsyncAnalyticsResource
from .resources.approval_policies import ApprovalPoliciesResource, AsyncApprovalPoliciesResource
from .resources.approvals import ApprovalsResource, AsyncApprovalsResource
from .resources.audit import AsyncAuditResource, AuditResource
from .resources.auth import AsyncAuthResource, AuthResource
from .resources.billing import AsyncBillingResource, BillingResource
from .resources.budgets import AsyncBudgetsResource, BudgetsResource
from .resources.connections import AsyncConnectionsResource, ConnectionsResource
from .resources.dlq import AsyncDlqResource, DlqResource
from .resources.end_users import AsyncEndUsersResource, EndUsersResource
from .resources.environment import AsyncEnvironmentResource, EnvironmentResource
from .resources.events import AsyncEventsResource, EventsResource
from .resources.functions import AsyncFunctionsResource, FunctionsResource
from .resources.impact_limits import AsyncImpactLimitsResource, ImpactLimitsResource
from .resources.integrations import AsyncIntegrationsResource, IntegrationsResource
from .resources.logs import AsyncLogsResource, LogsResource
from .resources.mcp_upstreams import AsyncMcpUpstreamsResource, McpUpstreamsResource
from .resources.notifications import AsyncNotificationsResource, NotificationsResource
from .resources.runs import AsyncRunsResource, RunsResource
from .resources.secret_stores import AsyncSecretStoresResource, SecretStoresResource
from .resources.secrets import AsyncSecretsResource, SecretsResource
from .resources.sign_offs import AsyncSignOffsResource, SignOffsResource


def _build_config(
    api_key: str | None,
    base_url: str | None,
    timeout: float | None,
    retry: RetryConfig | None,
    default_headers: dict[str, str] | None,
) -> AnlyonClientConfig:
    resolved_key = api_key or os.environ.get("ANLYON_API_KEY")
    if not resolved_key:
        raise AnlyonError(
            "No API key provided. Pass api_key or set the ANLYON_API_KEY environment variable.",
            code="MISSING_API_KEY",
        )
    config = AnlyonClientConfig(api_key=resolved_key)
    resolved_base_url = base_url or os.environ.get("ANLYON_BASE_URL")
    if resolved_base_url:
        config.base_url = resolved_base_url
    if timeout:
        config.timeout = timeout
    if retry:
        config.retry = retry
    if default_headers:
        config.default_headers = default_headers
    return config


class Client:
    """Synchronous Anlyon client."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float | None = None,
        retry: RetryConfig | None = None,
        default_headers: dict[str, str] | None = None,
    ) -> None:
        self._attach(HttpClient(_build_config(api_key, base_url, timeout, retry, default_headers)))

    def _attach(self, http: HttpClient) -> None:
        self._http = http
        self._end_users: EndUsersResource | None = None
        self._functions: FunctionsResource | None = None
        self._events: EventsResource | None = None
        self._runs: RunsResource | None = None
        self._secrets: SecretsResource | None = None
        self._secret_stores: SecretStoresResource | None = None
        self._connections: ConnectionsResource | None = None
        self._environment: EnvironmentResource | None = None
        self._actions: ActionsResource | None = None
        self._approvals: ApprovalsResource | None = None
        self._budgets: BudgetsResource | None = None
        self._impact_limits: ImpactLimitsResource | None = None
        self._sign_offs: SignOffsResource | None = None
        self._mcp_upstreams: McpUpstreamsResource | None = None
        self._audit: AuditResource | None = None
        self._approval_policies: ApprovalPoliciesResource | None = None
        self._auth: AuthResource | None = None
        self._dlq: DlqResource | None = None
        self._analytics: AnalyticsResource | None = None
        self._billing: BillingResource | None = None
        self._notifications: NotificationsResource | None = None
        self._integrations: IntegrationsResource | None = None
        self._logs: LogsResource | None = None

    def for_user(self, end_user_id: str) -> Client:
        """A client that acts for one of your users.

        Every request it makes carries ``Anlyon-End-User: <end_user_id>``, so actions use that end
        user's own connections and count against their limits, and their approvals and receipts
        carry the id. Your server states the end user, and the model never does: build this client
        from your own session and hand it to the tool adapter.

        The binding is fixed. This client cannot be switched to another end user, and the client
        you call it on stays a workspace client. The two share one connection pool; closing the
        bound client leaves it open.

        ``end_user_id`` is 1 to 128 characters from ``A-Z a-z 0-9 . _ : @ -``, checked here before
        anything is sent::

            user_client = client.for_user(session.user_id)
            try:
                user_client.actions.invoke("gmail-send-email", {"to": [to], "subject": subject})
            except EndUserNotConnectedError as error:
                return {"connect_url": error.connect_url}
        """
        check_end_user_id(end_user_id)
        bound = self._http.end_user_id
        if bound is not None:
            if bound == end_user_id:
                return self
            raise AnlyonError(
                "This client already acts for an end user and cannot be switched. "
                "Call for_user() on the client it was built from.",
                code="VALIDATION_ERROR",
            )
        client = Client.__new__(Client)
        client._attach(self._http.for_end_user(end_user_id))
        return client

    @property
    def end_user_id(self) -> str | None:
        """The end user this client acts for, or ``None`` for a workspace client."""
        return self._http.end_user_id

    @property
    def events(self) -> EventsResource:
        if self._events is None:
            self._events = EventsResource(self._http)
        return self._events

    @property
    def runs(self) -> RunsResource:
        """Agent runs and spans (the trace model)."""
        if self._runs is None:
            self._runs = RunsResource(self._http)
        return self._runs

    def stream(self, *, cursor: str | None = None) -> Any:
        """
        Subscribe to the realtime event stream, scoped to this key's workspace and
        environment. Reconnects automatically with a resume cursor. Yields parsed
        event dicts; iterate to consume.

        Example::

            for event in client.stream():
                if event["type"] == "run.started":
                    print(event["data"]["runId"])
        """
        for message in self._http.stream_sse("/api/v2/stream", last_event_id=cursor):
            try:
                yield json.loads(message["data"])
            except (ValueError, KeyError):
                continue

    @property
    def secrets(self) -> SecretsResource:
        """Write-only vault. Values go in and are never returned."""
        if self._secrets is None:
            self._secrets = SecretsResource(self._http)
        return self._secrets

    @property
    def secret_stores(self) -> SecretStoresResource:
        """Enterprise. Your own AWS Secrets Manager or HashiCorp Vault, read at dispatch."""
        if self._secret_stores is None:
            self._secret_stores = SecretStoresResource(self._http)
        return self._secret_stores

    @property
    def connections(self) -> ConnectionsResource:
        """Connected accounts: secrets whose access token is fetched at dispatch."""
        if self._connections is None:
            self._connections = ConnectionsResource(self._http)
        return self._connections

    @property
    def environment(self) -> EnvironmentResource:
        """This key's own environment, and its kill switch.

        ``halt`` and ``resume`` need the ``environments:halt`` scope, which is
        not granted by default -- put an operator key holding it behind your
        on-call runbook.
        """
        if self._environment is None:
            self._environment = EnvironmentResource(self._http)
        return self._environment

    @property
    def actions(self) -> ActionsResource:
        """Hosted tools the agent invokes by name."""
        if self._actions is None:
            self._actions = ActionsResource(self._http)
        return self._actions

    @property
    def approvals(self) -> ApprovalsResource:
        """Human-in-the-loop gates."""
        if self._approvals is None:
            self._approvals = ApprovalsResource(self._http)
        return self._approvals

    @property
    def budgets(self) -> BudgetsResource:
        """Per-API-key spend caps."""
        if self._budgets is None:
            self._budgets = BudgetsResource(self._http)
        return self._budgets

    @property
    def impact_limits(self) -> ImpactLimitsResource:
        """Shared caps on money and resource mutations that governed effects reserve before dispatch."""
        if self._impact_limits is None:
            self._impact_limits = ImpactLimitsResource(self._http)
        return self._impact_limits

    @property
    def sign_offs(self) -> SignOffsResource:
        """Loosening changes this credential asked for, which a human must approve before they apply."""
        if self._sign_offs is None:
            self._sign_offs = SignOffsResource(self._http)
        return self._sign_offs

    @property
    def mcp_upstreams(self) -> McpUpstreamsResource:
        """Remote MCP servers behind Anlyon. Adopting a tool always waits for a person's sign-off."""
        if self._mcp_upstreams is None:
            self._mcp_upstreams = McpUpstreamsResource(self._http)
        return self._mcp_upstreams

    @property
    def audit(self) -> AuditResource:
        """Audit records and the evidence export (Enterprise and Team plan; needs ``audit:read``)."""
        if self._audit is None:
            self._audit = AuditResource(self._http)
        return self._audit

    @property
    def approval_policies(self) -> ApprovalPoliciesResource:
        """Approval policies. Needs an operator credential (policies:read / policies:write)."""
        if self._approval_policies is None:
            self._approval_policies = ApprovalPoliciesResource(self._http)
        return self._approval_policies

    @property
    def auth(self) -> AuthResource:
        """Inspect the credential this client uses: type, environment, effective scopes, expiry."""
        if self._auth is None:
            self._auth = AuthResource(self._http)
        return self._auth

    @property
    def dlq(self) -> DlqResource:
        if self._dlq is None:
            self._dlq = DlqResource(self._http)
        return self._dlq

    @property
    def analytics(self) -> AnalyticsResource:
        if self._analytics is None:
            self._analytics = AnalyticsResource(self._http)
        return self._analytics

    @property
    def billing(self) -> BillingResource:
        if self._billing is None:
            self._billing = BillingResource(self._http)
        return self._billing

    @property
    def notifications(self) -> NotificationsResource:
        if self._notifications is None:
            self._notifications = NotificationsResource(self._http)
        return self._notifications

    @property
    def integrations(self) -> IntegrationsResource:
        if self._integrations is None:
            self._integrations = IntegrationsResource(self._http)
        return self._integrations

    @property
    def logs(self) -> LogsResource:
        if self._logs is None:
            self._logs = LogsResource(self._http)
        return self._logs

    @property
    def end_users(self) -> EndUsersResource:
        """End users: connect their accounts, list and remove connections, decide their approvals.

        To act for one, use :meth:`for_user`.
        """
        if self._end_users is None:
            self._end_users = EndUsersResource(self._http)
        return self._end_users

    @property
    def functions(self) -> FunctionsResource:
        """Hosted functions: plan a run's writes for approval, then apply the approved plan.

        On a client from :meth:`for_user`, every run acts for that end user. Function runs are
        read with ``functions.runs.get``, not ``runs``.
        """
        if self._functions is None:
            self._functions = FunctionsResource(self._http)
        return self._functions

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


class AsyncClient:
    """Asynchronous Anlyon client."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float | None = None,
        retry: RetryConfig | None = None,
        default_headers: dict[str, str] | None = None,
    ) -> None:
        self._attach(
            AsyncHttpClient(_build_config(api_key, base_url, timeout, retry, default_headers))
        )

    def _attach(self, http: AsyncHttpClient) -> None:
        self._http = http
        self._end_users: AsyncEndUsersResource | None = None
        self._functions: AsyncFunctionsResource | None = None
        self._events: AsyncEventsResource | None = None
        self._runs: AsyncRunsResource | None = None
        self._secrets: AsyncSecretsResource | None = None
        self._secret_stores: AsyncSecretStoresResource | None = None
        self._connections: AsyncConnectionsResource | None = None
        self._environment: AsyncEnvironmentResource | None = None
        self._actions: AsyncActionsResource | None = None
        self._approvals: AsyncApprovalsResource | None = None
        self._budgets: AsyncBudgetsResource | None = None
        self._impact_limits: AsyncImpactLimitsResource | None = None
        self._sign_offs: AsyncSignOffsResource | None = None
        self._mcp_upstreams: AsyncMcpUpstreamsResource | None = None
        self._audit: AsyncAuditResource | None = None
        self._approval_policies: AsyncApprovalPoliciesResource | None = None
        self._auth: AsyncAuthResource | None = None
        self._dlq: AsyncDlqResource | None = None
        self._analytics: AsyncAnalyticsResource | None = None
        self._billing: AsyncBillingResource | None = None
        self._notifications: AsyncNotificationsResource | None = None
        self._integrations: AsyncIntegrationsResource | None = None
        self._logs: AsyncLogsResource | None = None

    def for_user(self, end_user_id: str) -> AsyncClient:
        """A client that acts for one of your users.

        Every request it makes carries ``Anlyon-End-User: <end_user_id>``, so actions use that end
        user's own connections and count against their limits, and their approvals and receipts
        carry the id. Your server states the end user, and the model never does: build this client
        from your own session and hand it to the tool adapter.

        The binding is fixed. This client cannot be switched to another end user, and the client
        you call it on stays a workspace client. The two share one connection pool; closing the
        bound client leaves it open.

        ``end_user_id`` is 1 to 128 characters from ``A-Z a-z 0-9 . _ : @ -``, checked here before
        anything is sent::

            user_client = client.for_user(session.user_id)
            try:
                user_client.actions.invoke("gmail-send-email", {"to": [to], "subject": subject})
            except EndUserNotConnectedError as error:
                return {"connect_url": error.connect_url}
        """
        check_end_user_id(end_user_id)
        bound = self._http.end_user_id
        if bound is not None:
            if bound == end_user_id:
                return self
            raise AnlyonError(
                "This client already acts for an end user and cannot be switched. "
                "Call for_user() on the client it was built from.",
                code="VALIDATION_ERROR",
            )
        client = AsyncClient.__new__(AsyncClient)
        client._attach(self._http.for_end_user(end_user_id))
        return client

    @property
    def end_user_id(self) -> str | None:
        """The end user this client acts for, or ``None`` for a workspace client."""
        return self._http.end_user_id

    @property
    def events(self) -> AsyncEventsResource:
        if self._events is None:
            self._events = AsyncEventsResource(self._http)
        return self._events

    @property
    def runs(self) -> AsyncRunsResource:
        """Agent runs and spans (the trace model)."""
        if self._runs is None:
            self._runs = AsyncRunsResource(self._http)
        return self._runs

    async def stream(self, *, cursor: str | None = None) -> AsyncIterator[Any]:
        """Async twin of Client.stream  see that docstring."""
        async for message in self._http.stream_sse("/api/v2/stream", last_event_id=cursor):
            try:
                yield json.loads(message["data"])
            except (ValueError, KeyError):
                continue

    @property
    def secrets(self) -> AsyncSecretsResource:
        """Write-only vault. Values go in and are never returned."""
        if self._secrets is None:
            self._secrets = AsyncSecretsResource(self._http)
        return self._secrets

    @property
    def secret_stores(self) -> AsyncSecretStoresResource:
        """Enterprise. Your own AWS Secrets Manager or HashiCorp Vault, read at dispatch."""
        if self._secret_stores is None:
            self._secret_stores = AsyncSecretStoresResource(self._http)
        return self._secret_stores

    @property
    def connections(self) -> AsyncConnectionsResource:
        """Connected accounts: secrets whose access token is fetched at dispatch."""
        if self._connections is None:
            self._connections = AsyncConnectionsResource(self._http)
        return self._connections

    @property
    def environment(self) -> AsyncEnvironmentResource:
        """This key's own environment, and its kill switch.

        ``halt`` and ``resume`` need the ``environments:halt`` scope, which is
        not granted by default -- put an operator key holding it behind your
        on-call runbook.
        """
        if self._environment is None:
            self._environment = AsyncEnvironmentResource(self._http)
        return self._environment

    @property
    def actions(self) -> AsyncActionsResource:
        """Hosted tools the agent invokes by name."""
        if self._actions is None:
            self._actions = AsyncActionsResource(self._http)
        return self._actions

    @property
    def approvals(self) -> AsyncApprovalsResource:
        """Human-in-the-loop gates."""
        if self._approvals is None:
            self._approvals = AsyncApprovalsResource(self._http)
        return self._approvals

    @property
    def budgets(self) -> AsyncBudgetsResource:
        """Per-API-key spend caps."""
        if self._budgets is None:
            self._budgets = AsyncBudgetsResource(self._http)
        return self._budgets

    @property
    def impact_limits(self) -> AsyncImpactLimitsResource:
        """Shared caps on money and resource mutations that governed effects reserve before dispatch."""
        if self._impact_limits is None:
            self._impact_limits = AsyncImpactLimitsResource(self._http)
        return self._impact_limits

    @property
    def sign_offs(self) -> AsyncSignOffsResource:
        """Loosening changes this credential asked for, which a human must approve before they apply."""
        if self._sign_offs is None:
            self._sign_offs = AsyncSignOffsResource(self._http)
        return self._sign_offs

    @property
    def mcp_upstreams(self) -> AsyncMcpUpstreamsResource:
        """Remote MCP servers behind Anlyon. Adopting a tool always waits for a person's sign-off."""
        if self._mcp_upstreams is None:
            self._mcp_upstreams = AsyncMcpUpstreamsResource(self._http)
        return self._mcp_upstreams

    @property
    def audit(self) -> AsyncAuditResource:
        """Audit records and the evidence export (Enterprise and Team plan; needs ``audit:read``)."""
        if self._audit is None:
            self._audit = AsyncAuditResource(self._http)
        return self._audit

    @property
    def approval_policies(self) -> AsyncApprovalPoliciesResource:
        """Approval policies. Needs an operator credential (policies:read / policies:write)."""
        if self._approval_policies is None:
            self._approval_policies = AsyncApprovalPoliciesResource(self._http)
        return self._approval_policies

    @property
    def auth(self) -> AsyncAuthResource:
        """Inspect the credential this client uses: type, environment, effective scopes, expiry."""
        if self._auth is None:
            self._auth = AsyncAuthResource(self._http)
        return self._auth

    @property
    def dlq(self) -> AsyncDlqResource:
        if self._dlq is None:
            self._dlq = AsyncDlqResource(self._http)
        return self._dlq

    @property
    def analytics(self) -> AsyncAnalyticsResource:
        if self._analytics is None:
            self._analytics = AsyncAnalyticsResource(self._http)
        return self._analytics

    @property
    def billing(self) -> AsyncBillingResource:
        if self._billing is None:
            self._billing = AsyncBillingResource(self._http)
        return self._billing

    @property
    def notifications(self) -> AsyncNotificationsResource:
        if self._notifications is None:
            self._notifications = AsyncNotificationsResource(self._http)
        return self._notifications

    @property
    def integrations(self) -> AsyncIntegrationsResource:
        if self._integrations is None:
            self._integrations = AsyncIntegrationsResource(self._http)
        return self._integrations

    @property
    def logs(self) -> AsyncLogsResource:
        if self._logs is None:
            self._logs = AsyncLogsResource(self._http)
        return self._logs

    @property
    def end_users(self) -> AsyncEndUsersResource:
        """End users: connect their accounts, list and remove connections, decide their approvals."""
        if self._end_users is None:
            self._end_users = AsyncEndUsersResource(self._http)
        return self._end_users

    @property
    def functions(self) -> AsyncFunctionsResource:
        """Hosted functions: plan a run's writes for approval, then apply the approved plan."""
        if self._functions is None:
            self._functions = AsyncFunctionsResource(self._http)
        return self._functions

    async def close(self) -> None:
        await self._http.close()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self._http.close()
