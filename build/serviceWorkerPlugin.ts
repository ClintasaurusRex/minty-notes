import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? listFiles(full) : [full]
  })
}

/**
 * Writes dist/sw.js after the build with the exact list of output files to
 * precache. The version is a hash of their contents, so any change produces
 * a new worker that the app offers as an update.
 */
export function mintyServiceWorker(): Plugin {
  let outDir = 'dist'
  return {
    name: 'minty-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const files = listFiles(outDir)
        .map((f) => relative(outDir, f).split(sep).join('/'))
        .filter((f) => f !== 'sw.js' && !f.endsWith('.map'))
        .sort()
      const hash = createHash('sha256')
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)))
      const version = hash.digest('hex').slice(0, 16)
      const template = readFileSync(resolve(import.meta.dirname, 'sw-template.js'), 'utf8')
      const assets = JSON.stringify(files.map((f) => `./${f}`))
      writeFileSync(join(outDir, 'sw.js'), template.replace('__VERSION__', version).replace('__ASSETS__', assets))
    },
  }
}
