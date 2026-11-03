import { describe, expect, it } from 'vitest'
import { readArchive, sha256Hex } from '../backup/archive'
import { BackupService } from '../backup/backupService'
import { docFromPlainText, docToPlainText } from '../domain/richtext'
import { columnTasks, DEFAULT_TASK_FILTERS, filterTasks, linkState, nextTask, tasksLinkingPage } from '../domain/tasks'
import { newId, nowIso, type ImageObject, type TextObject, type WorkspaceRecords } from '../domain/types'
import { IdbRepository } from '../storage/repository'
import { freshStore, PNG_1x1 } from '../test/fixtures'
import { buildStage1Archive, buildStage2Archive, toStage1Records, toStage2Records } from '../test/legacy'
import { WorkspaceStore } from './workspaceStore'

function textBox(pageId: string, text: string, y = 48): TextObject {
  const at = nowIso()
  return { id: newId(), pageId, type: 'text', x: 48, y, w: 480, h: 60, z: 1, doc: docFromPlainText(text), createdAt: at, updatedAt: at }
}

async function bodyOf(store: WorkspaceStore, pageId: string): Promise<string> {
  const objects = await store.ensurePageObjects(pageId)
  return Object.values(objects)
    .filter((o): o is TextObject => o.type === 'text')
    .map((o) => docToPlainText(o.doc))
    .join('\n')
}

/** Reopen the same database in a fresh store (like a reload). */
async function reload(repo: IdbRepository) {
  const store = new WorkspaceStore(repo, { debounceMs: 5, maxWaitMs: 20 })
  await store.load()
  return store
}

/** A synthetic VTScada job: library reference, project, a note with a screenshot. */
async function vtscadaJob() {
  const { store, repo } = await freshStore()
  const vt = store.createCategory('VTScada')
  const { section } = store.createNotebook('VTScada reference', [vt.id])
  const ref = store.createPage({ kind: 'section', sectionId: section.id }, 'Alarm priorities')
  store.addObjects(ref.id, [textBox(ref.id, 'Priority 1 = critical')])
  const project = store.createProject({ name: 'North pump station', customer: 'City of Example', jobNumber: 'J-1001', categoryIds: [vt.id] })
  const note = store.createPage({ kind: 'project', projectId: project.id }, 'Commissioning checklist')
  const at = nowIso()
  const attachmentId = newId()
  await store.addAttachment(
    { id: attachmentId, fileName: 'tag-browser.png', mimeType: 'image/png', size: PNG_1x1.byteLength, sha256: await sha256Hex(PNG_1x1), width: 1, height: 1, source: 'paste', createdAt: at },
    new Blob([PNG_1x1], { type: 'image/png' }),
  )
  const image: ImageObject = { id: newId(), pageId: note.id, type: 'image', attachmentId, alt: 'Tag browser', x: 48, y: 140, w: 300, h: 200, z: 2, createdAt: at, updatedAt: at }
  store.addObjects(note.id, [textBox(note.id, 'Check every I/O point'), image])
  await store.flush()
  return { store, repo, vt, section, ref, project, note, attachmentId }
}

async function backupRestores(store: WorkspaceStore) {
  const { bytes } = await new BackupService(store, { appVersion: 'test', folderSupported: false }).createArchive()
  const validated = await readArchive(bytes)
  if (!validated.ok) throw new Error(`Backup failed validation: ${validated.errors.join('; ')}`)
  const clean = await freshStore()
  await clean.store.becomeEditor()
  await new BackupService(clean.store, { appVersion: 'test', folderSupported: false }).restore(validated)
  return { restored: clean.store, validated }
}

