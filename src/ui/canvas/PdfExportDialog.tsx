import { useEffect, useId, useRef, useState } from 'react'
import { useServices, useWorkspace } from '../../app/context'
import type { Page } from '../../domain/types'
import { PAPER_SIZES, pdfFileName, type Orientation, type Paper } from '../../export/layoutRules'
import type { NotePdfOptions, NotePdfResult } from '../../export/notePdf'
import { saveBytesAsDownload } from '../../platform/download'
import { locationLabel } from '../locations'
import { notify } from '../notices'
import { PdfPages } from './OriginalPreview'

const PREFS_KEY = 'minty:pdf-export'

/** Letter where it is the usual paper size, A4 elsewhere. */
function defaultPaper(): Paper {
  const lang = (typeof navigator !== 'undefined' && navigator.language) || ''
  return /-(US|CA|MX|PH|CL|CO|VE|GT|CR|PR)$/i.test(lang) ? 'letter' : 'a4'
}

function loadPrefs(): NotePdfOptions {
  const fallback: NotePdfOptions = { paper: defaultPaper(), orientation: 'auto', theme: 'light' }
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<NotePdfOptions> | null
    if (!raw) return fallback
    return {
      paper: raw.paper === 'a4' || raw.paper === 'letter' ? raw.paper : fallback.paper,
      orientation: raw.orientation === 'portrait' || raw.orientation === 'landscape' ? raw.orientation : 'auto',
      theme: raw.theme === 'dark' ? 'dark' : 'light',
    }
  } catch {
    return fallback
  }
}

function savePrefs(o: NotePdfOptions): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(o))
  } catch {
    // A per-device convenience only.
  }
}

/**
 * Export one note (any page: Inbox, standalone, notebook, project) as a PDF,
 * with a preview of the actual file before it is saved. The note is read,
 * never changed, so this also works in a read-only window.
 */
export function PdfExportDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const { store } = useServices()
  const objects = useWorkspace((s) => s.data.objects[page.id])
  const attachments = useWorkspace((s) => s.data.attachments)
  // A string, so it is stable between renders.
  const location = useWorkspace((s) => locationLabel(page.location, s.data))
  const [options, setOptions] = useState<NotePdfOptions>(loadPrefs)
  /** The last finished build, with the inputs it was made from (a result for older inputs is stale). */
  const [outcome, setOutcome] = useState<{ inputs: readonly unknown[]; seq: number; value: NotePdfResult | null; error: string | null } | null>(null)
  const [progress, setProgress] = useState('Preparing…')
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  const seq = useRef(0)
  const inputs = [options, objects, page, location, attachments] as const

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
    const used = [options, objects, page, location, attachments] as const
    void (async () => {
      // Let the dialog paint before the (synchronous) layout work starts.
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
      if (!alive) return
      setProgress('Preparing…')
      const run = ++seq.current
      try {
        const { buildNotePdf } = await import('../../export/notePdf')
        const value = await buildNotePdf(
          { page, objects: Object.values(objects ?? {}), location, attachments, getBlob: (id) => store.getBlob(id), appVersion: __APP_VERSION__ },
          options,
          (message) => alive && setProgress(message),
        )
        if (alive) setOutcome({ inputs: used, seq: run, value, error: null })
      } catch (err) {
        if (alive) setOutcome({ inputs: used, seq: run, value: null, error: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      alive = false
    }
    // Rebuilt when the options or the note change (the preview always shows the file that will be saved).
  }, [options, objects, page, location, attachments, store])

  const busy = !outcome || outcome.inputs.some((v, i) => v !== inputs[i])
  const result = outcome?.value ? { seq: outcome.seq, value: outcome.value } : null
  const error = busy ? null : (outcome?.error ?? null)

  const update = (patch: Partial<NotePdfOptions>) => {
    const next = { ...options, ...patch }
    setOptions(next)
    savePrefs(next)
  }

  const download = () => {
    if (!result) return
    const name = pdfFileName(page.title)
    saveBytesAsDownload(result.value.bytes, name, 'application/pdf')
    notify('success', `Saved “${name}” (${result.value.pageCount} page${result.value.pageCount === 1 ? '' : 's'}). The note itself is unchanged.`)
  }

  const ready = !!result && !busy && !error
  return (
    <dialog
      ref={dialog}
      className="dialog preview-dialog pdf-dialog"
      aria-labelledby={headingId}
      data-testid="pdf-export"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div className="card-head">
        <h2 id={headingId}>Export PDF: {page.title || 'Untitled page'}</h2>
        <span className="btn-row">
          <button type="button" className="btn btn-small btn-primary" disabled={!ready} onClick={download} data-testid="pdf-download">
            Download PDF
          </button>
          <button type="button" className="btn btn-small" onClick={onClose}>
            Close
          </button>
        </span>
      </div>
      <p className="muted small">
        Made on this computer from the note as it is now. The note, its images, and their originals are not changed. Pictures are flattened: redacted areas are solid black in the PDF, and the original image files are not included.
      </p>
      <div className="pdf-options">
        <label className="field">
          <span className="field-label">Paper</span>
          <select aria-label="Paper size" value={options.paper} onChange={(e) => update({ paper: e.target.value as Paper })}>
            {(Object.keys(PAPER_SIZES) as Paper[]).map((p) => (
              <option key={p} value={p}>
                {PAPER_SIZES[p].label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Orientation</span>
          <select aria-label="Orientation" value={options.orientation} onChange={(e) => update({ orientation: e.target.value as Orientation })}>
            <option value="auto">Automatic (landscape for wide notes)</option>
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Colours</span>
          <select aria-label="Colours" value={options.theme} onChange={(e) => update({ theme: e.target.value === 'dark' ? 'dark' : 'light' })}>
            <option value="light">Light paper (for printing)</option>
            <option value="dark">Dark, as on screen</option>
          </select>
        </label>
      </div>
      <p className="pdf-status muted small" role="status" aria-live="polite" data-testid="pdf-status">
        {busy ? progress : error ? '' : result ? `Ready: ${result.value.pageCount} page${result.value.pageCount === 1 ? '' : 's'}. The preview below is the PDF file itself.` : ''}
      </p>
      {error && <p className="error-text">The PDF could not be made: {error}</p>}
      {result && !busy && !error && (
        <ul className="pdf-notes" data-testid="pdf-notes">
          {result.value.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <div className="preview-body">{result && !error && <PdfPages key={result.seq} bytes={result.value.bytes} />}</div>
    </dialog>
  )
}
