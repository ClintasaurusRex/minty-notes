import { defineConfig } from 'vitest/config'

// Unit and integration tests run in Node with fake-indexeddb.
// Rich-text validation uses the ProseMirror schema, which needs no DOM.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify('test') },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
  },
})
