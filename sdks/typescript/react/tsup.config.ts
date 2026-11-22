import { copyFile, mkdir } from 'node:fs/promises';
import { defineConfig } from 'tsup';

const shared = {
  format: ['cjs', 'esm'] as const,
  dts: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  minify: false,
  target: 'es2022',
  outDir: 'dist',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
};

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    clean: true,
    treeshake: false,
    banner: { js: '"use client";' },
    async onSuccess() {
      await mkdir('dist', { recursive: true });
      await copyFile('src/styles.css', 'dist/styles.css');
    },
  },
  {
    ...shared,
    entry: { server: 'src/server.ts' },
    clean: false,
  },
]);
