import { useState } from 'react'
import { useServices, useWorkspace } from '../app/context'
import { dueState, todayDateOnly } from '../domain/dates'
import { filterTasks, nextTask, DEFAULT_TASK_FILTERS } from '../domain/tasks'
import { isPageVisible, isProjectOpen, projectNotes, projectReferences } from '../domain/references'
import { pageContext } from '../domain/search'
import type { Page, Project, Template } from '../domain/types'
import { ReadOnlyError } from '../store/workspaceStore'
import { relativeTime } from './format'
import { IconInbox, IconLeaf, IconPin, IconPlus, IconQuick } from './icons'
import { useNav } from './nav'
import { notify } from './notices'
import { STATUS_LABELS } from './projectFormat'
import { readRecent } from './recent'
import { DueBadge, PriorityBadge } from './TaskBoard'
import { TemplatePicker } from './Templates'

const STATUS_RANK = { active: 0, 'on-hold': 1, planned: 2, complete: 3 }

function ProjectCard({ project }: { project: Project }) {
  const nav = useNav()
  const data = useWorkspace((s) => s.data)
  const notes = projectNotes(project.id, data.pages)
  const refs = projectReferences(project, data)
  const due = project.dueDate ? dueState(project.dueDate) : null
  const next = nextTask(Object.values(data.tasks), project.id)
  return (
    <li>
      <button type="button" className="project-tile" onClick={() => nav.openProject(project.id)} data-testid="project-tile">
        <span className="tile-top">
          <span className="tile-name">{project.name || 'Untitled project'}</span>
          <span className={`badge status-${project.status}`}>{STATUS_LABELS[project.status]}</span>
        </span>
        <span className="tile-sub">{[project.customer, project.site, project.jobNumber].filter(Boolean).join(' · ') || 'No customer or site yet'}</span>
        <span className="tile-chips">
          {project.categoryIds.map((id) => (data.categories[id] ? <span key={id} className="chip chip-category">{data.categories[id].name}</span> : null))}
        </span>
        <span className="tile-foot">
          {notes.length} note{notes.length === 1 ? '' : 's'} · {refs.pinned.length + refs.suggested.length} reference{refs.pinned.length + refs.suggested.length === 1 ? '' : 's'}
          {due && <span className={`due due-${due.tone}`}> · {due.text}</span>}
        </span>
        <span className="tile-next" data-testid="tile-next-task">
          {next ? (
            <>
              Next: {next.title} {next.dueDate && <DueBadge task={next} />}
            </>
          ) : (
            <span className="muted">No open tasks</span>
          )}
        </span>
      </button>
    </li>
  )
}

function PageLink({ page, projectId, meta }: { page: Page; projectId: string | null; meta: string }) {
  const nav = useNav()
  return (
    <li>
      <button type="button" className="ref-open" onClick={() => nav.openPage(page.id, projectId)}>
        <span className="ref-title">{page.title || 'Untitled'}</span>
        <span className="ref-meta">{meta}</span>
      </button>
    </li>
  )
}

