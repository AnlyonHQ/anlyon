/**
 * @anlyonhq/react: prebuilt components and hooks that let your end users approve what your agent
 * wants to do, and connect their own accounts, inside your app. Beta: the API may change before 1.0.
 *
 * Wrap them in `<AnlyonProvider getToken>`; mint the token on your server with
 * `createSessionHandler` from `@anlyonhq/react/server`. Styles: `import '@anlyonhq/react/styles.css'`.
 */

export { AnlyonProvider, useAnlyon } from './provider';
export type { AnlyonProviderProps, ConnectMode, ConnectOptions } from './provider';

export { ApprovalInbox } from './components/approval-inbox';
export type { ApprovalInboxProps } from './components/approval-inbox';
export { ApprovalPrompt } from './components/approval-prompt';
export type { ApprovalPromptProps } from './components/approval-prompt';
export { ConnectButton } from './components/connect-button';
export type { ConnectButtonProps } from './components/connect-button';
export { Connections } from './components/connections';
export type { ConnectionsProps } from './components/connections';
export { ConnectPrompt } from './components/connect-prompt';
export type { ConnectPromptProps } from './components/connect-prompt';
export type { StyleProps } from './components/shared';

export { useApprovals, useApproval } from './hooks/use-approvals';
export type {
  ApprovalItem,
  ApprovalState,
  Decision,
  UseApprovalResult,
  UseApprovalsOptions,
  UseApprovalsResult,
} from './hooks/use-approvals';
export { useConnections, useConnect } from './hooks/use-connections';
export type {
  ConnectPhase,
  ConnectState,
  UseConnectOptions,
  UseConnectResult,
  UseConnectionsResult,
} from './hooks/use-connections';

export { AnlyonUIError } from './core/client';
export type { SessionTokenResult } from './core/token';
export { approvalHeadline, formatImpact, formatMoney } from './core/format';
export { isConnectRequiredResult } from './core/types';
export type {
  Approval,
  ApprovalDecision,
  ApprovalPreview,
  ApprovalStatus,
  ConnectLink,
  ConnectRequiredResult,
  Connection,
  ConnectionStatus,
  ImpactQuantity,
  PreviewBlock,
} from './core/types';
