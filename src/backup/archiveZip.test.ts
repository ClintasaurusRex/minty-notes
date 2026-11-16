import { afterEach, describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { WORKER_STOPPED_MESSAGE, zipAsync } from './archiveZip'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

const files = () => ({ 'original.bin': [new Uint8Array([1, 2, 3, 255]), { level: 0 }] as [Uint8Array, { level: 0 }], 'records.json': new TextEncoder().encode('{"hello":"minty"}') })

/** Bytes no real ZIP writer produces: if they come back, the worker's reply was used. */
const WORKER_BYTES = new Uint8Array([9, 8, 7, 6])

type Script = (w: FakeWorker) => void
/** A scriptable stand-in for the module worker; `startup` runs as the module would load. */
class FakeWorker {
  static startup: Script = () => {}
  static onPost: Script = () => {}
  static instances: FakeWorker[] = []
  onmessage?: (e: { data: unknown }) => void
  onerror?: (e: { preventDefault: () => void }) => void
  onmessageerror?: () => void
  posted: unknown[] = []
  terminate = vi.fn()
  constructor() {
    FakeWorker.instances.push(this)
    queueMicrotask(() => FakeWorker.startup(this))
  }
  postMessage(data: unknown) {
    this.posted.push(data)
    queueMicrotask(() => FakeWorker.onPost(this))
  }
  ready() { this.onmessage?.({ data: { ready: true } }) }
  crash() { this.onerror?.({ preventDefault: vi.fn() }) }
}

function useFakeWorker(startup: Script, onPost: Script = () => {}) {
  FakeWorker.startup = startup
  FakeWorker.onPost = onPost
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
}

describe('ZIP worker and fallback', () => {
  it('keeps the existing ZIP contents when workers are unavailable', async () => {
    vi.stubGlobal('Worker', undefined)
    const input = files()
    const unpacked = unzipSync(await zipAsync(input))
    expect(unpacked['original.bin']).toEqual(new Uint8Array([1, 2, 3, 255]))
    expect(new TextDecoder().decode(unpacked['records.json'])).toBe('{"hello":"minty"}')
    expect(input['original.bin'][0]).toEqual(new Uint8Array([1, 2, 3, 255]))
  })

  it('falls back when creating a worker is blocked', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new DOMException('Blocked', 'SecurityError') } })
    expect(unzipSync(await zipAsync(files()))['original.bin']).toEqual(new Uint8Array([1, 2, 3, 255]))
  })

  it('falls back only when the module fails before reporting ready, without detaching input', async () => {
    useFakeWorker((w) => w.crash())
    const input = files()
    expect(unzipSync(await zipAsync(input))['original.bin']).toEqual(input['original.bin'][0])
    const [worker] = FakeWorker.instances
    expect(worker.posted).toHaveLength(0) // nothing was handed over, so nothing was built
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('posts files only after ready and returns the worker’s own bytes', async () => {
    useFakeWorker((w) => w.ready(), (w) => w.onmessage?.({ data: { ok: true, bytes: WORKER_BYTES } }))
    const input = files()
    expect(await zipAsync(input)).toBe(WORKER_BYTES)
    const [worker] = FakeWorker.instances
    expect(worker.posted).toEqual([input])
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it.each([
    ['an error event', (w: FakeWorker) => w.crash()],
    ['an unreadable reply', (w: FakeWorker) => w.onmessageerror?.()],
  ])('rejects without a main-thread rebuild after a runtime crash (%s)', async (_label, crash) => {
    useFakeWorker((w) => w.ready(), crash)
    await expect(zipAsync(files())).rejects.toThrow(WORKER_STOPPED_MESSAGE)
    expect(FakeWorker.instances).toHaveLength(1)
    expect(FakeWorker.instances[0].posted).toHaveLength(1)
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce()
  })

  it('rejects when the files cannot be handed to a started worker', async () => {
    useFakeWorker((w) => {
      w.postMessage = () => { throw new DOMException('Out of memory', 'DataCloneError') }
      w.ready()
    })
    await expect(zipAsync(files())).rejects.toThrow(/could not be handed to the background writer/)
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce()
  })

  it('propagates a writer failure and terminates without retrying another writer', async () => {
    useFakeWorker((w) => w.ready(), (w) => w.onmessage?.({ data: { ok: false, error: 'Synthetic writer failure' } }))
    await expect(zipAsync(files())).rejects.toThrow('Synthetic writer failure')
    expect(FakeWorker.instances).toHaveLength(1)
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce()
  })

  it.each([
    ['before ready', () => {}],
    ['after ready', (w: FakeWorker) => w.ready()],
  ])('stops a hung worker (%s) without leaving the operation busy or retrying on the UI thread', async (_label, startup) => {
    vi.useFakeTimers()
    useFakeWorker(startup)
    const result = zipAsync(files())
    const rejected = expect(result).rejects.toThrow('took too long')
    await vi.advanceTimersByTimeAsync(300_000)
    await rejected
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce()
  })

  it('ignores a late crash after the reply was used', async () => {
    useFakeWorker((w) => w.ready(), (w) => {
      w.onmessage?.({ data: { ok: true, bytes: WORKER_BYTES } })
      w.crash()
    })
    expect(await zipAsync(files())).toBe(WORKER_BYTES)
  })
})
