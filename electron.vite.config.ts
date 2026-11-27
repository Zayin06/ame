import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { monacoHighlightFix } from './scripts/monaco-highlight-fix'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: {
      index: resolve('apps/desktop/src/main/index.ts'),
      'ts-lsp-worker': resolve('packages/ide-core/src/ts-lsp-worker.ts'),
      'search-worker': resolve('packages/ide-core/src/search-worker.ts')
    } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: {
      index: resolve('apps/desktop/src/preload/index.ts'),
      pet: resolve('apps/desktop/src/preload/pet.ts')
    }, output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: {
    root: resolve('apps/desktop/src/renderer'),
    plugins: [monacoHighlightFix(), react(), { name: 'prod-csp', apply: 'build', transformIndexHtml(html) { return html.replace(/ ws:\/\/localhost:\* ws:\/\/127\.0\.0\.1:\*/g, '') } }],
    optimizeDeps: { exclude: ['monaco-editor'] },
    build: { rollupOptions: { input: resolve('apps/desktop/src/renderer/index.html') } },
    server: { host: '127.0.0.1', fs: { allow: [resolve('.')] } }
  }
})
