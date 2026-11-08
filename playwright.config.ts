import { defineConfig, devices } from '@playwright/test'

// Browser checks run against the production build (service worker included)
// served by `vite preview` at a stable local origin.
const PORT = 4173

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    // Date fields take keys in the browser's own locale order (Chromium on Linux reads
    // it from LANG); the tests type US month/day/year, so the browser runs in en-US.
    locale: 'en-US',
    launchOptions: { env: { ...process.env, LANG: 'en_US.UTF-8', LANGUAGE: 'en_US:en' } },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
})
