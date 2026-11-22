import { defineConfig } from 'tsup';

const shared = {
  format: ['esm'] as const,
  dts: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  minify: false,
  target: 'es2022' as const,
  outDir: 'dist',
  external: ['@anlyonhq/sdk', '@modelcontextprotocol/sdk'],
};

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    clean: true,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    ...shared,
    entry: { lib: 'src/lib.ts', 'profiles/openai': 'src/profiles/openai/index.ts' },
    clean: false,
  },
]);
