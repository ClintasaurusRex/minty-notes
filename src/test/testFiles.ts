/**
 * Read fixture files in unit tests (Vitest runs in Node). The app's TypeScript
 * program has no Node types on purpose, so `node:fs` is loaded untyped and
 * given the two functions the tests use.
 */
interface NodeFs {
  readFileSync(path: URL): Uint8Array
  readdirSync(path: URL): string[]
}

const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as NodeFs

/** The bytes of a file (as a plain Uint8Array of its own). */
export const readTestFile = (url: URL): Uint8Array => new Uint8Array(fs.readFileSync(url))

/** Names of the files in a folder that end with `extension`, sorted. */
export const listTestFiles = (dir: URL, extension: string): string[] => fs.readdirSync(dir).filter((name) => name.endsWith(extension)).sort()

/** Node's Buffer for a byte array (some libraries want one in Node). */
export const nodeBuffer = (bytes: Uint8Array): unknown => (globalThis as unknown as { Buffer: { from(b: Uint8Array): unknown } }).Buffer.from(bytes)
