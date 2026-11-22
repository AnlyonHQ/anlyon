import { redact, redactValue } from './redact';
import { SIGN_OFF_REQUIRED, signOffDetails, type CliError } from './errors';
import { printSignOffNotice } from './sign-off';

export interface Streams {
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
}

export interface Column<T> {
  header: string;
  value: (row: T) => unknown;
}

function cell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * The output contract: results go to stdout, everything else (progress, warnings,
 * errors) to stderr. With --json stdout carries exactly one JSON document, so it
 * can be piped to jq without filtering. Everything written passes through redact().
 */
export class Output {
  constructor(
    private readonly streams: Streams,
    readonly json: boolean,
  ) {}

  /** A line of human-readable result (not used in --json mode). */
  line(text = ''): void {
    this.streams.stdout.write(`${redact(text)}\n`);
  }

  /** Progress or diagnostics. Never on stdout. */
  info(text: string): void {
    this.streams.stderr.write(`${redact(text)}\n`);
  }

  warn(text: string): void {
    this.streams.stderr.write(`warning: ${redact(text)}\n`);
  }

  /** Emit the command's result document. */
  result(value: unknown): void {
    this.streams.stdout.write(`${JSON.stringify(redactValue(value), null, 2)}\n`);
  }

  table<T>(rows: T[], columns: Column<T>[]): void {
    if (rows.length === 0) {
      this.info('No results.');
      return;
    }
    const cells = rows.map((row) => columns.map((column) => cell(column.value(row))));
    const widths = columns.map((column, index) =>
      Math.min(60, Math.max(column.header.length, ...cells.map((r) => r[index]!.length))),
    );
    const fmt = (values: string[]) =>
      values
        .map((value, index) => {
          const width = widths[index]!;
          const clipped = value.length > width ? `${value.slice(0, width - 1)}…` : value;
          return index === values.length - 1 ? clipped : clipped.padEnd(width);
        })
        .join('  ');
    this.line(fmt(columns.map((column) => column.header.toUpperCase())));
    for (const row of cells) this.line(fmt(row));
  }

  /** Key/value block for a single object. */
  fields(pairs: [string, unknown][]): void {
    const width = Math.max(...pairs.map(([key]) => key.length));
    for (const [key, value] of pairs) this.line(`${key.padEnd(width)}  ${cell(value)}`);
  }

  error(error: CliError): void {
    const signOff = signOffDetails(error);
    if (this.json) {
      if (signOff) this.result({ data: signOff });
      this.streams.stderr.write(`${JSON.stringify({ error: error.toJSON() })}\n`);
      return;
    }
    if (signOff && error.code === SIGN_OFF_REQUIRED) {
      printSignOffNotice(this, signOff);
      return;
    }
    const status = error.status ? ` (HTTP ${error.status})` : '';
    this.streams.stderr.write(`error: ${redact(error.message)}${status}\n`);
    if (error.hint) this.streams.stderr.write(`hint: ${redact(error.hint)}\n`);
    if (error.requestId) this.streams.stderr.write(`request id: ${error.requestId}\n`);
  }
}
