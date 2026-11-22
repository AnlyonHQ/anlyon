import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { approvalHeadline, formatExpiry, formatImpact, formatValue } from '../core/format';
import type { Approval } from '../core/types';
import { useAnlyon } from '../provider';
import { useApprovals, type ApprovalItem, type Decision, type UseApprovalsOptions } from '../hooks/use-approvals';
import { useNow } from '../hooks/shared';
import { ApprovalOutcome, ApprovalWhat, DecisionBar, STATE_LABEL } from './approval-detail';
import { AlertIcon, ChevronIcon, LiveRegion, SkeletonRows, rootClass, useAnnouncer, type StyleProps } from './shared';

export interface ApprovalInboxProps extends StyleProps, UseApprovalsOptions {
  /** The heading. Default `Approvals`; null hides the header. */
  title?: ReactNode;
  /**
   * Each row's headline, in your app's words, e.g.
   * `(a) => (a.actionName === 'send-invoice' ? 'Send the invoice' : undefined)`.
   * Return undefined to keep the default, the action's name in words. Text is also what assistive tech announces.
   */
  approvalTitle?: (approval: Approval) => ReactNode | undefined;
  /** Shown when nothing waits for an answer. */
  empty?: ReactNode;
  /** Called after each answer lands. */
  onDecided?: (decision: Decision, approval: Approval) => void;
}

/** A short line under the headline: the target account, or the first plain values of the request. */
function summaryOf(approval: Approval, locale?: string): string {
  const parts: string[] = [];
  const money = approval.preview?.impact.find((q) => q.dimension === 'money');
  if (approval.preview?.target.account) parts.push(approval.preview.target.account);
  for (const value of Object.values(approval.input ?? {})) {
    if (parts.length >= 2) break;
    const text = formatValue(value);
    if (text && !text.includes('\n') && !parts.some((part) => part.includes(text) || text.includes(part))) parts.push(text);
  }
  if (money) parts.push(formatImpact(money, locale));
  if (parts.length === 0 && approval.description) parts.push(approval.description);
  return parts.join(' · ');
}

function Row({
  item,
  open,
  onToggle,
  onDecide,
  now,
  locale,
  title,
}: {
  item: ApprovalItem;
  open: boolean;
  onToggle: () => void;
  onDecide: (decision: Decision, reason?: string) => Promise<void>;
  now: number;
  locale?: string;
  /** The app's headline for this row, from `approvalTitle`. */
  title?: ReactNode;
}) {
  const bodyId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const headline = rowLabel(item.approval, title);
  const summary = summaryOf(item.approval, locale);
  const waiting = item.state === 'pending' || item.state === 'deciding' || item.state === 'failed';

  return (
    <li className="anlyon-approval" data-state={item.state} data-open={open || undefined}>
      <button
        ref={toggleRef}
        type="button"
        className="anlyon-approval-row"
        data-anlyon-row=""
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <span className="anlyon-dot" data-state={item.state} aria-hidden="true" />
        <span className="anlyon-approval-text">
          <span className="anlyon-approval-headline">{title ?? headline}</span>
          {summary ? <span className="anlyon-approval-summary">{summary}</span> : null}
        </span>
        <span className="anlyon-approval-meta">
          {waiting ? (
            <span className="anlyon-expiry" data-soon={Date.parse(item.approval.expiresAt) - now < 5 * 60_000 || undefined}>
              {formatExpiry(item.approval.expiresAt, now)}
            </span>
          ) : (
            <span className="anlyon-badge" data-state={item.state}>
              {STATE_LABEL[item.state]}
            </span>
          )}
          <ChevronIcon className="anlyon-icon anlyon-chevron" />
        </span>
      </button>
      <div className="anlyon-approval-body" id={bodyId} role="region" aria-label={headline} hidden={!open}>
        {open ? (
          <>
            <ApprovalWhat approval={item.approval} locale={locale} />
            {waiting ? (
              <DecisionBar
                item={item}
                now={now}
                label={headline}
                onDecide={async (decision, reason) => {
                  await onDecide(decision, reason);
                  toggleRef.current?.focus();
                }}
              />
            ) : (
              <ApprovalOutcome item={item} now={now} />
            )}
          </>
        ) : null}
      </div>
    </li>
  );
}

