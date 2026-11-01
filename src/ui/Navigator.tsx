import { useState, type ReactNode } from 'react'
import { useServices, useWorkspace } from '../app/context'
import type { Page } from '../domain/types'
import { ReadOnlyError } from '../store/workspaceStore'
import { shortDateTime } from './format'
import { IconChevron, IconPencil, IconPlus, IconRestore, IconTrash } from './icons'
import { notify } from './notices'

export type NavSection = 'inbox' | 'notes' | 'notebooks' | 'trash' | 'settings'

interface Props {
  section: NavSection
  pageId: string | null
  onOpenPage: (id: string) => void
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

export function Navigator({ section, pageId, onOpenPage, onQuickNote }: Props) {
  const { store } = useServices()
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
    return (
      <nav className="navigator" aria-label="Trash">
        <div className="nav-head">
          <h2>Trash</h2>
        </div>
        <p className="nav-hint">Trashed pages are kept until you delete them forever. Backups include them.</p>
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
                        if (window.confirm(`Delete “${p.title}” forever? Its text and layout will be removed from this workspace.`)) {
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
            <button type="button" className="btn btn-small" onClick={() => guard(() => STARTER_NOTEBOOKS.forEach((t) => store.createNotebook(t)))}>
              Add starter notebooks
            </button>
          )}
          <p className="muted small">Creates empty notebooks for {STARTER_NOTEBOOKS.join(', ')}. Rename or delete them freely.</p>
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
                  </button>
                )}
                {!readOnly && renaming !== nb.id && (
                  <span className="row-actions">
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
                            <span className="tree-label section-label">{sec.title}</span>
                          )}
                          {!readOnly && renaming !== sec.id && (
                            <span className="row-actions">
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
    </nav>
  )
}
