import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
      '@renderer': resolve(import.meta.dirname, 'src/renderer'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // better-sqlite3 is compiled for Electron's ABI, so tests run inside Electron's Node
    // (see the "test" npm script: ELECTRON_RUN_AS_NODE=1).
    pool: 'forks',
  },
})
