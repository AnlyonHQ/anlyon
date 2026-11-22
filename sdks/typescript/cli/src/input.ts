import { readFile } from 'node:fs/promises';
import { usageError } from './errors';
import type { OptionSpec, OptionValue } from './args';

export async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `--input <file|->`: a JSON object whose keys are the command's option names.
 * Flags given on the command line win over the file. Unknown keys are refused,
 * so a typo cannot silently widen or narrow what a command does.
 */
export async function loadInput(
  source: string,
  spec: Record<string, OptionSpec>,
  stdin: NodeJS.ReadableStream,
): Promise<Record<string, NonNullable<OptionValue>>> {
  let text: string;
  try {
    text = source === '-' ? await readStdin(stdin) : await readFile(source, 'utf8');
  } catch (error) {
    throw usageError(`Cannot read --input ${source}: ${(error as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw usageError('--input must be a JSON object.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw usageError('--input must be a JSON object.');

  const out: Record<string, NonNullable<OptionValue>> = {};
  const allowed = { ...spec, limit: { type: 'string' }, cursor: { type: 'string' } } as Record<string, { type: string; multiple?: boolean }>;
  for (const [key, raw] of Object.entries(value)) {
    const option = allowed[key];
    if (!option) {
      throw usageError(`--input has unknown key "${key}". Allowed: ${Object.keys(allowed).join(', ') || '(none)'}.`);
    }
    if (option.type === 'boolean') {
      if (typeof raw !== 'boolean') throw usageError(`--input key "${key}" must be true or false.`);
      out[key] = raw;
    } else if (option.multiple) {
      const items = Array.isArray(raw) ? raw : [raw];
      if (!items.every((item) => typeof item === 'string')) throw usageError(`--input key "${key}" must be a string or a list of strings.`);
      out[key] = items as string[];
    } else {
      if (typeof raw !== 'string' && typeof raw !== 'number') throw usageError(`--input key "${key}" must be a string.`);
      out[key] = String(raw);
    }
  }
  return out;
}

/** `--input` as a raw JSON document, for commands whose input is a request body. */
export async function loadBody(source: string, stdin: NodeJS.ReadableStream): Promise<unknown> {
  let text: string;
  try {
    text = source === '-' ? await readStdin(stdin) : await readFile(source, 'utf8');
  } catch (error) {
    throw usageError(`Cannot read --input ${source}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw usageError('--input must be valid JSON.');
  }
}
