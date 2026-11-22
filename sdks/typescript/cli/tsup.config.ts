import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const cli = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const sdk = JSON.parse(readFileSync(new URL('../sdk/package.json', import.meta.url), 'utf8'));

export default defineConfig({
  entry: { anlyon: 'src/bin.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: false,
  noExternal: [/.*/],
  banner: {
    js: ['#!/usr/bin/env node', "import { createRequire as __anlyonCreateRequire } from 'node:module';", 'const require = __anlyonCreateRequire(import.meta.url);'].join('\n'),
  },
  define: {
    __ANLYON_CLI_VERSION__: JSON.stringify(cli.version),
    __ANLYON_SDK_VERSION__: JSON.stringify(sdk.version),
  },
});
