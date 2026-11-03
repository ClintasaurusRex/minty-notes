import { useEffect, useState } from 'react'
import { useServices, useWorkspace } from '../../app/context'
import { inheritedCategoryIds, isLinkedTo, linkedProjects } from '../../domain/references'
import { STATUS_LABELS, tasksLinkingPage } from '../../domain/tasks'
import { saveAsTemplate } from '../actions'
import type { Page, PageLocation } from '../../domain/types'
import { ReadOnlyError } from '../../store/workspaceStore'
import { shortDateTime } from '../format'
import { IconCopy, IconEyeOff, IconLink, IconPin, IconTrash } from '../icons'
import { LabelPicker } from '../LabelPicker'
import { locationKey, locationLabel, parseLocationKey, useLocationOptions } from '../locations'
import { useNav } from '../nav'
import { notify } from '../notices'
import { ToolButton } from './Toolbar'

interface Props {
  page: Page
  /** The project this page was opened from (its owner, or a project that links it). */
  projectId: string | null
  onLeave: () => void
  zoom: 'fit' | 'actual'
  scale: number
  onZoom: (zoom: 'fit' | 'actual') => void
}

function guard(fn: () => void) {
  try {
    fn()
  } catch (err) {
    if (err instanceof ReadOnlyError) notify('info', err.message)
    else throw err
  }
}

