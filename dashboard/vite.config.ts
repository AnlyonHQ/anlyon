import { defineConfig } from 'vitest/config'
import { devtools } from '@tanstack/devtools-vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import type { Plugin } from 'vite'

function extensionCsp(): Plugin {
  const root = fileURLToPath(new URL('./src/extensions', import.meta.url))
  const sources = new Map<string, string[]>()
  if (existsSync(root)) {
    for (const name of readdirSync(root).sort()) {
      const file = join(root, name, 'csp.json')
      if (!existsSync(file)) continue
      const extra = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      for (const [directive, list] of Object.entries(extra)) {
        if (!Array.isArray(list)) continue
        sources.set(directive, [...(sources.get(directive) ?? []), ...list.map(String)])
      }
    }
  }
  return cspPlugin('anlyon-extension-csp', sources)
}

function devCsp(): Plugin {
  const sources = new Map<string, string[]>([
    ['script-src', ["'unsafe-inline'", "'unsafe-eval'"]],
    ['connect-src', ['http://localhost:4000', 'ws:', 'wss:']],
  ])
  const plugin = cspPlugin('anlyon-dev-csp', sources)
  return {
    ...plugin,
    apply: 'serve',
    configResolved(config) {
      const api = config.env.VITE_API_BASE_URL
      if (typeof api === 'string' && /^https?:\/\//.test(api)) {
        sources.get('connect-src')!.push(new URL(api).origin)
      }
    },
  }
}

function cspPlugin(name: string, sources: Map<string, string[]>): Plugin {
  return {
    name,
    transformIndexHtml(html) {
      if (sources.size === 0) return html
      return html.replace(
        /(http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/,
        (_, open: string, policy: string, close: string) =>
          open +
          policy
            .split(';')
            .map((part) => {
              const directive = part.trim().split(/\s+/)[0]
              const extra = sources.get(directive)
              return extra ? `${part.trimEnd()} ${extra.join(' ')}` : part
            })
            .join(';') +
          close,
      )
    },
  }
}

export default defineConfig({
  plugins: [
    devtools(),
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    viteReact(),
    tailwindcss(),
    extensionCsp(),
    devCsp(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    chunkSizeWarningLimit: 1000,
  },
  test: {
    setupFiles: ['./src/test-setup.ts'],
  },
})
