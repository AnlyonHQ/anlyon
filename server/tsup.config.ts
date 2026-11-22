import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'tsup';

function copyExtensionManifests(): void {
  const from = 'src/extensions';
  if (!existsSync(from)) return;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const manifest = join(from, entry.name, 'extension.json');
    if (!entry.isDirectory() || !existsSync(manifest)) continue;
    mkdirSync(join('dist', 'extensions', entry.name), { recursive: true });
    copyFileSync(manifest, join('dist', 'extensions', entry.name, 'extension.json'));
  }
}

export default defineConfig({
  entry: ['src/index.ts', 'src/extensions/*/index.ts', 'src/db/migrate.ts', 'src/scripts/setup-log-partitions.ts', 'src/scripts/setup-pgvector.ts', 'src/scripts/reencrypt-secret-envelopes.ts', 'src/scripts/create-admin.ts', 'src/scripts/encrypt-sso-secrets.ts', 'src/scripts/backfill-audit-events.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  splitting: true,
  sourcemap: false,
  minify: false,
  bundle: true,

  noExternal: ['@anlyon/feature-flags', '@anlyon-dev/risk', '@anlyon/known-vendors'],
  treeshake: true,
  dts: false,
  onSuccess: async () => copyExtensionManifests(),
  esbuildOptions(options) {
    options.allowOverwrite = true;
  },
});









