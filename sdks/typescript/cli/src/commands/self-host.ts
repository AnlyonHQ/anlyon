import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { CliError, usageError } from '../errors';
import { EXIT } from '../exit-codes';
import { registerSecret } from '../redact';
import {
  EnvFileExistsError,
  generateSecrets,
  parsePublicAddress,
  renderEnvFile,
  setupUrl,
  writeEnvFile,
  type PublicAddress,
} from '../self-host/env-file';
import type { CommandContext, CommandSpec } from './types';

const DEFAULT_DIR = join('deploy', 'self-host');

function interactive(ctx: CommandContext): boolean {
  return Boolean((ctx.rt.stdin as { isTTY?: boolean }).isTTY) && !ctx.globals.noInput && ctx.options.yes !== true;
}

async function ask(ctx: CommandContext, question: string): Promise<string> {
  const rl = createInterface({ input: ctx.rt.stdin, output: ctx.rt.streams.stderr });
  try {
    return await new Promise<string>((done) => rl.question(question, done));
  } finally {
    rl.close();
  }
}

async function publicAddress(ctx: CommandContext): Promise<PublicAddress> {
  const given = ctx.options.domain;
  if (typeof given === 'string') {
    const address = parsePublicAddress(given);
    if (!address) throw usageError(`--domain must be a host name such as anlyon.example.com or localhost:8080, not "${given}".`);
    return address;
  }
  if (!interactive(ctx)) return parsePublicAddress('localhost')!;
  for (;;) {
    const answer = (await ask(ctx, 'Public domain for this install (anlyon.example.com, or press Enter for localhost:8080): ')).trim();
    const address = parsePublicAddress(answer || 'localhost');
    if (address) return address;
    ctx.out.warn(`"${answer}" is not a host name. Try again.`);
  }
}

async function dockerComposeUp(dir: string): Promise<number> {
  return new Promise((done) => {
    const child = spawn('docker', ['compose', 'up', '-d', '--build'], { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', () => done(127));
    child.on('exit', (code) => done(code ?? 1));
  });
}

/**
 * `anlyon self-host init`: one command from a checkout to a running install. Asks only for the
 * public domain, writes deploy/self-host/.env with fresh secrets (owner-only permissions, never
 * printed), optionally starts the containers, and prints the setup URL that creates the first
 * owner. Everything else is configured in the console.
 */
export const selfHostInit: CommandSpec = {
  path: ['self-host', 'init'],
  summary: 'Write a self-hosted install\'s .env with fresh secrets and print its setup URL.',
  options: {
    domain: { type: 'string', description: 'Public domain, e.g. anlyon.example.com (HTTPS) or localhost:8080 (HTTP). Asked for when omitted.' },
    dir: { type: 'string', description: `Directory holding docker-compose.yml (default: ${DEFAULT_DIR}).` },
    edition: { type: 'string', choices: ['community', 'team', 'enterprise'], description: 'Edition to run (default: community).' },
    up: { type: 'boolean', description: 'Start it with `docker compose up -d --build` afterwards.' },
    force: { type: 'boolean', description: 'Replace an existing .env. Makes a new root key: secrets stored under the old one become unreadable.' },
    yes: { type: 'boolean', description: 'Do not prompt: localhost unless --domain is given, and start only with --up.' },
  },
  async run(ctx) {
    if (ctx.args.length) throw usageError('self-host init takes no arguments.');
    const dir = resolve(typeof ctx.options.dir === 'string' ? ctx.options.dir : DEFAULT_DIR);
    const isDir = await stat(dir).then((info) => info.isDirectory(), () => false);
    if (!isDir) {
      throw usageError(`${dir} does not exist.`, 'Run this from a checkout of the Anlyon repository, or pass --dir with the folder that holds docker-compose.yml.');
    }
    const hasCompose = await access(join(dir, 'docker-compose.yml')).then(() => true, () => false);
    if (!hasCompose) ctx.out.warn(`${dir} has no docker-compose.yml; the .env is written there anyway.`);

    const address = await publicAddress(ctx);
    const secrets = generateSecrets();
    for (const secret of [secrets.rootKey, secrets.postgresPassword]) registerSecret(secret);
    const envPath = join(dir, '.env');
    const edition = (typeof ctx.options.edition === 'string' ? ctx.options.edition : 'community') as 'community' | 'team' | 'enterprise';

    try {
      await writeEnvFile(envPath, renderEnvFile({ address, secrets, edition }), ctx.options.force === true);
    } catch (error) {
      if (error instanceof EnvFileExistsError) {
        throw new CliError('ENV_FILE_EXISTS', `${envPath} already exists. Nothing was changed.`, EXIT.USAGE, {
          hint: 'It holds this install\'s root key. Pass --force only to start over: a new root key makes secrets stored under the old one unreadable.',
        });
      }
      throw error;
    }

    let start = ctx.options.up === true;
    if (!start && interactive(ctx) && hasCompose) {
      start = /^(y(es)?)?$/i.test((await ask(ctx, 'Start it now with docker compose? [Y/n] ')).trim());
    }
    let started = false;
    if (start) {
      ctx.out.info('Starting: docker compose up -d --build (the first build takes a few minutes)...');
      const code = await dockerComposeUp(dir);
      if (code !== 0) {
        throw new CliError('COMPOSE_FAILED', `docker compose exited with ${code}. The .env was written; fix the problem and run \`docker compose up -d --build\` in ${dir}.`, EXIT.ERROR);
      }
      started = true;
    }

    const url = setupUrl(address, secrets.setupToken);
    if (ctx.out.json) return ctx.out.result({ envFile: envPath, publicUrl: address.url, setupUrl: url, started });
    ctx.out.line(`Wrote ${envPath} (readable by you only). It holds the root key: copy ANLYON_ROOT_KEY to a password manager.`);
    if (!started) ctx.out.line(`Start it:  cd ${dir} && docker compose up -d --build`);
    ctx.out.line('');
    ctx.out.line('Then open this URL to create the first owner (it works once):');
    ctx.out.line(`  ${url}`);
    ctx.out.line('');
    ctx.out.line('Everything else (email, storage, sign-up, licence, telemetry, OAuth apps) is set in the console.');
  },
};

export const selfHostCommands: CommandSpec[] = [selfHostInit];
