import { useId, useRef, useState, type ReactNode } from 'react';
import { lineDiff } from '../core/diff';
import { formatAgo, formatDateTime, formatExpiry, formatImpact, formatValue, humanizeKey } from '../core/format';
import type { Approval, ImpactQuantity, PreviewBlock } from '../core/types';
import type { ApprovalItem, Decision } from '../hooks/use-approvals';
import { AlertIcon, CheckIcon, ClockIcon, Spinner, XIcon } from './shared';

/** A long value shows this much until "Show all". */
const CLAMP_CHARS = 280;
const CLAMP_LINES = 6;

function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  const long = text.length > CLAMP_CHARS || lines.length > CLAMP_LINES;
  if (!long) return <span className="anlyon-value-text">{text}</span>;
  const short = lines.slice(0, CLAMP_LINES).join('\n').slice(0, CLAMP_CHARS).trimEnd();
  return (
    <span className="anlyon-value-text">
      {open ? text : `${short}…`}{' '}
      <button type="button" className="anlyon-link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Show less' : 'Show all'}
      </button>
    </span>
  );
}

function Value({ value }: { value: unknown }) {
  const text = formatValue(value);
  if (text === null) return <pre className="anlyon-code">{JSON.stringify(value, null, 2)}</pre>;
  if (text === '') return <span className="anlyon-value-empty">Empty</span>;
  return <LongText text={text} />;
}

