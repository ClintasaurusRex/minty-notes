import type { PDFDocumentProxy } from 'pdfjs-dist'
import { MAX_PDF_PAGES } from './formats'
import type { PdfPageText } from './pdfText'

/**
 * PDF.js, loaded only when a PDF is imported or previewed (and cached for
 * offline use with the rest of the app). It parses in its own worker; PDF
 * scripts, forms (XFA), and annotations are never run or rendered here.
 */
type PdfJs = typeof import('pdfjs-dist')
let loading: Promise<PdfJs> | null = null

export function loadPdfJs(): Promise<PdfJs> {
  loading ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default
    return lib
  })
  return loading
}

/** Open a PDF from bytes with conservative options (no XFA forms, no WebAssembly fetches). `close` frees its worker. */
export async function openPdf(bytes: Uint8Array): Promise<{ pdf: PDFDocumentProxy; close: () => void }> {
  const pdfjs = await loadPdfJs()
  // The worker takes ownership of the buffer, so it gets a copy.
  const task = pdfjs.getDocument({ data: bytes.slice(), enableXfa: false, useWasm: false, stopAtErrors: false })
  try {
    return { pdf: await task.promise, close: () => void task.destroy() }
  } catch (err) {
    void task.destroy()
    throw err
  }
}

export interface PdfExtraction {
  pageCount: number
  pages: PdfPageText[]
  /** Pages that draw images (not converted; they stay in the original). */
  imagePages: number[]
  /** Pages with form fields or other annotations (not converted). */
  annotatedPages: number[]
  hasScripts: boolean
  hasAttachments: boolean
}

/** Read the text runs of every page (up to the page limit) and note what was not converted. */
export async function extractPdf(bytes: Uint8Array, onProgress?: (done: number, total: number) => void): Promise<PdfExtraction> {
  const pdfjs = await loadPdfJs()
  const { pdf, close } = await openPdf(bytes)
  try {
    const total = Math.min(pdf.numPages, MAX_PDF_PAGES)
    const imageOps = new Set<number>([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintImageXObjectRepeat])
    const out: PdfExtraction = { pageCount: pdf.numPages, pages: [], imagePages: [], annotatedPages: [], hasScripts: false, hasAttachments: false }
    for (let n = 1; n <= total; n++) {
      const page = await pdf.getPage(n)
      const content = await page.getTextContent()
      const runs = []
      for (const item of content.items) {
        if (!('str' in item) || !item.str) continue
        const [a, b, c, d, x, y] = item.transform as number[]
        runs.push({ str: item.str, x, y, size: Math.hypot(c, d) || Math.hypot(a, b) || item.height, width: item.width })
      }
      out.pages.push({ number: n, runs })
      const ops = await page.getOperatorList()
      if (ops.fnArray.some((fn) => imageOps.has(fn))) out.imagePages.push(n)
      const annotations = await page.getAnnotations()
      if (annotations.some((an) => an.subtype !== 'Link')) out.annotatedPages.push(n)
      page.cleanup()
      onProgress?.(n, total)
    }
    out.hasScripts = !!(await pdf.getJSActions().catch(() => null))
    out.hasAttachments = !!(await pdf.getAttachments().catch(() => null))
    return out
  } finally {
    close()
  }
}

/** A readable reason for a PDF that could not be opened. */
export function describePdfError(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  if (name === 'PasswordException') return 'it is password-protected'
  if (name === 'InvalidPDFException') return 'it is damaged or not a valid PDF'
  return `it could not be read (${err instanceof Error ? err.message : String(err)})`
}
