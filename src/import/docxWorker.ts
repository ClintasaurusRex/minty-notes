/// <reference lib="webworker" />
import { convertDocxToHtml } from './docxConvert'

/** Converts a DOCX off the main thread so a large document never freezes the editor. */
self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const result = await convertDocxToHtml(event.data)
    ;(self as unknown as DedicatedWorkerGlobalScope).postMessage({ ok: true, result }, result.images.map((i) => i.bytes.buffer as ArrayBuffer))
  } catch (err) {
    ;(self as unknown as DedicatedWorkerGlobalScope).postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
