import { useEffect, useId, useRef, useState } from 'react'
import { useServices } from '../app/context'
import { saveBytesAsDownload } from '../platform/download'
import { formatBytes } from '../platform/storageInfo'
import { REFERENCE_REASON_LABELS } from '../portable/format'
import { buildProjectExport, loadExportSnapshot, type ExportSnapshot } from '../portable/projectTransfer'
import { DEFAULT_EXPORT_OPTIONS, selectProject, type ExportOptions, type ExportSummary, type ReferenceGroup } from '../portable/selectProject'
import { IconAlert, IconDownload } from './icons'
import { notify } from './notices'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const GROUPS: { id: ReferenceGroup; option: keyof ExportOptions; label: string; hint: string }[] = [
  { id: 'pinned', option: 'includePinned', label: 'Pinned reference pages', hint: 'Pages you pinned to this project.' },
  { id: 'linked', option: 'includeLinked', label: 'Pages linked from this project’s notes and tasks', hint: 'Direct links only; links inside those pages are not followed.' },
  { id: 'suggested', option: 'includeSuggested', label: 'Pages suggested by category', hint: 'Every library page that shares a category with the project. This can be a large part of your library.' },
]

/** What the package would contain with these options (the same selection the export uses). */
function summarize(snapshot: ExportSnapshot | null, projectId: string, options: ExportOptions, at: string): { summary: ExportSummary | null; error: string | null } {
  if (!snapshot) return { summary: null, error: null }
  try {
    return { summary: selectProject(snapshot.records, projectId, options, at).summary, error: null }
  } catch (err) {
    return { summary: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Export one project as a portable package. The dialog first shows exactly
 * what will be in the file (and what will not), with the warning that a
 * package holds editable originals — then builds and downloads it. Nothing in
 * the workspace is changed.
 */
export function ProjectExportDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { store } = useServices()
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  const [snapshot, setSnapshot] = useState<ExportSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS)
  const [understood, setUnderstood] = useState(false)
  const [openedAt] = useState(() => new Date().toISOString())
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'building' } | { kind: 'done'; fileName: string; size: number } | { kind: 'failed'; message: string }>({ kind: 'idle' })

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
    loadExportSnapshot(store)
      .then((s) => alive && setSnapshot(s))
      .catch((err: unknown) => alive && setLoadError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [store])

  const { summary, error: selectError } = loadError ? { summary: null, error: loadError } : summarize(snapshot, projectId, options, openedAt)

  const busy = state.kind === 'building'
  const exportNow = async () => {
    if (!snapshot) return
    setState({ kind: 'building' })
    try {
      const result = await buildProjectExport(snapshot, projectId, options, __APP_VERSION__)
      saveBytesAsDownload(result.bytes, result.fileName)
      setState({ kind: 'done', fileName: result.fileName, size: result.bytes.byteLength })
      notify('success', `Saved the project package “${result.fileName}”. The project itself is unchanged.`, 8000)
    } catch (err) {
      setState({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const included = summary?.references.filter((r) => r.included) ?? []
  const needsAck = !!summary && summary.coveredImages > 0
  const out = summary?.unresolved
  const hiddenLinked = summary?.excluded.filter((x) => x.why === 'hidden') ?? []
  const otherProject = summary?.excluded.filter((x) => x.why === 'other-project') ?? []

  return (
    <dialog
      ref={dialog}
      className="dialog transfer-dialog"
      aria-labelledby={headingId}
      data-testid="project-export"
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id={headingId}>Export project{summary ? `: ${summary.projectName}` : ''}</h2>
      <p className="muted small">Makes one file you can send to a coworker or move to another computer. In Minty Notes there, “Import project” adds it as a new project. Exporting only reads: this project and your workspace are not changed.</p>

      {!snapshot && !selectError && <p role="status">Reading the saved project…</p>}
      {selectError && (
        <p role="alert" className="error-text">
          The project cannot be exported: {selectError}
        </p>
      )}

      {summary && (
        <div data-testid="export-summary">
          <h3 className="subhead">In the package</h3>
          <dl className="summary">
            <dt>Project</dt>
            <dd>Details, contacts, equipment, software versions, categories</dd>
            <dt>Notes</dt>
            <dd data-testid="export-notes">
              {plural(summary.notes.length, 'project note')}
              {summary.sketches > 0 && `, ${plural(summary.sketches, 'sketch', 'sketches')}`}
            </dd>
            <dt>Tasks</dt>
            <dd data-testid="export-tasks">
              {plural(summary.tasks.total, 'task')}
              {summary.tasks.done > 0 && ` (${summary.tasks.done} done)`} with status, order, priority, due dates, and note links
            </dd>
            <dt>Images</dt>
            <dd data-testid="export-images">
              {plural(summary.images, 'original image file')} with markup, crop, and annotations
            </dd>
            <dt>Imported documents</dt>
            <dd data-testid="export-originals">{summary.originals === 0 ? 'none' : `${plural(summary.originals, 'original DOCX/PDF file')} with ${summary.originals === 1 ? 'its' : 'their'} editable draft${summary.originals === 1 ? '' : 's'}`}</dd>
            <dt>Reference copies</dt>
            <dd data-testid="export-references">{included.length === 0 ? 'none' : plural(included.length, 'page')}</dd>
            <dt>Categories, tags</dt>
            <dd>
              {summary.categories.length === 0 ? 'no categories' : summary.categories.join(', ')} · {summary.tags.length === 0 ? 'no tags' : summary.tags.map((t) => `#${t}`).join(' ')}
            </dd>
            <dt>File locations</dt>
            <dd data-testid="export-locations">
              {summary.fileLocations.paths + summary.fileLocations.links === 0
                ? 'none'
                : `${plural(summary.fileLocations.paths, 'folder path')} and ${plural(summary.fileLocations.links, 'web link')} — as text only. The files and folders they point to are not included.`}
            </dd>
            <dt>Size of files</dt>
            <dd>{formatBytes(summary.attachmentBytes)}</dd>
          </dl>

          <h3 className="subhead">Reference pages</h3>
          <p className="muted small">Library pages this project links to (pages in notebooks, standalone notes, and the Inbox) are packed as copies (snapshots), so the project is understandable without your library. Your library pages are not changed. Pages hidden for this project and pages that belong to another project are never packed.</p>
          {GROUPS.map((g) => {
            // A page that is, say, both pinned and linked is listed under both: either option includes it.
            const pages = summary.references.filter((r) => r.groups.includes(g.id))
            return (
              <div key={g.id} className="transfer-group">
                <label className="check-row">
                  <input type="checkbox" checked={options[g.option]} disabled={busy || pages.length === 0} onChange={(e) => setOptions({ ...options, [g.option]: e.target.checked })} data-testid={`export-${g.id}`} />
                  <span>
                    {g.label} <span className="muted">({pages.length})</span>
                  </span>
                </label>
                {pages.length > 0 && (
                  <>
                    <p className="muted small transfer-hint">{g.hint}</p>
                    <ul className="transfer-list">
                      {pages.map((r) => (
                        <li key={r.pageId} className={r.included ? '' : 'is-out'}>
                          <span className="transfer-title">{r.title}</span>
                          <span className="muted small">
                            {' '}
                            · from {r.from} · {r.reasons.map((x) => REFERENCE_REASON_LABELS[x]).join(', ')}
                            {!r.included && ' · not included'}
                            {r.included && !options[g.option] && ' · still included by another choice here'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )
          })}

          <h3 className="subhead">Not in the package</h3>
          <ul className="transfer-list plain" data-testid="export-excluded">
            <li>Other projects, the rest of your notebooks and library, templates, and the Trash.</li>
            <li>The contents of saved file locations (only the paths and links themselves).</li>
            {summary.trashedNotes > 0 && <li>{plural(summary.trashedNotes, 'project note')} in the Trash.</li>}
            {summary.hiddenReferences > 0 && (
              <li data-testid="export-hidden">
                {plural(summary.hiddenReferences, 'page')} hidden for this project{hiddenLinked.length > 0 ? ` — also where a note or task links to ${summary.hiddenReferences === 1 ? 'it' : 'one'}.` : '.'}
              </li>
            )}
            {summary.excluded.length > 0 && (
              <li data-testid="export-excluded-pages">
                {otherProject.length > 0 && hiddenLinked.length > 0 ? 'Pages this project links to that are never packed:' : otherProject.length > 0 ? `${otherProject.length === 1 ? 'A page' : 'Pages'} of another project that this project links to (another project’s pages are never packed):` : `Hidden for this project, so not packed although the project links to ${hiddenLinked.length === 1 ? 'it' : 'them'}:`}
                <ul className="transfer-list">
                  {summary.excluded.map((x) => (
                    <li key={x.pageId} className="is-out">
                      <span className="transfer-title">{x.title}</span>
                      <span className="muted small">
                        {' '}
                        · {x.why === 'hidden' ? 'hidden for this project' : 'belongs to another project'} · from {x.from} · {x.reasons.map((r) => REFERENCE_REASON_LABELS[r]).join(', ')}
                      </span>
                    </li>
                  ))}
                </ul>
                <span className="muted small">Links to {summary.excluded.length === 1 ? 'this page' : 'these pages'} stay in the text and will show as unavailable after import; task links to {summary.excluded.length === 1 ? 'it' : 'them'} are left off.</span>
              </li>
            )}
            {summary.trashedPinned > 0 && <li>{plural(summary.trashedPinned, 'pinned page')} in the Trash.</li>}
            {out && out.linksNotIncluded > 0 && <li>{plural(out.linksNotIncluded, 'linked page')} outside the choices above: links to {out.linksNotIncluded === 1 ? 'it' : 'them'} stay in the text and will show as unavailable after import.</li>}
            {out && out.linksToTrash > 0 && <li>{plural(out.linksToTrash, 'linked page')} in the Trash: {out.linksToTrash === 1 ? 'that link' : 'those links'} will show as unavailable after import.</li>}
            {out && out.linksToDeleted > 0 && <li>{plural(out.linksToDeleted, 'link')} to a page that was already deleted forever.</li>}
            {out && out.taskLinks > 0 && <li>{plural(out.taskLinks, 'task link')} to pages that are not included (left off the copied tasks).</li>}
            {summary.clearedDueDates > 0 && <li>{plural(summary.clearedDueDates, 'due date')} that is not a real calendar date (left empty in the package).</li>}
          </ul>

          <div className="callout callout-warn" role="note" data-testid="export-privacy">
            <strong>
              <IconAlert size={15} /> A project package is editable data, not a redacted document.
            </strong>
            <p>
              It contains the <strong>original image files in full</strong>, also where a screenshot shows a redaction box, a blur, or a crop — whoever imports it can remove those and see what is underneath. It also contains the original DOCX/PDF files of imported documents and everything written in the notes and tasks listed above.
            </p>
            {summary.coveredImages > 0 && (
              <p data-testid="export-covered">
                <strong>
                  {plural(summary.coveredImages, 'image')} in this project {summary.coveredImages === 1 ? 'has' : 'have'} a redaction, blur, or crop.
                </strong>{' '}
                The hidden parts are in the package.
              </p>
            )}
            <p className="small">To share something without the hidden parts, use “Save PNG copy” on the picture or “Export PDF” on the note instead — those files are flattened.</p>
            {needsAck && (
              <label className="check-row">
                <input type="checkbox" checked={understood} disabled={busy} onChange={(e) => setUnderstood(e.target.checked)} data-testid="export-understood" />
                <span>I understand that the package contains the unredacted original images.</span>
              </label>
            )}
          </div>
        </div>
      )}

      {state.kind === 'building' && <p role="status">Building and checking the package…</p>}
      {state.kind === 'done' && (
        <p role="status" className="ok-text" data-testid="export-done">
          Saved “{state.fileName}” ({formatBytes(state.size)}) through the browser’s downloads. Send that file as it is; do not unpack it.
        </p>
      )}
      {state.kind === 'failed' && (
        <p role="alert" className="error-text">
          {state.message}
        </p>
      )}

      <div className="dialog-actions">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {state.kind === 'done' ? 'Done' : 'Cancel'}
        </button>
        <button type="button" className="btn btn-primary" disabled={!summary || busy || (needsAck && !understood)} onClick={() => void exportNow()} data-testid="export-download">
          <IconDownload size={15} /> {state.kind === 'done' ? 'Download again' : 'Download package'}
        </button>
      </div>
    </dialog>
  )
}
