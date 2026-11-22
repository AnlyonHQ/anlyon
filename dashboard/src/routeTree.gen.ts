/* eslint-disable */

// @ts-nocheck

import { Route as rootRouteImport } from './routes/__root'
import { Route as SetupRouteImport } from './routes/setup'
import { Route as ProtectedRouteImport } from './routes/_protected'
import { Route as IndexRouteImport } from './routes/index'
import { Route as WorkspacesSetupRouteImport } from './routes/workspaces/setup'
import { Route as WorkspacesSelectRouteImport } from './routes/workspaces/select'
import { Route as WorkspacesNewRouteImport } from './routes/workspaces/new'
import { Route as OauthWorkspaceRouteImport } from './routes/oauth/workspace'
import { Route as OauthConsentRouteImport } from './routes/oauth/consent'
import { Route as InviteTokenRouteImport } from './routes/invite.$token'
import { Route as AuthVerifyEmailRouteImport } from './routes/auth/verify-email'
import { Route as AuthTwoFactorRouteImport } from './routes/auth/two-factor'
import { Route as AuthSignupRouteImport } from './routes/auth/signup'
import { Route as AuthResetPasswordRouteImport } from './routes/auth/reset-password'
import { Route as AuthLoginRouteImport } from './routes/auth/login'
import { Route as AuthForgotPasswordRouteImport } from './routes/auth/forgot-password'
import { Route as ProtectedUsageRouteImport } from './routes/_protected/usage'
import { Route as ProtectedTeamRouteImport } from './routes/_protected/team'
import { Route as ProtectedRecentRunsRouteImport } from './routes/_protected/recent-runs'
import { Route as ProtectedMcpServersRouteImport } from './routes/_protected/mcp-servers'
import { Route as ProtectedLogsExplorerRouteImport } from './routes/_protected/logs-explorer'
import { Route as ProtectedGetStartedRouteImport } from './routes/_protected/get-started'
import { Route as ProtectedFunctionsRouteImport } from './routes/_protected/functions'
import { Route as ProtectedEventsRouteImport } from './routes/_protected/events'
import { Route as ProtectedEnvironmentsRouteImport } from './routes/_protected/environments'
import { Route as ProtectedDlqRouteImport } from './routes/_protected/dlq'
import { Route as ProtectedDashboardRouteImport } from './routes/_protected/dashboard'
import { Route as ProtectedConnectSettingsRouteImport } from './routes/_protected/connect-settings'
import { Route as ProtectedApprovalsRouteImport } from './routes/_protected/approvals'
import { Route as ProtectedApprovalPoliciesRouteImport } from './routes/_protected/approval-policies'
import { Route as ProtectedAnalyticsRouteImport } from './routes/_protected/analytics'
import { Route as ProtectedAgentsRouteImport } from './routes/_protected/agents'
import { Route as ProtectedActionsRouteImport } from './routes/_protected/actions'
import { Route as ProtectedSplatRouteImport } from './routes/_protected/$'
import { Route as ProtectedSettingsRouteRouteImport } from './routes/_protected/settings/route'
import { Route as ProtectedUsersIndexRouteImport } from './routes/_protected/users/index'
import { Route as ProtectedSignOffsIndexRouteImport } from './routes/_protected/sign-offs/index'
import { Route as ProtectedSettingsIndexRouteImport } from './routes/_protected/settings/index'
import { Route as ProtectedMcpServersIndexRouteImport } from './routes/_protected/mcp-servers/index'
import { Route as ProtectedIntegrationsIndexRouteImport } from './routes/_protected/integrations/index'
import { Route as ProtectedFunctionsIndexRouteImport } from './routes/_protected/functions/index'
import { Route as ProtectedEventsIndexRouteImport } from './routes/_protected/events/index'
import { Route as ProtectedEndUsersIndexRouteImport } from './routes/_protected/end-users/index'
import { Route as ProtectedActionsIndexRouteImport } from './routes/_protected/actions/index'
import { Route as ProtectedUsersEndUserIdRouteImport } from './routes/_protected/users/$endUserId'
import { Route as ProtectedSignOffsSignOffIdRouteImport } from './routes/_protected/sign-offs/$signOffId'
import { Route as ProtectedSettingsWebhooksRouteImport } from './routes/_protected/settings/webhooks'
import { Route as ProtectedSettingsUsageRouteImport } from './routes/_protected/settings/usage'
import { Route as ProtectedSettingsTeamRouteImport } from './routes/_protected/settings/team'
import { Route as ProtectedSettingsSsoRouteImport } from './routes/_protected/settings/sso'
import { Route as ProtectedSettingsSecurityRouteImport } from './routes/_protected/settings/security'
import { Route as ProtectedSettingsScimRouteImport } from './routes/_protected/settings/scim'
import { Route as ProtectedSettingsProfileRouteImport } from './routes/_protected/settings/profile'
import { Route as ProtectedSettingsNotificationsRouteImport } from './routes/_protected/settings/notifications'
import { Route as ProtectedSettingsIntegrationsRouteImport } from './routes/_protected/settings/integrations'
import { Route as ProtectedSettingsInstanceRouteImport } from './routes/_protected/settings/instance'
import { Route as ProtectedSettingsGeneralRouteImport } from './routes/_protected/settings/general'
import { Route as ProtectedSettingsDefaultsRouteImport } from './routes/_protected/settings/defaults'
import { Route as ProtectedSettingsConnectionsRouteImport } from './routes/_protected/settings/connections'
import { Route as ProtectedSettingsConnectedAppsRouteImport } from './routes/_protected/settings/connected-apps'
import { Route as ProtectedSettingsAuditRouteImport } from './routes/_protected/settings/audit'
import { Route as ProtectedSettingsAssistantRouteImport } from './routes/_protected/settings/assistant'
import { Route as ProtectedSettingsApiKeysRouteImport } from './routes/_protected/settings/api-keys'
import { Route as ProtectedSettingsSplatRouteImport } from './routes/_protected/settings/$'
import { Route as ProtectedMcpServersNewRouteImport } from './routes/_protected/mcp-servers/new'
import { Route as ProtectedMcpServersNameRouteImport } from './routes/_protected/mcp-servers/$name'
import { Route as ProtectedIntegrationsSettingsRouteImport } from './routes/_protected/integrations/settings'
import { Route as ProtectedFunctionsNameRouteImport } from './routes/_protected/functions/$name'
import { Route as ProtectedEventsRecentRouteImport } from './routes/_protected/events/recent'
import { Route as ProtectedEndUsersEndUserIdRouteImport } from './routes/_protected/end-users/$endUserId'
import { Route as ProtectedActionsSecretsRouteImport } from './routes/_protected/actions/secrets'
import { Route as ProtectedActionsLimitsRouteImport } from './routes/_protected/actions/limits'
import { Route as ProtectedActionsInvocationsRouteImport } from './routes/_protected/actions/invocations'
import { Route as ProtectedActionsEffectsRouteImport } from './routes/_protected/actions/effects'
import { Route as ProtectedActionsConnectionsRouteImport } from './routes/_protected/actions/connections'
import { Route as ProtectedFunctionsRunsRunIdRouteImport } from './routes/_protected/functions/runs/$runId'

