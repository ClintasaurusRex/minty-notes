import { daysUntil, isDateOnly, todayDateOnly } from './dates'
import { TASK_PRIORITIES, TASK_STATUSES, type DateOnly, type Page, type Project, type Task, type TaskPriority, type TaskStatus } from './types'

/**
 * Tasks (pure rules, no storage). A task belongs to one project and sits in
 * one status column (To do / Doing / Done), ordered by `order`. Due dates are
 * date-only values compared in the local calendar (see dates.ts).
 */

export const STATUS_LABELS: Record<TaskStatus, string> = { todo: 'To do', doing: 'Doing', done: 'Done' }
export const PRIORITY_LABELS: Record<TaskPriority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' }

export function priorityRank(p: TaskPriority): number {
  return TASK_PRIORITIES.indexOf(p)
}

export function isTaskStatus(v: unknown): v is TaskStatus {
  return TASK_STATUSES.includes(v as TaskStatus)
}

export function isTaskPriority(v: unknown): v is TaskPriority {
  return TASK_PRIORITIES.includes(v as TaskPriority)
}

/** Tasks of one project in one column, in board order. */
export function columnTasks(tasks: Iterable<Task>, projectId: string, status: TaskStatus): Task[] {
  return [...tasks].filter((t) => t.projectId === projectId && t.status === status).sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/**
 * Place a task in `status` before `beforeId` (or at the end), renumbering that
 * column 1..n. Returns only the tasks whose status/order actually change.
 */
export function placeTask(tasks: Iterable<Task>, taskId: string, status: TaskStatus, beforeId: string | null): { id: string; status: TaskStatus; order: number }[] {
  const all = [...tasks]
  const task = all.find((t) => t.id === taskId)
  if (!task) return []
  const column = columnTasks(all, task.projectId, status).filter((t) => t.id !== taskId)
  const at = beforeId ? column.findIndex((t) => t.id === beforeId) : -1
  column.splice(at < 0 ? column.length : at, 0, task)
  const out: { id: string; status: TaskStatus; order: number }[] = []
  column.forEach((t, i) => {
    const order = i + 1
    if (t.order !== order || t.status !== status) out.push({ id: t.id, status, order })
  })
  return out
}

/** Keyboard moves: one column left/right (to the end), or one place up/down within the column. */
export type TaskMove = 'left' | 'right' | 'up' | 'down'

export function moveTarget(tasks: Iterable<Task>, task: Task, move: TaskMove): { status: TaskStatus; beforeId: string | null } | null {
  const all = [...tasks]
  if (move === 'left' || move === 'right') {
    const i = TASK_STATUSES.indexOf(task.status) + (move === 'left' ? -1 : 1)
    if (i < 0 || i >= TASK_STATUSES.length) return null
    return { status: TASK_STATUSES[i], beforeId: null }
  }
  const column = columnTasks(all, task.projectId, task.status)
  const i = column.findIndex((t) => t.id === task.id)
  if (move === 'up') {
    if (i <= 0) return null
    return { status: task.status, beforeId: column[i - 1].id }
  }
  if (i < 0 || i >= column.length - 1) return null
  return { status: task.status, beforeId: column[i + 2]?.id ?? null }
}

export type DueFilter = 'any' | 'overdue' | 'today' | 'week' | 'later' | 'none'

export const DUE_FILTER_LABELS: Record<DueFilter, string> = {
  any: 'Any due date',
  overdue: 'Overdue',
  today: 'Due today',
  week: 'Due in the next 7 days',
  later: 'Due later',
  none: 'No due date',
}

/** Is an open task's due date in the chosen range? Done tasks are never overdue. */
export function matchesDue(task: Task, filter: DueFilter, today: DateOnly = todayDateOnly()): boolean {
  if (filter === 'any') return true
  const due = task.dueDate && isDateOnly(task.dueDate) ? task.dueDate : null
  if (filter === 'none') return due === null
  if (!due) return false
  const days = daysUntil(due, today)
  if (filter === 'overdue') return task.status !== 'done' && days < 0
  if (filter === 'today') return days === 0
  if (filter === 'week') return days >= 0 && days <= 7
  return days > 7
}

export function isOverdue(task: Task, today: DateOnly = todayDateOnly()): boolean {
  return task.status !== 'done' && !!task.dueDate && isDateOnly(task.dueDate) && daysUntil(task.dueDate, today) < 0
}

/** Project is in the Trash or gone: its tasks are hidden everywhere except a restored project. */
export function taskProjectLive(task: Task, projects: Record<string, Project>): boolean {
  const p = projects[task.projectId]
  return !!p && !p.trashedAt
}

export type StatusFilter = 'open' | TaskStatus | 'all'
export type TaskSort = 'due' | 'priority' | 'project' | 'updated'

export const STATUS_FILTER_LABELS: Record<StatusFilter, string> = { open: 'Open (To do + Doing)', todo: 'To do', doing: 'Doing', done: 'Done', all: 'All' }
export const SORT_LABELS: Record<TaskSort, string> = { due: 'Due date', priority: 'Priority', project: 'Project', updated: 'Recently changed' }

export interface TaskFilters {
  status: StatusFilter
  /** 'all' or the lowest priority to include. */
  minPriority: 'all' | TaskPriority
  due: DueFilter
  /** 'all' or a project ID. */
  project: string
  includeArchived: boolean
  sort: TaskSort
}

export const DEFAULT_TASK_FILTERS: TaskFilters = { status: 'open', minPriority: 'all', due: 'any', project: 'all', includeArchived: false, sort: 'due' }

const dueKey = (t: Task) => (t.dueDate && isDateOnly(t.dueDate) ? t.dueDate : '9999-99-99')

/** The combined task list across projects. Tasks of trashed projects are never shown; archived ones only on request. */
export function filterTasks(tasks: Iterable<Task>, projects: Record<string, Project>, f: TaskFilters, today: DateOnly = todayDateOnly()): Task[] {
  const list = [...tasks].filter((t) => {
    const p = projects[t.projectId]
    if (!p || p.trashedAt) return false
    if (p.archivedAt && !f.includeArchived && f.project !== p.id) return false
    if (f.project !== 'all' && t.projectId !== f.project) return false
    if (f.status === 'open' ? t.status === 'done' : f.status !== 'all' && t.status !== f.status) return false
    if (f.minPriority !== 'all' && priorityRank(t.priority) < priorityRank(f.minPriority)) return false
    return matchesDue(t, f.due, today)
  })
  const name = (t: Task) => projects[t.projectId]?.name ?? ''
  const byDue = (a: Task, b: Task) => dueKey(a).localeCompare(dueKey(b))
  const byPriority = (a: Task, b: Task) => priorityRank(b.priority) - priorityRank(a.priority)
  const tie = (a: Task, b: Task) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
  const cmp: Record<TaskSort, (a: Task, b: Task) => number> = {
    due: (a, b) => byDue(a, b) || byPriority(a, b) || tie(a, b),
    priority: (a, b) => byPriority(a, b) || byDue(a, b) || tie(a, b),
    project: (a, b) => name(a).localeCompare(name(b)) || TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status) || a.order - b.order || tie(a, b),
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt) || tie(a, b),
  }
  return list.sort(cmp[f.sort])
}

