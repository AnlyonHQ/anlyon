import { useId, useRef, type ReactNode } from 'react';
import { approvalHeadline, formatAgo, formatDateTime } from '../core/format';
import { useAnlyon } from '../provider';
import { useApproval, type Decision } from '../hooks/use-approvals';
import type { Approval } from '../core/types';
import { useNow } from '../hooks/shared';
import { ApprovalOutcome, ApprovalWhat, DecisionBar, STATE_LABEL } from './approval-detail';
import { AlertIcon, LiveRegion, rootClass, useAnnouncer, type StyleProps } from './shared';

export interface ApprovalPromptProps extends StyleProps {
  /** The approval to show, e.g. the `approvalId` a tool result carries. */
  approvalId: string;
  /** Replaces the headline, which by default is the action's name in words. */
  title?: ReactNode;
  /** Called after the end user's answer lands. */
  onDecided?: (decision: Decision, approval: Approval) => void;
}

/** One approval, inline: what the agent wants, and Approve or Decline. */
export function ApprovalPrompt({ approvalId, title, onDecided, className, unstyled }: ApprovalPromptProps) {
  const { locale } = useAnlyon();
  const { item, loading, error, refresh, decide } = useApproval(approvalId);
  const now = useNow();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [message, announce] = useAnnouncer();
  const root = rootClass('anlyon-approval-prompt', { className, unstyled });

  if (!item) {
    if (loading) {
      return (
        <div className={root} data-state="loading" aria-busy="true">
          <div className="anlyon-prompt-head">
            <span className="anlyon-skeleton" data-size="title" />
          </div>
          <div className="anlyon-prompt-body">
            <span className="anlyon-skeleton" data-size="line" />
            <span className="anlyon-skeleton" data-size="line" />
          </div>
          <span className="anlyon-sr-only">Loading approval</span>
        </div>
      );
    }
    const missing = error?.code === 'APPROVAL_NOT_FOUND' || error?.status === 404;
    return (
      <div className={root} data-state="error">
        <div className="anlyon-message" role="alert">
          <AlertIcon />
          <div>
            <p className="anlyon-message-title">{missing ? 'This approval is not available' : "Couldn't load this approval"}</p>
            <p className="anlyon-muted">{missing ? 'It may be for someone else, or the link is old.' : error?.message}</p>
          </div>
          {!missing ? (
            <button type="button" className="anlyon-button" data-variant="secondary" data-size="sm" onClick={() => void refresh()}>
              Try again
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const headline = typeof title === 'string' && title.trim() ? title : approvalHeadline(item.approval);
  const decided = item.state === 'approved' || item.state === 'declined' || item.state === 'expired';

  return (
    <section className={root} data-state={item.state} aria-labelledby={headingId}>
      <header className="anlyon-prompt-head">
        <div className="anlyon-prompt-heading">
          <h3 className="anlyon-prompt-title" id={headingId} ref={headingRef} tabIndex={-1}>
            {title ?? headline}
          </h3>
          <p className="anlyon-muted" title={formatDateTime(item.approval.createdAt, locale)}>
            Asked {formatAgo(item.approval.createdAt, now)}
          </p>
        </div>
        <span className="anlyon-badge" data-state={item.state}>
          {STATE_LABEL[item.state]}
        </span>
      </header>
      <div className="anlyon-prompt-body">
        <ApprovalWhat approval={item.approval} locale={locale} />
      </div>
      <footer className="anlyon-prompt-foot">
        {decided ? (
          <ApprovalOutcome item={item} now={now} />
        ) : (
          <DecisionBar
            item={item}
            now={now}
            label={headline}
            onDecide={async (decision, reason) => {
              const decided = await decide(decision, reason);
              announce(decided ? `${decision === 'approve' ? 'Approved' : 'Declined'}: ${headline}` : `Your answer did not count: ${headline}`);
              if (decided) headingRef.current?.focus();
              if (decided) onDecided?.(decision, decided);
            }}
          />
        )}
      </footer>
      <LiveRegion message={message} />
    </section>
  );
}
