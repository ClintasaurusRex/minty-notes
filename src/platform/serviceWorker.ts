/**
 * Service worker registration and user-controlled updates.
 * Production builds only; the dev server never registers a worker.
 */
export interface AppUpdateState {
  supported: boolean
  offlineReady: boolean
  updateReady: boolean
  error: string | null
}

let state: AppUpdateState = { supported: false, offlineReady: false, updateReady: false, error: null }
const listeners = new Set<() => void>()
let registration: ServiceWorkerRegistration | null = null

function set(patch: Partial<AppUpdateState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

export const appUpdate = {
  getState: (): AppUpdateState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l)
    return () => listeners.delete(l)
  },
}

export async function registerServiceWorker(): Promise<void> {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  set({ supported: true })
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' })
    registration = reg
    const watch = (worker: ServiceWorker | null) => {
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) set({ updateReady: true })
      })
    }
    if (reg.waiting && navigator.serviceWorker.controller) set({ updateReady: true })
    watch(reg.installing)
    reg.addEventListener('updatefound', () => watch(reg.installing))
    // An active worker has finished installing, which means every app file is cached.
    await navigator.serviceWorker.ready
    set({ offlineReady: true })
    const check = () => void reg.update().catch(() => undefined)
    setInterval(check, 60 * 60 * 1000)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check()
    })
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err) })
  }
}

/** Save first, then activate the waiting version and reload. */
export async function applyUpdate(saveFirst: () => Promise<boolean>): Promise<boolean> {
  const waiting = registration?.waiting
  if (!waiting) return false
  if (!(await saveFirst())) return false
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true })
  waiting.postMessage({ type: 'SKIP_WAITING' })
  return true
}
