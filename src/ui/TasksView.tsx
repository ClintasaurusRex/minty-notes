import { useState } from 'react'
import { useServices, useWorkspace } from '../app/context'
import { todayDateOnly } from '../domain/dates'
import { isProjectOpen } from '../domain/references'
import {
  DEFAULT_TASK_FILTERS,
  DUE_FILTER_LABELS,
  filterTasks,
  isOverdue,
  matchesDue,
  PRIORITY_LABELS,
  SORT_LABELS,
  STATUS_FILTER_LABELS,
  STATUS_LABELS,
  taskProjectLive,
  type DueFilter,
  type StatusFilter,
  type TaskFilters,
  type TaskSort,
} from '../domain/tasks'
import { TASK_PRIORITIES, type TaskPriority } from '../domain/types'
import { guard } from './actions'
import { IconCheck } from './icons'
import { useNav } from './nav'
import { DueBadge, PriorityBadge } from './TaskBoard'

const PREF = 'minty:task-filters'

function readFilters(): TaskFilters {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF) ?? 'null') as Partial<TaskFilters> | null
    return { ...DEFAULT_TASK_FILTERS, ...(saved ?? {}) }
  } catch {
    return DEFAULT_TASK_FILTERS
  }
}

/** All tasks across projects with filters and sorting. Opening a task goes to its project's board. */
export function TasksView() {
  const { store } = useServices()
  const nav = useNav()
  const data = useWorkspace((s) => s.data)
  const readOnly = useWorkspace((s) => s.readOnly)
  const [filters, setFilters] = useState(readFilters)
  const set = (patch: Partial<TaskFilters>) => {
    const next = { ...filters, ...patch }
    setFilters(next)
    try {
      localStorage.setItem(PREF, JSON.stringify(next))
    } catch {
      // Filters are a per-device convenience.
    }
  }
  const today = todayDateOnly()
  // A project chosen in the filter must still exist and not be in the Trash.
  const chosen = filters.project !== 'all' ? data.projects[filters.project] : undefined
  const effective = chosen && !chosen.trashedAt ? filters : { ...filters, project: 'all' }
  const tasks = filterTasks(Object.values(data.tasks), data.projects, effective, today)
  const live = Object.values(data.tasks).filter((t) => taskProjectLive(t, data.projects) && (isProjectOpen(data.projects[t.projectId]) || filters.includeArchived))
  const overdue = live.filter((t) => isOverdue(t, today)).length
  const week = live.filter((t) => t.status !== 'done' && matchesDue(t, 'week', today)).length
  const projects = Object.values(data.projects)
    .filter((p) => !p.trashedAt)
    .sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || a.name.localeCompare(b.name))

  return (
    <div className="tasks-view" data-testid="tasks-view">
      <header className="home-head">
        <h1>Tasks</h1>
        <p className="muted">
          <button type="button" className="link-btn" onClick={() => set({ status: 'open', due: 'overdue' })} data-testid="overdue-count">
            <span className={overdue ? 'due-overdue' : ''}>{overdue} overdue</span>
          </button>{' '}
          ·{' '}
          <button type="button" className="link-btn" onClick={() => set({ status: 'open', due: 'week' })}>
            {week} due in the next 7 days
          </button>
        </p>
      </header>
      <div className="filters" role="group" aria-label="Task filters">
        <label className="field inline">
          <span className="field-label">Status</span>
          <select aria-label="Status filter" value={filters.status} onChange={(e) => set({ status: e.target.value as StatusFilter })}>
            {Object.entries(STATUS_FILTER_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span className="field-label">Priority</span>
          <select aria-label="Priority filter" value={filters.minPriority} onChange={(e) => set({ minPriority: e.target.value as TaskPriority | 'all' })}>
            <option value="all">Any priority</option>
            {[...TASK_PRIORITIES].reverse().map((p) => (
              <option key={p} value={p}>
                {p === 'urgent' ? 'Urgent only' : `${PRIORITY_LABELS[p]} or higher`}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span className="field-label">Due</span>
          <select aria-label="Due date filter" value={filters.due} onChange={(e) => set({ due: e.target.value as DueFilter })}>
            {Object.entries(DUE_FILTER_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span className="field-label">Project</span>
          <select aria-label="Project filter" value={effective.project} onChange={(e) => set({ project: e.target.value })}>
            <option value="all">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || 'Untitled project'}
                {p.archivedAt ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span className="field-label">Sort by</span>
          <select aria-label="Sort tasks" value={filters.sort} onChange={(e) => set({ sort: e.target.value as TaskSort })}>
            {Object.entries(SORT_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={filters.includeArchived} onChange={(e) => set({ includeArchived: e.target.checked })} /> Include archived projects
        </label>
        <button type="button" className="btn btn-small btn-ghost" onClick={() => set(DEFAULT_TASK_FILTERS)}>
          Reset
        </button>
      </div>
      <p className="muted small" aria-live="polite">
        {tasks.length} task{tasks.length === 1 ? '' : 's'}. Tasks of projects in the Trash are not shown.
      </p>
      {tasks.length === 0 ? (
        <p className="muted">No tasks match these filters.</p>
      ) : (
        <ul className="task-table" aria-label="Tasks">
          {tasks.map((t) => {
            const project = data.projects[t.projectId]
            return (
              <li key={t.id} className={`task-row prio-edge-${t.priority}${t.status === 'done' ? ' is-done' : ''}`} data-testid="task-row">
                {!readOnly && !project.trashedAt ? (
                  <button
                    type="button"
                    className={`task-check${t.status === 'done' ? ' is-on' : ''}`}
                    aria-label={t.status === 'done' ? `Reopen “${t.title}”` : `Complete “${t.title}”`}
                    aria-pressed={t.status === 'done'}
                    onClick={() => guard(() => store.setTaskDone(t.id, t.status !== 'done'))}
                  >
                    {t.status === 'done' && <IconCheck size={12} />}
                  </button>
                ) : (
                  <span />
                )}
                <button type="button" className="ref-open" onClick={() => nav.openProject(t.projectId, { tab: 'tasks', taskId: t.id })}>
                  <span className="ref-title">{t.title || 'Untitled task'}</span>
                  <span className="ref-meta">
                    {project.name || 'Untitled project'}
                    {project.archivedAt ? ' (archived)' : ''}
                    {t.linkedPageIds.length > 0 && ` · ${t.linkedPageIds.length} linked note${t.linkedPageIds.length === 1 ? '' : 's'}`}
                  </span>
                </button>
                <span className="task-row-meta">
                  <span className={`badge status-task-${t.status}`}>{STATUS_LABELS[t.status]}</span>
                  <PriorityBadge priority={t.priority} />
                  <DueBadge task={t} />
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
