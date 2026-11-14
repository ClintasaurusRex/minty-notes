import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useServices, useWorkspace } from '../app/context'
import { formatBytes, readStorageInfo } from '../platform/storageInfo'
import { PACKAGE_LIMITS, REFERENCE_REASON_LABELS } from '../portable/format'
import { previewProjectImport } from '../portable/importPlan'
import { importProjectPackage, type ImportResult } from '../portable/projectTransfer'
import { readProjectPackage, type ValidPackage } from '../portable/readPackage'
import { describeStorageError } from '../storage/repository'
import { fullDateTime } from './format'
import { IconAlert, IconDownload } from './icons'
import { useNav } from './nav'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

type Step =
  | { kind: 'validating' }
  | { kind: 'invalid'; errors: string[] }
  | { kind: 'review'; pkg: ValidPackage }
  | { kind: 'importing'; pkg: ValidPackage }
  | { kind: 'done'; result: ImportResult }
  | { kind: 'failed'; pkg: ValidPackage; message: string }

async function freeBytes(): Promise<number | null> {
  const info = await readStorageInfo()
  return info.quota != null && info.usage != null ? Math.max(0, info.quota - info.usage) : null
}

/**
 * Import a portable project package: validate the whole file first, show what
 * it contains and how it will arrive here, and only add it after the user
 * confirms. It adds one new project; nothing existing is replaced or changed.
 */
