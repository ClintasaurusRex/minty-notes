import type * as Fflate from 'fflate'

/**
 * Counts every way the ZIP library can decompress, so a test can state that
 * an archive was refused WITHOUT anything being decompressed — not merely
 * that it was refused in the end. Use it in a test file with:
 *
 *   vi.mock('fflate', async (original) => (await import('../test/countingFflate')).countingFflate(await original()))
 *
 * and read `work` (reset it with `resetWork()`).
 */
export const work = { inflaters: 0, compressedBytesIn: 0, bytesOut: 0, bulkCalls: 0 }

export const NOTHING_DECOMPRESSED = { inflaters: 0, compressedBytesIn: 0, bytesOut: 0, bulkCalls: 0 }

export function resetWork(): void {
  work.inflaters = work.compressedBytesIn = work.bytesOut = work.bulkCalls = 0
}

export function countingFflate(real: typeof Fflate): typeof Fflate {
  class CountingInflate extends real.Inflate {
    private sink: ((chunk: Uint8Array, final: boolean) => void) | undefined
    constructor() {
      super()
      work.inflaters++
      // The reader assigns `ondata` afterwards; whatever it assigns is counted on the way through.
      Object.defineProperty(this, 'ondata', {
        configurable: true,
        get: () => (chunk: Uint8Array, final: boolean) => {
          work.bytesOut += chunk.byteLength
          this.sink?.(chunk, final)
        },
        set: (fn: (chunk: Uint8Array, final: boolean) => void) => {
          this.sink = fn
        },
      })
    }
    push(chunk: Uint8Array, final?: boolean) {
      work.compressedBytesIn += chunk.byteLength
      super.push(chunk, final)
    }
  }
  const counted = <F extends (...args: never[]) => unknown>(fn: F): F =>
    ((...args: Parameters<F>) => {
      work.bulkCalls++
      return fn(...args)
    }) as F
  // No bulk call may ever be used on an untrusted archive: everything goes through the bounded reader.
  return {
    ...real,
    Inflate: CountingInflate as unknown as typeof real.Inflate,
    unzip: counted(real.unzip),
    unzipSync: counted(real.unzipSync),
    inflateSync: counted(real.inflateSync),
    inflate: counted(real.inflate),
    decompressSync: counted(real.decompressSync),
    decompress: counted(real.decompress),
  }
}