describe('tasks', () => {
  it('creates, edits, completes, reopens, and deletes tasks; everything persists across a reload', async () => {
    const { store, repo, project } = await vtscadaJob()
    const t = store.createTask(project.id, { title: '  Configure alarm list  ', priority: 'high', dueDate: '2026-11-20' })
    expect(t).toMatchObject({ title: 'Configure alarm list', status: 'todo', priority: 'high', dueDate: '2026-11-20', completedAt: null, order: 1 })
    const second = store.createTask(project.id, { title: 'Test historian' })
    expect(second.order).toBe(2)
    store.updateTask(t.id, { description: 'Use the VTScada priority list', title: 'Configure alarms' })
    store.setTaskDone(t.id, true)
    let saved = store.getState().data.tasks[t.id]
    expect(saved.status).toBe('done')
    expect(saved.completedAt).not.toBeNull()
    await store.flush()

    let again = await reload(repo)
    expect(again.getState().data.tasks[t.id]).toMatchObject({ title: 'Configure alarms', description: 'Use the VTScada priority list', status: 'done', priority: 'high', dueDate: '2026-11-20' })

    store.setTaskDone(t.id, false)
    saved = store.getState().data.tasks[t.id]
    expect(saved).toMatchObject({ status: 'todo', completedAt: null })
    expect(columnTasks(Object.values(store.getState().data.tasks), project.id, 'todo').map((x) => x.id)).toEqual([second.id, t.id])
    store.deleteTask(second.id)
    await store.flush()
    again = await reload(repo)
    expect(Object.keys(again.getState().data.tasks)).toEqual([t.id])
  })

  it('ignores invalid values so a task can never corrupt a backup', async () => {
    const { store, project } = await vtscadaJob()
    const t = store.createTask(project.id, { title: 'Order panel', dueDate: '20261-12-15' })
    expect(t.dueDate).toBeNull()
    store.updateTask(t.id, { dueDate: '2026-12-15' })
    store.updateTask(t.id, { dueDate: '2026-02-30', priority: 'whenever' as never, status: 'blocked' as never })
    expect(store.getState().data.tasks[t.id]).toMatchObject({ dueDate: '2026-12-15', priority: 'normal', status: 'todo' })
    store.updateTask(t.id, { dueDate: null })
    expect(store.getState().data.tasks[t.id].dueDate).toBeNull()
    store.updateTask(t.id, { linkedPageIds: ['no-such-page'] })
    expect(store.getState().data.tasks[t.id].linkedPageIds).toEqual([])
    await store.flush()
    const { validated } = await backupRestores(store)
    expect(validated.records.tasks).toHaveLength(1)
  })

  it('moves tasks with keyboard-style moves: left/right between columns, up/down within one, with edges', async () => {
    const { store, repo, project } = await vtscadaJob()
    const [a, b, c] = ['Wire panel', 'Load program', 'FAT'].map((title) => store.createTask(project.id, { title }))
    const col = (status: 'todo' | 'doing' | 'done') => columnTasks(Object.values(store.getState().data.tasks), project.id, status).map((t) => t.title)
    expect(store.nudgeTask(a.id, 'left')).toBe(false) // already in the first column
    expect(store.nudgeTask(a.id, 'up')).toBe(false) // already at the top
    expect(store.nudgeTask(a.id, 'down')).toBe(true)
    expect(col('todo')).toEqual(['Load program', 'Wire panel', 'FAT'])
    expect(store.nudgeTask(c.id, 'up')).toBe(true)
    expect(col('todo')).toEqual(['Load program', 'FAT', 'Wire panel'])
    expect(store.nudgeTask(b.id, 'right')).toBe(true)
    expect(store.nudgeTask(c.id, 'right')).toBe(true)
    expect(col('doing')).toEqual(['Load program', 'FAT'])
    expect(store.nudgeTask(b.id, 'right')).toBe(true)
    expect(store.getState().data.tasks[b.id].completedAt).not.toBeNull()
    expect(store.nudgeTask(b.id, 'right')).toBe(false) // already Done
    expect(store.nudgeTask(b.id, 'left')).toBe(true)
    expect(store.getState().data.tasks[b.id]).toMatchObject({ status: 'doing', completedAt: null })
    expect(col('doing')).toEqual(['FAT', 'Load program'])
    // Drag-and-drop style placement: put Wire panel before FAT in Doing.
    store.moveTask(a.id, 'doing', c.id)
    expect(col('doing')).toEqual(['Wire panel', 'FAT', 'Load program'])
    expect(col('todo')).toEqual([])
    await store.flush()
    const again = await reload(repo)
    expect(columnTasks(Object.values(again.getState().data.tasks), project.id, 'doing').map((t) => t.title)).toEqual(['Wire panel', 'FAT', 'Load program'])
  })

  it('filters and sorts the combined list by status, priority, and date-only due date', async () => {
    const { store, project } = await vtscadaJob()
    const other = store.createProject({ name: 'South lift station' })
    const today = '2026-11-02'
    const overdue = store.createTask(project.id, { title: 'Overdue', dueDate: '2026-10-30', priority: 'low' })
    const dueToday = store.createTask(other.id, { title: 'Today', dueDate: today, priority: 'urgent' })
    const soon = store.createTask(project.id, { title: 'Soon', dueDate: '2026-11-09', priority: 'high' })
    const later = store.createTask(other.id, { title: 'Later', dueDate: '2026-12-31' })
    const undated = store.createTask(project.id, { title: 'Undated', priority: 'high' })
    const done = store.createTask(project.id, { title: 'Done late', dueDate: '2026-10-01', status: 'done' })
    const { tasks, projects } = store.getState().data
    const run = (f: Partial<typeof DEFAULT_TASK_FILTERS>) => filterTasks(Object.values(tasks), projects, { ...DEFAULT_TASK_FILTERS, ...f }, today).map((t) => t.title)
    expect(run({})).toEqual(['Overdue', 'Today', 'Soon', 'Later', 'Undated'])
    expect(run({ due: 'overdue' })).toEqual(['Overdue']) // a Done task is never overdue
    expect(run({ due: 'today' })).toEqual(['Today'])
    expect(run({ due: 'week' })).toEqual(['Today', 'Soon'])
    expect(run({ due: 'later' })).toEqual(['Later'])
    expect(run({ due: 'none' })).toEqual(['Undated'])
    expect(run({ minPriority: 'high' })).toEqual(['Today', 'Soon', 'Undated'])
    expect(run({ sort: 'priority' })).toEqual(['Today', 'Soon', 'Undated', 'Later', 'Overdue'])
    expect(run({ status: 'done' })).toEqual(['Done late'])
    expect(run({ status: 'all', project: other.id })).toEqual(['Today', 'Later'])
    expect(run({ sort: 'project' })).toEqual(['Overdue', 'Soon', 'Undated', 'Today', 'Later'])
    expect(nextTask(Object.values(tasks), project.id)?.id).toBe(overdue.id)
    store.moveTask(undated.id, 'doing', null)
    expect(nextTask(Object.values(store.getState().data.tasks), project.id)?.id).toBe(undated.id) // Doing first
    void [dueToday, soon, later, done]
  })

  it('due dates stay on their calendar day in every time zone', async () => {
    const { store, project } = await vtscadaJob()
    const t = store.createTask(project.id, { title: 'Site visit', dueDate: '2026-11-02' })
    // Node reads TZ on every Date call; the app's tsconfig has no Node types, hence the cast.
    const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
    const original = env.TZ
    try {
      for (const tz of ['Pacific/Honolulu', 'America/Vancouver', 'UTC', 'Europe/Berlin', 'Pacific/Kiritimati']) {
        env.TZ = tz
        const { dueState, todayDateOnly } = await import('../domain/dates')
        // Noon local time on Nov 2 is "today" everywhere; the stored date never moves.
        const noonLocal = new Date(2026, 10, 2, 12, 0, 0)
        expect(todayDateOnly(noonLocal)).toBe('2026-11-02')
        expect(dueState(store.getState().data.tasks[t.id].dueDate!, todayDateOnly(noonLocal)).tone).toBe('today')
        expect(filterTasks([store.getState().data.tasks[t.id]], store.getState().data.projects, { ...DEFAULT_TASK_FILTERS, due: 'today' }, todayDateOnly(noonLocal))).toHaveLength(1)
      }
      // One instant (20:00 UTC on Nov 2) is Nov 2 in Honolulu but Nov 3 in Kiritimati: the
      // stored date is compared with each local calendar and is never shifted itself.
      const { dueState, todayDateOnly } = await import('../domain/dates')
      const instant = new Date(Date.UTC(2026, 10, 2, 20, 0, 0))
      env.TZ = 'Pacific/Honolulu'
      expect(todayDateOnly(instant)).toBe('2026-11-02')
      expect(dueState('2026-11-02', todayDateOnly(instant)).tone).toBe('today')
      env.TZ = 'Pacific/Kiritimati'
      expect(todayDateOnly(instant)).toBe('2026-11-03')
      expect(dueState('2026-11-02', todayDateOnly(instant)).tone).toBe('overdue')
      expect(store.getState().data.tasks[t.id].dueDate).toBe('2026-11-02')
    } finally {
      env.TZ = original
    }
    await store.flush()
    const { restored } = await backupRestores(store)
    expect(restored.getState().data.tasks[t.id].dueDate).toBe('2026-11-02')
  })
})

