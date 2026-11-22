import { defineConfig } from 'vite'
export default defineConfig({ build: {
  target: 'node22', emptyOutDir: false, outDir: 'resources/amekit-models',
  lib: { entry: 'packages/amekit-server/src/server.ts', formats: ['es'], fileName: () => 'server.js' },
  rollupOptions: { external: [/^@opencode\//, /^effect(?:\/|$)/, /^node:/] },
} })
