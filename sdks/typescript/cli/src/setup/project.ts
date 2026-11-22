import { access, chmod, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * What `anlyon init` needs to know about the project it runs in: which SDK, how it installs
 * packages, and which file keeps its environment variables. Read from files only; nothing runs.
 */
export interface Project {
  dir: string;
  name: string;
  language: 'typescript' | 'python' | null;
  /** Next.js reads `.env.local` and keeps it out of the client bundle; everything else gets `.env`. */
  framework: 'next' | null;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'uv' | 'poetry' | 'pip' | null;
  /** The SDK is already a dependency. */
  hasSdk: boolean;
  envFile: string;
}

export const TS_SDK = '@anlyonhq/sdk';
export const PY_SDK = 'anlyon';

const exists = (path: string) => access(path).then(() => true, () => false);

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

export async function detectProject(dir: string): Promise<Project> {
  const pkgText = await readText(join(dir, 'package.json'));
  if (pkgText !== undefined) {
    let pkg: { name?: unknown; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      pkg = {};
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const next = 'next' in deps || (await exists(join(dir, 'next.config.js'))) || (await exists(join(dir, 'next.config.mjs'))) || (await exists(join(dir, 'next.config.ts')));
    const packageManager = (await exists(join(dir, 'pnpm-lock.yaml')))
      ? 'pnpm'
      : (await exists(join(dir, 'bun.lockb'))) || (await exists(join(dir, 'bun.lock')))
        ? 'bun'
        : (await exists(join(dir, 'yarn.lock')))
          ? 'yarn'
          : 'npm';
    return {
      dir,
      name: typeof pkg.name === 'string' && pkg.name ? pkg.name : basename(dir),
      language: 'typescript',
      framework: next ? 'next' : null,
      packageManager,
      hasSdk: TS_SDK in deps,
      envFile: next ? '.env.local' : '.env',
    };
  }
  const pyproject = await readText(join(dir, 'pyproject.toml'));
  const requirements = await readText(join(dir, 'requirements.txt'));
  if (pyproject !== undefined || requirements !== undefined) {
    const text = `${pyproject ?? ''}\n${requirements ?? ''}`;
    const packageManager = (await exists(join(dir, 'uv.lock')))
      ? 'uv'
      : (await exists(join(dir, 'poetry.lock'))) || /\[tool\.poetry\]/.test(pyproject ?? '')
        ? 'poetry'
        : 'pip';
    const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(pyproject ?? '')?.[1] ?? basename(dir);
    return {
      dir,
      name,
      language: 'python',
      framework: null,
      packageManager,
      hasSdk: /(^|["'\s,[])anlyon(?![\w-])/m.test(text),
      envFile: '.env',
    };
  }
  return { dir, name: basename(dir), language: null, framework: null, packageManager: null, hasSdk: false, envFile: '.env' };
}

/** The command that adds the SDK, or null when there is nothing to install. Fixed arguments only. */
export function installCommand(project: Project): { command: string; args: string[] } | null {
  switch (project.packageManager) {
    case 'pnpm': return { command: 'pnpm', args: ['add', TS_SDK] };
    case 'yarn': return { command: 'yarn', args: ['add', TS_SDK] };
    case 'bun': return { command: 'bun', args: ['add', TS_SDK] };
    case 'npm': return { command: 'npm', args: ['install', TS_SDK] };
    case 'uv': return { command: 'uv', args: ['add', PY_SDK] };
    case 'poetry': return { command: 'poetry', args: ['add', PY_SDK] };
    case 'pip': return { command: 'pip', args: ['install', PY_SDK] };
    default: return null;
  }
}

/** The line ending a file already uses, so an edit never mixes CRLF and LF. */
export function lineEnding(text: string | undefined): '\r\n' | '\n' {
  return text?.includes('\r\n') ? '\r\n' : '\n';
}

const ENV_LINE = (name: string) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`);

/** The value of one variable in a dotenv file, unquoted, or undefined. */
export function envValue(text: string | undefined, name: string): string | undefined {
  for (const line of (text ?? '').split(/\r?\n/)) {
    const match = ENV_LINE(name).exec(line);
    if (!match) continue;
    const raw = match[1]!.trim();
    const quoted = /^(["'])(.*)\1$/.exec(raw);
    const value = quoted ? quoted[2]! : raw.replace(/\s+#.*$/, '');
    return value || undefined;
  }
  return undefined;
}

export async function readEnvFile(path: string): Promise<string | undefined> {
  return readText(path);
}

/**
 * Set variables in a dotenv file: replace a line that sets one, or append it. Existing lines,
 * comments and line endings are kept. A new file is created readable by its owner only; an
 * existing one is replaced atomically. Values are written, never printed.
 */
export async function setEnvValues(path: string, values: Record<string, string>): Promise<'created' | 'updated' | 'unchanged'> {
  const before = await readText(path);
  const eol = lineEnding(before ?? (process.platform === 'win32' ? '\r\n' : '\n'));
  const lines = before === undefined ? [] : before.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let changed = false;
  for (const [name, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => ENV_LINE(name).test(line));
    const line = `${name}=${value}`;
    if (index === -1) {
      lines.push(line);
      changed = true;
    } else if (envValue(lines[index], name) !== value) {
      lines[index] = line;
      changed = true;
    }
  }
  if (!changed) return 'unchanged';
  const text = `${lines.join(eol)}${eol}`;
  if (before === undefined) {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
    } finally {
      await handle.close();
    }
    return 'created';
  }
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await chmod(path, 0o600).catch(() => {});
  return 'updated';
}

/**
 * Whether .gitignore already keeps this env file out of git, by the usual patterns. Deliberately
 * simple: a pattern it does not recognise means one more line, never a key in a commit.
 */
export function ignoresEnvFile(gitignore: string | undefined, envFile: string): boolean {
  const patterns = (gitignore ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const accepted = new Set(['.env*', '/.env*', '*.env*', '.env.*', '/.env.*', envFile, `/${envFile}`, `**/${envFile}`]);
  if (envFile === '.env.local') for (const pattern of ['.env*.local', '/.env*.local', '*.local', '.env.local*']) accepted.add(pattern);
  return patterns.some((pattern) => accepted.has(pattern));
}

/** Make sure `.env*` files stay out of git. Appends to .gitignore, or creates it. */
export async function ensureEnvIgnored(dir: string, envFile: string): Promise<'present' | 'added'> {
  const path = join(dir, '.gitignore');
  const before = await readText(path);
  if (ignoresEnvFile(before, envFile) && ignoresEnvFile(before, '.env')) return 'present';
  const eol = lineEnding(before ?? '\n');
  const block = ['# Environment files hold keys: never commit them.', '.env*', '!.env.example'].join(eol);
  const text = before === undefined ? `${block}${eol}` : `${before}${before.endsWith('\n') || before === '' ? '' : eol}${eol}${block}${eol}`;
  await writeFile(path, text, 'utf8');
  return 'added';
}

/** `owner` and `repo` from a GitHub `origin` remote in .git/config, for a read-only smoke call. */
export async function gitHubRemote(dir: string): Promise<{ owner: string; repo: string } | null> {
  const config = await readText(join(dir, '.git', 'config'));
  if (!config) return null;
  const section = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] ?? '';
  const url = /^\s*url\s*=\s*(\S+)/m.exec(section)?.[1];
  const match = url ? /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url) : null;
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}
