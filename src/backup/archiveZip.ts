import { zip, type AsyncZippable } from 'fflate'

export type ZipWorkerReply = { ready: true } | { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; error: string }

function zipHere(files: AsyncZippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => zip(files, (err, data) => (err ? reject(err) : resolve(data))))
}

export const WORKER_STOPPED_MESSAGE = 'The background archive writer stopped unexpectedly (it may have run out of memory). No backup or project file was written. Close other tabs or windows and try again.'
export const WORKER_TIMEOUT_MESSAGE = 'Creating the archive took too long and was stopped. No backup or project file was written. Try again with more memory available.'

/**
 * fflate's asynchronous `zip` still computes every CRC and copies the complete
 * ZIP on the calling thread (including level-0 image/document entries). Build
 * in a module worker so a large backup or project does not block navigation.
 * Inputs are cloned, not transferred: the caller retains its bytes.
 *
 * Main-thread fallback is only for genuine startup failures: no Worker support,
 * a constructor the browser blocks, or a module that fails before it reports
 * `ready`. The files are posted only after `ready`, so once construction may
 * have started, a crash, an unreadable reply, or a hang rejects instead —
 * a large archive is never silently built a second time on the UI thread.
 * The archive format, per-entry options, and all reader checks stay the same.
 */
export function zipAsync(files: AsyncZippable): Promise<Uint8Array> {
  if (typeof Worker === 'undefined') return zipHere(files)
  let worker: Worker
  try {
    worker = new Worker(new URL('./archiveZipWorker.ts', import.meta.url), { type: 'module' })
  } catch {
    return zipHere(files)
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let started = false
    const finish = () => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      worker.terminate()
      return true
    }
    const fail = (message: string) => {
      if (finish()) reject(new Error(message))
    }
    const stopped = () => {
      if (!started) {
        // The module never loaded: nothing was built, so the main thread may build it.
        if (finish()) zipHere(files).then(resolve, reject)
      } else fail(WORKER_STOPPED_MESSAGE)
    }
    worker.onmessage = (event: MessageEvent<ZipWorkerReply>) => {
      const reply = event.data
      if ('ready' in reply) {
        if (started || settled) return
        started = true
        try {
          worker.postMessage(files)
        } catch {
          fail('The archive could not be handed to the background writer (the browser may be low on memory). No backup or project file was written.')
        }
        return
      }
      if (!finish()) return
      if (reply.ok) resolve(reply.bytes)
      else reject(new Error(reply.error))
    }
    worker.onerror = (event) => {
      event.preventDefault()
      stopped()
    }
    worker.onmessageerror = () => fail(WORKER_STOPPED_MESSAGE)
    // A stopped worker must not leave backup/export permanently busy. Reject
    // rather than retry a long-running writer on the UI thread. Nothing has
    // been written or pruned when a build fails.
    const timer = setTimeout(() => fail(WORKER_TIMEOUT_MESSAGE), 300_000)
  })
}
