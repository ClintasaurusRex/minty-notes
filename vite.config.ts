import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import { mintyServiceWorker } from './build/serviceWorkerPlugin.ts'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// https://vite.dev/config/
export default defineConfig({
  // Relative URLs let the static build run from any stable HTTPS path.
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    mintyServiceWorker(),
  ],
})
