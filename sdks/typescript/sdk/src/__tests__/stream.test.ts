import { describe, expect, it, vi } from 'vitest';
import { Client } from '../client';

function sseResponse(text: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function evt(id: string, type: string, data: object): string {
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ id, v: 1, type, environmentId: null, data, ts: 1 })}\n\n`;
}

describe('client.stream()', () => {
  it('yields typed events and skips control frames', async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse(
        'event: ready\ndata: {"v":1}\n\n' +
          evt('1-0', 'run.started', { runId: 'run_1' }) +
          ':heartbeat\n\n' +
          evt('2-0', 'run.ended', { runId: 'run_1' }),
      ),
    );
    const client = new Client({ apiKey: 'k', baseUrl: 'https://api.test', fetch: fetchFn as unknown as typeof fetch });

    const ac = new AbortController();
    const received: string[] = [];
    for await (const event of client.stream({ signal: ac.signal })) {
      received.push(event.type);
      expect(event.v).toBe(1);
      if (event.type === 'run.started') expect(event.data.runId).toBe('run_1');
      if (received.length === 2) ac.abort();
    }

    expect(received).toEqual(['run.started', 'run.ended']);
  });

  it('sends the Accept and resume-cursor headers', async () => {
    let seenHeaders: Headers | undefined;
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      seenHeaders = new Headers(init.headers);
      return sseResponse(evt('5-0', 'ping', {}));
    });
    const client = new Client({ apiKey: 'k', baseUrl: 'https://api.test', fetch: fetchFn as unknown as typeof fetch });

    const ac = new AbortController();
    for await (const _e of client.stream({ cursor: '4-0', signal: ac.signal })) {
      ac.abort();
    }

    expect(seenHeaders?.get('accept')).toBe('text/event-stream');
    expect(seenHeaders?.get('last-event-id')).toBe('4-0');
  });

  it('reconnects with the last seen id after the stream ends', async () => {
    const lastEventIds: (string | null)[] = [];
    const ac = new AbortController();
    let call = 0;
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      call += 1;
      lastEventIds.push(new Headers(init.headers).get('last-event-id'));
      if (call === 1) return sseResponse(evt('9-0', 'run.started', {}));
      ac.abort();
      return sseResponse('');
    });
    const client = new Client({ apiKey: 'k', baseUrl: 'https://api.test', fetch: fetchFn as unknown as typeof fetch });

    const received: string[] = [];
    for await (const event of client.stream({ signal: ac.signal })) {
      received.push(event.type);
    }

    expect(received).toEqual(['run.started']);
    expect(lastEventIds[0]).toBeNull();
    expect(lastEventIds[1]).toBe('9-0');
  }, 10000);
});
