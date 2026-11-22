import { hostname } from 'node:os';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CliError } from './errors';
import { EXIT } from './exit-codes';

/**
 * A cross-process mutex built on exclusive file creation (O_CREAT|O_EXCL), which
 * is atomic on every local filesystem the CLI supports, Windows included.
 *
 * Why it exists: the authorization server rotates refresh tokens and treats a
 * second use of a rotated token as theft, revoking the whole token family. Two
 * terminals refreshing the same profile at once would therefore log each other
 * out. Refreshes (and config rewrites) run under this lock; see auth/tokens.ts.
 *
 * A holder that crashed leaves its file behind. A lock is considered stale when
 * its owner process is gone (same host) or it is older than `staleMs`, whichever
 * is detected first, and is then broken.
 */
export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  signal?: AbortSignal;
}

interface Owner {
  pid: number;
  host: string;
  token: string;
  at: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function isStale(path: string, staleMs: number): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(path, 'utf8')) as Partial<Owner>;
    if (typeof owner.at === 'number' && Date.now() - owner.at > staleMs) return true;
    if (owner.host === hostname() && typeof owner.pid === 'number' && !processAlive(owner.pid)) return true;
    return false;
  } catch {
    try {
      return Date.now() - (await stat(path)).mtimeMs > staleMs;
    } catch {
      return false;
    }
  }
}

export async function withLock<T>(path: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const staleMs = options.staleMs ?? 300_000;
  const token = randomBytes(12).toString('hex');
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw new CliError('CANCELLED', 'Cancelled.', EXIT.CANCELLED);
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        const owner: Owner = { pid: process.pid, host: hostname(), token, at: Date.now() };
        await handle.writeFile(JSON.stringify(owner));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await isStale(path, staleMs)) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new CliError('LOCK_TIMEOUT', `Another anlyon process is holding ${path}.`, EXIT.ERROR, {
          hint: 'Wait for it to finish, or delete the file if no anlyon process is running.',
        });
      }
      await sleep(Math.min(250, 20 + attempt * 10) + Math.floor(Math.random() * 20));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const owner = JSON.parse(await readFile(path, 'utf8')) as Partial<Owner>;
      if (owner.token === token) await rm(path, { force: true });
    } catch {
    }
  }
}
