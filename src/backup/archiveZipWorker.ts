/// <reference lib="webworker" />
import { zipSync, type AsyncZippable, type Zippable } from 'fflate'
import type { ZipWorkerReply } from './archiveZip'

const port = self as unknown as DedicatedWorkerGlobalScope

// The input uses the common synchronous subset of AsyncZippable: entry bytes
// and ZIP options. No async-only `consume` option is used by either caller.
port.onmessage = (event: MessageEvent<AsyncZippable>) => {
  try {
    const bytes = zipSync(event.data as Zippable)
    port.postMessage({ ok: true, bytes } satisfies ZipWorkerReply, [bytes.buffer])
  } catch (err) {
    port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ZipWorkerReply)
  }
}

// Sent once this module has loaded. Before it, a failure is a startup failure
// (the caller may build on the main thread); after it, the caller never retries.
port.postMessage({ ready: true } satisfies ZipWorkerReply)
