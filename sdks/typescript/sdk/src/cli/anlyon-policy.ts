/**
 * anlyon-policy: approval policies as files.
 *
 *   anlyon-policy plan <file>                          Show what applying the file would change.
 *   anlyon-policy apply <file> --digest <digest>       Apply exactly the plan you reviewed.
 *   anlyon-policy apply <file> --auto-approve          Plan and apply in one step (CI).
 *   anlyon-policy test <file> <cases-file>             Check fixture requests against the file.
 *
 * Options: --note "<why>" (apply), --json (machine-readable output).
 * Environment: ANLYON_API_KEY (an operator key with policies:read / policies:write), ANLYON_BASE_URL.
 *
 * Exit codes: 0 success (plan: no changes; test: all passed), 1 error or refusal,
 *             2 plan has changes to apply, 3 test cases failed.
 *
 * The server parses and checks the file, so this tool and the API can never disagree about it.
 *
 * This module has no side effects on import; the executable entry is ./anlyon-policy-bin.ts,
 * which tsup builds to dist/cli/anlyon-policy.js (the package.json "bin").
 */
import { readFile } from 'node:fs/promises';
import { Client } from '../client';
import type { PolicyFilePlan, PolicyFileTestResult } from '../types/agent';

export interface PolicyCliDeps {
  readFile: (path: string) => Promise<string>;
  policies: {
    planFile(source: string): Promise<{ data?: PolicyFilePlan }>;
    applyFile(source: string, options: { digest: string; changeNote?: string }): Promise<{ data?: PolicyFilePlan & { applied: true } }>;
    testFile(source: string, cases: string): Promise<{ data?: PolicyFileTestResult }>;
  };
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `Usage:
  anlyon-policy plan <file> [--json]
  anlyon-policy apply <file> (--digest <digest> | --auto-approve) [--note "<why>"] [--json]
  anlyon-policy test <file> <cases-file> [--json]

Environment: ANLYON_API_KEY (required), ANLYON_BASE_URL (optional).
Exit codes: 0 ok, 1 error, 2 plan has changes, 3 test failures.`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json' || arg === '--auto-approve' || arg === '--help' || arg === '-h') flags[arg.replace(/^-+/, '')] = true;
    else if (arg === '--digest' || arg === '--note') {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      flags[arg.slice(2)] = value;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { positional, flags };
}

function printPlan(plan: PolicyFilePlan, out: (line: string) => void) {
  out(`Policy file "${plan.file}" in environment ${plan.environmentId}`);
  for (const change of plan.changes) {
    if (change.op === 'create') out(`  + create  ${change.key}  (${change.name})`);
    if (change.op === 'update') out(`  ~ update  ${change.key}  ${change.fields?.join(', ') ?? ''}`);
    if (change.op === 'delete') out(`  - delete  ${change.key}  (${change.policyId})`);
  }
  const { create, update, delete: remove, unchanged } = plan.summary;
  out(`${create} to create, ${update} to update, ${remove} to delete, ${unchanged} unchanged.`);
  for (const error of plan.errors) out(`  ! ${error}`);
  if (!plan.errors.length) out(`digest: ${plan.digest}`);
}

function hasChanges(plan: PolicyFilePlan) {
  return plan.summary.create + plan.summary.update + plan.summary.delete > 0;
}

function describeError(error: unknown): string[] {
  const e = error as { message?: string; status?: number; code?: string; details?: { errors?: unknown } };
  const lines = [`Error${e.status ? ` (${e.status}${e.code ? ` ${e.code}` : ''})` : ''}: ${e.message ?? String(error)}`];
  if (Array.isArray(e.details?.errors)) for (const item of e.details.errors) lines.push(`  ! ${String(item)}`);
  return lines;
}

export async function runPolicyCli(argv: string[], deps: PolicyCliDeps): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    deps.err((error as Error).message);
    deps.err(USAGE);
    return 1;
  }
  const { positional: [command, file, casesFile], flags } = parsed;
  if (flags.help || !command) {
    (flags.help ? deps.out : deps.err)(USAGE);
    return flags.help ? 0 : 1;
  }
  const json = flags.json === true;
  if (!['plan', 'apply', 'test'].includes(command)) {
    deps.err(`Unknown command "${command}".`);
    deps.err(USAGE);
    return 1;
  }
  try {
    if (!file) throw new Error(`${command} needs a policy file.`);
    const source = await deps.readFile(file);

    if (command === 'plan') {
      const plan = (await deps.policies.planFile(source)).data as PolicyFilePlan;
      if (json) deps.out(JSON.stringify(plan, null, 2));
      else printPlan(plan, deps.out);
      if (plan.errors.length) return 1;
      return hasChanges(plan) ? 2 : 0;
    }

    if (command === 'apply') {
      const note = typeof flags.note === 'string' ? flags.note : undefined;
      let digest = typeof flags.digest === 'string' ? flags.digest : undefined;
      if (!digest && flags['auto-approve'] !== true) {
        throw new Error('apply needs --digest from a plan you reviewed, or --auto-approve to plan and apply in one step.');
      }
      if (!digest) {
        const plan = (await deps.policies.planFile(source)).data as PolicyFilePlan;
        if (!json) printPlan(plan, deps.out);
        if (plan.errors.length) return 1;
        if (!hasChanges(plan)) {
          if (!json) deps.out('Nothing to apply.');
          else deps.out(JSON.stringify({ ...plan, applied: false }, null, 2));
          return 0;
        }
        digest = plan.digest;
      }
      const applied = (await deps.policies.applyFile(source, { digest, ...(note ? { changeNote: note } : {}) })).data as PolicyFilePlan;
      if (json) deps.out(JSON.stringify(applied, null, 2));
      else {
        const { create, update, delete: remove } = applied.summary;
        deps.out(`Applied "${applied.file}": ${create} created, ${update} updated, ${remove} deleted.`);
      }
      return 0;
    }

    if (command === 'test') {
      if (!casesFile) throw new Error('test needs a cases file.');
      const result = (await deps.policies.testFile(source, await deps.readFile(casesFile))).data as PolicyFileTestResult;
      if (json) deps.out(JSON.stringify(result, null, 2));
      else {
        deps.out('Policy-only results: action approval floors and execution admission checks are not evaluated.');
        for (const r of result.results) {
          deps.out(`  ${r.pass ? 'pass' : 'FAIL'}  ${r.name}  -> ${r.effect}${r.policy ? ` by ${r.policy}` : ' (no policy matched)'}`);
        }
        deps.out(`${result.passed} passed, ${result.failed} failed.`);
      }
      return result.failed ? 3 : 0;
    }

    return 1;
  } catch (error) {
    for (const line of describeError(error)) deps.err(line);
    if (error instanceof Error && / needs /.test(error.message)) deps.err(USAGE);
    return 1;
  }
}

/** Runs the CLI against the real process: argv, environment, stdio and exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<never> {
  const apiKey = process.env.ANLYON_API_KEY;
  const offline = !argv.length || argv.includes('--help') || argv.includes('-h') || !['plan', 'apply', 'test'].includes(argv[0]);
  if (!apiKey && !offline) {
    process.stderr.write('Set ANLYON_API_KEY to an operator key with policies:read (and policies:write to apply).\n');
    process.exit(1);
  }
  const client = apiKey
    ? new Client({ apiKey, ...(process.env.ANLYON_BASE_URL ? { baseUrl: process.env.ANLYON_BASE_URL } : {}) })
    : undefined;
  const code = await runPolicyCli(argv, {
    readFile: (path) => readFile(path, 'utf8'),
    policies: client?.approvalPolicies ?? offlinePolicies,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
  process.exit(code);
}

const offline = async (): Promise<never> => {
  throw new Error('Set ANLYON_API_KEY to an operator key with policies:read (and policies:write to apply).');
};
const offlinePolicies: PolicyCliDeps['policies'] = { planFile: offline, applyFile: offline, testFile: offline };
