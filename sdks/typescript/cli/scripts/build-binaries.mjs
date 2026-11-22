#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist', 'anlyon.js');
const outDir = join(root, 'dist', 'bin');
const ALL = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'];

const hostTarget = () => {
  const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform];
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
  if (!os || !arch) throw new Error(`No binary target for ${process.platform}/${process.arch}`);
  return `${os}-${arch}`;
};

let targets = process.argv.slice(2);
if (targets.length === 0) targets = ALL;
targets = targets.map((t) => (t === 'host' ? hostTarget() : t));
for (const t of targets) if (!ALL.includes(t)) throw new Error(`Unknown target ${t}; expected one of ${ALL.join(', ')} or host`);
if (!existsSync(entry)) throw new Error('dist/anlyon.js is missing; run `pnpm build` first.');

mkdirSync(outDir, { recursive: true });
const sums = [];
for (const target of targets) {
  const outfile = join(outDir, `anlyon-${target}${target.startsWith('windows') ? '.exe' : ''}`);
  const result = spawnSync('bun', ['build', entry, '--compile', `--target=bun-${target}`, '--outfile', outfile], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`bun build --compile failed for ${target}`);
  const digest = createHash('sha256').update(readFileSync(outfile)).digest('hex');
  sums.push(`${digest}  ${outfile.slice(outDir.length + 1)}`);
  console.log(`built ${outfile}`);
}
writeFileSync(join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
