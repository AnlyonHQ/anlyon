import { ConfigStore, configDir, type Env } from './config';
import { selectCredentialStore, type CredentialStore } from './credentials/store';
import type { FetchFn } from './auth/http';
import type { Streams } from './output';
import { openBrowser } from './auth/browser';
import { runProcess, type ProcessRunner } from './process';

/**
 * Everything a command touches outside its own arguments, injected so tests can
 * run the whole CLI in-process against fakes.
 */
export interface Runtime {
  env: Env;
  platform: NodeJS.Platform;
  streams: Streams;
  stdin: NodeJS.ReadableStream;
  fetch: FetchFn;
  config: ConfigStore;
  credentialStore: () => CredentialStore;
  openBrowser: (url: string) => boolean;
  /** Aborted on SIGINT or when --timeout elapses. */
  signal: AbortSignal;
  abortState: { cancelled: boolean; timedOut: boolean };
  /** Default request timeout in ms (from --timeout). */
  timeoutMs: number;
  /** The directory project commands (init, plan, apply, pull) work in. */
  cwd: string;
  /** Run a program (a package manager) with fixed arguments. Injected so tests never install anything. */
  run: ProcessRunner;
}

export function defaultRuntime(streams: Streams, stdin: NodeJS.ReadableStream, signal: AbortSignal, abortState: Runtime['abortState']): Runtime {
  const env = process.env;
  const dir = configDir(env);
  let store: CredentialStore | undefined;
  return {
    env,
    platform: process.platform,
    streams,
    stdin,
    fetch: globalThis.fetch.bind(globalThis),
    config: new ConfigStore(dir),
    credentialStore: () => (store ??= selectCredentialStore(env, dir)),
    openBrowser: (url) => openBrowser(url),
    signal,
    abortState,
    timeoutMs: 60_000,
    cwd: process.cwd(),
    run: runProcess,
  };
}
