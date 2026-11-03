import { sha256Hex } from '../backup/archive'
import { newId, nowIso, type AttachmentMeta, type RichTextDoc } from '../domain/types'
import { prepareImage } from '../platform/images'
import { htmlToBlocks } from './docxBlocks'
import { convertDocxToHtml, type DocxConversion } from './docxConvert'
import { checkDocxContainer, detectFormat, MAX_IMPORT_CHARS, MAX_PDF_PAGES, mimeOf, titleFromFileName, type ImportFormat } from './formats'
import { describePdfError, extractPdf } from './pdf'
import { pdfToDocs } from './pdfText'

export interface StoredFile {
  meta: AttachmentMeta
  blob: Blob
}

export type ImportBlock = { kind: 'text'; doc: RichTextDoc } | { kind: 'image'; file: StoredFile; width: number; height: number }

export type ImportOutcome =
  | { ok: true; format: ImportFormat; title: string; original: StoredFile; blocks: ImportBlock[]; notes: string[]; summary: string }
  /** `original` is set when the file is a real DOCX/PDF that could not be converted: it can still be kept. */
  | { ok: false; reason: string; format?: ImportFormat; title?: string; original?: StoredFile }

/** Images a browser can show; others (EMF, WMF, TIFF, SVG) are reported instead. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp'])

const DOCX_TIMEOUT_MS = 120_000

/** Run mammoth in a worker (falls back to this thread if workers are unavailable). */
export function convertInWorker(bytes: ArrayBuffer): Promise<DocxConversion> {
  if (typeof Worker === 'undefined') return convertDocxToHtml(bytes)
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./docxWorker.ts', import.meta.url), { type: 'module' })
    } catch {
      convertDocxToHtml(bytes).then(resolve, reject)
      return
    }
    const timer = setTimeout(() => {
      worker.terminate()
      reject(new Error('the conversion took too long and was stopped'))
    }, DOCX_TIMEOUT_MS)
    worker.onmessage = (e: MessageEvent<{ ok: true; result: DocxConversion } | { ok: false; error: string }>) => {
      clearTimeout(timer)
      worker.terminate()
      if (e.data.ok) resolve(e.data.result)
      else reject(new Error(e.data.error))
    }
    worker.onerror = (e) => {
      clearTimeout(timer)
      worker.terminate()
      reject(new Error(e.message || 'the converter stopped unexpectedly'))
    }
    worker.postMessage(bytes, [bytes])
  })
}

const list = (pages: number[]) => (pages.length > 12 ? `${pages.slice(0, 12).join(', ')} and ${pages.length - 12} more` : pages.join(', '))

/**
 * Convert a local DOCX or text-based PDF into an editable draft. Nothing is
 * stored here: the caller stores the original (always unchanged) and the
 * draft. Malformed, unsupported, and oversized files are refused with a reason.
 */
