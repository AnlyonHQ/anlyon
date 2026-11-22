import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { ConfigStore } from '../src/config';
import type { CredentialStore } from '../src/credentials/store';
import { main } from '../src/main';
import type { Runtime } from '../src/runtime';
import { completeBrowserLogin } from './fixtures/fake-anlyon.mjs';

export class MemoryStore implements CredentialStore {
  readonly name = 'memory';
  readonly secure = true;
  maxSecretBytes = 16_384;
  readonly entries = new Map<string, string>();
  async get(account: string) {
    return this.entries.get(account) ?? null;
  }
  async set(account: string, secret: string) {
    this.entries.set(account, secret);
  }
  async delete(account: string) {
    return this.entries.delete(account);
  }
}

export async function tempDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'anlyon-cli-test-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  browserUrls: string[];
}

export interface Harness {
  configDir: string;
  store: MemoryStore;
  env: Record<string, string | undefined>;
  ran: { command: string; args: string[]; cwd: string }[];
  runExitCode?: number;
  run(argv: string[], options?: { env?: Record<string, string | undefined>; stdin?: string; handleSignals?: boolean; cwd?: string }): Promise<RunResult>;
}

export function harness(configDir: string, baseEnv: Record<string, string | undefined> = {}): Harness {
  const store = new MemoryStore();
  const h: Harness = {
    configDir,
    store,
    ran: [],
    env: { ANLYON_CONFIG_DIR: configDir, ...baseEnv },
    async run(argv, options = {}) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let out = '';
      let err = '';
      stdout.on('data', (chunk) => (out += chunk));
      stderr.on('data', (chunk) => (err += chunk));
      const browserUrls: string[] = [];
      const pendingLogins: Promise<unknown>[] = [];
      const stdin = Readable.from(options.stdin !== undefined ? [Buffer.from(options.stdin)] : []);
      const env = { ...h.env, ...(options.env ?? {}) };
      const code = await main(argv, {
        streams: { stdout, stderr },
        handleSignals: options.handleSignals,
        runtime: (signal, abortState): Runtime => ({
          env,
          platform: process.platform,
          streams: { stdout, stderr },
          stdin,
          fetch: globalThis.fetch.bind(globalThis),
          config: new ConfigStore(configDir),
          credentialStore: () => store,
          openBrowser: (url) => {
            browserUrls.push(url);
            pendingLogins.push(completeBrowserLogin(url).catch(() => undefined));
            return true;
          },
          signal,
          abortState,
          timeoutMs: 60_000,
          cwd: options.cwd ?? process.cwd(),
          run: async (command, args, runOptions) => {
            h.ran.push({ command, args, cwd: runOptions.cwd });
            return { code: h.runExitCode ?? 0 };
          },
        }),
      });
      await Promise.all(pendingLogins);
      return { code, stdout: out, stderr: err, browserUrls };
    },
  };
  return h;
}

export function storedSecrets(store: MemoryStore): string[] {
  const secrets: string[] = [];
  for (const raw of store.entries.values()) {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ['apiKey', 'refreshToken', 'accessToken']) if (typeof parsed[key] === 'string') secrets.push(parsed[key] as string);
  }
  return secrets;
}