export function ProjectImportDialog({ file, onClose }: { file: File; onClose: () => void }) {
  const { store } = useServices()
  const nav = useNav()
  const data = useWorkspace((s) => s.data)
  const readOnly = useWorkspace((s) => s.readOnly)
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  const [step, setStep] = useState<Step>({ kind: 'validating' })
  const [reuse, setReuse] = useState(false)

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
    void (async () => {
      try {
        // The size is checked before the file is read into memory.
        if (file.size > PACKAGE_LIMITS.fileBytes) {
          if (alive) setStep({ kind: 'invalid', errors: [`This file is ${formatBytes(file.size)}; the largest project package Minty Notes imports is ${formatBytes(PACKAGE_LIMITS.fileBytes)}.`] })
          return
        }
        const result = await readProjectPackage(new Uint8Array(await file.arrayBuffer()))
        if (alive) setStep(result.ok ? { kind: 'review', pkg: result } : { kind: 'invalid', errors: result.errors })
      } catch (err) {
        if (alive) setStep({ kind: 'invalid', errors: [`The file could not be read: ${err instanceof Error ? err.message : String(err)}`] })
      }
    })()
    return () => {
      alive = false
    }
  }, [file])

  const confirm = async (pkg: ValidPackage) => {
    setStep({ kind: 'importing', pkg })
    try {
      const result = await importProjectPackage(store, pkg, { reuseExisting: reuse }, { freeBytes })
      setStep({ kind: 'done', result })
    } catch (err) {
      setStep({ kind: 'failed', pkg, message: describeStorageError(err) })
    }
  }

  const busy = step.kind === 'validating' || step.kind === 'importing'
  const pkg = step.kind === 'review' || step.kind === 'importing' || step.kind === 'failed' ? step.pkg : null
  const s = pkg?.summary
  const preview = pkg ? previewProjectImport(pkg, data) : null
  const candidates = preview?.reuseCandidates ?? []

  return (
    <dialog
      ref={dialog}
      className="dialog transfer-dialog"
      aria-labelledby={headingId}
      data-testid="project-import"
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id={headingId}>Import project</h2>
      <p className="muted small">File: {file.name}</p>

      {step.kind === 'validating' && <p role="status">Checking the package…</p>}

      {step.kind === 'invalid' && (
        <div role="alert" data-testid="import-invalid">
          <p className="error-text">This file cannot be imported. Nothing in your workspace was changed.</p>
          <ul className="error-list">
            {step.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {pkg && s && preview && (
        <div data-testid="import-review">
          <p>The package passed every check (structure, version, checksums, records, and links). It contains:</p>
          <dl className="summary">
            <dt>Project</dt>
            <dd data-testid="import-name">
              <strong>{preview.projectName}</strong>
              {preview.renamedFrom && <span className="muted small"> — a project named “{preview.renamedFrom}” is already here, so this one gets a different name. Both are kept; you can rename it afterwards.</span>}
            </dd>
            <dt>Exported</dt>
            <dd>
              {s.createdAt ? fullDateTime(s.createdAt) : 'unknown'} with Minty Notes {s.appVersion} (package {s.packageVersion}, format {s.formatVersion})
            </dd>
            <dt>Notes</dt>
            <dd data-testid="import-notes-count">
              {plural(s.notes.length, 'project note')}
              {s.sketches > 0 && `, ${plural(s.sketches, 'sketch', 'sketches')}`}
            </dd>
            <dt>Tasks</dt>
            <dd data-testid="import-tasks">
              {plural(s.tasks.total, 'task')}
              {s.tasks.done > 0 && ` (${s.tasks.done} done)`}
            </dd>
            <dt>Images</dt>
            <dd data-testid="import-images">{plural(s.images, 'image')} (original files, with their markup)</dd>
            <dt>Imported documents</dt>
            <dd data-testid="import-originals">{s.originals === 0 ? 'none' : plural(s.originals, 'original DOCX/PDF file')}</dd>
            <dt>Reference copies</dt>
            <dd data-testid="import-references">{s.references.length === 0 ? 'none' : plural(s.references.length, 'page')}</dd>
            <dt>Categories</dt>
            <dd data-testid="import-categories">{preview.categories.length === 0 ? 'none' : preview.categories.map((c) => `${c.name} (${c.existing ? 'already here' : 'new'})`).join(', ')}</dd>
            <dt>Tags</dt>
            <dd>{preview.tags.length === 0 ? 'none' : preview.tags.map((t) => `#${t.name} (${t.existing ? 'already here' : 'new'})`).join(', ')}</dd>
            <dt>File locations</dt>
            <dd>
              {s.fileLocations.paths + s.fileLocations.links === 0 ? 'none' : `${plural(s.fileLocations.paths, 'folder path')} and ${plural(s.fileLocations.links, 'web link')} — text only; the files they point to are not in the package and may not exist on this computer.`}
            </dd>
            <dt>Size of files</dt>
            <dd>{formatBytes(s.attachmentBytes)}</dd>
          </dl>

          {s.notes.length > 0 && (
            <details className="transfer-details">
              <summary>Notes ({s.notes.length})</summary>
              <ul className="transfer-list">
                {s.notes.map((title, i) => (
                  <li key={i}>{title}</li>
                ))}
              </ul>
            </details>
          )}
          {s.references.length > 0 && (
            <details className="transfer-details" open>
              <summary>Reference copies ({s.references.length})</summary>
              <p className="muted small">Copies of pages the sender’s project linked to. They arrive as independent pages of this project (“Project copy”); they are not connected to the sender’s library or to pages of yours with the same title.</p>
              <ul className="transfer-list" data-testid="import-reference-list">
                {s.references.map((r) => (
                  <li key={r.pageId}>
                    <span className="transfer-title">{r.title}</span>
                    <span className="muted small">
                      {' '}
                      · was in {r.from} · {r.reasons.map((x) => REFERENCE_REASON_LABELS[x]).join(', ')}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {candidates.length > 0 && (
            <fieldset className="transfer-choice" data-testid="import-reuse">
              <legend>
                {plural(candidates.length, 'reference page')} of this package {candidates.length === 1 ? 'is a page' : 'are pages'} of this very library ({candidates.map((c) => `“${c.title}”`).join(', ')})
              </legend>
              <label className="check-row">
                <input type="radio" name="reuse" checked={!reuse} disabled={busy} onChange={() => setReuse(false)} />
                <span>Import independent copies (recommended) — the project keeps the pages as they were when it was exported.</span>
              </label>
              <label className="check-row">
                <input type="radio" name="reuse" checked={reuse} disabled={busy} onChange={() => setReuse(true)} data-testid="import-reuse-existing" />
                <span>Link to my existing pages instead — the project pins the pages already in this library (their current content; they are not changed).</span>
              </label>
            </fieldset>
          )}

          {preview.categories.some((c) => c.existing) && <p className="muted small">Because the project uses a category that is already here, pages of your own library with that category will be suggested in the project, as for any project. Nothing is linked or changed automatically.</p>}

          {pkg.warnings.length > 0 && (
            <ul className="warn-list" data-testid="import-warnings">
              {pkg.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          {s.coveredImages > 0 && (
            <p className="callout callout-warn" data-testid="import-covered">
              <IconAlert size={15} /> {plural(s.coveredImages, 'image')} in this project {s.coveredImages === 1 ? 'is' : 'are'} shown with a redaction, blur, or crop. The package contains the full original {s.coveredImages === 1 ? 'image' : 'images'}; the hidden parts can be uncovered in the markup editor.
            </p>
          )}

          <p className="callout" data-testid="import-promise">
            Importing <strong>adds a new project</strong> with its own notes, tasks, and files. <strong>Nothing that is already in this workspace is replaced or changed</strong>, and the imported project is independent of the sender’s copy.
          </p>
          {readOnly && (
            <p className="error-text" role="alert">
              This window is read-only. Use “Edit here instead” first; then import.
            </p>
          )}
        </div>
      )}

      {step.kind === 'importing' && <p role="status">Importing…</p>}

      {step.kind === 'done' && (
        <div role="status" data-testid="import-done">
          <p className="ok-text">
            Imported “{step.result.projectName}”: {plural(step.result.counts.notes, 'note')}, {plural(step.result.counts.snapshots, 'reference copy', 'reference copies')}
            {step.result.counts.linkedExisting > 0 && `, ${plural(step.result.counts.linkedExisting, 'linked existing page')}`}, {plural(step.result.counts.tasks, 'task')}, and {plural(step.result.counts.attachments, 'file')}.
          </p>
          {step.result.counts.unresolvedLinks > 0 && <p className="muted small">{plural(step.result.counts.unresolvedLinks, 'linked page')} was not part of the package; links to {step.result.counts.unresolvedLinks === 1 ? 'it' : 'them'} are shown as unavailable.</p>}
          <p className="muted small">It is in Projects with your other projects. Make a backup when convenient; the next automatic backup includes it.</p>
        </div>
      )}

      {step.kind === 'failed' && (
        <p role="alert" className="error-text" data-testid="import-failed">
          The project was not imported, and nothing in your workspace was changed. {step.message}
        </p>
      )}

      <div className="dialog-actions">
        {step.kind === 'done' ? (
          <>
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                nav.openProject(step.result.projectId)
                onClose()
              }}
              data-testid="import-open"
            >
              Open project
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              {step.kind === 'invalid' ? 'Close' : 'Cancel'}
            </button>
            {pkg && (
              <button type="button" className="btn btn-primary" disabled={busy || readOnly} onClick={() => void confirm(pkg)} data-testid="import-confirm">
                <IconDownload size={15} /> {step.kind === 'failed' ? 'Try again' : 'Import project'}
              </button>
            )}
          </>
        )}
      </div>
    </dialog>
  )
}

/** “Import project” on the Projects screen: choose a package file, then review it in the dialog. */
export function ImportProjectButton({ variant = 'icon' }: { variant?: 'icon' | 'button' }) {
  const readOnly = useWorkspace((s) => s.readOnly)
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  if (readOnly) return null
  return (
    <>
      {variant === 'icon' ? (
        <button type="button" className="icon-btn" aria-label="Import project" title="Import a project package (a file exported with “Export project”)" onClick={() => input.current?.click()} data-testid="import-project">
          <IconDownload />
        </button>
      ) : (
        <button type="button" className="btn" title="A file exported with “Export project” on another computer" onClick={() => input.current?.click()} data-testid="import-project-main">
          <IconDownload size={16} /> Import project…
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        hidden
        data-testid="import-project-file"
        onChange={(e) => {
          const chosen = e.target.files?.[0]
          e.target.value = ''
          if (chosen) setFile(chosen)
        }}
      />
      {/* Outside the list's own markup, so its heading and list styles do not apply to the dialog. */}
      {file && createPortal(<ProjectImportDialog file={file} onClose={() => setFile(null)} />, document.body)}
    </>
  )
}