const SetupRoute = SetupRouteImport.update({
  id: '/setup',
  path: '/setup',
  getParentRoute: () => rootRouteImport,
} as any)
const ProtectedRoute = ProtectedRouteImport.update({
  id: '/_protected',
  getParentRoute: () => rootRouteImport,
} as any)
const IndexRoute = IndexRouteImport.update({
  id: '/',
  path: '/',
  getParentRoute: () => rootRouteImport,
} as any)
const WorkspacesSetupRoute = WorkspacesSetupRouteImport.update({
  id: '/workspaces/setup',
  path: '/workspaces/setup',
  getParentRoute: () => rootRouteImport,
} as any)
const WorkspacesSelectRoute = WorkspacesSelectRouteImport.update({
  id: '/workspaces/select',
  path: '/workspaces/select',
  getParentRoute: () => rootRouteImport,
} as any)
const WorkspacesNewRoute = WorkspacesNewRouteImport.update({
  id: '/workspaces/new',
  path: '/workspaces/new',
  getParentRoute: () => rootRouteImport,
} as any)
const OauthWorkspaceRoute = OauthWorkspaceRouteImport.update({
  id: '/oauth/workspace',
  path: '/oauth/workspace',
  getParentRoute: () => rootRouteImport,
} as any)
const OauthConsentRoute = OauthConsentRouteImport.update({
  id: '/oauth/consent',
  path: '/oauth/consent',
  getParentRoute: () => rootRouteImport,
} as any)
const InviteTokenRoute = InviteTokenRouteImport.update({
  id: '/invite/$token',
  path: '/invite/$token',
  getParentRoute: () => rootRouteImport,
} as any)
const AuthVerifyEmailRoute = AuthVerifyEmailRouteImport.update({
  id: '/auth/verify-email',
  path: '/auth/verify-email',
  getParentRoute: () => rootRouteImport,
} as any)
const AuthTwoFactorRoute = AuthTwoFactorRouteImport.update({
  id: '/auth/two-factor',
  path: '/auth/two-factor',
  getParentRoute: () => rootRouteImport,
} as any)
const AuthSignupRoute = AuthSignupRouteImport.update({
  id: '/auth/signup',
  path: '/auth/signup',
  getParentRoute: () => rootRouteImport,
} as any)
const AuthResetPasswordRoute = AuthResetPasswordRouteImport.update({
  id: '/auth/reset-password',
  path: '/auth/reset-password',
  getParentRoute: () => rootRouteImport,
} as any)
const AuthLoginRoute = AuthLoginRouteImport.update({
  id: '/auth/login',
  path: '/auth/login',
  getParentRoute: () => rootRouteImport,
} as any)
const AuthForgotPasswordRoute = AuthForgotPasswordRouteImport.update({
  id: '/auth/forgot-password',
  path: '/auth/forgot-password',
  getParentRoute: () => rootRouteImport,
} as any)
const ProtectedUsageRoute = ProtectedUsageRouteImport.update({
  id: '/usage',
  path: '/usage',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedTeamRoute = ProtectedTeamRouteImport.update({
  id: '/team',
  path: '/team',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedRecentRunsRoute = ProtectedRecentRunsRouteImport.update({
  id: '/recent-runs',
  path: '/recent-runs',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedMcpServersRoute = ProtectedMcpServersRouteImport.update({
  id: '/mcp-servers',
  path: '/mcp-servers',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedLogsExplorerRoute = ProtectedLogsExplorerRouteImport.update({
  id: '/logs-explorer',
  path: '/logs-explorer',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedGetStartedRoute = ProtectedGetStartedRouteImport.update({
  id: '/get-started',
  path: '/get-started',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedFunctionsRoute = ProtectedFunctionsRouteImport.update({
  id: '/functions',
  path: '/functions',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedEventsRoute = ProtectedEventsRouteImport.update({
  id: '/events',
  path: '/events',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedEnvironmentsRoute = ProtectedEnvironmentsRouteImport.update({
  id: '/environments',
  path: '/environments',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedDlqRoute = ProtectedDlqRouteImport.update({
  id: '/dlq',
  path: '/dlq',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedDashboardRoute = ProtectedDashboardRouteImport.update({
  id: '/dashboard',
  path: '/dashboard',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedConnectSettingsRoute =
  ProtectedConnectSettingsRouteImport.update({
    id: '/connect-settings',
    path: '/connect-settings',
    getParentRoute: () => ProtectedRoute,
  } as any)
const ProtectedApprovalsRoute = ProtectedApprovalsRouteImport.update({
  id: '/approvals',
  path: '/approvals',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedApprovalPoliciesRoute =
  ProtectedApprovalPoliciesRouteImport.update({
    id: '/approval-policies',
    path: '/approval-policies',
    getParentRoute: () => ProtectedRoute,
  } as any)
const ProtectedAnalyticsRoute = ProtectedAnalyticsRouteImport.update({
  id: '/analytics',
  path: '/analytics',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedAgentsRoute = ProtectedAgentsRouteImport.update({
  id: '/agents',
  path: '/agents',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedActionsRoute = ProtectedActionsRouteImport.update({
  id: '/actions',
  path: '/actions',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedSplatRoute = ProtectedSplatRouteImport.update({
  id: '/$',
  path: '/$',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedSettingsRouteRoute = ProtectedSettingsRouteRouteImport.update({
  id: '/settings',
  path: '/settings',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedUsersIndexRoute = ProtectedUsersIndexRouteImport.update({
  id: '/users/',
  path: '/users/',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedSignOffsIndexRoute = ProtectedSignOffsIndexRouteImport.update({
  id: '/sign-offs/',
  path: '/sign-offs/',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedSettingsIndexRoute = ProtectedSettingsIndexRouteImport.update({
  id: '/',
  path: '/',
  getParentRoute: () => ProtectedSettingsRouteRoute,
} as any)
const ProtectedMcpServersIndexRoute =
  ProtectedMcpServersIndexRouteImport.update({
    id: '/',
    path: '/',
    getParentRoute: () => ProtectedMcpServersRoute,
  } as any)
const ProtectedIntegrationsIndexRoute =
  ProtectedIntegrationsIndexRouteImport.update({
    id: '/integrations/',
    path: '/integrations/',
    getParentRoute: () => ProtectedRoute,
  } as any)
const ProtectedFunctionsIndexRoute = ProtectedFunctionsIndexRouteImport.update({
  id: '/',
  path: '/',
  getParentRoute: () => ProtectedFunctionsRoute,
} as any)
const ProtectedEventsIndexRoute = ProtectedEventsIndexRouteImport.update({
  id: '/',
  path: '/',
  getParentRoute: () => ProtectedEventsRoute,
} as any)
const ProtectedEndUsersIndexRoute = ProtectedEndUsersIndexRouteImport.update({
  id: '/end-users/',
  path: '/end-users/',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedActionsIndexRoute = ProtectedActionsIndexRouteImport.update({
  id: '/',
  path: '/',
  getParentRoute: () => ProtectedActionsRoute,
} as any)
const ProtectedUsersEndUserIdRoute = ProtectedUsersEndUserIdRouteImport.update({
  id: '/users/$endUserId',
  path: '/users/$endUserId',
  getParentRoute: () => ProtectedRoute,
} as any)
const ProtectedSignOffsSignOffIdRoute =
  ProtectedSignOffsSignOffIdRouteImport.update({
    id: '/sign-offs/$signOffId',
    path: '/sign-offs/$signOffId',
    getParentRoute: () => ProtectedRoute,
  } as any)
const ProtectedSettingsWebhooksRoute =
  ProtectedSettingsWebhooksRouteImport.update({
    id: '/webhooks',
    path: '/webhooks',
    getParentRoute: () => ProtectedSettingsRouteRoute,
  } as any)
const ProtectedSettingsUsageRoute = ProtectedSettingsUsageRouteImport.update({
  id: '/usage',
  path: '/usage',
  getParentRoute: () => ProtectedSettingsRouteRoute,
} as any)
const ProtectedSettingsTeamRoute = ProtectedSettingsTeamRouteImport.update({
  id: '/team',
  path: '/team',
  getParentRoute: () => ProtectedSettingsRouteRoute,
} as any)
const ProtectedSettingsSsoRoute = ProtectedSettingsSsoRouteImport.update({
  id: '/sso',
  path: '/sso',
  getParentRoute: () => ProtectedSettingsRouteRoute,
} as any)
const ProtectedSettingsSecurityRoute =
  ProtectedSettingsSecurityRouteImport.update({
    id: '/security',
    path: '/security',
    getParentRoute: () => ProtectedSettingsRouteRoute,
  } as any)
const ProtectedSettingsScimRoute = ProtectedSettingsScimRouteImport.update({
  id: '/scim',
  path: '/scim',
  getParentRoute: () => ProtectedSettingsRouteRoute,
} as any)
const ProtectedSettingsProfileRoute =
  ProtectedSettingsProfileRouteImport.update({
    id: '/profile',
    path: '/profile',
    getParentRoute: () => ProtectedSettingsRouteRoute,
  } as any)
const ProtectedSettingsNotificationsRoute =
  ProtectedSettingsNotificationsRouteImport.update({
    id: '/notifications',
    path: '/notifications',
    getParentRoute: () => ProtectedSettingsRouteRoute,
  } as any)
const ProtectedSettingsIntegrationsRoute =
  ProtectedSettingsIntegrationsRouteImport.update({
    id: '/integrations',
    path: '/integrations',
    getParentRoute: () => ProtectedSettingsRouteRoute,
  } as any)
const ProtectedSettingsInstanceRoute =
  ProtectedSettingsInstanceRouteImport.update({
    id: '/instance',
    path: '/instance',
    getParentRoute: () => ProtectedSettingsRouteRoute,
  } as any)
const ProtectedSettingsGeneralRoute =
  ProtectedSettingsGeneralRouteImport.update({
    id: '/general',
    path: '/general',
    getParentRoute: () => ProtectedSettingsRouteRoute,
  } as any)
const ProtectedSettingsDefaultsRoute =
  ProtectedSettingsDefaultsRouteImport.update({
    id: '/defaults',
    path: '/defaults',
    getParentRoute: () => ProtectedSettingsRouteRoute,
  } as any)
const ProtectedSettingsConnectionsRoute =
  ProtectedSettingsConnectionsRouteImport.update({
    id: '/connections',
    path: '/connections',
    getParentRoute: () => ProtectedSettingsRouteRoute,
  } as any)
const ProtectedSettingsConnectedAppsRoute =
  ProtectedSettingsConnectedAppsRouteImport.update({
    id: '/connected-apps',
    path: '/connected-apps',
    getParentRoute: () => ProtectedSettingsRouteRoute,
  } as any)
const ProtectedSettingsAuditRoute = ProtectedSettingsAuditRouteImport.update({
  id: '/audit',
  path: '/audit',
  getParentRoute: () => ProtectedSettingsRouteRoute,
} as any)
const ProtectedSettingsAssistantRoute =
  ProtectedSettingsAssistantRouteImport.update({
    id: '/assistant',
    path: '/assistant',
    getParentRoute: () => ProtectedSettingsRouteRoute,
  } as any)
const ProtectedSettingsApiKeysRoute =
  ProtectedSettingsApiKeysRouteImport.update({
    id: '/api-keys',
    path: '/api-keys',
    getParentRoute: () => ProtectedSettingsRouteRoute,
  } as any)
const ProtectedSettingsSplatRoute = ProtectedSettingsSplatRouteImport.update({
  id: '/$',
  path: '/$',
  getParentRoute: () => ProtectedSettingsRouteRoute,
} as any)
const ProtectedMcpServersNewRoute = ProtectedMcpServersNewRouteImport.update({
  id: '/new',
  path: '/new',
  getParentRoute: () => ProtectedMcpServersRoute,
} as any)
const ProtectedMcpServersNameRoute = ProtectedMcpServersNameRouteImport.update({
  id: '/$name',
  path: '/$name',
  getParentRoute: () => ProtectedMcpServersRoute,
} as any)
const ProtectedIntegrationsSettingsRoute =
  ProtectedIntegrationsSettingsRouteImport.update({
    id: '/integrations/settings',
    path: '/integrations/settings',
    getParentRoute: () => ProtectedRoute,
  } as any)
const ProtectedFunctionsNameRoute = ProtectedFunctionsNameRouteImport.update({
  id: '/$name',
  path: '/$name',
  getParentRoute: () => ProtectedFunctionsRoute,
} as any)
const ProtectedEventsRecentRoute = ProtectedEventsRecentRouteImport.update({
  id: '/recent',
  path: '/recent',
  getParentRoute: () => ProtectedEventsRoute,
} as any)
const ProtectedEndUsersEndUserIdRoute =
  ProtectedEndUsersEndUserIdRouteImport.update({
    id: '/end-users/$endUserId',
    path: '/end-users/$endUserId',
    getParentRoute: () => ProtectedRoute,
  } as any)
const ProtectedActionsSecretsRoute = ProtectedActionsSecretsRouteImport.update({
  id: '/secrets',
  path: '/secrets',
  getParentRoute: () => ProtectedActionsRoute,
} as any)
const ProtectedActionsLimitsRoute = ProtectedActionsLimitsRouteImport.update({
  id: '/limits',
  path: '/limits',
  getParentRoute: () => ProtectedActionsRoute,
} as any)
const ProtectedActionsInvocationsRoute =
  ProtectedActionsInvocationsRouteImport.update({
    id: '/invocations',
    path: '/invocations',
    getParentRoute: () => ProtectedActionsRoute,
  } as any)
const ProtectedActionsEffectsRoute = ProtectedActionsEffectsRouteImport.update({
  id: '/effects',
  path: '/effects',
  getParentRoute: () => ProtectedActionsRoute,
} as any)
const ProtectedActionsConnectionsRoute =
  ProtectedActionsConnectionsRouteImport.update({
    id: '/connections',
    path: '/connections',
    getParentRoute: () => ProtectedActionsRoute,
  } as any)
const ProtectedFunctionsRunsRunIdRoute =
  ProtectedFunctionsRunsRunIdRouteImport.update({
    id: '/runs/$runId',
    path: '/runs/$runId',
    getParentRoute: () => ProtectedFunctionsRoute,
  } as any)

export interface FileRoutesByFullPath {
  '/': typeof IndexRoute
  '/setup': typeof SetupRoute
  '/settings': typeof ProtectedSettingsRouteRouteWithChildren
  '/$': typeof ProtectedSplatRoute
  '/actions': typeof ProtectedActionsRouteWithChildren
  '/agents': typeof ProtectedAgentsRoute
  '/analytics': typeof ProtectedAnalyticsRoute
  '/approval-policies': typeof ProtectedApprovalPoliciesRoute
  '/approvals': typeof ProtectedApprovalsRoute
  '/connect-settings': typeof ProtectedConnectSettingsRoute
  '/dashboard': typeof ProtectedDashboardRoute
  '/dlq': typeof ProtectedDlqRoute
  '/environments': typeof ProtectedEnvironmentsRoute
  '/events': typeof ProtectedEventsRouteWithChildren
  '/functions': typeof ProtectedFunctionsRouteWithChildren
  '/get-started': typeof ProtectedGetStartedRoute
  '/logs-explorer': typeof ProtectedLogsExplorerRoute
  '/mcp-servers': typeof ProtectedMcpServersRouteWithChildren
  '/recent-runs': typeof ProtectedRecentRunsRoute
  '/team': typeof ProtectedTeamRoute
  '/usage': typeof ProtectedUsageRoute
  '/auth/forgot-password': typeof AuthForgotPasswordRoute
  '/auth/login': typeof AuthLoginRoute
  '/auth/reset-password': typeof AuthResetPasswordRoute
  '/auth/signup': typeof AuthSignupRoute
  '/auth/two-factor': typeof AuthTwoFactorRoute
  '/auth/verify-email': typeof AuthVerifyEmailRoute
  '/invite/$token': typeof InviteTokenRoute
  '/oauth/consent': typeof OauthConsentRoute
  '/oauth/workspace': typeof OauthWorkspaceRoute
  '/workspaces/new': typeof WorkspacesNewRoute
  '/workspaces/select': typeof WorkspacesSelectRoute
  '/workspaces/setup': typeof WorkspacesSetupRoute
  '/actions/connections': typeof ProtectedActionsConnectionsRoute
  '/actions/effects': typeof ProtectedActionsEffectsRoute
  '/actions/invocations': typeof ProtectedActionsInvocationsRoute
  '/actions/limits': typeof ProtectedActionsLimitsRoute
  '/actions/secrets': typeof ProtectedActionsSecretsRoute
  '/end-users/$endUserId': typeof ProtectedEndUsersEndUserIdRoute
  '/events/recent': typeof ProtectedEventsRecentRoute
  '/functions/$name': typeof ProtectedFunctionsNameRoute
  '/integrations/settings': typeof ProtectedIntegrationsSettingsRoute
  '/mcp-servers/$name': typeof ProtectedMcpServersNameRoute
  '/mcp-servers/new': typeof ProtectedMcpServersNewRoute
  '/settings/$': typeof ProtectedSettingsSplatRoute
  '/settings/api-keys': typeof ProtectedSettingsApiKeysRoute
  '/settings/assistant': typeof ProtectedSettingsAssistantRoute
  '/settings/audit': typeof ProtectedSettingsAuditRoute
  '/settings/connected-apps': typeof ProtectedSettingsConnectedAppsRoute
  '/settings/connections': typeof ProtectedSettingsConnectionsRoute
  '/settings/defaults': typeof ProtectedSettingsDefaultsRoute
  '/settings/general': typeof ProtectedSettingsGeneralRoute
  '/settings/instance': typeof ProtectedSettingsInstanceRoute
  '/settings/integrations': typeof ProtectedSettingsIntegrationsRoute
  '/settings/notifications': typeof ProtectedSettingsNotificationsRoute
  '/settings/profile': typeof ProtectedSettingsProfileRoute
  '/settings/scim': typeof ProtectedSettingsScimRoute
  '/settings/security': typeof ProtectedSettingsSecurityRoute
  '/settings/sso': typeof ProtectedSettingsSsoRoute
  '/settings/team': typeof ProtectedSettingsTeamRoute
  '/settings/usage': typeof ProtectedSettingsUsageRoute
  '/settings/webhooks': typeof ProtectedSettingsWebhooksRoute
  '/sign-offs/$signOffId': typeof ProtectedSignOffsSignOffIdRoute
  '/users/$endUserId': typeof ProtectedUsersEndUserIdRoute
  '/actions/': typeof ProtectedActionsIndexRoute
  '/end-users/': typeof ProtectedEndUsersIndexRoute
  '/events/': typeof ProtectedEventsIndexRoute
  '/functions/': typeof ProtectedFunctionsIndexRoute
  '/integrations/': typeof ProtectedIntegrationsIndexRoute
  '/mcp-servers/': typeof ProtectedMcpServersIndexRoute
  '/settings/': typeof ProtectedSettingsIndexRoute
  '/sign-offs/': typeof ProtectedSignOffsIndexRoute
  '/users/': typeof ProtectedUsersIndexRoute
  '/functions/runs/$runId': typeof ProtectedFunctionsRunsRunIdRoute
}
export interface FileRoutesByTo {
  '/': typeof IndexRoute
  '/setup': typeof SetupRoute
  '/$': typeof ProtectedSplatRoute
  '/agents': typeof ProtectedAgentsRoute
  '/analytics': typeof ProtectedAnalyticsRoute
  '/approval-policies': typeof ProtectedApprovalPoliciesRoute
  '/approvals': typeof ProtectedApprovalsRoute
  '/connect-settings': typeof ProtectedConnectSettingsRoute
  '/dashboard': typeof ProtectedDashboardRoute
  '/dlq': typeof ProtectedDlqRoute
  '/environments': typeof ProtectedEnvironmentsRoute
  '/get-started': typeof ProtectedGetStartedRoute
  '/logs-explorer': typeof ProtectedLogsExplorerRoute
  '/recent-runs': typeof ProtectedRecentRunsRoute
  '/team': typeof ProtectedTeamRoute
  '/usage': typeof ProtectedUsageRoute
  '/auth/forgot-password': typeof AuthForgotPasswordRoute
  '/auth/login': typeof AuthLoginRoute
  '/auth/reset-password': typeof AuthResetPasswordRoute
  '/auth/signup': typeof AuthSignupRoute
  '/auth/two-factor': typeof AuthTwoFactorRoute
  '/auth/verify-email': typeof AuthVerifyEmailRoute
  '/invite/$token': typeof InviteTokenRoute
  '/oauth/consent': typeof OauthConsentRoute
  '/oauth/workspace': typeof OauthWorkspaceRoute
  '/workspaces/new': typeof WorkspacesNewRoute
  '/workspaces/select': typeof WorkspacesSelectRoute
  '/workspaces/setup': typeof WorkspacesSetupRoute
  '/actions/connections': typeof ProtectedActionsConnectionsRoute
  '/actions/effects': typeof ProtectedActionsEffectsRoute
  '/actions/invocations': typeof ProtectedActionsInvocationsRoute
  '/actions/limits': typeof ProtectedActionsLimitsRoute
  '/actions/secrets': typeof ProtectedActionsSecretsRoute
  '/end-users/$endUserId': typeof ProtectedEndUsersEndUserIdRoute
  '/events/recent': typeof ProtectedEventsRecentRoute
  '/functions/$name': typeof ProtectedFunctionsNameRoute
  '/integrations/settings': typeof ProtectedIntegrationsSettingsRoute
  '/mcp-servers/$name': typeof ProtectedMcpServersNameRoute
  '/mcp-servers/new': typeof ProtectedMcpServersNewRoute
  '/settings/$': typeof ProtectedSettingsSplatRoute
  '/settings/api-keys': typeof ProtectedSettingsApiKeysRoute
  '/settings/assistant': typeof ProtectedSettingsAssistantRoute
  '/settings/audit': typeof ProtectedSettingsAuditRoute
  '/settings/connected-apps': typeof ProtectedSettingsConnectedAppsRoute
  '/settings/connections': typeof ProtectedSettingsConnectionsRoute
  '/settings/defaults': typeof ProtectedSettingsDefaultsRoute
  '/settings/general': typeof ProtectedSettingsGeneralRoute
  '/settings/instance': typeof ProtectedSettingsInstanceRoute
  '/settings/integrations': typeof ProtectedSettingsIntegrationsRoute
  '/settings/notifications': typeof ProtectedSettingsNotificationsRoute
  '/settings/profile': typeof ProtectedSettingsProfileRoute
  '/settings/scim': typeof ProtectedSettingsScimRoute
  '/settings/security': typeof ProtectedSettingsSecurityRoute
  '/settings/sso': typeof ProtectedSettingsSsoRoute
  '/settings/team': typeof ProtectedSettingsTeamRoute
  '/settings/usage': typeof ProtectedSettingsUsageRoute
  '/settings/webhooks': typeof ProtectedSettingsWebhooksRoute
  '/sign-offs/$signOffId': typeof ProtectedSignOffsSignOffIdRoute
  '/users/$endUserId': typeof ProtectedUsersEndUserIdRoute
  '/actions': typeof ProtectedActionsIndexRoute
  '/end-users': typeof ProtectedEndUsersIndexRoute
  '/events': typeof ProtectedEventsIndexRoute
  '/functions': typeof ProtectedFunctionsIndexRoute
  '/integrations': typeof ProtectedIntegrationsIndexRoute
  '/mcp-servers': typeof ProtectedMcpServersIndexRoute
  '/settings': typeof ProtectedSettingsIndexRoute
  '/sign-offs': typeof ProtectedSignOffsIndexRoute
  '/users': typeof ProtectedUsersIndexRoute
  '/functions/runs/$runId': typeof ProtectedFunctionsRunsRunIdRoute
}
export interface FileRoutesById {
  __root__: typeof rootRouteImport
  '/': typeof IndexRoute
  '/_protected': typeof ProtectedRouteWithChildren
  '/setup': typeof SetupRoute
  '/_protected/settings': typeof ProtectedSettingsRouteRouteWithChildren
  '/_protected/$': typeof ProtectedSplatRoute
  '/_protected/actions': typeof ProtectedActionsRouteWithChildren
  '/_protected/agents': typeof ProtectedAgentsRoute
  '/_protected/analytics': typeof ProtectedAnalyticsRoute
  '/_protected/approval-policies': typeof ProtectedApprovalPoliciesRoute
  '/_protected/approvals': typeof ProtectedApprovalsRoute
  '/_protected/connect-settings': typeof ProtectedConnectSettingsRoute
  '/_protected/dashboard': typeof ProtectedDashboardRoute
  '/_protected/dlq': typeof ProtectedDlqRoute
  '/_protected/environments': typeof ProtectedEnvironmentsRoute
  '/_protected/events': typeof ProtectedEventsRouteWithChildren
  '/_protected/functions': typeof ProtectedFunctionsRouteWithChildren
  '/_protected/get-started': typeof ProtectedGetStartedRoute
  '/_protected/logs-explorer': typeof ProtectedLogsExplorerRoute
  '/_protected/mcp-servers': typeof ProtectedMcpServersRouteWithChildren
  '/_protected/recent-runs': typeof ProtectedRecentRunsRoute
  '/_protected/team': typeof ProtectedTeamRoute
  '/_protected/usage': typeof ProtectedUsageRoute
  '/auth/forgot-password': typeof AuthForgotPasswordRoute
  '/auth/login': typeof AuthLoginRoute
  '/auth/reset-password': typeof AuthResetPasswordRoute
  '/auth/signup': typeof AuthSignupRoute
  '/auth/two-factor': typeof AuthTwoFactorRoute
  '/auth/verify-email': typeof AuthVerifyEmailRoute
  '/invite/$token': typeof InviteTokenRoute
  '/oauth/consent': typeof OauthConsentRoute
  '/oauth/workspace': typeof OauthWorkspaceRoute
  '/workspaces/new': typeof WorkspacesNewRoute
  '/workspaces/select': typeof WorkspacesSelectRoute
  '/workspaces/setup': typeof WorkspacesSetupRoute
  '/_protected/actions/connections': typeof ProtectedActionsConnectionsRoute
  '/_protected/actions/effects': typeof ProtectedActionsEffectsRoute
  '/_protected/actions/invocations': typeof ProtectedActionsInvocationsRoute
  '/_protected/actions/limits': typeof ProtectedActionsLimitsRoute
  '/_protected/actions/secrets': typeof ProtectedActionsSecretsRoute
  '/_protected/end-users/$endUserId': typeof ProtectedEndUsersEndUserIdRoute
  '/_protected/events/recent': typeof ProtectedEventsRecentRoute
  '/_protected/functions/$name': typeof ProtectedFunctionsNameRoute
  '/_protected/integrations/settings': typeof ProtectedIntegrationsSettingsRoute
  '/_protected/mcp-servers/$name': typeof ProtectedMcpServersNameRoute
  '/_protected/mcp-servers/new': typeof ProtectedMcpServersNewRoute
  '/_protected/settings/$': typeof ProtectedSettingsSplatRoute
  '/_protected/settings/api-keys': typeof ProtectedSettingsApiKeysRoute
  '/_protected/settings/assistant': typeof ProtectedSettingsAssistantRoute
  '/_protected/settings/audit': typeof ProtectedSettingsAuditRoute
  '/_protected/settings/connected-apps': typeof ProtectedSettingsConnectedAppsRoute
  '/_protected/settings/connections': typeof ProtectedSettingsConnectionsRoute
  '/_protected/settings/defaults': typeof ProtectedSettingsDefaultsRoute
  '/_protected/settings/general': typeof ProtectedSettingsGeneralRoute
  '/_protected/settings/instance': typeof ProtectedSettingsInstanceRoute
  '/_protected/settings/integrations': typeof ProtectedSettingsIntegrationsRoute
  '/_protected/settings/notifications': typeof ProtectedSettingsNotificationsRoute
  '/_protected/settings/profile': typeof ProtectedSettingsProfileRoute
  '/_protected/settings/scim': typeof ProtectedSettingsScimRoute
  '/_protected/settings/security': typeof ProtectedSettingsSecurityRoute
  '/_protected/settings/sso': typeof ProtectedSettingsSsoRoute
  '/_protected/settings/team': typeof ProtectedSettingsTeamRoute
  '/_protected/settings/usage': typeof ProtectedSettingsUsageRoute
  '/_protected/settings/webhooks': typeof ProtectedSettingsWebhooksRoute
  '/_protected/sign-offs/$signOffId': typeof ProtectedSignOffsSignOffIdRoute
  '/_protected/users/$endUserId': typeof ProtectedUsersEndUserIdRoute
  '/_protected/actions/': typeof ProtectedActionsIndexRoute
  '/_protected/end-users/': typeof ProtectedEndUsersIndexRoute
  '/_protected/events/': typeof ProtectedEventsIndexRoute
  '/_protected/functions/': typeof ProtectedFunctionsIndexRoute
  '/_protected/integrations/': typeof ProtectedIntegrationsIndexRoute
  '/_protected/mcp-servers/': typeof ProtectedMcpServersIndexRoute
  '/_protected/settings/': typeof ProtectedSettingsIndexRoute
  '/_protected/sign-offs/': typeof ProtectedSignOffsIndexRoute
  '/_protected/users/': typeof ProtectedUsersIndexRoute
  '/_protected/functions/runs/$runId': typeof ProtectedFunctionsRunsRunIdRoute
}
export interface FileRouteTypes {
  fileRoutesByFullPath: FileRoutesByFullPath
  fullPaths:
    | '/'
    | '/setup'
    | '/settings'
    | '/$'
    | '/actions'
    | '/agents'
    | '/analytics'
    | '/approval-policies'
    | '/approvals'
    | '/connect-settings'
    | '/dashboard'
    | '/dlq'
    | '/environments'
    | '/events'
    | '/functions'
    | '/get-started'
    | '/logs-explorer'
    | '/mcp-servers'
    | '/recent-runs'
    | '/team'
    | '/usage'
    | '/auth/forgot-password'
    | '/auth/login'
    | '/auth/reset-password'
    | '/auth/signup'
    | '/auth/two-factor'
    | '/auth/verify-email'
    | '/invite/$token'
    | '/oauth/consent'
    | '/oauth/workspace'
    | '/workspaces/new'
    | '/workspaces/select'
    | '/workspaces/setup'
    | '/actions/connections'
    | '/actions/effects'
    | '/actions/invocations'
    | '/actions/limits'
    | '/actions/secrets'
    | '/end-users/$endUserId'
    | '/events/recent'
    | '/functions/$name'
    | '/integrations/settings'
    | '/mcp-servers/$name'
    | '/mcp-servers/new'
    | '/settings/$'
    | '/settings/api-keys'
    | '/settings/assistant'
    | '/settings/audit'
    | '/settings/connected-apps'
    | '/settings/connections'
    | '/settings/defaults'
    | '/settings/general'
    | '/settings/instance'
    | '/settings/integrations'
    | '/settings/notifications'
    | '/settings/profile'
    | '/settings/scim'
    | '/settings/security'
    | '/settings/sso'
    | '/settings/team'
    | '/settings/usage'
    | '/settings/webhooks'
    | '/sign-offs/$signOffId'
    | '/users/$endUserId'
    | '/actions/'
    | '/end-users/'
    | '/events/'
    | '/functions/'
    | '/integrations/'
    | '/mcp-servers/'
    | '/settings/'
    | '/sign-offs/'
    | '/users/'
    | '/functions/runs/$runId'
  fileRoutesByTo: FileRoutesByTo
  to:
    | '/'
    | '/setup'
    | '/$'
    | '/agents'
    | '/analytics'
    | '/approval-policies'
    | '/approvals'
    | '/connect-settings'
    | '/dashboard'
    | '/dlq'
    | '/environments'
    | '/get-started'
    | '/logs-explorer'
    | '/recent-runs'
    | '/team'
    | '/usage'
    | '/auth/forgot-password'
    | '/auth/login'
    | '/auth/reset-password'
    | '/auth/signup'
    | '/auth/two-factor'
    | '/auth/verify-email'
    | '/invite/$token'
    | '/oauth/consent'
    | '/oauth/workspace'
    | '/workspaces/new'
    | '/workspaces/select'
    | '/workspaces/setup'
    | '/actions/connections'
    | '/actions/effects'
    | '/actions/invocations'
    | '/actions/limits'
    | '/actions/secrets'
    | '/end-users/$endUserId'
    | '/events/recent'
    | '/functions/$name'
    | '/integrations/settings'
    | '/mcp-servers/$name'
    | '/mcp-servers/new'
    | '/settings/$'
    | '/settings/api-keys'
    | '/settings/assistant'
    | '/settings/audit'
    | '/settings/connected-apps'
    | '/settings/connections'
    | '/settings/defaults'
    | '/settings/general'
    | '/settings/instance'
    | '/settings/integrations'
    | '/settings/notifications'
    | '/settings/profile'
    | '/settings/scim'
    | '/settings/security'
    | '/settings/sso'
    | '/settings/team'
    | '/settings/usage'
    | '/settings/webhooks'
    | '/sign-offs/$signOffId'
    | '/users/$endUserId'
    | '/actions'
    | '/end-users'
    | '/events'
    | '/functions'
    | '/integrations'
    | '/mcp-servers'
    | '/settings'
    | '/sign-offs'
    | '/users'
    | '/functions/runs/$runId'
  id:
    | '__root__'
    | '/'
    | '/_protected'
    | '/setup'
    | '/_protected/settings'
    | '/_protected/$'
    | '/_protected/actions'
    | '/_protected/agents'
    | '/_protected/analytics'
    | '/_protected/approval-policies'
    | '/_protected/approvals'
    | '/_protected/connect-settings'
    | '/_protected/dashboard'
    | '/_protected/dlq'
    | '/_protected/environments'
    | '/_protected/events'
    | '/_protected/functions'
    | '/_protected/get-started'
    | '/_protected/logs-explorer'
    | '/_protected/mcp-servers'
    | '/_protected/recent-runs'
    | '/_protected/team'
    | '/_protected/usage'
    | '/auth/forgot-password'
    | '/auth/login'
    | '/auth/reset-password'
    | '/auth/signup'
    | '/auth/two-factor'
    | '/auth/verify-email'
    | '/invite/$token'
    | '/oauth/consent'
    | '/oauth/workspace'
    | '/workspaces/new'
    | '/workspaces/select'
    | '/workspaces/setup'
    | '/_protected/actions/connections'
    | '/_protected/actions/effects'
    | '/_protected/actions/invocations'
    | '/_protected/actions/limits'
    | '/_protected/actions/secrets'
    | '/_protected/end-users/$endUserId'
    | '/_protected/events/recent'
    | '/_protected/functions/$name'
    | '/_protected/integrations/settings'
    | '/_protected/mcp-servers/$name'
    | '/_protected/mcp-servers/new'
    | '/_protected/settings/$'
    | '/_protected/settings/api-keys'
    | '/_protected/settings/assistant'
    | '/_protected/settings/audit'
    | '/_protected/settings/connected-apps'
    | '/_protected/settings/connections'
    | '/_protected/settings/defaults'
    | '/_protected/settings/general'
    | '/_protected/settings/instance'
    | '/_protected/settings/integrations'
    | '/_protected/settings/notifications'
    | '/_protected/settings/profile'
    | '/_protected/settings/scim'
    | '/_protected/settings/security'
    | '/_protected/settings/sso'
    | '/_protected/settings/team'
    | '/_protected/settings/usage'
    | '/_protected/settings/webhooks'
    | '/_protected/sign-offs/$signOffId'
    | '/_protected/users/$endUserId'
    | '/_protected/actions/'
    | '/_protected/end-users/'
    | '/_protected/events/'
    | '/_protected/functions/'
    | '/_protected/integrations/'
    | '/_protected/mcp-servers/'
    | '/_protected/settings/'
    | '/_protected/sign-offs/'
    | '/_protected/users/'
    | '/_protected/functions/runs/$runId'
  fileRoutesById: FileRoutesById
}
export interface RootRouteChildren {
  IndexRoute: typeof IndexRoute
  ProtectedRoute: typeof ProtectedRouteWithChildren
  SetupRoute: typeof SetupRoute
  AuthForgotPasswordRoute: typeof AuthForgotPasswordRoute
  AuthLoginRoute: typeof AuthLoginRoute
  AuthResetPasswordRoute: typeof AuthResetPasswordRoute
  AuthSignupRoute: typeof AuthSignupRoute
  AuthTwoFactorRoute: typeof AuthTwoFactorRoute
  AuthVerifyEmailRoute: typeof AuthVerifyEmailRoute
  InviteTokenRoute: typeof InviteTokenRoute
  OauthConsentRoute: typeof OauthConsentRoute
  OauthWorkspaceRoute: typeof OauthWorkspaceRoute
  WorkspacesNewRoute: typeof WorkspacesNewRoute
  WorkspacesSelectRoute: typeof WorkspacesSelectRoute
  WorkspacesSetupRoute: typeof WorkspacesSetupRoute
}

declare module '@tanstack/react-router' {
  interface FileRoutesByPath {
    '/setup': {
      id: '/setup'
      path: '/setup'
      fullPath: '/setup'
      preLoaderRoute: typeof SetupRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/_protected': {
      id: '/_protected'
      path: ''
      fullPath: '/'
      preLoaderRoute: typeof ProtectedRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/': {
      id: '/'
      path: '/'
      fullPath: '/'
      preLoaderRoute: typeof IndexRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/workspaces/setup': {
      id: '/workspaces/setup'
      path: '/workspaces/setup'
      fullPath: '/workspaces/setup'
      preLoaderRoute: typeof WorkspacesSetupRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/workspaces/select': {
      id: '/workspaces/select'
      path: '/workspaces/select'
      fullPath: '/workspaces/select'
      preLoaderRoute: typeof WorkspacesSelectRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/workspaces/new': {
      id: '/workspaces/new'
      path: '/workspaces/new'
      fullPath: '/workspaces/new'
      preLoaderRoute: typeof WorkspacesNewRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/oauth/workspace': {
      id: '/oauth/workspace'
      path: '/oauth/workspace'
      fullPath: '/oauth/workspace'
      preLoaderRoute: typeof OauthWorkspaceRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/oauth/consent': {
      id: '/oauth/consent'
      path: '/oauth/consent'
      fullPath: '/oauth/consent'
      preLoaderRoute: typeof OauthConsentRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/invite/$token': {
      id: '/invite/$token'
      path: '/invite/$token'
      fullPath: '/invite/$token'
      preLoaderRoute: typeof InviteTokenRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/auth/verify-email': {
      id: '/auth/verify-email'
      path: '/auth/verify-email'
      fullPath: '/auth/verify-email'
      preLoaderRoute: typeof AuthVerifyEmailRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/auth/two-factor': {
      id: '/auth/two-factor'
      path: '/auth/two-factor'
      fullPath: '/auth/two-factor'
      preLoaderRoute: typeof AuthTwoFactorRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/auth/signup': {
      id: '/auth/signup'
      path: '/auth/signup'
      fullPath: '/auth/signup'
      preLoaderRoute: typeof AuthSignupRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/auth/reset-password': {
      id: '/auth/reset-password'
      path: '/auth/reset-password'
      fullPath: '/auth/reset-password'
      preLoaderRoute: typeof AuthResetPasswordRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/auth/login': {
      id: '/auth/login'
      path: '/auth/login'
      fullPath: '/auth/login'
      preLoaderRoute: typeof AuthLoginRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/auth/forgot-password': {
      id: '/auth/forgot-password'
      path: '/auth/forgot-password'
      fullPath: '/auth/forgot-password'
      preLoaderRoute: typeof AuthForgotPasswordRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/_protected/usage': {
      id: '/_protected/usage'
      path: '/usage'
      fullPath: '/usage'
      preLoaderRoute: typeof ProtectedUsageRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/team': {
      id: '/_protected/team'
      path: '/team'
      fullPath: '/team'
      preLoaderRoute: typeof ProtectedTeamRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/recent-runs': {
      id: '/_protected/recent-runs'
      path: '/recent-runs'
      fullPath: '/recent-runs'
      preLoaderRoute: typeof ProtectedRecentRunsRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/mcp-servers': {
      id: '/_protected/mcp-servers'
      path: '/mcp-servers'
      fullPath: '/mcp-servers'
      preLoaderRoute: typeof ProtectedMcpServersRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/logs-explorer': {
      id: '/_protected/logs-explorer'
      path: '/logs-explorer'
      fullPath: '/logs-explorer'
      preLoaderRoute: typeof ProtectedLogsExplorerRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/get-started': {
      id: '/_protected/get-started'
      path: '/get-started'
      fullPath: '/get-started'
      preLoaderRoute: typeof ProtectedGetStartedRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/functions': {
      id: '/_protected/functions'
      path: '/functions'
      fullPath: '/functions'
      preLoaderRoute: typeof ProtectedFunctionsRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/events': {
      id: '/_protected/events'
      path: '/events'
      fullPath: '/events'
      preLoaderRoute: typeof ProtectedEventsRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/environments': {
      id: '/_protected/environments'
      path: '/environments'
      fullPath: '/environments'
      preLoaderRoute: typeof ProtectedEnvironmentsRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/dlq': {
      id: '/_protected/dlq'
      path: '/dlq'
      fullPath: '/dlq'
      preLoaderRoute: typeof ProtectedDlqRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/dashboard': {
      id: '/_protected/dashboard'
      path: '/dashboard'
      fullPath: '/dashboard'
      preLoaderRoute: typeof ProtectedDashboardRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/connect-settings': {
      id: '/_protected/connect-settings'
      path: '/connect-settings'
      fullPath: '/connect-settings'
      preLoaderRoute: typeof ProtectedConnectSettingsRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/approvals': {
      id: '/_protected/approvals'
      path: '/approvals'
      fullPath: '/approvals'
      preLoaderRoute: typeof ProtectedApprovalsRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/approval-policies': {
      id: '/_protected/approval-policies'
      path: '/approval-policies'
      fullPath: '/approval-policies'
      preLoaderRoute: typeof ProtectedApprovalPoliciesRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/analytics': {
      id: '/_protected/analytics'
      path: '/analytics'
      fullPath: '/analytics'
      preLoaderRoute: typeof ProtectedAnalyticsRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/agents': {
      id: '/_protected/agents'
      path: '/agents'
      fullPath: '/agents'
      preLoaderRoute: typeof ProtectedAgentsRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/actions': {
      id: '/_protected/actions'
      path: '/actions'
      fullPath: '/actions'
      preLoaderRoute: typeof ProtectedActionsRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/$': {
      id: '/_protected/$'
      path: '/$'
      fullPath: '/$'
      preLoaderRoute: typeof ProtectedSplatRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/settings': {
      id: '/_protected/settings'
      path: '/settings'
      fullPath: '/settings'
      preLoaderRoute: typeof ProtectedSettingsRouteRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/users/': {
      id: '/_protected/users/'
      path: '/users'
      fullPath: '/users/'
      preLoaderRoute: typeof ProtectedUsersIndexRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/sign-offs/': {
      id: '/_protected/sign-offs/'
      path: '/sign-offs'
      fullPath: '/sign-offs/'
      preLoaderRoute: typeof ProtectedSignOffsIndexRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/settings/': {
      id: '/_protected/settings/'
      path: '/'
      fullPath: '/settings/'
      preLoaderRoute: typeof ProtectedSettingsIndexRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/mcp-servers/': {
      id: '/_protected/mcp-servers/'
      path: '/'
      fullPath: '/mcp-servers/'
      preLoaderRoute: typeof ProtectedMcpServersIndexRouteImport
      parentRoute: typeof ProtectedMcpServersRoute
    }
    '/_protected/integrations/': {
      id: '/_protected/integrations/'
      path: '/integrations'
      fullPath: '/integrations/'
      preLoaderRoute: typeof ProtectedIntegrationsIndexRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/functions/': {
      id: '/_protected/functions/'
      path: '/'
      fullPath: '/functions/'
      preLoaderRoute: typeof ProtectedFunctionsIndexRouteImport
      parentRoute: typeof ProtectedFunctionsRoute
    }
    '/_protected/events/': {
      id: '/_protected/events/'
      path: '/'
      fullPath: '/events/'
      preLoaderRoute: typeof ProtectedEventsIndexRouteImport
      parentRoute: typeof ProtectedEventsRoute
    }
    '/_protected/end-users/': {
      id: '/_protected/end-users/'
      path: '/end-users'
      fullPath: '/end-users/'
      preLoaderRoute: typeof ProtectedEndUsersIndexRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/actions/': {
      id: '/_protected/actions/'
      path: '/'
      fullPath: '/actions/'
      preLoaderRoute: typeof ProtectedActionsIndexRouteImport
      parentRoute: typeof ProtectedActionsRoute
    }
    '/_protected/users/$endUserId': {
      id: '/_protected/users/$endUserId'
      path: '/users/$endUserId'
      fullPath: '/users/$endUserId'
      preLoaderRoute: typeof ProtectedUsersEndUserIdRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/sign-offs/$signOffId': {
      id: '/_protected/sign-offs/$signOffId'
      path: '/sign-offs/$signOffId'
      fullPath: '/sign-offs/$signOffId'
      preLoaderRoute: typeof ProtectedSignOffsSignOffIdRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/settings/webhooks': {
      id: '/_protected/settings/webhooks'
      path: '/webhooks'
      fullPath: '/settings/webhooks'
      preLoaderRoute: typeof ProtectedSettingsWebhooksRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/usage': {
      id: '/_protected/settings/usage'
      path: '/usage'
      fullPath: '/settings/usage'
      preLoaderRoute: typeof ProtectedSettingsUsageRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/team': {
      id: '/_protected/settings/team'
      path: '/team'
      fullPath: '/settings/team'
      preLoaderRoute: typeof ProtectedSettingsTeamRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/sso': {
      id: '/_protected/settings/sso'
      path: '/sso'
      fullPath: '/settings/sso'
      preLoaderRoute: typeof ProtectedSettingsSsoRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/security': {
      id: '/_protected/settings/security'
      path: '/security'
      fullPath: '/settings/security'
      preLoaderRoute: typeof ProtectedSettingsSecurityRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/scim': {
      id: '/_protected/settings/scim'
      path: '/scim'
      fullPath: '/settings/scim'
      preLoaderRoute: typeof ProtectedSettingsScimRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/profile': {
      id: '/_protected/settings/profile'
      path: '/profile'
      fullPath: '/settings/profile'
      preLoaderRoute: typeof ProtectedSettingsProfileRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/notifications': {
      id: '/_protected/settings/notifications'
      path: '/notifications'
      fullPath: '/settings/notifications'
      preLoaderRoute: typeof ProtectedSettingsNotificationsRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/integrations': {
      id: '/_protected/settings/integrations'
      path: '/integrations'
      fullPath: '/settings/integrations'
      preLoaderRoute: typeof ProtectedSettingsIntegrationsRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/instance': {
      id: '/_protected/settings/instance'
      path: '/instance'
      fullPath: '/settings/instance'
      preLoaderRoute: typeof ProtectedSettingsInstanceRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/general': {
      id: '/_protected/settings/general'
      path: '/general'
      fullPath: '/settings/general'
      preLoaderRoute: typeof ProtectedSettingsGeneralRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/defaults': {
      id: '/_protected/settings/defaults'
      path: '/defaults'
      fullPath: '/settings/defaults'
      preLoaderRoute: typeof ProtectedSettingsDefaultsRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/connections': {
      id: '/_protected/settings/connections'
      path: '/connections'
      fullPath: '/settings/connections'
      preLoaderRoute: typeof ProtectedSettingsConnectionsRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/connected-apps': {
      id: '/_protected/settings/connected-apps'
      path: '/connected-apps'
      fullPath: '/settings/connected-apps'
      preLoaderRoute: typeof ProtectedSettingsConnectedAppsRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/audit': {
      id: '/_protected/settings/audit'
      path: '/audit'
      fullPath: '/settings/audit'
      preLoaderRoute: typeof ProtectedSettingsAuditRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/assistant': {
      id: '/_protected/settings/assistant'
      path: '/assistant'
      fullPath: '/settings/assistant'
      preLoaderRoute: typeof ProtectedSettingsAssistantRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/api-keys': {
      id: '/_protected/settings/api-keys'
      path: '/api-keys'
      fullPath: '/settings/api-keys'
      preLoaderRoute: typeof ProtectedSettingsApiKeysRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/settings/$': {
      id: '/_protected/settings/$'
      path: '/$'
      fullPath: '/settings/$'
      preLoaderRoute: typeof ProtectedSettingsSplatRouteImport
      parentRoute: typeof ProtectedSettingsRouteRoute
    }
    '/_protected/mcp-servers/new': {
      id: '/_protected/mcp-servers/new'
      path: '/new'
      fullPath: '/mcp-servers/new'
      preLoaderRoute: typeof ProtectedMcpServersNewRouteImport
      parentRoute: typeof ProtectedMcpServersRoute
    }
    '/_protected/mcp-servers/$name': {
      id: '/_protected/mcp-servers/$name'
      path: '/$name'
      fullPath: '/mcp-servers/$name'
      preLoaderRoute: typeof ProtectedMcpServersNameRouteImport
      parentRoute: typeof ProtectedMcpServersRoute
    }
    '/_protected/integrations/settings': {
      id: '/_protected/integrations/settings'
      path: '/integrations/settings'
      fullPath: '/integrations/settings'
      preLoaderRoute: typeof ProtectedIntegrationsSettingsRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/functions/$name': {
      id: '/_protected/functions/$name'
      path: '/$name'
      fullPath: '/functions/$name'
      preLoaderRoute: typeof ProtectedFunctionsNameRouteImport
      parentRoute: typeof ProtectedFunctionsRoute
    }
    '/_protected/events/recent': {
      id: '/_protected/events/recent'
      path: '/recent'
      fullPath: '/events/recent'
      preLoaderRoute: typeof ProtectedEventsRecentRouteImport
      parentRoute: typeof ProtectedEventsRoute
    }
    '/_protected/end-users/$endUserId': {
      id: '/_protected/end-users/$endUserId'
      path: '/end-users/$endUserId'
      fullPath: '/end-users/$endUserId'
      preLoaderRoute: typeof ProtectedEndUsersEndUserIdRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/actions/secrets': {
      id: '/_protected/actions/secrets'
      path: '/secrets'
      fullPath: '/actions/secrets'
      preLoaderRoute: typeof ProtectedActionsSecretsRouteImport
      parentRoute: typeof ProtectedActionsRoute
    }
    '/_protected/actions/limits': {
      id: '/_protected/actions/limits'
      path: '/limits'
      fullPath: '/actions/limits'
      preLoaderRoute: typeof ProtectedActionsLimitsRouteImport
      parentRoute: typeof ProtectedActionsRoute
    }
    '/_protected/actions/invocations': {
      id: '/_protected/actions/invocations'
      path: '/invocations'
      fullPath: '/actions/invocations'
      preLoaderRoute: typeof ProtectedActionsInvocationsRouteImport
      parentRoute: typeof ProtectedActionsRoute
    }
    '/_protected/actions/effects': {
      id: '/_protected/actions/effects'
      path: '/effects'
      fullPath: '/actions/effects'
      preLoaderRoute: typeof ProtectedActionsEffectsRouteImport
      parentRoute: typeof ProtectedActionsRoute
    }
    '/_protected/actions/connections': {
      id: '/_protected/actions/connections'
      path: '/connections'
      fullPath: '/actions/connections'
      preLoaderRoute: typeof ProtectedActionsConnectionsRouteImport
      parentRoute: typeof ProtectedActionsRoute
    }
    '/_protected/functions/runs/$runId': {
      id: '/_protected/functions/runs/$runId'
      path: '/runs/$runId'
      fullPath: '/functions/runs/$runId'
      preLoaderRoute: typeof ProtectedFunctionsRunsRunIdRouteImport
      parentRoute: typeof ProtectedFunctionsRoute
    }
  }
}

interface ProtectedSettingsRouteRouteChildren {
  ProtectedSettingsSplatRoute: typeof ProtectedSettingsSplatRoute
  ProtectedSettingsApiKeysRoute: typeof ProtectedSettingsApiKeysRoute
  ProtectedSettingsAssistantRoute: typeof ProtectedSettingsAssistantRoute
  ProtectedSettingsAuditRoute: typeof ProtectedSettingsAuditRoute
  ProtectedSettingsConnectedAppsRoute: typeof ProtectedSettingsConnectedAppsRoute
  ProtectedSettingsConnectionsRoute: typeof ProtectedSettingsConnectionsRoute
  ProtectedSettingsDefaultsRoute: typeof ProtectedSettingsDefaultsRoute
  ProtectedSettingsGeneralRoute: typeof ProtectedSettingsGeneralRoute
  ProtectedSettingsInstanceRoute: typeof ProtectedSettingsInstanceRoute
  ProtectedSettingsIntegrationsRoute: typeof ProtectedSettingsIntegrationsRoute
  ProtectedSettingsNotificationsRoute: typeof ProtectedSettingsNotificationsRoute
  ProtectedSettingsProfileRoute: typeof ProtectedSettingsProfileRoute
  ProtectedSettingsScimRoute: typeof ProtectedSettingsScimRoute
  ProtectedSettingsSecurityRoute: typeof ProtectedSettingsSecurityRoute
  ProtectedSettingsSsoRoute: typeof ProtectedSettingsSsoRoute
  ProtectedSettingsTeamRoute: typeof ProtectedSettingsTeamRoute
  ProtectedSettingsUsageRoute: typeof ProtectedSettingsUsageRoute
  ProtectedSettingsWebhooksRoute: typeof ProtectedSettingsWebhooksRoute
  ProtectedSettingsIndexRoute: typeof ProtectedSettingsIndexRoute
}

const ProtectedSettingsRouteRouteChildren: ProtectedSettingsRouteRouteChildren =
  {
    ProtectedSettingsSplatRoute: ProtectedSettingsSplatRoute,
    ProtectedSettingsApiKeysRoute: ProtectedSettingsApiKeysRoute,
    ProtectedSettingsAssistantRoute: ProtectedSettingsAssistantRoute,
    ProtectedSettingsAuditRoute: ProtectedSettingsAuditRoute,
    ProtectedSettingsConnectedAppsRoute: ProtectedSettingsConnectedAppsRoute,
    ProtectedSettingsConnectionsRoute: ProtectedSettingsConnectionsRoute,
    ProtectedSettingsDefaultsRoute: ProtectedSettingsDefaultsRoute,
    ProtectedSettingsGeneralRoute: ProtectedSettingsGeneralRoute,
    ProtectedSettingsInstanceRoute: ProtectedSettingsInstanceRoute,
    ProtectedSettingsIntegrationsRoute: ProtectedSettingsIntegrationsRoute,
    ProtectedSettingsNotificationsRoute: ProtectedSettingsNotificationsRoute,
    ProtectedSettingsProfileRoute: ProtectedSettingsProfileRoute,
    ProtectedSettingsScimRoute: ProtectedSettingsScimRoute,
    ProtectedSettingsSecurityRoute: ProtectedSettingsSecurityRoute,
    ProtectedSettingsSsoRoute: ProtectedSettingsSsoRoute,
    ProtectedSettingsTeamRoute: ProtectedSettingsTeamRoute,
    ProtectedSettingsUsageRoute: ProtectedSettingsUsageRoute,
    ProtectedSettingsWebhooksRoute: ProtectedSettingsWebhooksRoute,
    ProtectedSettingsIndexRoute: ProtectedSettingsIndexRoute,
  }

const ProtectedSettingsRouteRouteWithChildren =
  ProtectedSettingsRouteRoute._addFileChildren(
    ProtectedSettingsRouteRouteChildren,
  )

interface ProtectedActionsRouteChildren {
  ProtectedActionsConnectionsRoute: typeof ProtectedActionsConnectionsRoute
  ProtectedActionsEffectsRoute: typeof ProtectedActionsEffectsRoute
  ProtectedActionsInvocationsRoute: typeof ProtectedActionsInvocationsRoute
  ProtectedActionsLimitsRoute: typeof ProtectedActionsLimitsRoute
  ProtectedActionsSecretsRoute: typeof ProtectedActionsSecretsRoute
  ProtectedActionsIndexRoute: typeof ProtectedActionsIndexRoute
}

const ProtectedActionsRouteChildren: ProtectedActionsRouteChildren = {
  ProtectedActionsConnectionsRoute: ProtectedActionsConnectionsRoute,
  ProtectedActionsEffectsRoute: ProtectedActionsEffectsRoute,
  ProtectedActionsInvocationsRoute: ProtectedActionsInvocationsRoute,
  ProtectedActionsLimitsRoute: ProtectedActionsLimitsRoute,
  ProtectedActionsSecretsRoute: ProtectedActionsSecretsRoute,
  ProtectedActionsIndexRoute: ProtectedActionsIndexRoute,
}

const ProtectedActionsRouteWithChildren =
  ProtectedActionsRoute._addFileChildren(ProtectedActionsRouteChildren)

interface ProtectedEventsRouteChildren {
  ProtectedEventsRecentRoute: typeof ProtectedEventsRecentRoute
  ProtectedEventsIndexRoute: typeof ProtectedEventsIndexRoute
}

const ProtectedEventsRouteChildren: ProtectedEventsRouteChildren = {
  ProtectedEventsRecentRoute: ProtectedEventsRecentRoute,
  ProtectedEventsIndexRoute: ProtectedEventsIndexRoute,
}

const ProtectedEventsRouteWithChildren = ProtectedEventsRoute._addFileChildren(
  ProtectedEventsRouteChildren,
)

interface ProtectedFunctionsRouteChildren {
  ProtectedFunctionsNameRoute: typeof ProtectedFunctionsNameRoute
  ProtectedFunctionsIndexRoute: typeof ProtectedFunctionsIndexRoute
  ProtectedFunctionsRunsRunIdRoute: typeof ProtectedFunctionsRunsRunIdRoute
}

const ProtectedFunctionsRouteChildren: ProtectedFunctionsRouteChildren = {
  ProtectedFunctionsNameRoute: ProtectedFunctionsNameRoute,
  ProtectedFunctionsIndexRoute: ProtectedFunctionsIndexRoute,
  ProtectedFunctionsRunsRunIdRoute: ProtectedFunctionsRunsRunIdRoute,
}

const ProtectedFunctionsRouteWithChildren =
  ProtectedFunctionsRoute._addFileChildren(ProtectedFunctionsRouteChildren)

interface ProtectedMcpServersRouteChildren {
  ProtectedMcpServersNameRoute: typeof ProtectedMcpServersNameRoute
  ProtectedMcpServersNewRoute: typeof ProtectedMcpServersNewRoute
  ProtectedMcpServersIndexRoute: typeof ProtectedMcpServersIndexRoute
}

const ProtectedMcpServersRouteChildren: ProtectedMcpServersRouteChildren = {
  ProtectedMcpServersNameRoute: ProtectedMcpServersNameRoute,
  ProtectedMcpServersNewRoute: ProtectedMcpServersNewRoute,
  ProtectedMcpServersIndexRoute: ProtectedMcpServersIndexRoute,
}

const ProtectedMcpServersRouteWithChildren =
  ProtectedMcpServersRoute._addFileChildren(ProtectedMcpServersRouteChildren)

interface ProtectedRouteChildren {
  ProtectedSettingsRouteRoute: typeof ProtectedSettingsRouteRouteWithChildren
  ProtectedSplatRoute: typeof ProtectedSplatRoute
  ProtectedActionsRoute: typeof ProtectedActionsRouteWithChildren
  ProtectedAgentsRoute: typeof ProtectedAgentsRoute
  ProtectedAnalyticsRoute: typeof ProtectedAnalyticsRoute
  ProtectedApprovalPoliciesRoute: typeof ProtectedApprovalPoliciesRoute
  ProtectedApprovalsRoute: typeof ProtectedApprovalsRoute
  ProtectedConnectSettingsRoute: typeof ProtectedConnectSettingsRoute
  ProtectedDashboardRoute: typeof ProtectedDashboardRoute
  ProtectedDlqRoute: typeof ProtectedDlqRoute
  ProtectedEnvironmentsRoute: typeof ProtectedEnvironmentsRoute
  ProtectedEventsRoute: typeof ProtectedEventsRouteWithChildren
  ProtectedFunctionsRoute: typeof ProtectedFunctionsRouteWithChildren
  ProtectedGetStartedRoute: typeof ProtectedGetStartedRoute
  ProtectedLogsExplorerRoute: typeof ProtectedLogsExplorerRoute
  ProtectedMcpServersRoute: typeof ProtectedMcpServersRouteWithChildren
  ProtectedRecentRunsRoute: typeof ProtectedRecentRunsRoute
  ProtectedTeamRoute: typeof ProtectedTeamRoute
  ProtectedUsageRoute: typeof ProtectedUsageRoute
  ProtectedEndUsersEndUserIdRoute: typeof ProtectedEndUsersEndUserIdRoute
  ProtectedIntegrationsSettingsRoute: typeof ProtectedIntegrationsSettingsRoute
  ProtectedSignOffsSignOffIdRoute: typeof ProtectedSignOffsSignOffIdRoute
  ProtectedUsersEndUserIdRoute: typeof ProtectedUsersEndUserIdRoute
  ProtectedEndUsersIndexRoute: typeof ProtectedEndUsersIndexRoute
  ProtectedIntegrationsIndexRoute: typeof ProtectedIntegrationsIndexRoute
  ProtectedSignOffsIndexRoute: typeof ProtectedSignOffsIndexRoute
  ProtectedUsersIndexRoute: typeof ProtectedUsersIndexRoute
}

const ProtectedRouteChildren: ProtectedRouteChildren = {
  ProtectedSettingsRouteRoute: ProtectedSettingsRouteRouteWithChildren,
  ProtectedSplatRoute: ProtectedSplatRoute,
  ProtectedActionsRoute: ProtectedActionsRouteWithChildren,
  ProtectedAgentsRoute: ProtectedAgentsRoute,
  ProtectedAnalyticsRoute: ProtectedAnalyticsRoute,
  ProtectedApprovalPoliciesRoute: ProtectedApprovalPoliciesRoute,
  ProtectedApprovalsRoute: ProtectedApprovalsRoute,
  ProtectedConnectSettingsRoute: ProtectedConnectSettingsRoute,
  ProtectedDashboardRoute: ProtectedDashboardRoute,
  ProtectedDlqRoute: ProtectedDlqRoute,
  ProtectedEnvironmentsRoute: ProtectedEnvironmentsRoute,
  ProtectedEventsRoute: ProtectedEventsRouteWithChildren,
  ProtectedFunctionsRoute: ProtectedFunctionsRouteWithChildren,
  ProtectedGetStartedRoute: ProtectedGetStartedRoute,
  ProtectedLogsExplorerRoute: ProtectedLogsExplorerRoute,
  ProtectedMcpServersRoute: ProtectedMcpServersRouteWithChildren,
  ProtectedRecentRunsRoute: ProtectedRecentRunsRoute,
  ProtectedTeamRoute: ProtectedTeamRoute,
  ProtectedUsageRoute: ProtectedUsageRoute,
  ProtectedEndUsersEndUserIdRoute: ProtectedEndUsersEndUserIdRoute,
  ProtectedIntegrationsSettingsRoute: ProtectedIntegrationsSettingsRoute,
  ProtectedSignOffsSignOffIdRoute: ProtectedSignOffsSignOffIdRoute,
  ProtectedUsersEndUserIdRoute: ProtectedUsersEndUserIdRoute,
  ProtectedEndUsersIndexRoute: ProtectedEndUsersIndexRoute,
  ProtectedIntegrationsIndexRoute: ProtectedIntegrationsIndexRoute,
  ProtectedSignOffsIndexRoute: ProtectedSignOffsIndexRoute,
  ProtectedUsersIndexRoute: ProtectedUsersIndexRoute,
}

const ProtectedRouteWithChildren = ProtectedRoute._addFileChildren(
  ProtectedRouteChildren,
)

const rootRouteChildren: RootRouteChildren = {
  IndexRoute: IndexRoute,
  ProtectedRoute: ProtectedRouteWithChildren,
  SetupRoute: SetupRoute,
  AuthForgotPasswordRoute: AuthForgotPasswordRoute,
  AuthLoginRoute: AuthLoginRoute,
  AuthResetPasswordRoute: AuthResetPasswordRoute,
  AuthSignupRoute: AuthSignupRoute,
  AuthTwoFactorRoute: AuthTwoFactorRoute,
  AuthVerifyEmailRoute: AuthVerifyEmailRoute,
  InviteTokenRoute: InviteTokenRoute,
  OauthConsentRoute: OauthConsentRoute,
  OauthWorkspaceRoute: OauthWorkspaceRoute,
  WorkspacesNewRoute: WorkspacesNewRoute,
  WorkspacesSelectRoute: WorkspacesSelectRoute,
  WorkspacesSetupRoute: WorkspacesSetupRoute,
}
export const routeTree = rootRouteImport
  ._addFileChildren(rootRouteChildren)
  ._addFileTypes<FileRouteTypes>()
