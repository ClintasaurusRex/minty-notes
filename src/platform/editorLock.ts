/**
 * Single-editor coordination between windows of the same workspace.
 *
 * The first window takes an exclusive Web Lock and edits; others open
 * read-only. "Edit here instead" asks the editor to hand over:
 *
 *   requester → takeover(id)
 *   editor    → takeover-ack(id)            (alive; now saving)
 *   editor    → releases the lock           (everything saved)
 *          or → takeover-refused(id, why)   (could not save; keeps editing)
 *
 * With no acknowledgement in time the editor is assumed frozen and the lock is
 * stolen. A window whose lock is stolen is told via `onLost`. Storage also
 * refuses writes from any window that is no longer the owner (fencing token),
 * so a frozen window that wakes up can never overwrite the new editor's work.
 */
export type LockState = 'acquiring' | 'editor' | 'read-only' | 'unsupported'

export type HandoverResult = { ok: true } | { ok: false; reason: string }

const LOCK_NAME = 'minty-notes:editor'
const CHANNEL = 'minty-notes'

type Message =
  | { type: 'takeover'; requestId: string }
  | { type: 'takeover-ack'; requestId: string }
  | { type: 'takeover-refused'; requestId: string; reason: string }
  | { type: 'saved' }

export interface EditorLockHooks {
  /** Freeze and save before giving up editing. Return ok:false to refuse the handover. */
  beforeRelease: () => Promise<HandoverResult>
  /** Runs after the lock is granted, before this window counts as the editor. Throw to give it back. */
  afterAcquire: () => Promise<void>
  /** The lock was taken without a handover (stolen). Stop writing immediately. */
  onLost: () => void
  /** Another window saved changes (read-only windows refresh). */
  onRemoteSave: () => void
  /** This window refused a handover request. */
  onRefused?: (reason: string) => void
}

interface ChannelLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (e: MessageEvent) => void): void
  close?(): void
}

