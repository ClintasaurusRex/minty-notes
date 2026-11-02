import { useRef, useState, type ReactNode } from 'react'
import { useServices, useWorkspace } from '../app/context'
import { normalize } from '../domain/search'
import { projectNotes, projectReferences } from '../domain/references'
import type { Page } from '../domain/types'
import { ReadOnlyError } from '../store/workspaceStore'
import { shortDateTime } from './format'
import { IconChevron, IconPencil, IconPin, IconPlus, IconRestore, IconTag, IconTrash } from './icons'
import { LabelPicker } from './LabelPicker'
import { useNav, type NavSection, type OpenProjectOptions } from './nav'
import { notify } from './notices'
import { STATUS_LABELS } from './projectFormat'

interface Props {
  section: NavSection
  pageId: string | null
  projectId: string | null
  onOpenPage: (id: string, projectId?: string | null) => void
  onOpenProject: (id: string | null, options?: OpenProjectOptions) => void
  onQuickNote: () => void
}

const STARTER_NOTEBOOKS = ['VTScada', 'Studio 5000', 'Weidmüller', 'Custom tools', 'Panel building']

function guard(fn: () => void) {
  try {
    fn()
  } catch (err) {
    if (err instanceof ReadOnlyError) notify('info', err.message)
    else throw err
  }
}

