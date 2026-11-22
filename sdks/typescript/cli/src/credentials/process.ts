import { spawn } from 'node:child_process';

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The executable could not be started at all (ENOENT etc). */
  spawnError?: NodeJS.ErrnoException;
}

/**
 * Run a helper with the secret on stdin, never in argv: argv is visible to every
 * user on the machine through `ps`, stdin is not.
 */
export function runProcess(
  command: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', spawnError: error as NodeJS.ErrnoException });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr: `${stderr}\n(timed out)` });
    }, options.timeoutMs ?? 20_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error: NodeJS.ErrnoException) => finish({ code: null, stdout, stderr, spawnError: error }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}
