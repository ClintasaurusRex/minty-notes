import { useState, type ReactNode } from 'react'
import { useServices, useWorkspace } from '../app/context'
import { dueState } from '../domain/dates'
import { linkedProjects, projectNotes, projectReferences, sharedCategoryIds } from '../domain/references'
import { normalize } from '../domain/search'
import { columnTasks, nextTask } from '../domain/tasks'
import { newId, PROJECT_STATUSES, type Contact, type Page, type Project, type ProjectItem, type ProjectStatus } from '../domain/types'
import { ReadOnlyError } from '../store/workspaceStore'
import { copyText, saveAsTemplate } from './actions'
import { relativeTime } from './format'
import { FilesTab } from './FilesTab'
import { IconArchive, IconCopy, IconEye, IconEyeOff, IconPin, IconPlus, IconRestore, IconTrash } from './icons'
import { LabelPicker } from './LabelPicker'
import { locationLabel } from './locations'
import { useNav, type ProjectTab } from './nav'
import { notify } from './notices'
import { safeUrl, STATUS_LABELS } from './projectFormat'
import { DueBadge, PriorityBadge, TaskBoard } from './TaskBoard'
import { TemplatePicker } from './Templates'

function guard(fn: () => void) {
  try {
    fn()
  } catch (err) {
    if (err instanceof ReadOnlyError) notify('info', err.message)
    else throw err
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

const TABS: { id: ProjectTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'files', label: 'Files' },
]

/** Open tasks for the overview: Doing first, then by due date and priority. */
function NextTasks({ project, onOpenTask }: { project: Project; onOpenTask: (id: string) => void }) {
  const tasks = useWorkspace((s) => s.data.tasks)
  const all = Object.values(tasks)
  const open = [...columnTasks(all, project.id, 'doing'), ...columnTasks(all, project.id, 'todo')]
  const next = nextTask(all, project.id)
  const shown = next ? [next, ...open.filter((t) => t.id !== next.id)].slice(0, 5) : []
  const done = columnTasks(all, project.id, 'done').length
  const nav = useNav()
  return (
    <section className="card project-card" aria-labelledby="next-h">
      <div className="card-head">
        <h2 id="next-h">Next tasks</h2>
        <button type="button" className="btn btn-small" onClick={() => nav.openProject(project.id, { tab: 'tasks' })}>
          Open board
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="muted small">{done > 0 ? `All ${done} task${done === 1 ? ' is' : 's are'} done.` : 'No tasks yet. Add them on the Tasks tab.'}</p>
      ) : (
        <ul className="ref-list">
          {shown.map((t) => (
            <li key={t.id} className="ref-row">
              <button type="button" className="ref-open" onClick={() => onOpenTask(t.id)}>
                <span className="ref-title">{t.title}</span>
                <span className="ref-meta task-meta">
                  <span className="badge">{t.status === 'doing' ? 'Doing' : 'To do'}</span> <PriorityBadge priority={t.priority} /> <DueBadge task={t} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        {open.length} open · {done} done
      </p>
    </section>
  )
}

interface ProjectViewProps {
  projectId: string
  tab: ProjectTab
  onTab: (tab: ProjectTab) => void
  /** Task whose editor is open on the board. */
  openTaskId: string | null
  onOpenTask: (id: string | null) => void
}

export function ProjectView({ projectId, tab, onTab, openTaskId, onOpenTask }: ProjectViewProps) {
  const { store } = useServices()
  const nav = useNav()
  const data = useWorkspace((s) => s.data)
  const readOnly = useWorkspace((s) => s.readOnly)
  const project = data.projects[projectId]
  if (!project) return <div className="empty-main"><p className="muted">This project no longer exists.</p></div>
  const taskCount = Object.values(data.tasks).filter((t) => t.projectId === project.id && t.status !== 'done').length

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
              <button type="button" className="btn btn-small" onClick={() => void saveAsTemplate('project', `${project.name} template`, (name) => store.createTemplateFromProject(project.id, name))}>
                Save as template
              </button>
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
        <div className="tabs" role="tablist" aria-label="Project sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={`tab${tab === t.id ? ' is-on' : ''}`}
              onClick={() => onTab(t.id)}
              onKeyDown={(e) => {
                const i = TABS.findIndex((x) => x.id === tab)
                const next = e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length] : e.key === 'ArrowLeft' ? TABS[(i + TABS.length - 1) % TABS.length] : null
                if (!next) return
                e.preventDefault()
                onTab(next.id)
                requestAnimationFrame(() => document.getElementById(`tab-${next.id}`)?.focus())
              }}
              data-testid={`tab-${t.id}`}
            >
              {t.label}
              {t.id === 'tasks' && taskCount > 0 && <span className="count">{taskCount}</span>}
              {t.id === 'files' && project.fileLocations.length > 0 && <span className="count">{project.fileLocations.length}</span>}
            </button>
          ))}
        </div>
      </header>

      {tab === 'tasks' && (
        <div role="tabpanel" id="panel-tasks" aria-labelledby="tab-tasks">
          <TaskBoard projectId={project.id} openTaskId={openTaskId} onOpenTask={onOpenTask} />
        </div>
      )}
      {tab === 'files' && (
        <div role="tabpanel" id="panel-files" aria-labelledby="tab-files">
          <FilesTab projectId={project.id} />
        </div>
      )}
      {tab === 'overview' && (
      <div role="tabpanel" id="panel-overview" aria-labelledby="tab-overview" className="project-panel">
      <div className="project-grid">
        <NextTasks project={project} onOpenTask={(id) => nav.openProject(project.id, { tab: 'tasks', taskId: id })} />
        <section className="card project-card" aria-labelledby="files-sum-h">
          <div className="card-head">
            <h2 id="files-sum-h">Files</h2>
            <button type="button" className="btn btn-small" onClick={() => onTab('files')}>
              Open Files
            </button>
          </div>
          {project.fileLocations.length === 0 ? (
            <p className="muted small">No saved file locations. Add folder paths (to copy) and Dropbox web links (to open) on the Files tab.</p>
          ) : (
            <ul className="ref-list">
              {project.fileLocations.slice(0, 4).map((loc) => {
                const url = loc.kind === 'url' ? safeUrl(loc.value) : null
                return (
                  <li key={loc.id} className="ref-row">
                    <span className="ref-open">
                      <span className="ref-title">{loc.label || (loc.kind === 'url' ? 'Web link' : 'Local path')}</span>
                      <span className="ref-meta mono">{loc.value}</span>
                    </span>
                    <span className="row-actions always">
                      <button type="button" className="icon-btn small" aria-label={`Copy ${loc.label || 'location'}`} title="Copy" disabled={!loc.value} onClick={() => void copyText(loc.value, loc.kind === 'url' ? 'Link' : 'Path')}>
                        <IconCopy size={14} />
                      </button>
                      {url && (
                        <a className="btn btn-small" href={url} target="_blank" rel="noopener noreferrer">
                          Open
                        </a>
                      )}
                    </span>
                  </li>
                )
              })}
              {project.fileLocations.length > 4 && <li className="muted small">…and {project.fileLocations.length - 4} more on the Files tab.</li>}
            </ul>
          )}
        </section>
      </div>

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
            {!readOnly && !project.trashedAt && (
              <span className="btn-row">
                <TemplatePicker
                  kinds={['note']}
                  label="New from template…"
                  onPick={(t) => guard(() => nav.openPage(store.createPageFromTemplate(t.id, { kind: 'project', projectId: project.id }).id, project.id))}
                />
                <button type="button" className="btn btn-small" onClick={() => guard(() => nav.openPage(store.createPage({ kind: 'project', projectId: project.id }).id, project.id))}>
                  <IconPlus size={14} /> New note
                </button>
              </span>
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
      )}
    </div>
  )
}