describe('task-to-note links', () => {
  it('links tasks to existing notes by ID and survives moves, trash, restore, and permanent deletion', async () => {
    const { store, project, note, ref } = await vtscadaJob()
    const t = store.createTask(project.id, { title: 'Check I/O' })
    store.linkTaskPage(t.id, note.id)
    store.linkTaskPage(t.id, ref.id)
    store.linkTaskPage(t.id, ref.id) // no duplicates
    const data = () => store.getState().data
    expect(data().tasks[t.id].linkedPageIds).toEqual([note.id, ref.id])
    // The note is not copied: same page, same content.
    expect(Object.keys(data().pages)).toHaveLength(2)
    expect(tasksLinkingPage(Object.values(data().tasks), ref.id, data().projects).map((x) => x.id)).toEqual([t.id])

    // Moving the note keeps the link (IDs never change).
    store.movePage(note.id, { kind: 'standalone' })
    expect(linkState(note.id, data().pages, data().projects)).toBe('ok')
    store.movePage(note.id, { kind: 'project', projectId: project.id })

    // Trash keeps the link (shown as "in Trash"); restoring brings it back.
    store.trashPage(note.id)
    expect(linkState(note.id, data().pages, data().projects)).toBe('trashed')
    expect(data().tasks[t.id].linkedPageIds).toContain(note.id)
    store.restorePage(note.id)
    expect(linkState(note.id, data().pages, data().projects)).toBe('ok')

    // Deleting forever removes the link everywhere; the shared reference stays linked.
    store.trashPage(note.id)
    await store.deletePageForever(note.id)
    expect(data().tasks[t.id].linkedPageIds).toEqual([ref.id])
    expect(await bodyOf(store, ref.id)).toBe('Priority 1 = critical')
    await store.flush()
    const { restored } = await backupRestores(store)
    expect(restored.getState().data.tasks[t.id].linkedPageIds).toEqual([ref.id])
  })

  it('a link to a note owned by a trashed project reads as trashed', async () => {
    const { store, project, note } = await vtscadaJob()
    const other = store.createProject({ name: 'Other job' })
    const t = store.createTask(other.id, { title: 'See North notes' })
    store.linkTaskPage(t.id, note.id)
    store.trashProject(project.id)
    const data = store.getState().data
    expect(linkState(note.id, data.pages, data.projects)).toBe('trashed')
    expect(linkState('gone', data.pages, data.projects)).toBe('missing')
  })
})

