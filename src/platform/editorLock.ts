/**
 * Single-editor coordination between windows of the same workspace.
 * The first window takes an exclusive Web Lock and edits; other windows
 * open read-only and can ask to take over editing.
 */
export type LockState = 'acquiring' | 'editor' | 'read-only' | 'unsupported'

const LOCK_NAME = 'minty-notes:editor'
const CHANNEL = 'minty-notes'
const TAKEOVER_TIMEOUT_MS = 3000

type Message = { type: 'takeover' } | { type: 'saved' }

export interface EditorLockHooks {
  /** Save pending edits before giving up the lock. */
  beforeRelease: () => Promise<void>
  /** Reload stored data after gaining the lock. */
  afterAcquire: () => Promise<void>
  /** Another window saved changes (read-only windows refresh). */
  onRemoteSave: () => void
}

export class EditorLock {
  private state: LockState = 'acquiring'
  private readonly listeners = new Set<() => void>()
  private release: (() => void) | null = null
  private readonly channel: BroadcastChannel | null
  private readonly hooks: EditorLockHooks

  constructor(hooks: EditorLockHooks) {
    this.hooks = hooks
    this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null
    this.channel?.addEventListener('message', (e: MessageEvent<Message>) => void this.onMessage(e.data))
  }

  getState = (): LockState => this.state
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  private set(state: LockState): void {
    this.state = state
    for (const l of this.listeners) l()
  }

  get supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.locks
  }

  /** Try to become the editor without waiting. */
  async start(): Promise<LockState> {
    if (!this.supported) {
      this.set('unsupported')
      return this.state
    }
    const acquired = await new Promise<boolean>((resolve) => {
      navigator.locks
        .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false)
            return null
          }
          resolve(true)
          return this.holdUntilReleased()
        })
        .catch(() => this.lostLock())
    })
    this.set(acquired ? 'editor' : 'read-only')
    return this.state
  }

  private holdUntilReleased(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.release = resolve
    })
  }

  private lostLock(): void {
    this.release = null
    if (this.state === 'editor') this.set('read-only')
  }

  /** Ask the current editor window to hand over, then take the lock. */
  async takeOver(): Promise<void> {
    if (!this.supported || this.state === 'editor') return
    this.set('acquiring')
    this.channel?.postMessage({ type: 'takeover' } satisfies Message)
    const got = await this.requestLock(false, TAKEOVER_TIMEOUT_MS)
    // A frozen or unresponsive window: take the lock anyway.
    if (!got) await this.requestLock(true, 0)
    await this.hooks.afterAcquire()
    this.set('editor')
  }

  private requestLock(steal: boolean, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const controller = new AbortController()
      const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
      const options: LockOptions = steal ? { steal: true } : { signal: controller.signal }
      navigator.locks
        .request(LOCK_NAME, options, () => {
          if (timer) clearTimeout(timer)
          resolve(true)
          return this.holdUntilReleased()
        })
        .catch(() => {
          if (timer) clearTimeout(timer)
          if (this.release) this.lostLock()
          else resolve(false)
        })
    })
  }

  /** Tell read-only windows that new data was saved. */
  announceSave(): void {
    if (this.state === 'editor') this.channel?.postMessage({ type: 'saved' } satisfies Message)
  }

  private async onMessage(msg: Message): Promise<void> {
    if (msg.type === 'takeover' && this.state === 'editor' && this.release) {
      await this.hooks.beforeRelease().catch(() => undefined)
      const release = this.release
      this.release = null
      this.set('read-only')
      release()
    } else if (msg.type === 'saved' && this.state === 'read-only') {
      this.hooks.onRemoteSave()
    }
  }
}
