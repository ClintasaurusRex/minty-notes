import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { useServices, useWorkspace } from '../app/context'
import { dueState, isDateOnly } from '../domain/dates'
import { isPageVisible } from '../domain/references'
import { normalize, pageContext } from '../domain/search'
import { columnTasks, linkState, PRIORITY_LABELS, STATUS_LABELS, type TaskMove } from '../domain/tasks'
import { TASK_PRIORITIES, TASK_STATUSES, type Page, type Task, type TaskPriority, type TaskStatus } from '../domain/types'
import { guard } from './actions'
import { IconCheck, IconLink, IconPlus, IconTrash } from './icons'
import { useNav } from './nav'
import { notify } from './notices'

/** Priority label with a distinct glyph and color (never color alone). */
export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  const glyph = { low: '↓', normal: '•', high: '↑', urgent: '‼' }[priority]
  return (
    <span className={`badge prio prio-${priority}`} title={`Priority: ${PRIORITY_LABELS[priority]}`}>
      <span aria-hidden="true">{glyph}</span> {PRIORITY_LABELS[priority]}
    </span>
  )
}

/** Due date with an overdue/today/soon tone. Done tasks show the date only. */
export function DueBadge({ task }: { task: Task }) {
  if (!task.dueDate || !isDateOnly(task.dueDate)) return null
  const due = dueState(task.dueDate)
  const tone = task.status === 'done' ? 'later' : due.tone
  const text = task.status === 'done' ? due.text.replace(/^Overdue · /, 'Due ') : due.text
  return (
    <span className={`due-badge due-${tone}`} data-testid="task-due" data-tone={tone}>
      {tone === 'overdue' && <span aria-hidden="true">⚠ </span>}
      {text}
    </span>
  )
}

const MOVE_LABEL: Record<TaskMove, string> = { left: 'Move left', right: 'Move right', up: 'Move up', down: 'Move down' }

interface CardProps {
  task: Task
  index: number
  count: number
  readOnly: boolean
  onOpen: () => void
  /** `button` is the move button used (focus stays on it), or null for a keyboard shortcut. */
  onMove: (m: TaskMove, button: TaskMove | null) => void
  onToggleDone: () => void
  onDragStart: (e: DragEvent) => void
}

function TaskCard({ task, index, count, readOnly, onOpen, onMove, onToggleDone, onDragStart }: CardProps) {
  const col = TASK_STATUSES.indexOf(task.status)
  const onKey = (e: KeyboardEvent) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return
    const move = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const)[e.key as 'ArrowLeft']
    if (!move) return
    e.preventDefault()
    onMove(move, null)
  }
  const links = task.linkedPageIds.length
  return (
    <li className={`task-card prio-edge-${task.priority}${task.status === 'done' ? ' is-done' : ''}`} data-task-id={task.id} draggable={!readOnly} onDragStart={onDragStart} onKeyDown={onKey} data-testid="task-card">
      <div className="task-card-top">
        {!readOnly && (
          <button
            type="button"
            className={`task-check${task.status === 'done' ? ' is-on' : ''}`}
            aria-label={task.status === 'done' ? `Reopen “${task.title}”` : `Complete “${task.title}”`}
            aria-pressed={task.status === 'done'}
            title={task.status === 'done' ? 'Reopen (back to To do)' : 'Complete (move to Done)'}
            onClick={onToggleDone}
            data-action="complete"
          >
            {task.status === 'done' && <IconCheck size={12} />}
          </button>
        )}
        <button type="button" className="task-title-btn" onClick={onOpen} aria-describedby={`task-meta-${task.id}`} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown">
          {task.title || 'Untitled task'}
        </button>
      </div>
      <div className="task-meta" id={`task-meta-${task.id}`}>
        <PriorityBadge priority={task.priority} />
        <DueBadge task={task} />
        {links > 0 && (
          <span className="muted small">
            <IconLink size={11} /> {links} note{links === 1 ? '' : 's'}
          </span>
        )}
        <span className="sr-only">
          {STATUS_LABELS[task.status]}, position {index + 1} of {count}. Alt and arrow keys move it.
        </span>
      </div>
      {!readOnly && (
        <div className="task-moves" role="group" aria-label={`Move “${task.title}”`}>
          {(['left', 'up', 'down', 'right'] as TaskMove[]).map((m) => {
            const disabled = (m === 'left' && col === 0) || (m === 'right' && col === TASK_STATUSES.length - 1) || (m === 'up' && index === 0) || (m === 'down' && index === count - 1)
            const target = m === 'left' ? TASK_STATUSES[col - 1] : m === 'right' ? TASK_STATUSES[col + 1] : null
            return (
              <button key={m} type="button" className="icon-btn small" disabled={disabled} aria-label={target ? `Move to ${STATUS_LABELS[target]}` : MOVE_LABEL[m]} title={`${target ? `Move to ${STATUS_LABELS[target]}` : MOVE_LABEL[m]} (Alt+${{ left: '←', right: '→', up: '↑', down: '↓' }[m]})`} onClick={() => onMove(m, m)} data-move={m}>
                {{ left: '◀', right: '▶', up: '▲', down: '▼' }[m]}
              </button>
            )
          })}
        </div>
      )}
    </li>
  )
}

