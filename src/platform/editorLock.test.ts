import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorLock, type EditorLockHooks, type HandoverResult } from './editorLock'

/**
 * Minimal Web Locks stand-in for one exclusive lock: ifAvailable, signal
 * (abort while waiting), and steal (the previous holder's request rejects).
 */
class FakeLocks {
  private holder: { reject: (e: unknown) => void; done: boolean } | null = null
  private queue: { run: () => void; reject: (e: unknown) => void }[] = []

  request(_name: string, options: LockOptions, callback: (lock: Lock | null) => unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const run = () => {
        const entry = { reject, done: false }
        this.holder = entry
        Promise.resolve(callback({ name: 'x', mode: 'exclusive' } as Lock)).then((v) => {
          if (entry.done) return
          entry.done = true
          if (this.holder === entry) {
            this.holder = null
            this.queue.shift()?.run()
          }
          resolve(v)
        })
      }
      if (options.steal) {
        const old = this.holder
        if (old && !old.done) {
          old.done = true
          old.reject(new DOMException('stolen', 'AbortError'))
        }
        run()
        return
      }
      if (!this.holder) return run()
      if (options.ifAvailable) {
        Promise.resolve(callback(null)).then(resolve)
        return
      }
      const waiter = { run, reject }
      options.signal?.addEventListener('abort', () => {
        this.queue = this.queue.filter((w) => w !== waiter)
        reject(new DOMException('aborted', 'AbortError'))
      })
      this.queue.push(waiter)
    })
  }

  get held(): boolean {
    return this.holder !== null
  }
}

const locks: EditorLock[] = []
afterEach(() => {
  for (const l of locks.splice(0)) l.dispose()
})

function hooks(overrides: Partial<EditorLockHooks> = {}) {
  const h = {
    beforeRelease: vi.fn(async (): Promise<HandoverResult> => ({ ok: true })),
    afterAcquire: vi.fn(async () => undefined),
    onLost: vi.fn(),
    onRemoteSave: vi.fn(),
    onRefused: vi.fn(),
    ...overrides,
  }
  return h
}

function windowPair(channelName: string, fake: FakeLocks, a: ReturnType<typeof hooks>, b: ReturnType<typeof hooks>, aMuted = false) {
  const opts = { locks: fake as unknown as LockManager, ackTimeoutMs: 40, handoverTimeoutMs: 2000 }
  const lockA = new EditorLock(a, { ...opts, channel: aMuted ? null : new BroadcastChannel(channelName) })
  const lockB = new EditorLock(b, { ...opts, channel: new BroadcastChannel(channelName) })
  locks.push(lockA, lockB)
  return { lockA, lockB }
}

let n = 0
const channelName = () => `minty-test-${n++}`

describe('editor handover', () => {
  it('hands over after the editor saves', async () => {
    const fake = new FakeLocks()
    const a = hooks()
    const b = hooks()
    const { lockA, lockB } = windowPair(channelName(), fake, a, b)
    expect(await lockA.start()).toBe('editor')
    expect(await lockB.start()).toBe('read-only')
    expect(await lockB.takeOver()).toEqual({ ok: true })
    expect(a.beforeRelease).toHaveBeenCalledOnce()
    expect(b.afterAcquire).toHaveBeenCalledOnce()
    expect(lockA.getState()).toBe('read-only')
    expect(lockB.getState()).toBe('editor')
    expect(a.onLost).not.toHaveBeenCalled()
  })

  it('is refused (and nothing is stolen) when the editor cannot save', async () => {
    const fake = new FakeLocks()
    const a = hooks({ beforeRelease: vi.fn(async (): Promise<HandoverResult> => ({ ok: false, reason: 'disk full' })) })
    const b = hooks()
    const { lockA, lockB } = windowPair(channelName(), fake, a, b)
    await lockA.start()
    await lockB.start()
    const result = await lockB.takeOver()
    expect(result).toEqual({ ok: false, reason: 'disk full' })
    expect(lockA.getState()).toBe('editor')
    expect(lockB.getState()).toBe('read-only')
    expect(a.onRefused).toHaveBeenCalledWith('disk full')
    expect(a.onLost).not.toHaveBeenCalled()
    expect(b.afterAcquire).not.toHaveBeenCalled()
    // takeOver has finished and cleared its timers, so no later steal can happen.
    expect(fake.held).toBe(true)
  })

  it('treats a thrown save error as a refusal', async () => {
    const fake = new FakeLocks()
    const a = hooks({ beforeRelease: vi.fn(async (): Promise<HandoverResult> => Promise.reject(new Error('boom'))) })
    const b = hooks()
    const { lockA, lockB } = windowPair(channelName(), fake, a, b)
    await lockA.start()
    await lockB.start()
    expect(await lockB.takeOver()).toEqual({ ok: false, reason: 'boom' })
    expect(lockA.getState()).toBe('editor')
  })

  it('takes over from a frozen editor and tells it that editing was lost', async () => {
    const fake = new FakeLocks()
    const a = hooks()
    const b = hooks()
    const { lockA, lockB } = windowPair(channelName(), fake, a, b, true) // A never hears requests
    await lockA.start()
    await lockB.start()
    expect(await lockB.takeOver()).toEqual({ ok: true })
    expect(lockB.getState()).toBe('editor')
    await vi.waitFor(() => expect(a.onLost).toHaveBeenCalledOnce())
    expect(lockA.getState()).toBe('read-only')
    expect(a.beforeRelease).not.toHaveBeenCalled()
  })

  it('gives the lock back if preparing to edit fails', async () => {
    const fake = new FakeLocks()
    const a = hooks()
    const b = hooks({ afterAcquire: vi.fn(async () => Promise.reject(new Error('storage unavailable'))) })
    const { lockA, lockB } = windowPair(channelName(), fake, a, b)
    await lockA.start()
    await lockB.start()
    expect(await lockB.takeOver()).toEqual({ ok: false, reason: 'storage unavailable' })
    expect(lockB.getState()).toBe('read-only')
    expect(fake.held).toBe(false)
  })
})
