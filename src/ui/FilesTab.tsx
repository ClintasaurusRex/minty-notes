import { useServices, useWorkspace } from '../app/context'
import { newId, type FileLocation } from '../domain/types'
import { copyText, guard } from './actions'
import { IconCopy, IconExternal, IconFolder, IconLink, IconPlus, IconTrash } from './icons'
import { safeUrl } from './projectFormat'

/** Guess the kind from what was typed: an http(s) address is a web link, anything else a path. */
function guessKind(value: string): FileLocation['kind'] {
  return /^https?:\/\//i.test(value.trim()) ? 'url' : 'path'
}

/**
 * Saved file and folder locations of a project. Local paths are shown and
 * copied (a browser cannot open arbitrary Windows or Linux paths); only
 * http/https links (for example Dropbox web links) open, in a new tab.
 */
export function FilesTab({ projectId }: { projectId: string }) {
  const { store } = useServices()
  const project = useWorkspace((s) => s.data.projects[projectId])
  const readOnly = useWorkspace((s) => s.readOnly)
  if (!project) return null
  const editable = !readOnly && !project.trashedAt
  const items = project.fileLocations
  const save = (fileLocations: FileLocation[]) => guard(() => store.updateProject(projectId, { fileLocations }))
  const update = (id: string, patch: Partial<FileLocation>) => save(items.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  const add = (kind: FileLocation['kind']) => save([...items, { id: newId(), label: '', kind, value: '', description: '' }])

  return (
    <section className="card project-card files-tab" aria-labelledby="files-h" data-testid="files-tab">
      <div className="card-head">
        <h2 id="files-h">Files</h2>
        {editable && (
          <span className="btn-row">
            <button type="button" className="btn btn-small" onClick={() => add('path')}>
              <IconFolder size={14} /> Add local path
            </button>
            <button type="button" className="btn btn-small" onClick={() => add('url')}>
              <IconLink size={14} /> Add web link
            </button>
          </span>
        )}
      </div>
      <p className="muted small">
        Save where this project’s files live. <strong>Local paths</strong> (for example <code>C:\Jobs\J-1001</code> or <code>/home/me/Dropbox/Jobs</code>) are kept for copying: paste them into File Explorer or a file manager — browsers cannot open local folders directly. <strong>Web links</strong> (http/https, such as a Dropbox web link) open in a new tab and need a connection. Minty Notes stores only the location, not the files.
      </p>
      {items.length === 0 ? (
        <p className="muted small">No saved locations yet.</p>
      ) : (
        <ul className="file-list">
          {items.map((loc, i) => {
            const url = loc.kind === 'url' ? safeUrl(loc.value) : null
            const looksLikeLink = loc.kind === 'path' && guessKind(loc.value) === 'url'
            const unsafeLink = loc.kind === 'url' && loc.value.trim() !== '' && !url
            return (
              <li key={loc.id} className="file-item" data-testid="file-item">
                <div className="file-item-row">
                  <span className={`badge ${loc.kind === 'url' ? 'badge-library' : ''}`}>{loc.kind === 'url' ? 'Web link' : 'Local path'}</span>
                  <input className="file-label" aria-label={`Name of location ${i + 1}`} placeholder="Name, e.g. Job folder" value={loc.label} readOnly={!editable} onChange={(e) => update(loc.id, { label: e.target.value })} />
                  <select aria-label={`Type of location ${i + 1}`} value={loc.kind} disabled={!editable} onChange={(e) => update(loc.id, { kind: e.target.value as FileLocation['kind'] })}>
                    <option value="path">Local path</option>
                    <option value="url">Web link</option>
                  </select>
                  <span className="row-actions always">
                    <button type="button" className="icon-btn small" aria-label={`Copy ${loc.label || `location ${i + 1}`}`} title={loc.kind === 'url' ? 'Copy link' : 'Copy path'} disabled={!loc.value.trim()} onClick={() => void copyText(loc.value.trim(), loc.kind === 'url' ? 'Link' : 'Path')}>
                      <IconCopy size={14} />
                    </button>
                    {url && (
                      <a className="icon-btn small" href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${loc.label || 'link'} in a new tab`} title="Open in a new tab (needs a connection)">
                        <IconExternal size={14} />
                      </a>
                    )}
                    {editable && (
                      <button type="button" className="icon-btn small" aria-label={`Remove location ${i + 1}`} title="Remove (only the saved location; nothing on disk changes)" onClick={() => save(items.filter((f) => f.id !== loc.id))}>
                        <IconTrash size={14} />
                      </button>
                    )}
                  </span>
                </div>
                <input
                  className="file-value"
                  aria-label={`${loc.kind === 'url' ? 'Link' : 'Path'} of location ${i + 1}`}
                  placeholder={loc.kind === 'url' ? 'https://www.dropbox.com/…' : 'C:\\Jobs\\… or /home/…'}
                  value={loc.value}
                  readOnly={!editable}
                  spellCheck={false}
                  onChange={(e) => update(loc.id, { value: e.target.value })}
                />
                <textarea className="file-desc" rows={2} aria-label={`Description of location ${i + 1}`} placeholder="What is here? e.g. PLC program backups, panel drawings rev C" value={loc.description} readOnly={!editable} onChange={(e) => update(loc.id, { description: e.target.value })} />
                {looksLikeLink && editable && (
                  <p className="muted small">
                    This looks like a web link.{' '}
                    <button type="button" className="link-btn" onClick={() => update(loc.id, { kind: 'url' })}>
                      Save it as a web link
                    </button>{' '}
                    so it can open in the browser.
                  </p>
                )}
                {unsafeLink && <p className="small warn-text">Only http and https links can be opened. This one can still be copied.</p>}
              </li>
            )
          })}
        </ul>
      )}
      {editable && items.length > 0 && (
        <button type="button" className="btn btn-small" onClick={() => add('path')}>
          <IconPlus size={14} /> Add another location
        </button>
      )}
    </section>
  )
}
