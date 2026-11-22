import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalInbox } from '../src/components/approval-inbox';
import { ApprovalPrompt } from '../src/components/approval-prompt';
import { approval, fakeApi, renderWithApi } from './helpers';

const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const focused = () => document.activeElement;

describe('<ApprovalInbox />', () => {
  it('shows placeholder rows, then the approvals, newest open', async () => {
    const api = fakeApi({
      approvals: [
        approval(),
        approval({
          id: 'apr_2',
          actionName: 'slack-post-message',
          input: { channel: '#ops', text: 'Deploy done' },
          createdAt: new Date(Date.now() - 3_600_000).toISOString(),
        }),
      ],
    });
    const { container } = renderWithApi(<ApprovalInbox />, api);
    expect(container.querySelector('.anlyon-skeleton-row')).not.toBeNull();

    const first = await screen.findByRole('button', { name: /GitHub: Create issue/ });
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /Slack: Post message/ }).getAttribute('aria-expanded')).toBe('false');
    const body = screen.getByRole('region', { name: 'GitHub: Create issue' });
    within(body).getByText('Repo');
    within(body).getByText('acme/web');
    within(body).getByText('bug, auth');
    within(body).getByText(/Expires in 2\d min/);
    expect(container.querySelector('.anlyon-count')?.textContent).toBe('2 waiting');
    expect(api.calls[0].path).toBe('/approvals?status=pending&limit=20');
  });

  it('says so when nothing waits', async () => {
    renderWithApi(<ApprovalInbox />, fakeApi());
    await screen.findByText('Nothing to approve');
  });

  it('shows the API message when the list fails, and tries again', async () => {
    const api = fakeApi({ approvals: [approval()] });
    api.setOverride(() => ({ status: 403, body: { error: { code: 'END_USER_SESSION_SCOPE', message: 'This session cannot use approvals.' } } }));
    renderWithApi(<ApprovalInbox />, api);
    expect((await screen.findByRole('alert')).textContent).toContain('This session cannot use approvals.');
    api.setOverride(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: /GitHub: Create issue/ });
  });

  it('approves: sending, then approved with the outcome, announced', async () => {
    const api = fakeApi({ approvals: [approval()] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const gated = {
      ...api,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/decide')) await gate;
        return api.fetch(input, init);
      },
    };
    const { container } = renderWithApi(<ApprovalInbox />, gated);

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const sending = await screen.findByRole('button', { name: /Approving/ });
    expect((sending as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Decline' }) as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('.anlyon-approval')?.getAttribute('data-state')).toBe('deciding');

    release();
    await screen.findByText('Approved', { selector: '.anlyon-outcome-label' });
    screen.getByText(/Done/);
    await waitFor(() => expect(container.querySelector('[aria-live]')?.textContent).toBe('Approved: GitHub: Create issue'));
    expect(focused()).toBe(screen.getByRole('button', { name: /GitHub: Create issue/ }));
    expect(api.calls.find((c) => c.path.endsWith('/decide'))?.body).toEqual({ decision: 'approve' });
  });

  it('declines with a note', async () => {
    const api = fakeApi({ approvals: [approval()] });
    const onDecided = vi.fn();
    renderWithApi(<ApprovalInbox onDecided={onDecided} />, api);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a note' }));
    const note = screen.getByRole('textbox', { name: 'Note' });
    await waitFor(() => expect(focused()).toBe(note));
    fireEvent.change(note, { target: { value: 'Wrong repo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

    await screen.findByText('Declined', { selector: '.anlyon-outcome-label' });
    screen.getByText('Wrong repo', { selector: '.anlyon-note' });
    expect(api.calls.find((c) => c.path.endsWith('/decide'))?.body).toEqual({ decision: 'deny', reason: 'Wrong repo' });
    expect(onDecided).toHaveBeenCalledWith('deny', expect.objectContaining({ id: 'apr_1', status: 'denied' }));
  });

  it('shows why an answer failed, and lets it be sent again', async () => {
    const api = fakeApi({ approvals: [approval()] });
    api.setOverride((call) =>
      call.path.endsWith('/decide') ? { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again in a minute.' } } } : undefined,
    );
    const { container } = renderWithApi(<ApprovalInbox />, api);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Too many requests. Try again in a minute.');
    expect(container.querySelector('.anlyon-approval')?.getAttribute('data-state')).toBe('failed');

    api.setOverride(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('Approved', { selector: '.anlyon-outcome-label' });
  });

  it('shows what happened when it was decided elsewhere', async () => {
    const api = fakeApi({ approvals: [approval()] });
    renderWithApi(<ApprovalInbox />, api);
    await screen.findByRole('button', { name: 'Approve' });
    api.state.approvals[0] = { ...api.state.approvals[0], status: 'denied', decidedAt: new Date().toISOString() };
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('Declined', { selector: '.anlyon-outcome-label' });
    screen.getByText('Approval apr_1 is already denied');
  });

  it('marks an approval past its expiry as expired, without buttons', async () => {
    const api = fakeApi({ approvals: [approval({ expiresAt: new Date(Date.now() - 60_000).toISOString() })] });
    renderWithApi(<ApprovalInbox />, api);
    const row = await screen.findByRole('button', { name: /GitHub: Create issue/ });
    expect(row.closest('li')?.getAttribute('data-state')).toBe('expired');
    fireEvent.click(row);
    await screen.findByText('No answer in time. The action did not run.');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('moves between rows with the arrow keys, Home and End', async () => {
    const api = fakeApi({
      approvals: [
        approval({ id: 'a1' }),
        approval({ id: 'a2', actionName: 'slack-post-message' }),
        approval({ id: 'a3', actionName: 'linear-create-issue' }),
      ],
    });
    const { container } = renderWithApi(<ApprovalInbox />, api);
    await screen.findByRole('button', { name: /Slack/ });
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-anlyon-row]'));
    expect(rows).toHaveLength(3);
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    expect(focused()).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: 'End' });
    expect(focused()).toBe(rows[2]);
    fireEvent.keyDown(rows[2], { key: 'Home' });
    expect(focused()).toBe(rows[0]);
    fireEvent.keyDown(rows[0], { key: 'ArrowUp' });
    expect(focused()).toBe(rows[0]);
    fireEvent.click(rows[1]);
    expect(rows[1].getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the preview: fields, diff, impact, limits, and the request behind a disclosure', async () => {
    const api = fakeApi({
      approvals: [
        approval({
          actionName: 'stripe-create-refund',
          input: { paymentIntent: 'pi_123', amount: 1250 },
          preview: {
            target: { account: 'acct_acme', display: {} },
            blocks: [
              { type: 'fields', title: 'Refund', fields: [{ label: 'Refund amount', value: '$12.50' }] },
              { type: 'text_diff', title: 'File', path: 'README.md', before: 'one\ntwo', after: 'one\nthree', truncated: false },
              { type: 'limitations', title: 'Limits', items: [{ kind: 'irreversible', text: 'Refunds cannot be reversed.' }] },
            ],
            impact: [{ dimension: 'money', currency: 'usd', amount: 1250, bound: 'exact' }],
            expiresAt: inMinutes(10),
          },
        }),
      ],
    });
    renderWithApi(<ApprovalInbox />, api, { locale: 'en-US' });
    const body = await screen.findByRole('region', { name: 'Stripe: Create refund' });
    within(body).getByText('acct_acme');
    within(body).getByText('Refund amount');
    within(body).getByText('README.md');
    expect(within(body).getByText('three').closest('[data-kind]')?.getAttribute('data-kind')).toBe('add');
    expect(within(body).queryByText('Refunds cannot be reversed.')).toBeNull();
    within(body).getByText('$12.50', { selector: '.anlyon-chip' });
    within(body).getByText('Request details');
    screen.getByText(/acct_acme · pi_123 · \$12\.50/);
  });

  it('shows the end user the change and one undo line, never the execution target or guarantees', async () => {
    const api = fakeApi({
      approvals: [
        approval({
          actionName: 'acme-remind',
          input: { audience: 'team', text: 'Review the launch plan' },
          preview: {
            target: { account: null, display: {} },
            blocks: [
              { type: 'fields', title: 'Execution target', fields: [{ label: 'Adapter', value: 'http.declared v1' }] },
              { type: 'limitations', title: 'What is supported and what is not', items: [{ kind: 'unsupported', text: 'Not supported: Provider idempotency' }] },
            ],
            impact: [{ dimension: 'reminders', amount: 1, bound: 'exact' }],
            reversible: false,
            undo: "This can't be undone once it runs.",
            expiresAt: inMinutes(10),
          },
        }),
      ],
    });
    renderWithApi(<ApprovalInbox />, api, { locale: 'en-US' });
    const body = await screen.findByRole('region', { name: 'Acme remind' });
    for (const hidden of ['Execution target', 'Adapter', 'Not supported: Provider idempotency']) expect(within(body).queryByText(hidden)).toBeNull();
    within(body).getByText('1 reminder', { selector: '.anlyon-chip' });
    within(body).getByText("This can't be undone once it runs.");
    within(body).getByText('Details');
    within(body).getByText('Review the launch plan');
    expect(within(body).queryByText('Request details')).toBeNull();
  });

  it("takes each row's headline from approvalTitle, and announces it", async () => {
    const api = fakeApi({ approvals: [approval()] });
    const { container } = renderWithApi(
      <ApprovalInbox approvalTitle={(a) => (a.actionName === 'github-create-issue' ? 'File the Safari bug' : undefined)} />,
      api,
    );
    await screen.findByText('File the Safari bug', { selector: '.anlyon-approval-headline' });
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(container.querySelector('[aria-live]')?.textContent).toBe('Approved: File the Safari bug'));
  });

  it('drops the bundled styles when unstyled, keeping its class names', async () => {
    const { container } = renderWithApi(<ApprovalInbox unstyled className="mine" />, fakeApi());
    await screen.findByText('Nothing to approve');
    const root = container.firstElementChild!;
    expect(root.classList.contains('anlyon')).toBe(false);
    expect(root.classList.contains('anlyon-inbox')).toBe(true);
    expect(root.classList.contains('mine')).toBe(true);
  });
});

describe('<ApprovalPrompt />', () => {
  it('shows one approval and approves it, keeping focus in the prompt', async () => {
    const api = fakeApi({
      approvals: [
        approval({ id: 'apr_9', kind: 'custom', actionName: null, title: 'Send the weekly report', description: 'To 12 recipients.', input: { recipients: 12 } }),
      ],
    });
    const onDecided = vi.fn();
    renderWithApi(<ApprovalPrompt approvalId="apr_9" onDecided={onDecided} />, api);
    await screen.findByRole('heading', { name: 'Send the weekly report' });
    screen.getByText('To 12 recipients.');
    screen.getByText('Waiting', { selector: '.anlyon-badge' });

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('Approved', { selector: '.anlyon-badge' });
    expect(focused()).toBe(screen.getByRole('heading', { name: 'Send the weekly report' }));
    expect(onDecided).toHaveBeenCalledWith('approve', expect.objectContaining({ status: 'approved' }));
  });

  it('announces its own title, not the default headline', async () => {
    const api = fakeApi({ approvals: [approval()] });
    const { container } = renderWithApi(<ApprovalPrompt approvalId="apr_1" title="Create the Safari bug" />, api);
    await screen.findByRole('heading', { name: 'Create the Safari bug' });
    screen.getByRole('group', { name: 'Answer: Create the Safari bug' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(container.querySelector('[aria-live]')?.textContent).toBe('Approved: Create the Safari bug'));
  });

  it("says when the approval is not this user's", async () => {
    renderWithApi(<ApprovalPrompt approvalId="apr_other" />, fakeApi());
    expect((await screen.findByRole('alert')).textContent).toContain('This approval is not available');
  });

  it('shows a loading state first', () => {
    renderWithApi(<ApprovalPrompt approvalId="apr_1" />, fakeApi({ approvals: [approval()] }));
    screen.getByText('Loading approval');
  });

  it('agrees with an inbox under the same provider', async () => {
    const api = fakeApi({ approvals: [approval()] });
    renderWithApi(
      <>
        <ApprovalPrompt approvalId="apr_1" />
        <ApprovalInbox />
      </>,
      api,
    );
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);
    await waitFor(() => expect(screen.getAllByText('Approved', { selector: '.anlyon-outcome-label' })).toHaveLength(2));
    expect(api.calls.filter((c) => c.path.endsWith('/decide'))).toHaveLength(1);
  });
});