describe('project archive, Trash, and deletion with tasks', () => {
  it('archived tasks are hidden unless asked for; trashed projects hide theirs; delete forever removes them and keeps notes recoverable', async () => {
    const { store, project, note, ref } = await vtscadaJob()
    const other = store.createProject({ name: 'South lift station' })
    const own = store.createTask(project.id, { title: 'North task' })
    store.linkTaskPage(own.id, note.id)
    const cross = store.createTask(other.id, { title: 'Read North checklist' })
    store.linkTaskPage(cross.id, note.id)
    store.linkTaskPage(cross.id, ref.id)
    const list = (f: Partial<typeof DEFAULT_TASK_FILTERS> = {}) => filterTasks(Object.values(store.getState().data.tasks), store.getState().data.projects, { ...DEFAULT_TASK_FILTERS, ...f }).map((t) => t.title)

    store.setProjectArchived(project.id, true)
    expect(list()).toEqual(['Read North checklist'])
    expect(list({ includeArchived: true })).toEqual(['North task', 'Read North checklist'])
    expect(list({ project: project.id })).toEqual(['North task']) // a chosen archived project shows its own
    store.setProjectArchived(project.id, false)

    store.trashProject(project.id)
    expect(list({ includeArchived: true })).toEqual(['Read North checklist'])
    store.restoreProject(project.id)
    expect(list()).toEqual(['North task', 'Read North checklist'])

    store.trashProject(project.id)
    expect(store.deleteProjectForever(project.id)).toBe(1)
    const data = store.getState().data
    expect(data.tasks[own.id]).toBeUndefined() // the project's own tasks go with it
    expect(data.pages[note.id]).toMatchObject({ location: { kind: 'inbox' } }) // the note is in the Trash, restorable
    expect(data.pages[note.id].trashedAt).not.toBeNull()
    // The other project's task keeps its links (the note can still be restored).
    expect(data.tasks[cross.id].linkedPageIds).toEqual([note.id, ref.id])
    await store.flush()
    const { restored } = await backupRestores(store)
    expect(restored.getState().data.tasks[cross.id].linkedPageIds).toEqual([note.id, ref.id])
    restored.restorePage(note.id)
    expect(linkState(note.id, restored.getState().data.pages, restored.getState().data.projects)).toBe('ok')
  })
})

