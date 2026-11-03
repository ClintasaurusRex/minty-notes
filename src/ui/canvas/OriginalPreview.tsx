import { generateHTML } from '@tiptap/core'
import { useEffect, useId, useRef, useState } from 'react'
import { useServices } from '../../app/context'
import { richTextExtensions } from '../../domain/richtext'
import type { ImportedFrom } from '../../domain/types'
import { htmlToBlocks } from '../../import/docxBlocks'
import { MAX_IMPORT_CHARS } from '../../import/formats'
import { convertInWorker } from '../../import/importDocument'
import { describePdfError, openPdf } from '../../import/pdf'

type PdfDoc = Awaited<ReturnType<typeof openPdf>>

/** Page images of the original PDF, drawn with PDF.js (no scripts, forms, or annotations are run). */
function PdfPages({ bytes }: { bytes: Uint8Array }) {
  const [doc, setDoc] = useState<PdfDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pageNo, setPageNo] = useState(1)
  const canvas = useRef<HTMLCanvasElement>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    let opened: PdfDoc | null = null
    openPdf(bytes)
      .then((d) => {
        opened = d
        if (alive) setDoc(d)
        else d.close()
      })
      .catch((err: unknown) => alive && setError(describePdfError(err)))
    return () => {
      alive = false
      opened?.close()
    }
  }, [bytes])

  useEffect(() => {
    if (!doc || !canvas.current || !box.current) return
    let cancelled = false
    let task: { cancel: () => void } | null = null
    void (async () => {
      const page = await doc.pdf.getPage(pageNo)
      if (cancelled) return
      const width = Math.max(320, box.current!.clientWidth - 16)
      const base = page.getViewport({ scale: 1 })
      const scale = width / base.width
      const dpr = window.devicePixelRatio || 1
      const viewport = page.getViewport({ scale: scale * dpr })
      const c = canvas.current!
      c.width = Math.floor(viewport.width)
      c.height = Math.floor(viewport.height)
      c.style.width = `${Math.floor(viewport.width / dpr)}px`
      c.style.height = `${Math.floor(viewport.height / dpr)}px`
      const render = page.render({ canvas: c, viewport })
      task = render
      await render.promise.catch(() => undefined)
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, pageNo])

  if (error) return <p className="error-text">The original PDF could not be shown: {error}. You can still download it.</p>
  if (!doc) return <p className="muted">Opening the PDF…</p>
  const count = doc.pdf.numPages
  return (
    <div
      className="preview-pdf"
      tabIndex={0}
      aria-label={`PDF page ${pageNo} of ${count}. Left and right arrow keys change the page.`}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'PageDown') setPageNo((n) => Math.min(count, n + 1))
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') setPageNo((n) => Math.max(1, n - 1))
      }}
    >
      <div className="btn-row preview-nav">
        <button type="button" className="btn btn-small" disabled={pageNo <= 1} onClick={() => setPageNo(pageNo - 1)}>
          ‹ Previous
        </button>
        <span aria-live="polite" data-testid="preview-page">
          Page {pageNo} of {count}
        </span>
        <button type="button" className="btn btn-small" disabled={pageNo >= count} onClick={() => setPageNo(pageNo + 1)}>
          Next ›
        </button>
      </div>
      <div ref={box} className="preview-canvas-box">
        <canvas ref={canvas} className="preview-canvas" data-testid="preview-canvas" />
      </div>
    </div>
  )
}

/** A read-only conversion of the original Word file (rebuilt from the file, independent of later edits). */
function DocxView({ bytes }: { bytes: Uint8Array }) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const urls: string[] = []
    convertInWorker(bytes.slice().buffer)
      .then((conv) => {
        const { blocks } = htmlToBlocks(conv.html, MAX_IMPORT_CHARS)
        const parts = blocks.map((b) => {
          if (b.kind === 'text') return generateHTML(b.doc, richTextExtensions)
          const img = conv.images[b.index]
          if (!img || !/^image\/(png|jpeg|gif|bmp|webp)$/.test(img.contentType)) return '<p><em>[picture not shown]</em></p>'
          const url = URL.createObjectURL(new Blob([img.bytes as Uint8Array<ArrayBuffer>], { type: img.contentType }))
          urls.push(url)
          return `<p><img class="preview-img" alt="" src="${url}"></p>`
        })
        if (alive) setHtml(parts.join(''))
      })
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
      for (const u of urls) URL.revokeObjectURL(u)
    }
  }, [bytes])
  if (error) return <p className="error-text">The original could not be shown: {error}. You can still download it.</p>
  if (html === null) return <p className="muted">Reading the document…</p>
  // Schema-generated HTML plus our own blob: image URLs only.
  return <div className="rt preview-docx" data-testid="preview-docx" dangerouslySetInnerHTML={{ __html: html }} />
}

/** Preview of an imported document's original file. */
export function OriginalPreview({ source, onClose, onDownload }: { source: ImportedFrom; onClose: () => void; onDownload: () => void }) {
  const { store } = useServices()
  const [bytes, setBytes] = useState<Uint8Array | null | undefined>(undefined)
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  useEffect(() => {
    const d = dialog.current
    const returnTo = document.activeElement as HTMLElement | null
    if (d && !d.open) d.showModal()
    return () => {
      if (d?.open) d.close()
      if (returnTo?.isConnected) returnTo.focus()
    }
  }, [])
  useEffect(() => {
    let alive = true
    void store.getBlob(source.attachmentId).then(async (b) => {
      const data = b ? new Uint8Array(await b.arrayBuffer()) : null
      if (alive) setBytes(data)
    })
    return () => {
      alive = false
    }
  }, [store, source.attachmentId])
  return (
    <dialog
      ref={dialog}
      className="dialog preview-dialog"
      aria-labelledby={headingId}
      data-testid="original-preview"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div className="card-head">
        <h2 id={headingId}>Original: {source.fileName}</h2>
        <span className="btn-row">
          <button type="button" className="btn btn-small" onClick={onDownload}>
            Download original
          </button>
          <button type="button" className="btn btn-small btn-primary" onClick={onClose}>
            Close
          </button>
        </span>
      </div>
      <p className="muted small">
        {source.format === 'pdf'
          ? 'The stored PDF, drawn page by page. Its scripts, forms, and links are not run.'
          : 'A read-only view rebuilt from the stored Word file (independent of edits to the draft). Word page layout is not reproduced; download the original to open it in Word.'}
      </p>
      <div className="preview-body">
        {bytes === undefined ? <p className="muted">Loading…</p> : bytes === null ? <p className="error-text">The original file is missing from this workspace.</p> : source.format === 'pdf' ? <PdfPages bytes={bytes} /> : <DocxView bytes={bytes} />}
      </div>
    </dialog>
  )
}