/** The row's name for assistive tech: the app's title when it is text, otherwise the action's name in words. */
function rowLabel(approval: Approval, title: ReactNode | undefined): string {
  return typeof title === 'string' && title.trim() ? title : approvalHeadline(approval);
}

/** Up, Down, Home and End move between rows. */
function moveFocus(event: KeyboardEvent<HTMLUListElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const target = event.target as HTMLElement;
  if (!target.matches('[data-anlyon-row]')) return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-anlyon-row]'));
  const index = rows.indexOf(target as HTMLButtonElement);
  const next =
    event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : event.key === 'ArrowDown' ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1);
  event.preventDefault();
  rows[next]?.focus();
}

/** Every approval waiting for the end user, newest first. Each row opens to what the agent wants. */
export function ApprovalInbox({ status, limit, title = 'Approvals', approvalTitle, empty, onDecided, className, unstyled }: ApprovalInboxProps) {
  const { locale } = useAnlyon();
  const { items, pendingCount, loading, error, refresh, decide } = useApprovals({ status, limit });
  const now = useNow();
  const headingId = useId();
  const [message, announce] = useAnnouncer();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const opened = useRef(false);

  useEffect(() => {
    if (opened.current || loading) return;
    const first = items.find((i) => i.state === 'pending');
    if (first) setOpen((o) => ({ ...o, [first.approval.id]: true }));
    opened.current = true;
  }, [items, loading]);

  const root = rootClass('anlyon-inbox', { className, unstyled });

  let body: ReactNode;
  if (loading) {
    body = <SkeletonRows />;
  } else if (error && items.length === 0) {
    body = (
      <div className="anlyon-message" role="alert">
        <AlertIcon />
        <div>
          <p className="anlyon-message-title">Couldn't load approvals</p>
          <p className="anlyon-muted">{error.message}</p>
        </div>
        <button type="button" className="anlyon-button" data-variant="secondary" data-size="sm" onClick={() => void refresh()}>
          Try again
        </button>
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <div className="anlyon-empty">
        {empty ?? (
          <>
            <p className="anlyon-empty-title">Nothing to approve</p>
            <p className="anlyon-muted">When an agent asks before it acts for you, it shows up here.</p>
          </>
        )}
      </div>
    );
  } else {
    body = (
      <ul className="anlyon-list" onKeyDown={moveFocus}>
        {items.map((item) => (
          <Row
            key={item.approval.id}
            item={item}
            title={approvalTitle?.(item.approval) ?? undefined}
            now={now}
            locale={locale}
            open={open[item.approval.id] ?? false}
            onToggle={() => setOpen((o) => ({ ...o, [item.approval.id]: !o[item.approval.id] }))}
            onDecide={async (decision, reason) => {
              const headline = rowLabel(item.approval, approvalTitle?.(item.approval) ?? undefined);
              const decided = await decide(item.approval.id, decision, reason);
              announce(decided ? `${decision === 'approve' ? 'Approved' : 'Declined'}: ${headline}` : `Your answer did not count: ${headline}`);
              if (decided) onDecided?.(decision, decided);
            }}
          />
        ))}
      </ul>
    );
  }

  return (
    <section className={root} aria-labelledby={title === null ? undefined : headingId} aria-label={title === null ? 'Approvals' : undefined} aria-busy={loading || undefined}>
      {title === null ? null : (
        <header className="anlyon-header">
          <h2 className="anlyon-title" id={headingId}>
            {title}
          </h2>
          {pendingCount > 0 ? (
            <span className="anlyon-count">
              {pendingCount}
              <span className="anlyon-sr-only"> waiting</span>
            </span>
          ) : null}
          {error && items.length > 0 ? (
            <span className="anlyon-stale" role="status" title={error.message}>
              <AlertIcon /> Not up to date
            </span>
          ) : null}
        </header>
      )}
      {body}
      <LiveRegion message={message} />
    </section>
  );
}