export interface EditorLockOptions {
  /** Defaults to navigator.locks; null means unsupported. */
  locks?: LockManager | null
  /** Defaults to a BroadcastChannel; null disables messaging. */
  channel?: ChannelLike | null
  /** How long to wait for the editor to acknowledge before assuming it is frozen. */
  ackTimeoutMs?: number
  /** How long an acknowledged editor may take to save and hand over. */
  handoverTimeoutMs?: number
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class EditorLock {
  private state: LockState = 'acquiring'
  private readonly listeners = new Set<() => void>()
  private release: (() => void) | null = null
  private handingOver = false
  private readonly hooks: EditorLockHooks
  private readonly locks: LockManager | null
  private readonly channel: ChannelLike | null
  private readonly ackTimeoutMs: number
  private readonly handoverTimeoutMs: number

  constructor(hooks: EditorLockHooks, options: EditorLockOptions = {}) {
    this.hooks = hooks
    this.locks = options.locks !== undefined ? options.locks : typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null
    this.channel = options.channel !== undefined ? options.channel : typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null
    this.ackTimeoutMs = options.ackTimeoutMs ?? 3000
    this.handoverTimeoutMs = options.handoverTimeoutMs ?? 20000
    this.channel?.addEventListener('message', this.onChannelMessage)
  }

  getState = (): LockState => this.state
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  private set(state: LockState): void {
    if (this.state === state) return
    this.state = state
    for (const l of this.listeners) l()
  }

  get supported(): boolean {
    return this.locks !== null
  }

  /** Try to become the editor without waiting. The caller prepares the store for the result. */
  async start(): Promise<LockState> {
    if (!this.locks) {
      this.set('unsupported')
      return this.state
    }
    this.set((await this.acquire({ ifAvailable: true })) ? 'editor' : 'read-only')
    return this.state
  }

  /** Resolves true once the lock is held, false if it was not granted (busy or aborted). */
  private acquire(options: LockOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let granted = false
      this.locks!.request(LOCK_NAME, options, (lock) => {
        if (!lock) {
          resolve(false)
          return null
        }
        granted = true
        resolve(true)
        return new Promise<void>((done) => {
          this.release = done
        })
      }).catch(() => {
        if (granted) this.lost()
        else resolve(false)
      })
    })
  }

  private giveBack(): void {
    const release = this.release
    this.release = null
    release?.()
  }

  private lost(): void {
    this.release = null
    if (this.state === 'editor' || this.state === 'acquiring') {
      this.set('read-only')
      this.hooks.onLost()
    }
  }

  /** Ask the editor window to hand over, then become the editor. */
  async takeOver(): Promise<HandoverResult> {
    if (this.state === 'editor') return { ok: true }
    if (!this.locks) {
      // No cross-window lock: storage ownership alone decides who may write.
      try {
        await this.hooks.afterAcquire()
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: errorText(err) }
      }
    }
    if (this.state === 'acquiring') return { ok: false, reason: 'A request to edit is already in progress.' }
    this.set('acquiring')

    const requestId = Math.random().toString(36).slice(2)
    const controller = new AbortController()
    let acked = false
    let outcome: 'refused' | 'unresponsive' | 'busy' | null = null
    let reason = ''
    const onReply = (e: MessageEvent) => {
      const m = e.data as Message
      if (!m || !('requestId' in m) || m.requestId !== requestId) return
      if (m.type === 'takeover-ack') acked = true
      if (m.type === 'takeover-refused') {
        outcome = 'refused'
        reason = m.reason
        controller.abort()
      }
    }
    this.channel?.addEventListener('message', onReply)
    const ackTimer = setTimeout(() => {
      if (!acked && outcome === null) {
        outcome = 'unresponsive'
        controller.abort()
      }
    }, this.ackTimeoutMs)
    const busyTimer = setTimeout(() => {
      if (outcome === null) {
        outcome = 'busy'
        controller.abort()
      }
    }, this.handoverTimeoutMs)
    this.channel?.postMessage({ type: 'takeover', requestId } satisfies Message)

    let got = await this.acquire({ signal: controller.signal })
    clearTimeout(ackTimer)
    clearTimeout(busyTimer)
    this.channel?.removeEventListener('message', onReply)
    // Only a window that never answered is treated as frozen; a refusal is respected.
    if (!got && outcome === 'unresponsive') got = await this.acquire({ steal: true })
    if (!got) {
      this.set('read-only')
      return {
        ok: false,
        reason: outcome === 'refused' ? reason : 'The editing window is still saving. Try again in a moment.',
      }
    }
    try {
      await this.hooks.afterAcquire()
    } catch (err) {
      this.giveBack()
      this.set('read-only')
      return { ok: false, reason: errorText(err) }
    }
    this.set('editor')
    return { ok: true }
  }

  /** Tell read-only windows that new data was saved. */
  announceSave(): void {
    if (this.state === 'editor' || this.state === 'unsupported') this.channel?.postMessage({ type: 'saved' } satisfies Message)
  }

  private onChannelMessage = (e: MessageEvent): void => {
    void this.onMessage(e.data as Message)
  }

  private async onMessage(msg: Message): Promise<void> {
    if (msg?.type === 'takeover') {
      if (this.state !== 'editor' || !this.release || this.handingOver) return
      this.handingOver = true
      this.channel?.postMessage({ type: 'takeover-ack', requestId: msg.requestId } satisfies Message)
      let result: HandoverResult
      try {
        result = await this.hooks.beforeRelease()
      } catch (err) {
        result = { ok: false, reason: errorText(err) }
      }
      this.handingOver = false
      if (!result.ok) {
        // Keep the lock and keep editing; unsaved work stays here.
        this.channel?.postMessage({ type: 'takeover-refused', requestId: msg.requestId, reason: result.reason } satisfies Message)
        this.hooks.onRefused?.(result.reason)
        return
      }
      if (this.state !== 'editor' || !this.release) return
      this.set('read-only')
      this.giveBack()
    } else if (msg?.type === 'saved' && this.state === 'read-only') {
      this.hooks.onRemoteSave()
    }
  }

  /** Stop listening and give up the lock (tests, teardown). */
  dispose(): void {
    this.channel?.removeEventListener('message', this.onChannelMessage)
    this.channel?.close?.()
    this.giveBack()
  }
}
