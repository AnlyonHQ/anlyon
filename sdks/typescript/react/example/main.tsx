import { StrictMode, useEffect, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AnlyonProvider, ApprovalInbox, ApprovalPrompt, ConnectButton, ConnectPrompt, Connections } from '../src';
import '../src/styles.css';
import './gallery.css';
import { API, installMockApi, mockToken } from './mock-api';

installMockApi();

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') ?? 'os';
const view = params.get('view') ?? 'all';
if (theme !== 'os') document.documentElement.classList.add(theme);

function Click({ label, children }: { label: RegExp; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let done = false;
    const timer = setInterval(() => {
      const button = Array.from(ref.current?.querySelectorAll('button') ?? []).find(
        (b) => label.test(b.getAttribute('aria-label') ?? b.textContent ?? '') && b.getAttribute('aria-disabled') !== 'true',
      );
      if (button && !done) {
        done = true;
        button.click();
        clearInterval(timer);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [label]);
  return <div ref={ref}>{children}</div>;
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="g-section">
      <h2 className="g-title">{title}</h2>
      {note ? <p className="g-note">{note}</p> : null}
      {children}
    </section>
  );
}

const inbox = (
  <Section title="ApprovalInbox" note="status=&quot;all&quot;: waiting, approved, declined and expired.">
    <ApprovalInbox
      status="all"
      approvalTitle={(a) => (a.actionName === 'e2e-reminder' ? `Remind the team: ${String(a.input?.text ?? '')}` : undefined)}
    />
  </Section>
);

const prompts = (
  <>
    <Section title="ApprovalPrompt" note="An action your app declared, with a title from your app.">
      <ApprovalPrompt approvalId="apr_reminder" title="Remind the team: Review the launch plan" />
    </Section>
    <Section title="ApprovalPrompt" note="A preview with a diff.">
      <ApprovalPrompt approvalId="apr_file" />
    </Section>
    <Section title="ApprovalPrompt" note="Money, and a step that cannot be undone.">
      <ApprovalPrompt approvalId="apr_refund" />
    </Section>
    <Section title="Sending">
      <Click label={/^Approve$/}>
        <ApprovalPrompt approvalId="apr_hang" />
      </Click>
    </Section>
    <Section title="Failed" note="The API's own message; the buttons work again.">
      <Click label={/^Approve$/}>
        <ApprovalPrompt approvalId="apr_fail" />
      </Click>
    </Section>
  </>
);

const connect = (
  <>
    <Section title="ConnectButton">
      <div className="g-row">
        <ConnectButton integration="notion" />
        <ConnectButton integration="slack" />
        <ConnectButton integration="github" />
        <Click label={/Connect Attio/}>
          <ConnectButton integration="attio" />
        </Click>
      </div>
    </Section>
    <Section title="Connections" note="With integrations offered before they are connected; one row confirming a disconnect.">
      <Click label={/Disconnect Linear/}>
        <Connections integrations={['github', 'gmail', 'notion']} />
      </Click>
    </Section>
    <Section title="ConnectPrompt" note="For an AI SDK tool result.">
      <div className="g-stack">
        <ConnectPrompt result={{ status: 'connect_required', integration: 'gmail', connectUrl: null, message: '' }} />
        <ConnectPrompt result={{ status: 'reconnect_required', integration: 'slack', connectUrl: null, message: '' }} />
      </div>
    </Section>
  </>
);

function App() {
  return (
    <AnlyonProvider baseUrl={API} getToken={async () => mockToken()} connect={{ redirectUrl: 'http://localhost:5179/connected' }}>
      <main className="g-main" data-view={view}>
        {view === 'all' ? (
          <div className="g-grid">
            <div className="g-col">
              {inbox}
              {connect}
            </div>
            <div className="g-col">{prompts}</div>
          </div>
        ) : view === 'inbox' ? (
          inbox
        ) : view === 'prompts' ? (
          prompts
        ) : (
          connect
        )}
      </main>
    </AnlyonProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
