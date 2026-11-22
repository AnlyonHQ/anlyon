import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useAnlyon, type AnlyonContextValue } from '../provider';
import type { AnlyonUIError } from '../core/client';
import { toUIError } from '../core/store';
import type { Approval } from '../core/types';
import { useNow, useQuery } from './shared';

/**
 * What a person sees for one approval. `deciding` while the answer is on its way; `failed` when it
 * did not land, with the API's message, and the approval can be answered again.
 */
export type ApprovalState = 'pending' | 'deciding' | 'approved' | 'declined' | 'expired' | 'failed';

export type Decision = 'approve' | 'deny';

export interface ApprovalItem {
  approval: Approval;
  state: ApprovalState;
  /** The answer being sent, or the one this person sent. */
  decision: Decision | null;
  error: AnlyonUIError | null;
  /** When approving ran the call, its status, e.g. `succeeded`. */
  resultStatus: string | null;
}

interface DecisionRecord {
  state: 'deciding' | 'failed' | 'done';
  decision: Decision;
  error: AnlyonUIError | null;
  approval?: Approval;
  resultStatus?: string | null;
}

type Decisions = Record<string, DecisionRecord>;

const DECISIONS = 'decisions';
const NO_DECISIONS: Decisions = {};

function useDecisions(): Decisions {
  const { store } = useAnlyon();
  const subscribe = useCallback((listener: () => void) => store.subscribe(DECISIONS, listener), [store]);
  return useSyncExternalStore(
    subscribe,
    () => store.get<Decisions>(DECISIONS).data ?? NO_DECISIONS,
    () => NO_DECISIONS,
  );
}

export function itemOf(approval: Approval, record: DecisionRecord | undefined, now: number): ApprovalItem {
  if (record?.state === 'deciding' || record?.state === 'failed') {
    return { approval, state: record.state, decision: record.decision, error: record.error, resultStatus: null };
  }
  const current = record?.approval ?? approval;
  const state: ApprovalState =
    current.status === 'approved'
      ? 'approved'
      : current.status === 'denied'
        ? 'declined'
        : current.status === 'expired' || Date.parse(current.expiresAt) <= now
          ? 'expired'
          : 'pending';
  return {
    approval: current,
    state,
    decision: record?.decision ?? null,
    error: record?.error ?? null,
    resultStatus: record?.resultStatus ?? null,
  };
}

/** Send one answer. Resolves to the decided approval, or null when the answer did not count. Never throws: a failure lands in the item. */
async function sendDecision({ client, store }: AnlyonContextValue, approvalId: string, decision: Decision, reason?: string): Promise<Approval | null> {
  const record = (next: DecisionRecord) => store.set<Decisions>(DECISIONS, (all) => ({ ...all, [approvalId]: next }));
  record({ state: 'deciding', decision, error: null });
  const note = reason?.trim() || undefined;
  try {
    const out = await client.decideApproval(approvalId, decision, note);
    record({ state: 'done', decision, error: null, approval: out.approval, resultStatus: out.result?.status ?? null });
    store.set<Approval>(`approval:${approvalId}`, () => out.approval);
    return out.approval;
  } catch (cause) {
    const error = toUIError(cause);
    if (error.status === 409) {
      try {
        const fresh = await client.getApproval(approvalId);
        record({ state: 'done', decision, error, approval: fresh });
        store.set<Approval>(`approval:${approvalId}`, () => fresh);
        return null;
      } catch {
      }
    }
    record({ state: 'failed', decision, error });
    return null;
  }
}

export interface UseApprovalsOptions {
  /** `pending` (default) lists what waits for an answer; `all` includes the history. */
  status?: 'pending' | 'all';
  /** At most this many, newest first. Default 20, at most 100. */
  limit?: number;
}

export interface UseApprovalsResult {
  /** Newest first. Answers given here stay in the list, with their outcome, until the page reloads. */
  items: ApprovalItem[];
  /** Items still waiting for an answer. */
  pendingCount: number;
  loading: boolean;
  error: AnlyonUIError | null;
  refresh: () => Promise<void>;
  /** Resolves to the decided approval, or null when the answer did not count (the item says why). */
  decide: (approvalId: string, decision: Decision, reason?: string) => Promise<Approval | null>;
}

/** The end user's approvals, checked again while the page is visible. */
export function useApprovals(options: UseApprovalsOptions = {}): UseApprovalsResult {
  const context = useAnlyon();
  const status = options.status ?? 'pending';
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const query = useQuery(
    `approvals:${status}:${limit}`,
    async () => (await context.client.listApprovals({ status: status === 'all' ? undefined : 'pending', limit })).approvals,
    context.pollInterval,
  );
  const decisions = useDecisions();
  const now = useNow();

  const items = useMemo(() => {
    const listed = query.data ?? [];
    const seen = new Set(listed.map((a) => a.id));
    const answered = Object.values(decisions)
      .map((d) => d.approval)
      .filter((a): a is Approval => a !== undefined && !seen.has(a.id));
    return [...listed, ...answered]
      .map((a) => itemOf(a, decisions[a.id], now))
      .sort((a, b) => Date.parse(b.approval.createdAt) - Date.parse(a.approval.createdAt));
  }, [query.data, decisions, now]);

  const decide = useCallback(
    (approvalId: string, decision: Decision, reason?: string) => sendDecision(context, approvalId, decision, reason),
    [context],
  );

  return {
    items,
    pendingCount: items.filter((i) => i.state === 'pending' || i.state === 'deciding' || i.state === 'failed').length,
    loading: query.loading,
    error: query.error,
    refresh: query.refresh,
    decide,
  };
}

export interface UseApprovalResult {
  item: ApprovalItem | null;
  loading: boolean;
  /** The read failed: `APPROVAL_NOT_FOUND` for one that is not this end user's. */
  error: AnlyonUIError | null;
  refresh: () => Promise<void>;
  /** Resolves to the decided approval, or null when the answer did not count (the item says why). */
  decide: (decision: Decision, reason?: string) => Promise<Approval | null>;
}

/** One of the end user's approvals, by id, e.g. the `approvalId` a tool result carries. */
export function useApproval(approvalId: string): UseApprovalResult {
  const context = useAnlyon();
  const decisions = useDecisions();
  const now = useNow();
  const key = approvalId ? `approval:${approvalId}` : null;
  const cached = key ? context.store.get<Approval>(key).data : undefined;
  const poll = !cached || cached.status === 'pending' ? context.pollInterval : 0;
  const query = useQuery(key, () => context.client.getApproval(approvalId), poll);

  const item = query.data ? itemOf(query.data, decisions[approvalId], now) : null;
  const decide = useCallback(
    (decision: Decision, reason?: string) => sendDecision(context, approvalId, decision, reason),
    [context, approvalId],
  );

  return { item, loading: query.loading, error: item ? null : query.error, refresh: query.refresh, decide };
}
