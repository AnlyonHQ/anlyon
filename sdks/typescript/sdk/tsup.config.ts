import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    nextjs: 'src/nextjs/index.ts',
    hono: 'src/hono/index.ts',
    'cloudflare-workers': 'src/cloudflare-workers/index.ts',
    express: 'src/express/index.ts',
    fastify: 'src/fastify/index.ts',
    sveltekit: 'src/sveltekit/index.ts',
    h3: 'src/h3/index.ts',
    'types/index': 'src/types/index.ts',
    'cli/anlyon-policy': 'src/cli/anlyon-policy-bin.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minify: false,
  target: 'es2022',
  outDir: 'dist',
  external: [
    'zod',
    'next',
    'hono',
    'express',
    'fastify',
    '@sveltejs/kit',
    'h3',
  ],
});