export function HomeView() {
  const { store } = useServices()
  const nav = useNav()
  const data = useWorkspace((s) => s.data)
  const readOnly = useWorkspace((s) => s.readOnly)
  const [recent] = useState(readRecent)

  const open = Object.values(data.projects)
    .filter(isProjectOpen)
    .filter((p) => p.status !== 'complete')
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.name.localeCompare(b.name))

  // Pinned references across open projects (each page once, with the projects that pin it).
  const pinned = new Map<string, Project[]>()
  for (const p of open) for (const page of projectReferences(p, data).pinned) pinned.set(page.id, [...(pinned.get(page.id) ?? []), p])

  // Recently edited notes in open projects.
  const openIds = new Set(open.map((p) => p.id))
  const projectEdits = Object.values(data.pages)
    .filter((p) => !p.trashedAt && p.location.kind === 'project' && openIds.has(p.location.projectId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6)

  const recentPages = recent
    .map((e) => ({ entry: e, page: data.pages[e.pageId] }))
    .filter((r): r is { entry: typeof r.entry; page: Page } => !!r.page && isPageVisible(r.page, data))
    .slice(0, 8)

  const inboxCount = Object.values(data.pages).filter((p) => !p.trashedAt && p.location.kind === 'inbox').length
  const empty = Object.keys(data.projects).length === 0 && Object.keys(data.pages).length === 0

  // Overdue and upcoming (next 7 days) open tasks in open projects.
  const today = todayDateOnly()
  const openProjects = Object.fromEntries(Object.entries(data.projects).filter(([, p]) => isProjectOpen(p)))
  const overdueTasks = filterTasks(Object.values(data.tasks), openProjects, { ...DEFAULT_TASK_FILTERS, due: 'overdue' }, today)
  const upcomingTasks = filterTasks(Object.values(data.tasks), openProjects, { ...DEFAULT_TASK_FILTERS, due: 'week' }, today)
  const dueTasks = [...overdueTasks, ...upcomingTasks].slice(0, 8)

  const fromTemplate = (t: Template) => {
    try {
      if (t.kind === 'project') {
        const name = window.prompt('Name for the new project:', t.name)
        if (name === null) return
        nav.openProject(store.createProjectFromTemplate(t.id, name).id)
      } else {
        const page = store.createPageFromTemplate(t.id, { kind: 'inbox' })
        nav.openPage(page.id)
      }
    } catch (err) {
      if (err instanceof ReadOnlyError) notify('info', err.message)
      else throw err
    }
  }

  const newProject = () => {
    try {
      const p = store.createProject({ name: 'New project' })
      nav.openProject(p.id)
    } catch (err) {
      if (err instanceof ReadOnlyError) notify('info', err.message)
      else throw err
    }
  }

  return (
    <div className="home" data-testid="home">
      <header className="home-head">
        <h1>Home</h1>
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={nav.quickNote}>
            <IconQuick size={16} /> Quick note
          </button>
          {!readOnly && (
            <button type="button" className="btn" onClick={newProject}>
              <IconPlus size={16} /> New project
            </button>
          )}
          <TemplatePicker kinds={['note', 'project']} label="New from template…" onPick={fromTemplate} />
          {recentPages[0] && (
            <button type="button" className="btn btn-ghost" onClick={() => nav.openPage(recentPages[0].page.id, recentPages[0].entry.projectId)}>
              Continue “{recentPages[0].page.title || 'Untitled'}”
            </button>
          )}
        </div>
      </header>

      {empty && (
        <section className="card">
          <h2>
            <IconLeaf size={18} /> Welcome to Minty Notes
          </h2>
          <p className="muted">Capture a quick note (Alt+N), create a project for a job, or build a reference library in Notebooks. Give notebooks and projects the same system category (for example VTScada) and the project suggests those pages automatically.</p>
        </section>
      )}

      {inboxCount > 0 && (
        <p className="home-inbox">
          <IconInbox size={16} />{' '}
          <button type="button" className="link-btn" onClick={() => nav.go('inbox')}>
            {inboxCount} unsorted quick note{inboxCount === 1 ? '' : 's'}
          </button>
        </p>
      )}

      <section aria-labelledby="active-h" className="home-section">
        <h2 id="active-h">Active projects</h2>
        {open.length === 0 ? (
          <p className="muted">No active projects. {readOnly ? '' : 'Use “New project” to start one.'}</p>
        ) : (
          <ul className="tile-grid">
            {open.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="due-h" className="home-section" data-testid="home-due-tasks">
        <h2 id="due-h">
          Overdue and upcoming tasks
          <button type="button" className="link-btn small-link" onClick={() => nav.go('tasks')}>
            All tasks
          </button>
        </h2>
        {dueTasks.length === 0 ? (
          <p className="muted small">Nothing overdue or due in the next 7 days.</p>
        ) : (
          <ul className="ref-list">
            {dueTasks.map((t) => (
              <li key={t.id}>
                <button type="button" className="ref-open" onClick={() => nav.openProject(t.projectId, { tab: 'tasks', taskId: t.id })}>
                  <span className="ref-title">{t.title}</span>
                  <span className="ref-meta task-meta">
                    {data.projects[t.projectId]?.name} <PriorityBadge priority={t.priority} /> <DueBadge task={t} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="home-columns">
        <section aria-labelledby="pinned-h" className="home-section">
          <h2 id="pinned-h">
            <IconPin size={16} /> Pinned references
          </h2>
          {pinned.size === 0 ? (
            <p className="muted small">Pin library pages to a project to see them here.</p>
          ) : (
            <ul className="ref-list">
              {[...pinned].map(([pageId, projects]) => (
                <PageLink key={pageId} page={data.pages[pageId]} projectId={projects[0].id} meta={`Reference library · pinned in ${projects.map((p) => p.name).join(', ')}`} />
              ))}
            </ul>
          )}
          <h2 className="subhead-h2">Recently edited project notes</h2>
          {projectEdits.length === 0 ? (
            <p className="muted small">No project notes yet.</p>
          ) : (
            <ul className="ref-list">
              {projectEdits.map((p) => (
                <PageLink key={p.id} page={p} projectId={null} meta={`${pageContext(p, data)} · edited ${relativeTime(p.updatedAt)}`} />
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="recent-h" className="home-section">
          <h2 id="recent-h">Recently opened</h2>
          {recentPages.length === 0 ? (
            <p className="muted small">Pages you open appear here.</p>
          ) : (
            <ul className="ref-list" data-testid="recent-list">
              {recentPages.map(({ entry, page }) => (
                <PageLink key={page.id} page={page} projectId={entry.projectId} meta={`${pageContext(page, data)} · opened ${relativeTime(entry.at)}`} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