function PageItem({ page, active, onOpen, meta }: { page: Page; active: boolean; onOpen: () => void; meta?: ReactNode }) {
  return (
    <li>
      <button type="button" className={`nav-page${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onOpen}>
        <span className="nav-page-title">{page.title || 'Untitled'}</span>
        <span className="nav-page-meta">{meta ?? shortDateTime(page.createdAt)}</span>
      </button>
    </li>
  )
}

function RenameInput({ value, label, onDone }: { value: string; label: string; onDone: (v: string | null) => void }) {
  const [draft, setDraft] = useState(value)
  return (
    <input
      className="rename-input"
      aria-label={label}
      value={draft}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onDone(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(draft)
        if (e.key === 'Escape') onDone(null)
      }}
    />
  )
}

/** Edit the system categories of a notebook or section (pages inside inherit them). */
function CategoryDialog({ kind, id, onClose }: { kind: 'notebooks' | 'sections'; id: string; onClose: () => void }) {
  const { store } = useServices()
  const rec = useWorkspace((s) => s.data[kind][id])
  const notebooks = useWorkspace((s) => s.data.notebooks)
  const ref = useRef<HTMLDialogElement>(null)
  const open = (el: HTMLDialogElement | null) => {
    ref.current = el
    if (el && !el.open) el.showModal()
  }
  if (!rec) return null
  const inherited = kind === 'sections' ? (notebooks[(rec as { notebookId: string }).notebookId]?.categoryIds ?? []).map((c) => ({ id: c, from: 'its notebook' })) : []
  return (
    <dialog ref={open} className="dialog" aria-labelledby="cat-dialog-h" onClose={onClose} onCancel={onClose}>
      <h2 id="cat-dialog-h">Categories for “{rec.title}”</h2>
      <p className="muted small">Pages in this {kind === 'notebooks' ? 'notebook' : 'section'} get these system categories, so projects with the same category suggest them as references.</p>
      <LabelPicker kind="category" label={`Add category to ${rec.title}`} selected={rec.categoryIds} inherited={inherited} onChange={(ids) => guard(() => store.setCategories(kind, id, ids))} />
      <div className="dialog-actions">
        <button type="button" className="btn btn-primary" onClick={() => ref.current?.close()}>
          Done
        </button>
      </div>
    </dialog>
  )
}

function ProjectsNav({ projectId, pageId, onOpenPage, onOpenProject }: Pick<Props, 'projectId' | 'pageId' | 'onOpenPage' | 'onOpenProject'>) {
  const { store } = useServices()
  const data = useWorkspace((s) => s.data)
  const readOnly = useWorkspace((s) => s.readOnly)
  const [filter, setFilter] = useState<'open' | 'archived'>('open')
  const [query, setQuery] = useState('')
  const project = projectId ? data.projects[projectId] : undefined
  const nav = useNav()

  if (project) {
    const tasks = Object.values(data.tasks).filter((t) => t.projectId === project.id)
    const doneTasks = tasks.filter((t) => t.status === 'done').length
    const openTasks = tasks.length - doneTasks
    const notes = projectNotes(project.id, data.pages)
    const refs = projectReferences(project, data)
    return (
      <nav className="navigator" aria-label="Project">
        <button type="button" className="link-btn back-link" onClick={() => onOpenProject(null)}>
          ‹ All projects
        </button>
        <div className="nav-head">
          <h2 className="project-nav-title">{project.name || 'Untitled project'}</h2>
        </div>
        <ul className="nav-list">
          {(
            [
              ['overview', 'Overview', `${STATUS_LABELS[project.status]}${project.archivedAt ? ' · archived' : ''}${project.trashedAt ? ' · in Trash' : ''}`],
              ['tasks', 'Tasks', `${openTasks} open · ${doneTasks} done`],
              ['files', 'Files', `${project.fileLocations.length} location${project.fileLocations.length === 1 ? '' : 's'}`],
            ] as const
          ).map(([tab, label, meta]) => {
            const active = !pageId && nav.projectTab === tab
            return (
              <li key={tab}>
                <button type="button" className={`nav-page${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => onOpenProject(project.id, { tab })} data-testid={`project-nav-${tab}`}>
                  <span className="nav-page-title">{label}</span>
                  <span className="nav-page-meta">{meta}</span>
                </button>
              </li>
            )
          })}
        </ul>
        <div className="nav-subhead">
          <span>Notes</span>
          {!readOnly && !project.trashedAt && (
            <button type="button" className="icon-btn small" aria-label="New project note" title="New project note" onClick={() => guard(() => onOpenPage(store.createPage({ kind: 'project', projectId: project.id }).id, project.id))}>
              <IconPlus size={14} />
            </button>
          )}
        </div>
        <ul className="nav-list">
          {notes.length === 0 && <li className="nav-empty small">No notes</li>}
          {notes.map((p) => (
            <PageItem key={p.id} page={p} active={p.id === pageId} onOpen={() => onOpenPage(p.id, project.id)} meta={p.copiedFrom ? 'Project copy' : shortDateTime(p.updatedAt)} />
          ))}
        </ul>
        <div className="nav-subhead">
          <span>References</span>
        </div>
        <ul className="nav-list">
          {refs.pinned.length + refs.suggested.length === 0 && <li className="nav-empty small">None linked</li>}
          {refs.pinned.map((p) => (
            <PageItem key={p.id} page={p} active={p.id === pageId} onOpen={() => onOpenPage(p.id, project.id)} meta={<><IconPin size={11} /> Pinned · library</>} />
          ))}
          {refs.suggested.map((p) => (
            <PageItem key={p.id} page={p} active={p.id === pageId} onOpen={() => onOpenPage(p.id, project.id)} meta="Suggested · library" />
          ))}
        </ul>
      </nav>
    )
  }

  const q = normalize(query.trim())
  const list = Object.values(data.projects)
    .filter((p) => !p.trashedAt && (filter === 'archived' ? !!p.archivedAt : !p.archivedAt))
    .filter((p) => !q || normalize([p.name, p.customer, p.site, p.jobNumber].join(' ')).includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
  return (
    <nav className="navigator" aria-label="Projects">
      <div className="nav-head">
        <h2>Projects</h2>
        {!readOnly && (
          <button
            type="button"
            className="icon-btn"
            aria-label="New project"
            title="New project"
            onClick={() =>
              guard(() => {
                onOpenProject(store.createProject({ name: 'New project' }).id)
              })
            }
          >
            <IconPlus />
          </button>
        )}
      </div>
      <div className="seg" role="group" aria-label="Show projects">
        <button type="button" className={`seg-btn${filter === 'open' ? ' is-on' : ''}`} aria-pressed={filter === 'open'} onClick={() => setFilter('open')}>
          Current
        </button>
        <button type="button" className={`seg-btn${filter === 'archived' ? ' is-on' : ''}`} aria-pressed={filter === 'archived'} onClick={() => setFilter('archived')}>
          Archived
        </button>
      </div>
      <input className="nav-filter" aria-label="Filter projects" placeholder="Filter by name, customer, site, job…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {list.length === 0 ? (
        <p className="nav-empty">{filter === 'archived' ? 'No archived projects.' : q ? 'No matching projects.' : 'No projects yet.'}</p>
      ) : (
        <ul className="nav-list">
          {list.map((p) => (
            <li key={p.id}>
              <button type="button" className="nav-page" onClick={() => onOpenProject(p.id)}>
                <span className="nav-page-title">{p.name || 'Untitled project'}</span>
                <span className="nav-page-meta">
                  {STATUS_LABELS[p.status]}
                  {[p.customer, p.site].filter(Boolean).length > 0 && ` · ${[p.customer, p.site].filter(Boolean).join(' · ')}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}

export function Navigator({ section, pageId, projectId, onOpenPage, onOpenProject, onQuickNote }: Props) {
  const { store } = useServices()
  const projects = useWorkspace((s) => s.data.projects)
  const tasks = useWorkspace((s) => s.data.tasks)
  const categories = useWorkspace((s) => s.data.categories)
  const [editingCategories, setEditingCategories] = useState<{ kind: 'notebooks' | 'sections'; id: string } | null>(null)
  const pages = useWorkspace((s) => s.data.pages)
  const notebooks = useWorkspace((s) => s.data.notebooks)
  const sections = useWorkspace((s) => s.data.sections)
  const readOnly = useWorkspace((s) => s.readOnly)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)

  const all = Object.values(pages)
  const live = all.filter((p) => !p.trashedAt)
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (section === 'projects') {
    return <ProjectsNav projectId={projectId} pageId={pageId} onOpenPage={onOpenPage} onOpenProject={onOpenProject} />
  }

  if (section === 'inbox' || section === 'notes') {
    const inbox = section === 'inbox'
    const list = live
      .filter((p) => p.location.kind === (inbox ? 'inbox' : 'standalone'))
      .sort((a, b) => (inbox ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt)))
    return (
      <nav className="navigator" aria-label={inbox ? 'Inbox' : 'Standalone notes'}>
        <div className="nav-head">
          <h2>{inbox ? 'Inbox' : 'Standalone notes'}</h2>
          {!readOnly && (
            <button
              type="button"
              className="icon-btn"
              aria-label={inbox ? 'New quick note' : 'New standalone note'}
              title={inbox ? 'New quick note (Alt+N)' : 'New standalone note'}
              onClick={() => (inbox ? onQuickNote() : guard(() => onOpenPage(store.createPage({ kind: 'standalone' }, 'Untitled note').id)))}
            >
              <IconPlus />
            </button>
          )}
        </div>
        <p className="nav-hint">{inbox ? 'Quick captures land here. Move them into a notebook or keep them as standalone notes.' : 'Notes kept on their own, outside any notebook.'}</p>
        {list.length === 0 ? (
          <p className="nav-empty">{inbox ? 'Nothing captured yet.' : 'No standalone notes yet.'}</p>
        ) : (
          <ul className="nav-list">
            {list.map((p) => (
              <PageItem key={p.id} page={p} active={p.id === pageId} onOpen={() => onOpenPage(p.id)} />
            ))}
          </ul>
        )}
      </nav>
    )
  }

  if (section === 'trash') {
    const trashed = all.filter((p) => p.trashedAt).sort((a, b) => b.trashedAt!.localeCompare(a.trashedAt!))
    const trashedProjects = Object.values(projects)
      .filter((p) => p.trashedAt)
      .sort((a, b) => b.trashedAt!.localeCompare(a.trashedAt!))
    return (
      <nav className="navigator" aria-label="Trash">
        <div className="nav-head">
          <h2>Trash</h2>
        </div>
        <p className="nav-hint">Trashed pages and projects are kept until you delete them forever. Backups include them.</p>
        {trashedProjects.length > 0 && (
          <>
            <div className="nav-subhead">
              <span>Projects</span>
            </div>
            <ul className="nav-list" aria-label="Trashed projects">
              {trashedProjects.map((p) => {
                const owned = all.filter((pg) => pg.location.kind === 'project' && pg.location.projectId === p.id).length
                const taskCount = Object.values(tasks).filter((t) => t.projectId === p.id).length
                return (
                  <li key={p.id} className="trash-item">
                    <span className="nav-page-title">{p.name || 'Untitled project'}</span>
                    <span className="nav-page-meta">
                      Project · {owned} note{owned === 1 ? '' : 's'} · {taskCount} task{taskCount === 1 ? '' : 's'} · trashed {shortDateTime(p.trashedAt)}
                    </span>
                    {!readOnly && (
                      <span className="row-actions always">
                        <button type="button" className="btn btn-small" onClick={() => guard(() => store.restoreProject(p.id))}>
                          <IconRestore size={14} /> Restore
                        </button>
                        <button
                          type="button"
                          className="btn btn-small btn-danger"
                          onClick={() => {
                            const msg = `Delete the project “${p.name}” forever? Its details and links are removed.${taskCount ? ` Its ${taskCount} task${taskCount === 1 ? ' is' : 's are'} deleted with it.` : ''}${owned ? ` Its ${owned} note${owned === 1 ? '' : 's'} will stay in the Trash (restorable to the Inbox).` : ''} Shared reference pages are not affected.`
                            if (window.confirm(msg)) guard(() => void store.deleteProjectForever(p.id))
                          }}
                        >
                          Delete forever
                        </button>
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
            <div className="nav-subhead">
              <span>Pages</span>
            </div>
          </>
        )}
        {trashed.length === 0 ? (
          <p className="nav-empty">Trash is empty.</p>
        ) : (
          <ul className="nav-list">
            {trashed.map((p) => (
              <li key={p.id} className="trash-item">
                <span className="nav-page-title">{p.title || 'Untitled'}</span>
                <span className="nav-page-meta">Trashed {shortDateTime(p.trashedAt)}</span>
                {!readOnly && (
                  <span className="row-actions always">
                    <button type="button" className="btn btn-small" onClick={() => guard(() => store.restorePage(p.id))}>
                      <IconRestore size={14} /> Restore
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      onClick={() => {
                        const taskLinks = Object.values(tasks).filter((t) => t.linkedPageIds.includes(p.id)).length
                        if (window.confirm(`Delete “${p.title}” forever? Its text and layout will be removed from this workspace.${taskLinks ? ` It is also unlinked from ${taskLinks} task${taskLinks === 1 ? '' : 's'} (the tasks stay).` : ''}`)) {
                          store.deletePageForever(p.id).catch((err: unknown) => notify('error', String(err)))
                        }
                      }}
                    >
                      Delete forever
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </nav>
    )
  }

  // Notebooks → sections → pages
  const nbList = Object.values(notebooks).sort((a, b) => a.order - b.order)
  const finishRename = (kind: 'notebook' | 'section', id: string) => (v: string | null) => {
    setRenaming(null)
    if (v === null) return
    guard(() => (kind === 'notebook' ? store.renameNotebook(id, v) : store.renameSection(id, v)))
  }
  return (
    <nav className="navigator" aria-label="Notebooks">
      <div className="nav-head">
        <h2>Notebooks</h2>
        {!readOnly && (
          <button
            type="button"
            className="icon-btn"
            aria-label="New notebook"
            title="New notebook"
            onClick={() =>
              guard(() => {
                const { notebook } = store.createNotebook('New notebook')
                setRenaming(notebook.id)
              })
            }
          >
            <IconPlus />
          </button>
        )}
      </div>
      {nbList.length === 0 && (
        <div className="nav-empty">
          <p>No notebooks yet. Notebooks hold sections, and sections hold pages.</p>
          {!readOnly && (
            <button type="button" className="btn btn-small" onClick={() => guard(() => STARTER_NOTEBOOKS.forEach((t) => store.createNotebook(t, [store.createCategory(t).id])))}>
              Add starter notebooks
            </button>
          )}
          <p className="muted small">Creates empty notebooks for {STARTER_NOTEBOOKS.join(', ')}, each with the matching system category. Rename or delete them freely.</p>
        </div>
      )}
      <ul className="tree">
        {nbList.map((nb) => {
          const secs = Object.values(sections)
            .filter((s) => s.notebookId === nb.id)
            .sort((a, b) => a.order - b.order)
          const open = !collapsed.has(nb.id)
          const nbHasPages = secs.some((s) => live.some((p) => p.location.kind === 'section' && p.location.sectionId === s.id))
          return (
            <li key={nb.id} className="tree-notebook">
              <div className="tree-row">
                {renaming === nb.id ? (
                  <RenameInput value={nb.title} label="Notebook name" onDone={finishRename('notebook', nb.id)} />
                ) : (
                  <button type="button" className="tree-toggle" aria-expanded={open} onClick={() => toggle(nb.id)}>
                    <IconChevron size={14} className={open ? 'rot90' : ''} />
                    <span className="tree-label">{nb.title}</span>
                    <CategoryHint ids={nb.categoryIds} names={categories} />
                  </button>
                )}
                {!readOnly && renaming !== nb.id && (
                  <span className="row-actions">
                    <button type="button" className="icon-btn small" aria-label={`Categories for ${nb.title}`} title="System categories" onClick={() => setEditingCategories({ kind: 'notebooks', id: nb.id })}>
                      <IconTag size={14} />
                    </button>
                    <button type="button" className="icon-btn small" aria-label={`Add section to ${nb.title}`} title="Add section" onClick={() => guard(() => setRenaming(store.createSection(nb.id, 'New section').id))}>
                      <IconPlus size={14} />
                    </button>
                    <button type="button" className="icon-btn small" aria-label={`Rename ${nb.title}`} title="Rename" onClick={() => setRenaming(nb.id)}>
                      <IconPencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn small"
                      aria-label={`Delete notebook ${nb.title}`}
                      title={nbHasPages ? 'Move or trash its pages first' : 'Delete notebook'}
                      disabled={nbHasPages}
                      onClick={() => guard(() => void store.deleteNotebook(nb.id))}
                    >
                      <IconTrash size={14} />
                    </button>
                  </span>
                )}
              </div>
              {open && (
                <ul>
                  {secs.map((sec) => {
                    const secPages = live
                      .filter((p) => p.location.kind === 'section' && p.location.sectionId === sec.id)
                      .sort((a, b) => a.order - b.order)
                    return (
                      <li key={sec.id} className="tree-section">
                        <div className="tree-row">
                          {renaming === sec.id ? (
                            <RenameInput value={sec.title} label="Section name" onDone={finishRename('section', sec.id)} />
                          ) : (
                            <span className="tree-label section-label">
                              {sec.title}
                              <CategoryHint ids={sec.categoryIds} names={categories} />
                            </span>
                          )}
                          {!readOnly && renaming !== sec.id && (
                            <span className="row-actions">
                              <button type="button" className="icon-btn small" aria-label={`Categories for ${sec.title}`} title="System categories" onClick={() => setEditingCategories({ kind: 'sections', id: sec.id })}>
                                <IconTag size={14} />
                              </button>
                              <button
                                type="button"
                                className="icon-btn small"
                                aria-label={`Add page to ${sec.title}`}
                                title="Add page"
                                onClick={() => guard(() => onOpenPage(store.createPage({ kind: 'section', sectionId: sec.id }).id))}
                              >
                                <IconPlus size={14} />
                              </button>
                              <button type="button" className="icon-btn small" aria-label={`Rename ${sec.title}`} title="Rename" onClick={() => setRenaming(sec.id)}>
                                <IconPencil size={14} />
                              </button>
                              <button
                                type="button"
                                className="icon-btn small"
                                aria-label={`Delete section ${sec.title}`}
                                title={secPages.length ? 'Move or trash its pages first' : 'Delete section'}
                                disabled={secPages.length > 0}
                                onClick={() => guard(() => void store.deleteSection(sec.id))}
                              >
                                <IconTrash size={14} />
                              </button>
                            </span>
                          )}
                        </div>
                        <ul className="nav-list">
                          {secPages.map((p) => (
                            <PageItem key={p.id} page={p} active={p.id === pageId} onOpen={() => onOpenPage(p.id)} meta={shortDateTime(p.updatedAt)} />
                          ))}
                          {secPages.length === 0 && <li className="nav-empty small">No pages</li>}
                        </ul>
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
      {editingCategories && <CategoryDialog kind={editingCategories.kind} id={editingCategories.id} onClose={() => setEditingCategories(null)} />}
    </nav>
  )
}

function CategoryHint({ ids, names }: { ids: string[]; names: Record<string, { name: string }> }) {
  const list = ids.map((id) => names[id]?.name).filter(Boolean)
  if (list.length === 0) return null
  return <span className="cat-hint" title={`System categories: ${list.join(', ')}`}>{list.join(', ')}</span>
}