export async function importDocument(file: File, onProgress?: (message: string) => void): Promise<ImportOutcome> {
  const name = file.name || 'document'
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch {
    return { ok: false, reason: `“${name}” could not be read from disk.` }
  }
  const detected = detectFormat(name, bytes)
  if (!detected.ok) return { ok: false, reason: detected.reason }
  const format = detected.format
  const title = titleFromFileName(name)
  const notes: string[] = []

  if (format === 'docx') {
    const container = await checkDocxContainer(name, bytes)
    if (!container.ok) return { ok: false, reason: container.reason }
    if (container.macros) notes.push('The document contains macros. They were not run and are not part of the draft (the original file is kept as it was).')
  }

  const original: StoredFile = {
    meta: { id: newId(), fileName: name, mimeType: mimeOf(format), size: bytes.byteLength, sha256: await sha256Hex(bytes), width: null, height: null, source: 'import', createdAt: nowIso() },
    blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeOf(format) }),
  }
  const failed = (why: string): ImportOutcome => ({ ok: false, reason: `“${name}” could not be converted: ${why}.`, format, title, original })

  if (format === 'docx') {
    onProgress?.(`Converting “${name}”…`)
    let conversion: DocxConversion
    try {
      conversion = await convertInWorker(bytes.slice().buffer)
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err))
    }
    const { blocks: raw, truncated, fallbacks } = htmlToBlocks(conversion.html, MAX_IMPORT_CHARS)
    const blocks: ImportBlock[] = []
    let unsupported = 0
    let unreadable = 0
    for (const b of raw) {
      if (b.kind === 'text') {
        blocks.push(b)
        continue
      }
      const img = conversion.images[b.index]
      if (!img) continue
      if (!IMAGE_TYPES.has(img.contentType)) {
        unsupported++
        continue
      }
      try {
        const { meta, blob } = await prepareImage(new Blob([img.bytes as Uint8Array<ArrayBuffer>], { type: img.contentType }), 'import')
        blocks.push({ kind: 'image', file: { meta: { ...meta, fileName: `${title} — image ${b.index + 1}.${img.contentType.split('/')[1].replace('jpeg', 'jpg')}` }, blob }, width: meta.width ?? 400, height: meta.height ?? 300 })
      } catch {
        unreadable++
      }
    }
    if (blocks.length === 0) return failed('it has no text or pictures that could be read')
    const textBoxes = blocks.filter((b) => b.kind === 'text').length
    const images = blocks.length - textBoxes
    if (unsupported) notes.push(`${unsupported} picture${unsupported === 1 ? ' is' : 's are'} in a format browsers cannot show (for example EMF/WMF drawings) and ${unsupported === 1 ? 'was' : 'were'} not converted; see the original.`)
    if (unreadable) notes.push(`${unreadable} picture${unreadable === 1 ? '' : 's'} could not be read and ${unreadable === 1 ? 'was' : 'were'} skipped.`)
    if (conversion.skippedImages) notes.push(`Only the first ${conversion.images.length} pictures were converted; ${conversion.skippedImages} more are only in the original.`)
    if (truncated) notes.push('The document is very long; only the first part of its text was converted. The original keeps everything.')
    if (fallbacks) notes.push(`${fallbacks} section${fallbacks === 1 ? '' : 's'} could only be converted as plain text.`)
    // Unsupported pictures are already reported above in plain words.
    const messages = [...new Set(conversion.messages)].filter((m) => !/unlikely to display in web browsers/i.test(m))
    if (messages.length > 0) notes.push(`Word features not converted: ${messages.slice(0, 6).join('; ')}${messages.length > 6 ? `; and ${messages.length - 6} more` : ''}.`)
    notes.push('Page layout (page size, columns, headers, footers, text boxes, fonts) is not reproduced; check the draft against the original.')
    return { ok: true, format, title, original, blocks, notes, summary: `${textBoxes} text section${textBoxes === 1 ? '' : 's'} and ${images} picture${images === 1 ? '' : 's'}` }
  }

  onProgress?.(`Reading “${name}”…`)
  let extraction
  try {
    extraction = await extractPdf(bytes, (done, total) => onProgress?.(`Reading “${name}”: page ${done} of ${total}…`))
  } catch (err) {
    return failed(describePdfError(err))
  }
  const draft = pdfToDocs(extraction.pages, MAX_IMPORT_CHARS)
  if (draft.pages.length === 0) {
    return failed(`it has no selectable text (it may be scanned or made of images). Text recognition (OCR) is not available`)
  }
  if (draft.emptyPages.length) notes.push(`Page${draft.emptyPages.length === 1 ? '' : 's'} ${list(draft.emptyPages)} ${draft.emptyPages.length === 1 ? 'has' : 'have'} no selectable text (probably scanned or images). Text recognition (OCR) is not available, so ${draft.emptyPages.length === 1 ? 'it was' : 'they were'} not converted; see the original.`)
  if (extraction.imagePages.length) notes.push(`Pictures and drawings on page${extraction.imagePages.length === 1 ? '' : 's'} ${list(extraction.imagePages)} are not converted; see the original.`)
  if (extraction.annotatedPages.length) notes.push(`Form fields, comments, or other annotations on page${extraction.annotatedPages.length === 1 ? '' : 's'} ${list(extraction.annotatedPages)} were not converted.`)
  if (extraction.hasScripts) notes.push('The PDF contains scripts. They were not run.')
  if (extraction.hasAttachments) notes.push('The PDF contains attached files. They were not imported.')
  if (extraction.pageCount > MAX_PDF_PAGES) notes.push(`Only the first ${MAX_PDF_PAGES} of ${extraction.pageCount} pages were converted; the original keeps them all.`)
  if (draft.truncated) notes.push('The PDF is very long; only the first part of its text was converted. The original keeps everything.')
  notes.push('Tables, columns, and exact layout are not reconstructed from a PDF, and reading order may need fixing; check the draft against the original.')
  const blocks: ImportBlock[] = draft.pages.map((p) => ({ kind: 'text', doc: p.doc }))
  return { ok: true, format, title, original, blocks, notes, summary: `text from ${draft.pages.length} of ${extraction.pageCount} page${extraction.pageCount === 1 ? '' : 's'}` }
}
