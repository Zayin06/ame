import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { monacoHighlightFix } from './scripts/monaco-highlight-fix'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('apps/desktop/src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('apps/desktop/src/preload/index.ts'), output: { format: 'cjs', entryFileNames: 'index.cjs' } } }
  },
  renderer: {
    root: resolve('apps/desktop/src/renderer'),
    plugins: [monacoHighlightFix(), react()],
    optimizeDeps: { exclude: ['monaco-editor'] },
    build: { rollupOptions: { input: resolve('apps/desktop/src/renderer/index.html') } },
    server: { host: '127.0.0.1', fs: { allow: [resolve('.')] } }
  }
})
