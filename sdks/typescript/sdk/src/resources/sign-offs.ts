/**
 * Sign-offs resource: follow the governance changes this credential asked for that a human must
 * approve.
 *
 * An agent may never loosen its own guardrails. A loosening change made with an API key, a CLI
 * login or an MCP session is not applied: the call throws `SignOffRequiredError`, and a workspace
 * admin approves or rejects the change at its `signOffUrl`. These methods read and withdraw this
 * credential's own requests. Nothing here can approve one, and no API key or CLI login can.
 *
 * Reading your own requests needs no scope.
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type { ApiResponse } from '../types/api';
import type { ListSignOffsParams, SignOffRequest, WaitForSignOffOptions } from '../types/sign-offs';
import { AnlyonError } from '../core/errors';
import { ERROR_CODES } from '../types/errors';

const DEFAULT_WAIT_MS = 300_000;
const DEFAULT_POLL_SECONDS = 5;

export class SignOffsResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/sign-offs');
  }

  /** One of this credential's sign-off requests. 404 when the id is not this credential's. */
  async get(signOffId: string): Promise<ApiResponse<SignOffRequest>> {
    return this._get<SignOffRequest>(`/${encodeURIComponent(signOffId)}`);
  }

  /**
   * This credential's own sign-off requests, newest to oldest.
   *
   * @example
   * ```typescript
   * const { data } = await client.signOffs.list({ status: 'pending' });
   * ```
   */
  async list(params: ListSignOffsParams = {}): Promise<ApiResponse<SignOffRequest[]>> {
    return this._get<SignOffRequest[]>('', { status: params.status, limit: params.limit });
  }

  /** Withdraw a pending request. Answers 409 when it is no longer pending. */
  async cancel(signOffId: string): Promise<ApiResponse<SignOffRequest>> {
    return this._post<SignOffRequest>(`/${encodeURIComponent(signOffId)}/cancel`, {});
  }

  /**
   * Poll a request until a human decides it, then return it.
   *
   * A timeout is not an error: you get the request back still `pending`, so always branch on
   * `status`. `applied` carries the applied object in `result`; `failed` carries `error`.
   *
   * @example
   * ```typescript
   * const decided = await client.signOffs.wait(error.signOffId, { timeoutMs: 10 * 60_000 });
   * if (decided.status === 'applied') console.log(decided.result);
   * else if (decided.status === 'pending') console.log(`Still waiting: ${decided.signOffUrl}`);
   * ```
   */
  async wait(signOffId: string, options: WaitForSignOffOptions = {}): Promise<SignOffRequest> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const { data } = await this.get(signOffId);
      if (!data) {
        throw new AnlyonError({ code: ERROR_CODES.PARSE_ERROR, message: `The API returned no sign-off request for ${signOffId}.` });
      }
      if (data.status !== 'pending') return data;

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || options.signal?.aborted) return data;

      const intervalMs = options.pollIntervalMs ?? Math.max(1, data.pollAfterSeconds || DEFAULT_POLL_SECONDS) * 1000;
      await sleep(Math.min(intervalMs, remainingMs), options.signal);
      if (options.signal?.aborted) return data;
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
