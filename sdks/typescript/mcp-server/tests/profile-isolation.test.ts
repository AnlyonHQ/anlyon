import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
  );

describe('profile isolation', () => {
  it('no core file imports a profile', () => {
    const core = files(src).filter((path) => !relative(src, path).startsWith('profiles/'));
    expect(core.length).toBeGreaterThan(10);
    for (const path of core) {
      expect(readFileSync(path, 'utf8'), relative(src, path)).not.toMatch(/from ['"][^'"]*profiles\//);
    }
  });
});
