import { useState, type ReactNode } from 'react'
import { useServices, useWorkspace } from '../app/context'
import { dueState } from '../domain/dates'
import { linkedProjects, projectNotes, projectReferences, sharedCategoryIds } from '../domain/references'
import { normalize } from '../domain/search'
import { newId, PROJECT_STATUSES, type Contact, type FileLocation, type Page, type Project, type ProjectItem, type ProjectStatus } from '../domain/types'
import { ReadOnlyError } from '../store/workspaceStore'
import { relativeTime } from './format'
import { IconArchive, IconCopy, IconExternal, IconEye, IconEyeOff, IconPin, IconPlus, IconRestore, IconTrash } from './icons'
import { LabelPicker } from './LabelPicker'
import { locationLabel } from './locations'
import { useNav } from './nav'
import { notify } from './notices'
import { safeUrl, STATUS_LABELS } from './projectFormat'

function guard(fn: () => void) {
  try {
    fn()
  } catch (err) {
    if (err instanceof ReadOnlyError) notify('info', err.message)
    else throw err
  }
}

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    notify('success', `${what} copied`)
  } catch {
    notify('error', 'The browser did not allow copying. Select the text and copy it instead.')
  }
}

function Field({ label, value, onChange, readOnly, placeholder, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; readOnly: boolean; placeholder?: string; type?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input type={type} value={value} readOnly={readOnly} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

interface RowListProps<T extends { id: string }> {
  title: string
  items: T[]
  readOnly: boolean
  empty: string
  addLabel: string
  make: () => T
  onChange: (items: T[]) => void
  columns: { key: keyof T & string; label: string; placeholder?: string; width?: string }[]
  extra?: (item: T) => ReactNode
}

/** Editable list of small records (contacts, equipment, software, file locations). */
function RowList<T extends { id: string }>({ title, items, readOnly, empty, addLabel, make, onChange, columns, extra }: RowListProps<T>) {
  const update = (id: string, key: keyof T, value: unknown) => onChange(items.map((i) => (i.id === id ? { ...i, [key]: value } : i)))
  return (
    <section className="card project-card" aria-label={title}>
      <div className="card-head">
        <h2>{title}</h2>
        {!readOnly && (
          <button type="button" className="btn btn-small" onClick={() => onChange([...items, make()])}>
            <IconPlus size={14} /> {addLabel}
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <ul className="row-list">
          {items.map((item, index) => (
            <li key={item.id} className="row-item">
              {columns.map((c) =>
                c.key === ('kind' as keyof T & string) ? (
                  <select
                    key={c.key}
                    aria-label={`${c.label} ${index + 1}`}
                    value={String(item[c.key])}
                    disabled={readOnly}
                    onChange={(e) => update(item.id, c.key, e.target.value)}
                  >
                    <option value="path">Path</option>
                    <option value="url">Web link</option>
                  </select>
                ) : (
                  <input
                    key={c.key}
                    style={c.width ? { flexBasis: c.width } : undefined}
                    aria-label={`${c.label} ${index + 1}`}
                    placeholder={c.placeholder ?? c.label}
                    value={String(item[c.key] ?? '')}
                    readOnly={readOnly}
                    onChange={(e) => update(item.id, c.key, e.target.value)}
                  />
                ),
              )}
              {extra?.(item)}
              {!readOnly && (
                <button type="button" className="icon-btn small" aria-label={`Remove ${title.toLowerCase()} ${index + 1}`} title="Remove" onClick={() => onChange(items.filter((i) => i.id !== item.id))}>
                  <IconTrash size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ReferenceRow({ page, project, kind }: { page: Page; project: Project; kind: 'pinned' | 'suggested' | 'hidden' }) {
  const { store } = useServices()
  const nav = useNav()
  const data = useWorkspace((s) => s.data)
  const readOnly = useWorkspace((s) => s.readOnly)
  const others = linkedProjects(page, data).filter((p) => p.id !== project.id)
  const reasons = kind === 'suggested' ? sharedCategoryIds(project, page, data).map((id) => data.categories[id]?.name) : []
  const copy = async () => {
    try {
      const created = await store.makeProjectCopy(project.id, page.id)
      notify('success', `Made an independent project copy of “${page.title}”. The original stays in the reference library and is no longer listed here.`)
      nav.openPage(created.id, project.id)
    } catch (err) {
      notify(err instanceof ReadOnlyError ? 'info' : 'error', err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <li className="ref-row" data-testid={`ref-${kind}`}>
      <button type="button" className="ref-open" onClick={() => nav.openPage(page.id, project.id)}>
        <span className="ref-title">{page.title || 'Untitled'}</span>
        <span className="ref-meta">
          <span className="badge badge-library">Reference library</span> {locationLabel(page.location, data)} · edited {relativeTime(page.updatedAt)}
          {others.length > 0 && ` · also linked in ${others.map((p) => p.name).join(', ')}`}
          {reasons.length > 0 && ` · matches ${reasons.join(', ')}`}
        </span>
      </button>
      {!readOnly && (
        <span className="row-actions always">
          {kind === 'suggested' && (
            <button type="button" className="icon-btn small" aria-label={`Pin ${page.title}`} title="Pin to this project" onClick={() => guard(() => store.pinReference(project.id, page.id))}>
              <IconPin size={14} />
            </button>
          )}
          {kind === 'pinned' && (
            <button type="button" className="icon-btn small" aria-label={`Unpin ${page.title}`} title="Unpin (the page is not changed)" onClick={() => guard(() => store.unpinReference(project.id, page.id))}>
              <IconPin size={14} className="unpin" />
            </button>
          )}
          {kind !== 'hidden' ? (
            <button type="button" className="icon-btn small" aria-label={`Hide ${page.title}`} title="Hide from this project (the page is not changed)" onClick={() => guard(() => store.hideReference(project.id, page.id))}>
              <IconEyeOff size={14} />
            </button>
          ) : (
            <button type="button" className="icon-btn small" aria-label={`Show ${page.title}`} title="Show in this project again" onClick={() => guard(() => store.unhideReference(project.id, page.id))}>
              <IconEye size={14} />
            </button>
          )}
          {kind !== 'hidden' && (
            <button type="button" className="icon-btn small" aria-label={`Make a project copy of ${page.title}`} title="Make a project copy (independent)" onClick={() => void copy()}>
              <IconCopy size={14} />
            </button>
          )}
        </span>
      )}
    </li>
  )
}

function PinFinder({ project }: { project: Project }) {
  const { store } = useServices()
  const pages = useWorkspace((s) => s.data.pages)
  const data = useWorkspace((s) => s.data)
  const [query, setQuery] = useState('')
  const q = normalize(query.trim())
  const matches = q
    ? Object.values(pages)
        .filter((p) => !p.trashedAt && p.location.kind !== 'project' && !project.pinnedPageIds.includes(p.id) && normalize(p.title).includes(q))
        .sort((a, b) => a.title.localeCompare(b.title))
        .slice(0, 8)
    : []
  return (
    <div className="pin-finder">
      <input aria-label="Find a library page to pin" placeholder="Find a library page to pin…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {q && (
        <ul className="pin-results">
          {matches.length === 0 && <li className="muted small">No matching library pages.</li>}
          {matches.map((p) => (
            <li key={p.id}>
              <span>
                {p.title || 'Untitled'} <span className="muted small">· {locationLabel(p.location, data)}</span>
              </span>
              <button
                type="button"
                className="btn btn-small"
                onClick={() =>
                  guard(() => {
                    store.pinReference(project.id, p.id)
                    setQuery('')
                  })
                }
              >
                <IconPin size={14} /> Pin
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ProjectView({ projectId }: { projectId: string }) {
  const { store } = useServices()
  const nav = useNav()
  const data = useWorkspace((s) => s.data)
  const readOnly = useWorkspace((s) => s.readOnly)
  const project = data.projects[projectId]
  if (!project) return <div className="empty-main"><p className="muted">This project no longer exists.</p></div>

  const set = (patch: Partial<Project>) => guard(() => store.updateProject(project.id, patch))
  const notes = projectNotes(project.id, data.pages)
  const refs = projectReferences(project, data)
  const due = project.dueDate ? dueState(project.dueDate) : null

  return (
    <div className="project-view" data-testid="project-view">
      {project.trashedAt && (
        <div className="banner banner-warn" role="status">
          This project is in the Trash.
          {!readOnly && (
            <button type="button" className="btn btn-small" onClick={() => guard(() => store.restoreProject(project.id))}>
              <IconRestore size={14} /> Restore project
            </button>
          )}
        </div>
      )}
      {project.archivedAt && !project.trashedAt && (
        <div className="banner" role="status">
          Archived {relativeTime(project.archivedAt)}. Everything is kept; it is hidden from active lists.
        </div>
      )}
      <header className="project-header">
        <input className="project-name" aria-label="Project name" value={project.name} readOnly={readOnly} placeholder="Project name" onChange={(e) => set({ name: e.target.value })} onBlur={(e) => !e.target.value.trim() && !readOnly && set({ name: 'Untitled project' })} />
        <div className="project-header-row">
          <label className="field inline">
            <span className="field-label">Status</span>
            <select value={project.status} disabled={readOnly} onChange={(e) => set({ status: e.target.value as ProjectStatus })} aria-label="Status">
              {PROJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="field inline">
            <span className="field-label">Due</span>
            <input type="date" aria-label="Due date" max="9999-12-31" value={project.dueDate ?? ''} readOnly={readOnly} onChange={(e) => set({ dueDate: e.target.value || null })} />
          </label>
          {due && <span className={`pill due-${due.tone}`}>{due.text}</span>}
          <span className="spacer" />
          {!readOnly && !project.trashedAt && (
            <>
              <button type="button" className="btn btn-small" onClick={() => guard(() => store.setProjectArchived(project.id, !project.archivedAt))}>
                <IconArchive size={14} /> {project.archivedAt ? 'Unarchive' : 'Archive'}
              </button>
              <button
                type="button"
                className="btn btn-small btn-ghost"
                onClick={() =>
                  guard(() => {
                    store.trashProject(project.id)
                    notify('info', `“${project.name}” moved to Trash with its notes. Shared reference pages are not affected.`)
                    nav.openProject(null)
                  })
                }
              >
                <IconTrash size={14} /> Move to Trash
              </button>
            </>
          )}
        </div>
      </header>

      <div className="project-grid">
        <section className="card project-card" aria-labelledby="details-h">
          <h2 id="details-h">Details</h2>
          <div className="field-grid">
            <Field label="Customer" value={project.customer} readOnly={readOnly} onChange={(v) => set({ customer: v })} />
            <Field label="Site" value={project.site} readOnly={readOnly} onChange={(v) => set({ site: v })} />
            <Field label="Job number" value={project.jobNumber} readOnly={readOnly} onChange={(v) => set({ jobNumber: v })} />
          </div>
          <label className="field">
            <span className="field-label">Description</span>
            <textarea rows={2} value={project.description} readOnly={readOnly} onChange={(e) => set({ description: e.target.value })} />
          </label>
          <div className="field">
            <span className="field-label">System categories</span>
            <LabelPicker kind="category" label="Add system category to project" selected={project.categoryIds} onChange={(ids) => guard(() => store.setCategories('projects', project.id, ids))} />
            <p className="muted small">Library pages in matching notebooks, sections, or pages are suggested below.</p>
          </div>
        </section>

        <section className="card project-card" aria-labelledby="notes-h">
          <div className="card-head">
            <h2 id="notes-h">Project notes</h2>
            {!readOnly && (
              <button type="button" className="btn btn-small" onClick={() => guard(() => nav.openPage(store.createPage({ kind: 'project', projectId: project.id }).id, project.id))}>
                <IconPlus size={14} /> New note
              </button>
            )}
          </div>
          {notes.length === 0 ? (
            <p className="muted small">No project notes yet. Notes made here belong to this project.</p>
          ) : (
            <ul className="ref-list">
              {notes.map((p) => (
                <li key={p.id} className="ref-row">
                  <button type="button" className="ref-open" onClick={() => nav.openPage(p.id, project.id)}>
                    <span className="ref-title">{p.title || 'Untitled'}</span>
                    <span className="ref-meta">
                      {p.copiedFrom ? <span className="badge badge-copy">Project copy</span> : <span className="badge">Project note</span>} edited {relativeTime(p.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card project-card" aria-labelledby="refs-h">
        <div className="card-head">
          <h2 id="refs-h">References</h2>
        </div>
        <p className="muted small">Linked reference pages are the originals from the library: edits show everywhere they are linked. Use “Make a project copy” for project-specific changes.</p>
        <h3 className="subhead">Pinned</h3>
        {refs.pinned.length === 0 ? <p className="muted small">Nothing pinned.</p> : <ul className="ref-list">{refs.pinned.map((p) => <ReferenceRow key={p.id} page={p} project={project} kind="pinned" />)}</ul>}
        {refs.trashedPinned.length > 0 && (
          <p className="muted small">
            {refs.trashedPinned.length} pinned page{refs.trashedPinned.length === 1 ? ' is' : 's are'} in the Trash ({refs.trashedPinned.map((p) => `“${p.title}”`).join(', ')}). Restoring {refs.trashedPinned.length === 1 ? 'it' : 'them'} brings the pin back.
          </p>
        )}
        {!readOnly && <PinFinder project={project} />}
        <h3 className="subhead">Suggested by category</h3>
        {project.categoryIds.length === 0 ? (
          <p className="muted small">Add system categories to get suggestions.</p>
        ) : refs.suggested.length === 0 ? (
          <p className="muted small">No library pages match this project’s categories yet. Give a notebook, section, or page the same category.</p>
        ) : (
          <ul className="ref-list">{refs.suggested.map((p) => <ReferenceRow key={p.id} page={p} project={project} kind="suggested" />)}</ul>
        )}
        {refs.hidden.length > 0 && (
          <details className="hidden-refs">
            <summary>
              {refs.hidden.length} hidden suggestion{refs.hidden.length === 1 ? '' : 's'}
            </summary>
            <ul className="ref-list">{refs.hidden.map((p) => <ReferenceRow key={p.id} page={p} project={project} kind="hidden" />)}</ul>
          </details>
        )}
      </section>

      <RowList<FileLocation>
        title="File locations"
        items={project.fileLocations}
        readOnly={readOnly}
        empty="No saved locations. Add a project folder path (to copy) or a Dropbox web link (to open)."
        addLabel="Add location"
        make={() => ({ id: newId(), label: '', kind: 'path', value: '' })}
        onChange={(fileLocations) => set({ fileLocations })}
        columns={[
          { key: 'label', label: 'Location name', width: '160px' },
          { key: 'kind', label: 'Location type' },
          { key: 'value', label: 'Path or link', placeholder: 'C:\\Jobs\\… or https://www.dropbox.com/…', width: '320px' },
        ]}
        extra={(loc) => {
          const url = loc.kind === 'url' ? safeUrl(loc.value) : null
          return (
            <span className="row-actions always">
              <button type="button" className="icon-btn small" aria-label={`Copy ${loc.label || 'location'}`} title="Copy" disabled={!loc.value} onClick={() => void copyText(loc.value, loc.kind === 'url' ? 'Link' : 'Path')}>
                <IconCopy size={14} />
              </button>
              {url && (
                <a className="icon-btn small" href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${loc.label || 'link'}`} title="Open link in a new tab (needs a connection)">
                  <IconExternal size={14} />
                </a>
              )}
            </span>
          )
        }}
      />
      <div className="project-grid">
        <RowList<Contact>
          title="Contacts"
          items={project.contacts}
          readOnly={readOnly}
          empty="No contacts yet."
          addLabel="Add contact"
          make={() => ({ id: newId(), name: '', role: '', phone: '', email: '' })}
          onChange={(contacts) => set({ contacts })}
          columns={[
            { key: 'name', label: 'Contact name' },
            { key: 'role', label: 'Role' },
            { key: 'phone', label: 'Phone' },
            { key: 'email', label: 'Email' },
          ]}
        />
        <RowList<ProjectItem>
          title="Equipment"
          items={project.equipment}
          readOnly={readOnly}
          empty="No equipment listed."
          addLabel="Add equipment"
          make={() => ({ id: newId(), name: '', detail: '' })}
          onChange={(equipment) => set({ equipment })}
          columns={[
            { key: 'name', label: 'Equipment', placeholder: 'e.g. PLC' },
            { key: 'detail', label: 'Model or details', placeholder: 'e.g. 1756-L83E' },
          ]}
        />
        <RowList<ProjectItem>
          title="Software versions"
          items={project.software}
          readOnly={readOnly}
          empty="No software versions listed."
          addLabel="Add software"
          make={() => ({ id: newId(), name: '', detail: '' })}
          onChange={(software) => set({ software })}
          columns={[
            { key: 'name', label: 'Software', placeholder: 'e.g. VTScada' },
            { key: 'detail', label: 'Version', placeholder: 'e.g. 12.1.40' },
          ]}
        />
      </div>
    </div>
  )
}