/** Explains whether this page is shared (linked) or an independent copy, with the related actions. */
function ShareBanner({ page, projectId }: { page: Page; projectId: string | null }) {
  const { store } = useServices()
  const nav = useNav()
  const data = useWorkspace((s) => s.data)
  const readOnly = useWorkspace((s) => s.readOnly)
  const context = projectId ? data.projects[projectId] : undefined
  const owned = page.location.kind === 'project'
  if (page.copiedFrom) {
    const original = page.copiedFrom.pageId ? data.pages[page.copiedFrom.pageId] : undefined
    return (
      <div className="share-banner is-copy" role="note" data-testid="copy-banner">
        <span className="badge badge-copy">Project copy</span>
        <span>
          Independent copy of “{page.copiedFrom.title}” made {shortDateTime(page.copiedFrom.at)}. Changes here do not affect the original{original ? '' : ' (which has since been deleted)'}.
        </span>
        {original && !original.trashedAt && (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => nav.openPage(original.id, null)}>
            Open original
          </button>
        )}
      </div>
    )
  }
  if (owned) return null
  const linked = linkedProjects(page, data)
  const viaProject = context && isLinkedTo(context, page, data)
  if (linked.length === 0 && !viaProject) return null
  const pinned = !!context && context.pinnedPageIds.includes(page.id)
  const copy = async () => {
    if (!context) return
    try {
      const created = await store.makeProjectCopy(context.id, page.id)
      notify('success', `Made an independent copy in “${context.name}”. The original stays in the reference library.`)
      nav.openPage(created.id, context.id)
    } catch (err) {
      notify(err instanceof ReadOnlyError ? 'info' : 'error', err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <div className="share-banner" role="note" data-testid="shared-banner">
      <span className="badge badge-library">
        <IconLink size={12} /> Reference library
      </span>
      <span>
        Shared page — linked in {linked.length === 1 ? 'project' : `${linked.length} projects`} {linked.map((p) => `“${p.name}”`).join(', ')}. Edits here change it everywhere it is linked.
      </span>
      {viaProject && !readOnly && (
        <span className="btn-row">
          <button type="button" className="btn btn-small" onClick={() => void copy()}>
            <IconCopy size={14} /> Make a project copy
          </button>
          {pinned ? (
            <button type="button" className="btn btn-small btn-ghost" onClick={() => guard(() => store.unpinReference(context.id, page.id))}>
              <IconPin size={14} /> Unpin
            </button>
          ) : (
            <button type="button" className="btn btn-small btn-ghost" onClick={() => guard(() => store.hideReference(context.id, page.id))}>
              <IconEyeOff size={14} /> Hide from project
            </button>
          )}
        </span>
      )}
    </div>
  )
}

/** Tasks that link to this page (the link is by ID; the page is not copied into them). */
function TaskBacklinks({ page }: { page: Page }) {
  const nav = useNav()
  const tasks = useWorkspace((s) => s.data.tasks)
  const projects = useWorkspace((s) => s.data.projects)
  const linked = tasksLinkingPage(Object.values(tasks), page.id, projects)
  if (linked.length === 0) return null
  return (
    <div className="task-backlinks" data-testid="task-backlinks">
      <span className="muted small">Linked from task{linked.length === 1 ? '' : 's'}:</span>
      {linked.map((t) => (
        <button key={t.id} type="button" className="chip chip-task" onClick={() => nav.openProject(t.projectId, { tab: 'tasks', taskId: t.id })} title={`${STATUS_LABELS[t.status]} · ${projects[t.projectId]?.name ?? ''}`}>
          {t.status === 'done' ? '✓ ' : ''}
          {t.title} <span className="muted">· {projects[t.projectId]?.name}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * Notes whose text links to this page (internal page links). Read once when the
 * page opens: it scans every stored note, so it is not refreshed on every save.
 */
function usePageBacklinks(pageId: string): Page[] {
  const { store } = useServices()
  const [found, setFound] = useState<{ pageId: string; pages: Page[] } | null>(null)
  useEffect(() => {
    let alive = true
    store
      .pagesLinkingTo(pageId)
      .then((pages) => alive && setFound({ pageId, pages }))
      .catch(() => alive && setFound({ pageId, pages: [] }))
    return () => {
      alive = false
    }
  }, [store, pageId])
  return found?.pageId === pageId ? found.pages : []
}

function PageBacklinks({ pages }: { pages: Page[] }) {
  const nav = useNav()
  if (pages.length === 0) return null
  return (
    <div className="task-backlinks" data-testid="page-backlinks">
      <span className="muted small">Linked from note{pages.length === 1 ? '' : 's'}:</span>
      {pages.map((p) => (
        <button key={p.id} type="button" className="chip" onClick={() => nav.openPage(p.id)}>
          <IconLink size={12} /> {p.title || 'Untitled'}
        </button>
      ))}
    </div>
  )
}

export function PageHeader({ page, projectId, onLeave, zoom, scale, onZoom }: Props) {
  const { store } = useServices()
  const nav = useNav()
  const backlinks = usePageBacklinks(page.id)
  const readOnly = useWorkspace((s) => s.readOnly)
  const data = useWorkspace((s) => s.data)
  const options = useLocationOptions(page.location)
  const context = projectId ? data.projects[projectId] : undefined
  const inheritedFrom = (() => {
    if (page.location.kind !== 'section') return 'its section'
    const sec = data.sections[page.location.sectionId]
    return sec ? `${data.notebooks[sec.notebookId]?.title ?? 'notebook'} › ${sec.title}` : 'its section'
  })()

  const move = (location: PageLocation) => {
    guard(() => {
      store.movePage(page.id, location)
      notify('success', `Moved to ${locationLabel(location, data)}`)
    })
  }

  return (
    <header className="page-header">
      <div className="page-header-main">
        {nav.back && nav.back.pageId !== page.id && (
          <button type="button" className="btn btn-small btn-ghost back-link" onClick={nav.goBack} data-testid="link-back">
            ← Back to “{nav.back.title || 'Untitled'}”
          </button>
        )}
        <div className="crumbs" aria-label="Location">
          {context && page.location.kind !== 'project' ? `${context.name} › References · from ${locationLabel(page.location, data)}` : locationLabel(page.location, data)}
          <span className="muted"> · created {shortDateTime(page.createdAt)}</span>
        </div>
        <input
          className="page-title"
          value={page.title}
          readOnly={readOnly}
          aria-label="Page title"
          placeholder="Untitled"
          onChange={(e) => store.renamePage(page.id, e.target.value)}
          onBlur={(e) => {
            if (!e.target.value.trim() && !readOnly) store.renamePage(page.id, 'Untitled page')
          }}
        />
        <div className="page-labels">
          <LabelPicker
            kind="category"
            label="Add category to this page"
            selected={page.categoryIds}
            inherited={inheritedCategoryIds(page, data).map((id) => ({ id, from: inheritedFrom }))}
            onChange={(ids) => guard(() => store.setCategories('pages', page.id, ids))}
          />
          <LabelPicker kind="tag" label="Add tag to this page" selected={page.tagIds} onChange={(ids) => guard(() => store.setPageTags(page.id, ids))} />
        </div>
        <ShareBanner page={page} projectId={projectId} />
        <TaskBacklinks page={page} />
        <PageBacklinks pages={backlinks} />
      </div>
      <div className="page-header-actions">
        <div className="tool-group" role="group" aria-label="Zoom">
          <ToolButton label="Fit page to window width" active={zoom === 'fit'} onClick={() => onZoom('fit')} wide>
            Fit
          </ToolButton>
          <ToolButton label="Actual size (100%)" active={zoom === 'actual'} onClick={() => onZoom('actual')} wide>
            100%
          </ToolButton>
          <span className="zoom-readout" aria-live="polite">
            {Math.round(scale * 100)}%
          </span>
        </div>
        {!readOnly && (
          <>
            <label className="move-select">
              <span className="sr-only">Move page to</span>
              <select
                value={locationKey(page.location)}
                onChange={(e) => {
                  const loc = parseLocationKey(e.target.value)
                  if (loc) move(loc)
                }}
                title="Move this page (its owner). Other projects can still link to it."
              >
                {options.map((group) =>
                  group.options.length === 1 && !group.label ? (
                    <option key={group.options[0].key} value={group.options[0].key}>
                      {group.options[0].label}
                    </option>
                  ) : (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                    </optgroup>
                  ),
                )}
              </select>
            </label>
            <button type="button" className="btn btn-ghost" title="Save this page as a reusable note template" onClick={() => void saveAsTemplate('note', page.title, (name) => store.createTemplateFromPage(page.id, name))}>
              Save as template
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() =>
                guard(() => {
                  store.trashPage(page.id)
                  const links = linkedProjects(page, data).length
                  const notes = backlinks.length
                  notify(
                    'info',
                    `“${page.title}” moved to Trash${links ? `. It is no longer shown in the ${links} project${links === 1 ? '' : 's'} that link it until restored.` : ''}${notes ? ` ${notes} note${notes === 1 ? ' links' : 's link'} to it; ${notes === 1 ? 'that link shows' : 'those links show'} “in Trash” until it is restored.` : ''}`,
                  )
                  onLeave()
                })
              }
            >
              <IconTrash size={16} /> Trash
            </button>
          </>
        )}
      </div>
    </header>
  )
}