/** Label and value rows. */
function Fields({ rows }: { rows: Array<{ label: string; value: unknown }> }) {
  return (
    <dl className="anlyon-fields">
      {rows.map((row, index) => (
        <div className="anlyon-field" key={`${row.label}-${index}`}>
          <dt className="anlyon-field-label">{row.label}</dt>
          <dd className="anlyon-field-value">
            <Value value={row.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="anlyon-section" aria-labelledby={id}>
      <h4 className="anlyon-section-title" id={id}>
        {title}
      </h4>
      {children}
    </section>
  );
}

function Diff({ block }: { block: Extract<PreviewBlock, { type: 'text_diff' }> }) {
  const lines = lineDiff(block.before, block.after);
  return (
    <div className="anlyon-diff-wrap">
      <div className="anlyon-diff-path">{block.path}</div>
      {lines ? (
        <pre className="anlyon-diff" aria-label={`Changes to ${block.path}`}>
          {lines.map((line, index) =>
            line.kind === 'gap' ? (
              <span key={index} className="anlyon-diff-line" data-kind="gap">
                {`⋯ ${line.count} unchanged ${line.count === 1 ? 'line' : 'lines'}`}
              </span>
            ) : (
              <span key={index} className="anlyon-diff-line" data-kind={line.kind}>
                <span className="anlyon-diff-sign" aria-hidden="true">
                  {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                </span>
                {line.kind !== 'same' ? <span className="anlyon-sr-only">{line.kind === 'add' ? 'Added: ' : 'Removed: '}</span> : null}
                {line.text || ' '}
              </span>
            ),
          )}
        </pre>
      ) : (
        <Fields rows={[{ label: 'Before', value: block.before }, { label: 'After', value: block.after }]} />
      )}
      {block.truncated ? <p className="anlyon-muted">The preview is cut short.</p> : null}
    </div>
  );
}

function Impact({ quantities, locale }: { quantities: ImpactQuantity[]; locale?: string }) {
  return (
    <ul className="anlyon-chips">
      {quantities.map((q, index) => (
        <li key={index} className="anlyon-chip" data-dimension={q.dimension}>
          {formatImpact(q, locale)}
        </li>
      ))}
    </ul>
  );
}

const LIMITATION_LABEL: Record<string, string> = {
  irreversible: "Can't be undone",
  unsupported: 'Not supported',
  guarantee: 'Guarantee',
  freshness: 'Freshness',
};

function Block({ block, locale }: { block: PreviewBlock; locale?: string }) {
  switch (block.type) {
    case 'fields':
      return (
        <Section title={block.title}>
          <Fields rows={block.fields} />
        </Section>
      );
    case 'text_diff':
      return (
        <Section title={block.title}>
          <Diff block={block} />
        </Section>
      );
    case 'impact':
      return (
        <Section title={block.title}>
          <Impact quantities={block.quantities} locale={locale} />
        </Section>
      );
    case 'limitations':
      return (
        <Section title={block.title}>
          <ul className="anlyon-limitations">
            {block.items.map((item, index) => (
              <li key={index} className="anlyon-limitation" data-kind={item.kind}>
                <span className="anlyon-limitation-kind">{LIMITATION_LABEL[item.kind] ?? humanizeKey(item.kind)}</span>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        </Section>
      );
    default:
      return null;
  }
}

function inputRows(input: Record<string, unknown>) {
  return Object.entries(input).map(([key, value]) => ({ label: humanizeKey(key), value }));
}

/**
 * The blocks an end user reads. The API's end-user view already leaves out the operator's detail;
 * an older server may still send it, so the guarantees and the execution target never show here.
 */
function endUserBlocks(blocks: PreviewBlock[]): PreviewBlock[] {
  return blocks.filter((b) => b.type !== 'limitations' && !(b.type === 'fields' && b.title === 'Execution target'));
}

/** What the agent wants: what will change, then whether it can be undone, then the request itself. */
export function ApprovalWhat({ approval, locale }: { approval: Approval; locale?: string }) {
  const preview = approval.preview;
  const target = preview
    ? [
        ...(preview.target.account ? [{ label: 'Account', value: preview.target.account }] : []),
        ...Object.entries(preview.target.display).map(([key, value]) => ({ label: humanizeKey(key), value })),
      ]
    : [];
  const blocks = preview ? endUserBlocks(preview.blocks) : [];
  const hasImpactBlock = blocks.some((b) => b.type === 'impact');
  const input = approval.input && Object.keys(approval.input).length > 0 ? approval.input : null;
  const undo = preview?.undo ?? (preview?.reversible === false ? "This can't be undone once it runs." : null);

  return (
    <div className="anlyon-what">
      {approval.description ? <p className="anlyon-description">{approval.description}</p> : null}
      {target.length > 0 ? <Fields rows={target} /> : null}
      {blocks.map((block, index) => <Block key={index} block={block} locale={locale} />)}
      {preview && !hasImpactBlock && preview.impact.length > 0 ? (
        <Section title="Impact">
          <Impact quantities={preview.impact} locale={locale} />
        </Section>
      ) : null}
      {undo ? (
        <p className="anlyon-undo" data-reversible={preview?.reversible ? 'true' : 'false'}>
          {undo}
        </p>
      ) : null}
      {input ? (
        blocks.length > 0 ? (
          <details className="anlyon-raw">
            <summary className="anlyon-raw-summary">Request details</summary>
            <Fields rows={inputRows(input)} />
          </details>
        ) : (
          <Section title="Details">
            <Fields rows={inputRows(input)} />
          </Section>
        )
      ) : null}
    </div>
  );
}

const RESULT_TEXT: Record<string, string> = {
  succeeded: 'Done',
  failed: 'The action failed',
  running: 'Running',
  pending: 'Running',
  unknown: 'Sent; the outcome is not known yet',
};

/** The outcome line of a decided or expired approval. */
export function ApprovalOutcome({ item, now }: { item: ApprovalItem; now: number }) {
  const { approval, state } = item;
  if (state !== 'approved' && state !== 'declined' && state !== 'expired') return null;
  const when = approval.decidedAt ?? approval.expiresAt;
  const result = state === 'approved' && item.resultStatus ? RESULT_TEXT[item.resultStatus] ?? humanizeKey(item.resultStatus) : null;
  return (
    <div className="anlyon-outcome" data-state={state}>
      <p className="anlyon-outcome-line">
        {state === 'approved' ? <CheckIcon /> : state === 'declined' ? <XIcon /> : <ClockIcon />}
        <span className="anlyon-outcome-label">{state === 'approved' ? 'Approved' : state === 'declined' ? 'Declined' : 'Expired'}</span>
        {state === 'expired' ? (
          <span className="anlyon-muted">{approval.kind === 'action' ? 'No answer in time. The action did not run.' : 'No answer in time.'}</span>
        ) : (
          <span className="anlyon-muted" title={formatDateTime(when)}>
            {formatAgo(when, now)}
            {result ? ` · ${result}` : ''}
          </span>
        )}
      </p>
      {approval.decisionNote ? <p className="anlyon-note">{approval.decisionNote}</p> : null}
      {item.error ? <p className="anlyon-muted">{item.error.message}</p> : null}
    </div>
  );
}

export interface DecisionBarProps {
  item: ApprovalItem;
  now: number;
  onDecide: (decision: Decision, reason?: string) => void;
  /** Names the group of buttons for assistive tech: the approval's headline. */
  label: string;
}

/** Approve and Decline, an optional note, the expiry, and any error. */
export function DecisionBar({ item, now, onDecide, label }: DecisionBarProps) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const noteId = useId();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const deciding = item.state === 'deciding';
  const expiry = formatExpiry(item.approval.expiresAt, now);
  const soon = Date.parse(item.approval.expiresAt) - now < 5 * 60_000;

  const decide = (decision: Decision) => onDecide(decision, noteOpen ? note : undefined);

  return (
    <div className="anlyon-decision" role="group" aria-label={`Answer: ${label}`} aria-busy={deciding || undefined}>
      {noteOpen ? (
        <div className="anlyon-note-field">
          <label className="anlyon-sr-only" htmlFor={noteId}>
            Note
          </label>
          <textarea
            id={noteId}
            ref={noteRef}
            className="anlyon-textarea"
            placeholder="Add a note (optional)"
            rows={2}
            maxLength={1000}
            value={note}
            disabled={deciding}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !note) {
                event.stopPropagation();
                setNoteOpen(false);
              }
            }}
          />
        </div>
      ) : null}
      {item.state === 'failed' && item.error ? (
        <p className="anlyon-error" role="alert">
          <AlertIcon />
          <span>{item.error.message}</span>
        </p>
      ) : null}
      <div className="anlyon-decision-row">
        <span className="anlyon-expiry" data-soon={soon || undefined} title={formatDateTime(item.approval.expiresAt)}>
          <ClockIcon />
          {expiry}
        </span>
        {!noteOpen ? (
          <button
            type="button"
            className="anlyon-link"
            disabled={deciding}
            onClick={() => {
              setNoteOpen(true);
              setTimeout(() => noteRef.current?.focus(), 0);
            }}
          >
            Add a note
          </button>
        ) : null}
        <span className="anlyon-decision-buttons">
          <button
            type="button"
            className="anlyon-button"
            data-variant="secondary"
            disabled={deciding}
            onClick={() => decide('deny')}
          >
            {deciding && item.decision === 'deny' ? <Spinner /> : null}
            {deciding && item.decision === 'deny' ? 'Declining…' : 'Decline'}
          </button>
          <button
            type="button"
            className="anlyon-button"
            data-variant="primary"
            disabled={deciding}
            onClick={() => decide('approve')}
          >
            {deciding && item.decision === 'approve' ? <Spinner /> : null}
            {deciding && item.decision === 'approve' ? 'Approving…' : 'Approve'}
          </button>
        </span>
      </div>
    </div>
  );
}

/** The status word for a badge. */
export const STATE_LABEL: Record<ApprovalItem['state'], string> = {
  pending: 'Waiting',
  deciding: 'Sending',
  approved: 'Approved',
  declined: 'Declined',
  expired: 'Expired',
  failed: 'Not sent',
};