/** The next open task of a project: Doing before To do, then earliest due, then highest priority, then board order. */
export function nextTask(tasks: Iterable<Task>, projectId: string): Task | null {
  const open = [...tasks].filter((t) => t.projectId === projectId && t.status !== 'done')
  open.sort((a, b) => (a.status === b.status ? 0 : a.status === 'doing' ? -1 : 1) || dueKey(a).localeCompare(dueKey(b)) || priorityRank(b.priority) - priorityRank(a.priority) || a.order - b.order)
  return open[0] ?? null
}

/** Tasks (in live projects) that link to a page. */
export function tasksLinkingPage(tasks: Iterable<Task>, pageId: string, projects: Record<string, Project>): Task[] {
  return [...tasks].filter((t) => t.linkedPageIds.includes(pageId) && taskProjectLive(t, projects))
}

export type LinkState = 'ok' | 'trashed' | 'missing'

/** A linked note's current state: live, in the Trash (link kept; restoring brings it back), or gone. */
export function linkState(pageId: string, pages: Record<string, Page>, projects: Record<string, Project>): LinkState {
  const page = pages[pageId]
  if (!page) return 'missing'
  if (page.trashedAt) return 'trashed'
  if (page.location.kind === 'project') {
    const owner = projects[page.location.projectId]
    if (!owner || owner.trashedAt) return 'trashed'
  }
  return 'ok'
}
