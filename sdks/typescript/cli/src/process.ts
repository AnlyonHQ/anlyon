import { spawn } from 'node:child_process';

export type ProcessRunner = (command: string, args: string[], options: { cwd: string }) => Promise<{ code: number }>;

/**
 * Run a program with fixed arguments, its output going to this process's stderr so that stdout
 * stays the command's own result (one JSON document under --json). On Windows, package managers
 * are `.cmd` shims that only start through a shell; the arguments here never come from user input.
 */
export const runProcess: ProcessRunner = (command, args, options) =>
  new Promise((done) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', process.stderr, process.stderr],
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    child.on('error', () => done({ code: 127 }));
    child.on('exit', (code) => done({ code: code ?? 1 }));
  });
