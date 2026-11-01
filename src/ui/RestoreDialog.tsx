import { useEffect, useRef, useState } from 'react'
import { useServices } from '../app/context'
import { readArchive, type ArchiveValidation } from '../backup/archive'
import { formatBytes } from '../platform/storageInfo'
import { fullDateTime } from './format'

type Valid = Extract<ArchiveValidation, { ok: true }>

type Step =
  | { kind: 'validating' }
  | { kind: 'invalid'; errors: string[] }
  | { kind: 'review'; result: Valid }
  | { kind: 'restoring' }
  | { kind: 'done'; result: Valid }
  | { kind: 'failed'; message: string }

/**
 * Restore flow: validate the whole archive first, show what it contains,
 * and only replace the workspace after the user confirms.
 */
export function RestoreDialog({ source, load, onClose }: { source: string; load: () => Promise<Uint8Array>; onClose: () => void }) {
  const { backup } = useServices()
  const [step, setStep] = useState<Step>({ kind: 'validating' })
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    dialog.current?.showModal()
    let alive = true
    load()
      .then((bytes) => readArchive(bytes))
      .then((result) => {
        if (!alive) return
        setStep(result.ok ? { kind: 'review', result } : { kind: 'invalid', errors: result.errors })
      })
      .catch((err: unknown) => {
        if (alive) setStep({ kind: 'invalid', errors: [`The file could not be read: ${err instanceof Error ? err.message : String(err)}`] })
      })
    return () => {
      alive = false
    }
  }, [load])

  const confirm = async (result: Valid) => {
    setStep({ kind: 'restoring' })
    try {
      await backup.restore(result)
      setStep({ kind: 'done', result })
    } catch (err) {
      setStep({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const busy = step.kind === 'validating' || step.kind === 'restoring'

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="restore-title"
      onCancel={(e) => {
        if (busy) e.preventDefault()
        else onClose()
      }}
    >
      <h2 id="restore-title">Restore workspace</h2>
      <p className="muted small">Source: {source}</p>

      {step.kind === 'validating' && <p role="status">Checking the backup…</p>}

      {step.kind === 'invalid' && (
        <div role="alert">
          <p className="error-text">This backup cannot be restored. Nothing was changed.</p>
          <ul className="error-list">
            {step.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {step.kind === 'review' && (
        <div data-testid="restore-review">
          <p>The backup passed every check (structure, version, checksums, and links). It contains:</p>
          <dl className="summary">
            <dt>Created</dt>
            <dd>{fullDateTime(step.result.summary.createdAt)}</dd>
            <dt>Projects</dt>
            <dd>
              {step.result.summary.counts.projects}
              {step.result.summary.archivedProjects > 0 && ` (${step.result.summary.archivedProjects} archived)`}
              {step.result.summary.trashedProjects > 0 && ` (${step.result.summary.trashedProjects} in Trash)`}
            </dd>
            <dt>Categories and tags</dt>
            <dd>
              {step.result.summary.counts.categories} categories, {step.result.summary.counts.tags} tags
            </dd>
            <dt>Notebooks</dt>
            <dd>{step.result.summary.counts.notebooks}</dd>
            <dt>Sections</dt>
            <dd>{step.result.summary.counts.sections}</dd>
            <dt>Pages</dt>
            <dd>
              {step.result.summary.counts.pages}
              {step.result.summary.trashedPages > 0 && ` (${step.result.summary.trashedPages} in Trash)`}
            </dd>
            <dt>Text and image objects</dt>
            <dd>{step.result.summary.counts.objects}</dd>
            <dt>Images</dt>
            <dd>
              {step.result.summary.counts.attachments} ({formatBytes(step.result.summary.attachmentBytes)})
            </dd>
            <dt>Made with</dt>
            <dd>
              Minty Notes {step.result.summary.appVersion} (format {step.result.summary.formatVersion})
            </dd>
          </dl>
          {step.result.warnings.length > 0 && (
            <ul className="warn-list">
              {step.result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <p className="callout">
            Restoring <strong>replaces everything</strong> in this workspace. The current workspace is saved first as a safety copy, which you can download from Settings afterwards.
          </p>
        </div>
      )}

      {step.kind === 'restoring' && <p role="status">Saving a safety copy and restoring…</p>}

      {step.kind === 'done' && (
        <p role="status" className="ok-text">
          Restored {step.result.summary.counts.projects} projects, {step.result.summary.counts.pages} pages, and {step.result.summary.counts.attachments} images.
        </p>
      )}

      {step.kind === 'failed' && (
        <p role="alert" className="error-text">
          {step.message}
        </p>
      )}

      <div className="dialog-actions">
        {step.kind === 'review' ? (
          <>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void confirm(step.result)}>
              Replace workspace
            </button>
          </>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {step.kind === 'done' ? 'Done' : 'Close'}
          </button>
        )}
      </div>
    </dialog>
  )
}