describe('templates', () => {
  it('a note template makes independent notes with new IDs; the template keeps its definition', async () => {
    const { store, note, attachmentId, vt } = await vtscadaJob()
    store.setCategories('pages', note.id, [vt.id])
    const template = await store.createTemplateFromPage(note.id, 'Commissioning checklist')
    expect(template).toMatchObject({ kind: 'note', name: 'Commissioning checklist', project: null })
    expect(template.notes[0].objects).toHaveLength(2)
    expect(JSON.stringify(template)).not.toContain(note.id)

    const first = store.createPageFromTemplate(template.id, { kind: 'inbox' })
    const second = store.createPageFromTemplate(template.id, { kind: 'standalone' })
    expect(new Set([first.id, second.id, note.id]).size).toBe(3)
    expect(first).toMatchObject({ title: 'Commissioning checklist', categoryIds: [vt.id], copiedFrom: null, location: { kind: 'inbox' } })
    const firstObjects = Object.values(await store.ensurePageObjects(first.id))
    const secondObjects = Object.values(await store.ensurePageObjects(second.id))
    const sourceIds = new Set(Object.keys(await store.ensurePageObjects(note.id)))
    for (const o of [...firstObjects, ...secondObjects]) expect(sourceIds.has(o.id)).toBe(false)
    expect(new Set([...firstObjects, ...secondObjects].map((o) => o.id)).size).toBe(4)
    expect(firstObjects.find((o) => o.type === 'image')).toMatchObject({ attachmentId, alt: 'Tag browser' })

    // Editing a generated note changes nothing else.
    const firstText = firstObjects.find((o): o is TextObject => o.type === 'text')!
    store.setTextDoc(first.id, firstText.id, docFromPlainText('Changed in the first note'))
    expect(await bodyOf(store, second.id)).toBe('Check every I/O point')
    expect(await bodyOf(store, note.id)).toBe('Check every I/O point')
    expect(docToPlainText((store.getState().data.templates[template.id].notes[0].objects.find((o) => o.type === 'text') as unknown as TextObject).doc)).toBe('Check every I/O point')

    // The template outlives its source page; deleting the template keeps generated notes.
    store.trashPage(note.id)
    await store.deletePageForever(note.id)
    const third = store.createPageFromTemplate(template.id, { kind: 'inbox' })
    expect(await bodyOf(store, third.id)).toBe('Check every I/O point')
    store.deleteTemplate(template.id)
    expect(store.getState().data.pages[first.id]).toBeDefined()
    await store.flush()
    const { restored } = await backupRestores(store)
    expect(await bodyOf(restored, first.id)).toBe('Changed in the first note')
  })

  it('a project template makes a new project with its own notes and tasks; links are remapped or stay shared', async () => {
    const { store, project, note, ref, vt } = await vtscadaJob()
    store.pinReference(project.id, ref.id)
    store.updateProject(project.id, {
      description: 'Pump station SCADA upgrade',
      software: [{ id: newId(), name: 'VTScada', detail: '12.1' }],
      fileLocations: [{ id: newId(), label: 'Job folder', kind: 'path', value: 'D:\\Jobs\\J-1001', description: 'Drawings and backups' }],
      contacts: [{ id: newId(), name: 'Dana', role: 'Operator', phone: '', email: '' }],
      dueDate: '2026-12-01',
    })
    const t1 = store.createTask(project.id, { title: 'Walk the I/O list', priority: 'high', dueDate: '2026-11-10' })
    store.linkTaskPage(t1.id, note.id)
    store.linkTaskPage(t1.id, ref.id)
    const t2 = store.createTask(project.id, { title: 'Sign-off', status: 'done' })
    const template = await store.createTemplateFromProject(project.id, 'Pump station job')
    expect(template.kind).toBe('project')
    expect(template.notes).toHaveLength(1)
    expect(template.tasks.map((t) => t.title)).toEqual(['Walk the I/O list', 'Sign-off'])
    expect(template.tasks[0]).toMatchObject({ noteIndexes: [0], pageIds: [ref.id], priority: 'high' })
    expect(template.project).toMatchObject({ categoryIds: [vt.id], pinnedPageIds: [ref.id], description: 'Pump station SCADA upgrade' })

    const made = store.createProjectFromTemplate(template.id, 'East pump station')
    const again = store.createProjectFromTemplate(template.id, 'West pump station')
    const data = store.getState().data
    expect(made.id).not.toBe(project.id)
    expect(made).toMatchObject({ name: 'East pump station', customer: '', jobNumber: '', dueDate: null, contacts: [], categoryIds: [vt.id], pinnedPageIds: [ref.id] })
    expect(made.fileLocations[0]).toMatchObject({ label: 'Job folder', description: 'Drawings and backups' })
    expect(made.fileLocations[0].id).not.toBe(data.projects[project.id].fileLocations[0].id)
    const madeNotes = Object.values(data.pages).filter((p) => p.location.kind === 'project' && p.location.projectId === made.id)
    expect(madeNotes.map((p) => p.title)).toEqual(['Commissioning checklist'])
    expect(madeNotes[0].id).not.toBe(note.id)
    const madeTasks = columnTasks(Object.values(data.tasks), made.id, 'todo')
    expect(madeTasks.map((t) => t.title)).toEqual(['Walk the I/O list', 'Sign-off']) // a fresh To do list
    // The task links the new project's own note, and the shared library page (not a copy).
    expect(madeTasks[0].linkedPageIds).toEqual([madeNotes[0].id, ref.id])
    expect(madeTasks.every((t) => t.dueDate === null && t.completedAt === null)).toBe(true)
    const allIds = [project.id, made.id, again.id, ...Object.keys(data.tasks), ...Object.keys(data.pages)]
    expect(new Set(allIds).size).toBe(allIds.length)
    // Editing the new project's note leaves the source project's note alone.
    const madeText = Object.values(await store.ensurePageObjects(madeNotes[0].id)).find((o): o is TextObject => o.type === 'text')!
    store.setTextDoc(madeNotes[0].id, madeText.id, docFromPlainText('East only'))
    expect(await bodyOf(store, note.id)).toBe('Check every I/O point')
    void t2

    // Deleting the shared page forever removes it from the template too (no dangling link).
    store.trashPage(ref.id)
    await store.deletePageForever(ref.id)
    const tpl = store.getState().data.templates[template.id]
    expect(tpl.project!.pinnedPageIds).toEqual([])
    expect(tpl.tasks[0].pageIds).toEqual([])
    // Deleting the category strips it from the template.
    store.deleteCategory(vt.id)
    expect(store.getState().data.templates[template.id].project!.categoryIds).toEqual([])
    expect(store.getState().data.templates[template.id].notes[0].categoryIds).toEqual([])
    await store.flush()
    const { restored } = await backupRestores(store)
    expect(restored.getState().data.templates[template.id].tasks).toHaveLength(2)
  })
})