/** To do / Doing / Done board for one project. Keyboard: Alt+arrows on a card, or the move buttons. */
export function TaskBoard({ projectId, openTaskId, onOpenTask }: { projectId: string; openTaskId: string | null; onOpenTask: (id: string | null) => void }) {
  const { store } = useServices()
  const tasks = useWorkspace((s) => s.data.tasks)
  const project = useWorkspace((s) => s.data.projects[projectId])
  const readOnly = useWorkspace((s) => s.readOnly)
  const [draft, setDraft] = useState('')
  const [announce, setAnnounce] = useState('')
  /** After a move the card re-renders in its new place; focus follows it. */
  const focusAfter = useRef<{ id: string; action: string | null } | null>(null)
  const dragId = useRef<string | null>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const all = Object.values(tasks)
  const editable = !readOnly && !!project && !project.trashedAt

  useEffect(() => {
    const pending = focusAfter.current
    if (!pending) return
    focusAfter.current = null
    const card = boardRef.current?.querySelector<HTMLElement>(`[data-task-id="${pending.id}"]`)
    const target = (pending.action && card?.querySelector<HTMLButtonElement>(`[data-move="${pending.action}"]:not(:disabled), [data-action="${pending.action}"]`)) || card?.querySelector<HTMLElement>('.task-title-btn')
    target?.focus()
  })

  const announceMove = (id: string, action: string | null) => {
    const moved = store.getState().data.tasks[id]
    const column = columnTasks(Object.values(store.getState().data.tasks), projectId, moved.status)
    setAnnounce(`Moved “${moved.title}” to ${STATUS_LABELS[moved.status]}, position ${column.findIndex((t) => t.id === id) + 1} of ${column.length}.`)
    focusAfter.current = { id, action }
  }
  const move = (task: Task, m: TaskMove, button: TaskMove | null) => {
    guard(() => {
      if (store.nudgeTask(task.id, m)) announceMove(task.id, button)
    })
  }
  const toggleDone = (task: Task) => {
    guard(() => {
      store.setTaskDone(task.id, task.status !== 'done')
      announceMove(task.id, 'complete')
    })
  }

  const add = () => {
    const title = draft.trim()
    if (!title) return
    guard(() => {
      const t = store.createTask(projectId, { title })
      setDraft('')
      setAnnounce(`Added “${t.title}” to To do.`)
    })
  }

  const drop = (e: DragEvent, status: TaskStatus) => {
    e.preventDefault()
    const id = dragId.current ?? e.dataTransfer.getData('text/x-minty-task')
    dragId.current = null
    if (!id || !tasks[id]) return
    const over = (e.target as HTMLElement).closest<HTMLElement>('[data-task-id]')?.dataset.taskId ?? null
    if (over === id) return
    guard(() => {
      store.moveTask(id, status, over && tasks[over]?.status === status ? over : null)
      setAnnounce(`Moved “${tasks[id].title}” to ${STATUS_LABELS[status]}.`)
    })
  }

  const open = openTaskId ? tasks[openTaskId] : undefined
  return (
    <div className="task-board-wrap">
      <p className="muted small board-help">
        Click a task to edit it. Move tasks by dragging, with the arrow buttons, or with <kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> (column) and <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> (order) on a focused task.
      </p>
      <div className="task-board" ref={boardRef} data-testid="task-board">
        {TASK_STATUSES.map((status) => {
          const column = columnTasks(all, projectId, status)
          return (
            <section
              key={status}
              className={`task-col task-col-${status}`}
              aria-labelledby={`col-${status}`}
              data-testid={`column-${status}`}
              onDragOver={(e) => {
                if (editable && dragId.current) e.preventDefault()
              }}
              onDrop={(e) => drop(e, status)}
            >
              <h3 id={`col-${status}`} className="task-col-head">
                {STATUS_LABELS[status]} <span className="count">{column.length}</span>
              </h3>
              {status === 'todo' && editable && (
                <form
                  className="task-add"
                  onSubmit={(e) => {
                    e.preventDefault()
                    add()
                  }}
                >
                  <input aria-label="New task title" placeholder="Add a task…" value={draft} onChange={(e) => setDraft(e.target.value)} />
                  <button type="submit" className="icon-btn small" aria-label="Add task" disabled={!draft.trim()}>
                    <IconPlus size={14} />
                  </button>
                </form>
              )}
              <ul className="task-list" aria-label={`${STATUS_LABELS[status]} tasks`}>
                {column.length === 0 && <li className="muted small task-empty">{status === 'done' ? 'Completed tasks appear here.' : 'No tasks.'}</li>}
                {column.map((t, i) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    index={i}
                    count={column.length}
                    readOnly={!editable}
                    onOpen={() => onOpenTask(t.id)}
                    onMove={(m, button) => move(t, m, button)}
                    onToggleDone={() => toggleDone(t)}
                    onDragStart={(e) => {
                      dragId.current = t.id
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/x-minty-task', t.id)
                    }}
                  />
                ))}
              </ul>
            </section>
          )
        })}
      </div>
      <div className="sr-only" role="status" aria-live="polite" data-testid="board-announce">
        {announce}
      </div>
      {open && <TaskEditor task={open} onClose={() => onOpenTask(null)} />}
    </div>
  )
}

