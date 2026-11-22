import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  name: string;
  bin: Record<string, string>;
};
const binRelative = manifest.bin['anlyon-policy'];

function canSymlinkFiles(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'anlyon-symlink-probe-'));
  try {
    const target = join(dir, 'target');
    mkdirSync(target);
    symlinkSync(join(target, 'missing.js'), join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(entry: string, args: string[]) {
  const env = { ...process.env };
  delete env.ANLYON_API_KEY;
  delete env.ANLYON_BASE_URL;
  const result = spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8', timeout: 30_000 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function expectCliRuns(entry: string) {
  const help = run(entry, ['--help']);
  expect(help.stdout).toContain('Usage:');
  expect(help.code).toBe(0);

  const plan = run(entry, ['plan', 'x.yaml']);
  expect(plan.stderr).toContain('Set ANLYON_API_KEY');
  expect(plan.code).toBe(1);
}

describe('anlyon-policy bin', () => {
  let binPath: string;
  let sandbox: string;

  beforeAll(() => {
    binPath = join(packageRoot, binRelative);
    if (!existsSync(binPath)) {
      const require = createRequire(import.meta.url);
      const tsupPackage = require.resolve('tsup/package.json');
      const tsupBin = (JSON.parse(readFileSync(tsupPackage, 'utf8')) as { bin: Record<string, string> }).bin.tsup;
      execFileSync(process.execPath, [join(dirname(tsupPackage), tsupBin)], { cwd: packageRoot, stdio: 'inherit' });
    }
    sandbox = mkdtempSync(join(tmpdir(), 'anlyon-policy-bin-'));
  }, 180_000);

  afterAll(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  it('is published as an executable with a clean shebang', () => {
    expect(binRelative).toBe('./dist/cli/anlyon-policy.js');
    const firstLine = readFileSync(binPath, 'utf8').split('\n')[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });

  it('runs when started by its real path', () => {
    expectCliRuns(binPath);
  });

  it('runs when the package directory is reached through a link (npm link, pnpm, file: installs)', () => {
    const linkedPackage = join(sandbox, 'node_modules', ...manifest.name.split('/'));
    mkdirSync(dirname(linkedPackage), { recursive: true });
    symlinkSync(packageRoot, linkedPackage, 'junction');
    expectCliRuns(join(linkedPackage, binRelative));
  });

  it.skipIf(!canSymlinkFiles())('runs through a node_modules/.bin symlink (npm on POSIX)', () => {
    const binDir = join(sandbox, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const link = join(binDir, 'anlyon-policy');
    symlinkSync(binPath, link, 'file');
    expectCliRuns(link);
  });
});