describe('backup and restore of Stage 3 records', () => {
  it('tasks, templates, links, and file descriptions survive a full backup and clean restore', async () => {
    const { store, repo, project, note, ref } = await vtscadaJob()
    store.updateProject(project.id, { fileLocations: [{ id: newId(), label: 'Dropbox', kind: 'url', value: 'https://www.dropbox.com/home/J-1001', description: 'Shared job folder' }] })
    const t = store.createTask(project.id, { title: 'Commission', description: 'Two days on site', priority: 'urgent', dueDate: '2026-11-30' })
    store.linkTaskPage(t.id, note.id)
    store.linkTaskPage(t.id, ref.id)
    store.createTask(project.id, { title: 'Invoice', status: 'done' })
    await store.createTemplateFromPage(note.id, 'Checklist')
    await store.createTemplateFromProject(project.id, 'Job')
    store.setProjectArchived(project.id, true)
    await store.flush()
    const before = (await repo.readAll()).records
    const { restored, validated } = await backupRestores(store)
    expect(validated.summary.counts).toMatchObject({ tasks: 2, templates: 2, projects: 1 })
    expect(validated.summary.doneTasks).toBe(1)
    const after = (await restored.repository.readAll()).records
    const sortById = <T extends { id: string }>(l: T[]) => [...l].sort((a, b) => a.id.localeCompare(b.id))
    for (const key of ['projects', 'tasks', 'templates', 'pages', 'objects', 'attachments', 'categories'] as const) {
      expect(sortById(after[key] as { id: string }[])).toEqual(sortById(before[key] as { id: string }[]))
    }
  })

  it('a Stage 2 (format 2) backup restores with empty tasks/templates and file descriptions added', async () => {
    const { store, repo, project, note } = await vtscadaJob()
    store.updateProject(project.id, { fileLocations: [{ id: newId(), label: 'Folder', kind: 'path', value: 'C:\\Jobs', description: '' }] })
    await store.flush()
    const { records, blobs } = await repo.readAll()
    const bytes = await buildStage2Archive(toStage2Records(records), blobs)
    const validated = await readArchive(bytes)
    if (!validated.ok) throw new Error(validated.errors.join('\n'))
    expect(validated.summary.formatVersion).toBe(2)
    expect(validated.records.workspace.formatVersion).toBe(4)
    expect(validated.records.tasks).toEqual([])
    expect(validated.records.templates).toEqual([])
    expect(validated.records.projects[0].fileLocations[0]).toMatchObject({ label: 'Folder', value: 'C:\\Jobs', description: '' })
    const clean = await freshStore()
    await clean.store.becomeEditor()
    await new BackupService(clean.store, { appVersion: 'test', folderSupported: false }).restore(validated)
    expect(await bodyOf(clean.store, note.id)).toContain('Check every I/O point')
    // Stage 3 features work on the restored Stage 2 data.
    const t = clean.store.createTask(project.id, { title: 'New after restore' })
    clean.store.linkTaskPage(t.id, note.id)
    await clean.store.flush()
    await backupRestores(clean.store)
  })

  it('a Stage 1 (format 1) backup still restores (format 1 → 2 → 3 → 4)', async () => {
    const { store, repo, ref } = await vtscadaJob()
    await store.flush()
    const { records, blobs } = await repo.readAll()
    const stage1 = toStage1Records({ ...records, pages: records.pages.filter((p) => p.location.kind !== 'project') } as WorkspaceRecords)
    const stage1Objects = (stage1.objects as { pageId: string }[]).filter((o) => o.pageId === ref.id)
    const used = new Set<string>()
    const validated = await readArchive(await buildStage1Archive({ ...stage1, objects: stage1Objects, attachments: [] }, new Map([...blobs].filter(([id]) => used.has(id)))))
    if (!validated.ok) throw new Error(validated.errors.join('\n'))
    expect(validated.records.workspace.formatVersion).toBe(4)
    expect(validated.records.tasks).toEqual([])
    expect(validated.records.pages.map((p) => p.id)).toEqual([ref.id])
  })

  it('repairs an invalid task due date on restore and rejects broken task and template relationships', async () => {
    const { store, repo, project, note } = await vtscadaJob()
    const t = store.createTask(project.id, { title: 'Order parts', dueDate: '2026-11-10' })
    store.linkTaskPage(t.id, note.id)
    await store.createTemplateFromPage(note.id, 'Checklist')
    await store.flush()
    const { records, blobs } = await repo.readAll()
    const { buildArchive } = await import('../backup/archive')
    const archive = (r: WorkspaceRecords) => buildArchive(r, blobs, 'test').then(readArchive)

    const badDate = await archive({ ...records, tasks: records.tasks.map((x) => ({ ...x, dueDate: '20261-11-10' })) })
    expect(badDate.ok).toBe(true)
    if (badDate.ok) {
      expect(badDate.records.tasks[0].dueDate).toBeNull()
      expect(badDate.warnings.join(' ')).toContain('Task “Order parts” had an invalid due date')
    }
    const orphanTask = await archive({ ...records, tasks: records.tasks.map((x) => ({ ...x, projectId: 'missing' })) })
    expect(orphanTask.ok).toBe(false)
    if (!orphanTask.ok) expect(orphanTask.errors.join(' ')).toContain('refers to a missing project')
    const danglingLink = await archive({ ...records, tasks: records.tasks.map((x) => ({ ...x, linkedPageIds: ['missing'] })) })
    expect(danglingLink.ok).toBe(false)
    const badStatus = await archive({ ...records, tasks: records.tasks.map((x) => ({ ...x, status: 'blocked' as never })) })
    expect(badStatus.ok).toBe(false)
    const tpl = records.templates[0]
    const missingImage = await archive({
      ...records,
      templates: [{ ...tpl, notes: [{ ...tpl.notes[0], objects: tpl.notes[0].objects.map((o) => (o.type === 'image' ? { ...o, attachmentId: 'missing' } : o)) }] }],
    })
    expect(missingImage.ok).toBe(false)
    if (!missingImage.ok) expect(missingImage.errors.join(' ')).toContain('missing attachment')
    const badText = await archive({ ...records, templates: [{ ...tpl, notes: [{ ...tpl.notes[0], objects: [{ type: 'text', x: 0, y: 0, w: 10, h: 10, z: 1, doc: { type: 'doc', content: [{ type: 'script' }] } }] }] }] })
    expect(badText.ok).toBe(false)
  })
})