function NoteFinder({ task, onPick }: { task: Task; onPick: (page: Page) => void }) {
  const data = useWorkspace((s) => s.data)
  const [query, setQuery] = useState('')
  const q = normalize(query.trim())
  const matches = q
    ? Object.values(data.pages)
        .filter((p) => isPageVisible(p, data) && !task.linkedPageIds.includes(p.id) && normalize(p.title).includes(q))
        .sort((a, b) => Number(b.location.kind === 'project' && b.location.projectId === task.projectId) - Number(a.location.kind === 'project' && a.location.projectId === task.projectId) || a.title.localeCompare(b.title))
        .slice(0, 8)
    : []
  return (
    <div className="pin-finder">
      <input aria-label="Find a note to link" placeholder="Find a note to link…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {q && (
        <ul className="pin-results">
          {matches.length === 0 && <li className="muted small">No matching notes.</li>}
          {matches.map((p) => (
            <li key={p.id}>
              <span>
                {p.title || 'Untitled'} <span className="muted small">· {pageContext(p, data)}</span>
              </span>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  onPick(p)
                  setQuery('')
                }}
              >
                <IconLink size={14} /> Link
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Edit one task. Every change saves as you type (autosave), so there is no Save button. */
export function TaskEditor({ task, onClose }: { task: Task; onClose: () => void }) {
  const { store } = useServices()
  const nav = useNav()
  const data = useWorkspace((s) => s.data)
  const readOnly = useWorkspace((s) => s.readOnly)
  const project = data.projects[task.projectId]
  const editable = !readOnly && !!project && !project.trashedAt
  const titleRef = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = dialog.current
    const returnTo = document.activeElement as HTMLElement | null
    if (d && !d.open) d.showModal()
    titleRef.current?.focus()
    return () => {
      if (d?.open) d.close()
      if (returnTo?.isConnected) returnTo.focus()
    }
  }, [task.id])

  const set = (patch: Parameters<typeof store.updateTask>[1]) => guard(() => store.updateTask(task.id, patch))
  const openNote = (page: Page) => {
    onClose()
    nav.openPage(page.id)
  }
  const newNote = () =>
    guard(() => {
      const page = store.createPage({ kind: 'project', projectId: task.projectId }, task.title || 'Task note')
      store.linkTaskPage(task.id, page.id)
      notify('success', `Created and linked the note “${page.title}”.`)
      openNote(page)
    })

  return (
    <dialog
      ref={dialog}
      className="dialog task-editor"
      aria-labelledby="task-editor-h"
      data-testid="task-editor"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="task-editor-body">
        <div className="card-head">
          <h2 id="task-editor-h">Task · {project?.name ?? 'Project'}</h2>
          <button type="button" className="btn btn-small" onClick={onClose}>
            Close
          </button>
        </div>
        <label className="field">
          <span className="field-label">Title</span>
          <input ref={titleRef} aria-label="Task title" value={task.title} readOnly={!editable} onChange={(e) => set({ title: e.target.value })} onBlur={(e) => !e.target.value.trim() && editable && set({ title: 'Untitled task' })} />
        </label>
        <div className="field-grid">
          <label className="field">
            <span className="field-label">Status</span>
            <select aria-label="Task status" value={task.status} disabled={!editable} onChange={(e) => set({ status: e.target.value as TaskStatus })}>
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Priority</span>
            <select aria-label="Task priority" value={task.priority} disabled={!editable} onChange={(e) => set({ priority: e.target.value as TaskPriority })}>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Due date (optional)</span>
            <input type="date" max="9999-12-31" value={task.dueDate ?? ''} readOnly={!editable} onChange={(e) => set({ dueDate: e.target.value || null })} aria-label="Task due date" />
          </label>
        </div>
        <div className="task-editor-due">
          <DueBadge task={task} />
        </div>
        <label className="field">
          <span className="field-label">Details</span>
          <textarea aria-label="Task details" rows={4} value={task.description} readOnly={!editable} onChange={(e) => set({ description: e.target.value })} placeholder="Steps, parts, who to call…" />
        </label>
        <div className="field">
          <span className="field-label">Linked notes</span>
          {task.linkedPageIds.length === 0 ? (
            <p className="muted small">No linked notes. Link an existing note (it is not copied) or create a project note for this task.</p>
          ) : (
            <ul className="ref-list" data-testid="task-links">
              {task.linkedPageIds.map((id) => {
                const page = data.pages[id]
                const state = linkState(id, data.pages, data.projects)
                return (
                  <li key={id} className="ref-row">
                    {state === 'ok' ? (
                      <button type="button" className="ref-open" onClick={() => openNote(page)}>
                        <span className="ref-title">{page.title || 'Untitled'}</span>
                        <span className="ref-meta">{pageContext(page, data)}</span>
                      </button>
                    ) : (
                      <span className="ref-open is-unavailable">
                        <span className="ref-title">{page?.title || 'Deleted note'}</span>
                        <span className="ref-meta">{state === 'trashed' ? 'In the Trash — restore it to open it from here.' : 'This note no longer exists.'}</span>
                      </span>
                    )}
                    {editable && (
                      <span className="row-actions always">
                        <button type="button" className="icon-btn small" aria-label={`Unlink ${page?.title ?? 'note'}`} title="Unlink (the note is not changed)" onClick={() => guard(() => store.unlinkTaskPage(task.id, id))}>
                          ×
                        </button>
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {editable && (
            <div className="btn-row">
              <NoteFinder task={task} onPick={(p) => guard(() => store.linkTaskPage(task.id, p.id))} />
              <button type="button" className="btn btn-small" onClick={newNote}>
                <IconPlus size={14} /> New linked note
              </button>
            </div>
          )}
        </div>
        {editable && (
          <div className="btn-row dialog-foot">
            <button type="button" className="btn btn-small" onClick={() => guard(() => store.setTaskDone(task.id, task.status !== 'done'))}>
              <IconCheck size={14} /> {task.status === 'done' ? 'Reopen' : 'Complete'}
            </button>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-small btn-danger"
              onClick={() => {
                if (!window.confirm(`Delete the task “${task.title}”? Linked notes are not affected. This cannot be undone.`)) return
                guard(() => {
                  store.deleteTask(task.id)
                  notify('info', `Deleted the task “${task.title}”.`)
                  onClose()
                })
              }}
            >
              <IconTrash size={14} /> Delete task
            </button>
          </div>
        )}
      </div>
    </dialog>
  )
}
