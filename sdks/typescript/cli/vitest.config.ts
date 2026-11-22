import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const cli = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const sdk = JSON.parse(readFileSync(new URL('../sdk/package.json', import.meta.url), 'utf8'));

export default defineConfig({
  resolve: { alias: { '@anlyonhq/sdk': fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url)) } },
  define: {
    __ANLYON_CLI_VERSION__: JSON.stringify(cli.version),
    __ANLYON_SDK_VERSION__: JSON.stringify(sdk.version),
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
