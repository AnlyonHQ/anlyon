import { main } from './main';
import { defaultRuntime } from './runtime';

const streams = { stdout: process.stdout, stderr: process.stderr };

main(process.argv.slice(2), {
  streams,
  runtime: (signal, abortState) => defaultRuntime(streams, process.stdin, signal, abortState),
  handleSignals: true,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`anlyon: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
