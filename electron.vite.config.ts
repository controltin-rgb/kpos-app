import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@main': resolve(__dirname, 'src/main'),
  '@renderer': resolve(__dirname, 'src/renderer'),
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      // better-sqlite3 is a native module: keep it external (loaded from node_modules / app.asar.unpacked)
      externalizeDeps: true,
    },
  },
  preload: {
    resolve: { alias },
    build: {
      // sandboxed preload cannot require() node_modules: bundle everything except electron
      externalizeDeps: false,
      rollupOptions: {
        // sandboxed preload scripts must be CommonJS
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
})
