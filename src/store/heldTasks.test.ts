import { describe, expect, it } from 'vitest'
import { readArchive } from '../backup/archive'
import { BackupService } from '../backup/backupService'
import { docFromPlainText, docToPlainText } from '../domain/richtext'
import { newId, nowIso, type TextObject } from '../domain/types'
import { emptyChangeSet, OwnershipError } from '../storage/repository'
import { freshStore } from '../test/fixtures'
import { ReadOnlyError, WorkspaceStore } from './workspaceStore'

/**
 * Window A loses editing (frozen; B steals the lock) while holding unsaved
 * Stage 3 changes; B keeps working; A takes editing back. Fully awaited.
 */
async function setup(before?: (a: WorkspaceStore, ctx: { project: { id: string }; task: { id: string }; note: { id: string }; ref: { id: string } }) => Promise<void> | void) {
  const { store: a, repo } = await freshStore()
  await a.becomeEditor()
  const vt = a.createCategory('VTScada')
  const { section } = a.createNotebook('Library', [vt.id])
  const ref = a.createPage({ kind: 'section', sectionId: section.id }, 'Shared reference')
  const project = a.createProject({ name: 'Plant', categoryIds: [vt.id] })
  const note = a.createPage({ kind: 'project', projectId: project.id }, 'Site notes')
  a.addObjects(note.id, [{ id: newId(), pageId: note.id, type: 'text', x: 40, y: 40, w: 400, h: 60, z: 1, doc: docFromPlainText('Panel layout'), createdAt: nowIso(), updatedAt: nowIso() }])
  const task = a.createTask(project.id, { title: 'Wire panel', priority: 'normal' })
  await before?.(a, { project, task, note, ref })
  await a.flush()
  const b = new WorkspaceStore(repo, { debounceMs: 5, maxWaitMs: 20, retryDelaysMs: [10] })
  await b.becomeEditor() // A is frozen: no handover
  await b.ensurePageObjects(note.id)
  return { a, b, repo, vt, ref, project, note, task }
}

async function holdChanges(a: WorkspaceStore) {
  expect(await a.flush()).toBe(false)
  expect(a.getState()).toMatchObject({ owner: false, readOnly: true })
  expect(a.getState().heldChanges).toBeGreaterThan(0)
}

async function reclaim(a: WorkspaceStore, b: WorkspaceStore) {
  expect(await b.releaseOwnership()).toEqual({ ok: true })
  const result = await a.becomeEditor()
  expect(a.getState()).toMatchObject({ owner: true, readOnly: false, heldChanges: 0 })
  return result!
}

async function recoveryText(store: WorkspaceStore, pageId: string | null) {
  if (!pageId) return ''
  const objects = await store.ensurePageObjects(pageId)
  return Object.values(objects)
    .map((o) => (o.type === 'text' ? docToPlainText((o as TextObject).doc) : ''))
    .join('\n')
}

async function backupRestores(store: WorkspaceStore) {
  const { bytes } = await new BackupService(store, { appVersion: 'test', folderSupported: false }).createArchive()
  const validated = await readArchive(bytes)
  if (!validated.ok) throw new Error(`Backup failed validation: ${validated.errors.join('; ')}`)
  const clean = await freshStore()
  await clean.store.becomeEditor()
  await new BackupService(clean.store, { appVersion: 'test', folderSupported: false }).restore(validated)
  return clean.store
}

describe('held Stage 3 edits', () => {
  it('storage refuses a stale task write; a read-only window refuses every task and template change', async () => {
    const { a, b, repo, project, task, note } = await setup()
    a.updateTask(task.id, { title: 'Stale title' })
    await holdChanges(a)
    expect((await repo.loadIndex()).tasks[0].title).toBe('Wire panel')
    await expect(repo.commit(emptyChangeSet(), nowIso(), 'not-the-owner')).rejects.toBeInstanceOf(OwnershipError)

    b.setReadOnly(true)
    const attempts: (() => unknown)[] = [
      () => b.createTask(project.id, { title: 'x' }),
      () => b.updateTask(task.id, { title: 'x' }),
      () => b.moveTask(task.id, 'doing', null),
      () => b.nudgeTask(task.id, 'right'),
      () => b.setTaskDone(task.id, true),
      () => b.deleteTask(task.id),
      () => b.linkTaskPage(task.id, note.id),
      () => b.createPageFromTemplate('x', { kind: 'inbox' }),
      () => b.createProjectFromTemplate('x', 'x'),
      () => b.deleteTemplate('x'),
    ]
    for (const attempt of attempts) expect(attempt).toThrow(ReadOnlyError)
    await expect(b.createTemplateFromPage(note.id, 'x')).rejects.toBeInstanceOf(ReadOnlyError)
    expect(b.hasUnsavedChanges).toBe(false)
  })

  it('merges task fields: A’s move, priority, and links and B’s rename and links all survive', async () => {
    const { a, b, task, note, ref } = await setup()
    a.updateTask(task.id, { priority: 'urgent', dueDate: '2026-11-20' })
    a.moveTask(task.id, 'doing', null)
    a.linkTaskPage(task.id, note.id)
    await holdChanges(a)
    b.updateTask(task.id, { title: 'Wire panel (renamed in B)' })
    b.linkTaskPage(task.id, ref.id)
    await b.flush()

    const result = await reclaim(a, b)
    expect(result.recovered).toEqual([])
    const t = a.getState().data.tasks[task.id]
    expect(t).toMatchObject({ title: 'Wire panel (renamed in B)', priority: 'urgent', dueDate: '2026-11-20', status: 'doing' })
    expect(t.completedAt).toBeNull()
    expect(new Set(t.linkedPageIds)).toEqual(new Set([note.id, ref.id]))
    const restored = await backupRestores(a)
    expect(restored.getState().data.tasks[task.id].status).toBe('doing')
  })

  it('a task created for a project deleted elsewhere is recovered as a note, not attached to nothing', async () => {
    const { a, b, project } = await setup()
    a.createTask(project.id, { title: 'Order spare relays', description: 'Two of each', priority: 'high' })
    await holdChanges(a)
    b.trashProject(project.id)
    b.deleteProjectForever(project.id)
    await b.flush()

    const result = await reclaim(a, b)
    expect(Object.values(a.getState().data.tasks)).toEqual([])
    const text = await recoveryText(a, result.recoveryPageId)
    expect(text).toContain('Task “Order spare relays”')
    expect(text).toContain('Two of each')
    await backupRestores(a)
  })

  it('a refused held project deletion keeps the project’s tasks, notes, and links when B added a task', async () => {
    const { a, b, project, task, note } = await setup((a, x) => a.linkTaskPage(x.task.id, x.note.id))
    // A deletes the project forever while frozen (tasks and notes go with it)…
    a.trashProject(project.id)
    a.deleteProjectForever(project.id)
    await holdChanges(a)
    // …while B adds a task to it.
    const added = b.createTask(project.id, { title: 'Added in B' })
    await b.flush()

    const result = await reclaim(a, b)
    const data = a.getState().data
    expect(data.projects[project.id]).toBeDefined()
    expect(data.tasks[task.id]).toMatchObject({ linkedPageIds: [note.id] })
    expect(data.tasks[added.id]).toBeDefined()
    expect(data.pages[note.id]).toMatchObject({ location: { kind: 'project', projectId: project.id }, trashedAt: null })
    expect(result.recovered.some((r) => r.reason.includes('still in use'))).toBe(true)
    await backupRestores(a)
  })

  it('a refused held page deletion keeps task and template links to it', async () => {
    let templateId = ''
    const { a, b, task, ref } = await setup(async (a, x) => {
      a.linkTaskPage(x.task.id, x.ref.id)
      a.pinReference(x.project.id, x.ref.id)
      templateId = (await a.createTemplateFromProject(x.project.id, 'Plant template')).id
    })
    const template = a.getState().data.templates[templateId]
    expect(template.project!.pinnedPageIds).toEqual([ref.id])
    expect(template.tasks[0].pageIds).toEqual([ref.id])
    a.trashPage(ref.id)
    await a.deletePageForever(ref.id)
    await holdChanges(a)
    b.renamePage(ref.id, 'Shared reference (renamed in B)')
    await b.flush()

    await reclaim(a, b)
    const data = a.getState().data
    expect(data.pages[ref.id].title).toBe('Shared reference (renamed in B)')
    expect(data.tasks[task.id].linkedPageIds).toEqual([ref.id])
    expect(data.templates[template.id].project!.pinnedPageIds).toEqual([ref.id])
    expect(data.templates[template.id].tasks[0].pageIds).toEqual([ref.id])
    await backupRestores(a)
  })

  it('links to a page or category deleted in B are removed from held tasks and templates and reported', async () => {
    const { a, b, task, ref, vt, project } = await setup()
    a.linkTaskPage(task.id, ref.id)
    await a.createTemplateFromProject(project.id, 'Plant template')
    await holdChanges(a)
    b.trashPage(ref.id)
    await b.deletePageForever(ref.id)
    b.deleteCategory(vt.id)
    await b.flush()

    const result = await reclaim(a, b)
    const data = a.getState().data
    expect(data.tasks[task.id].linkedPageIds).toEqual([])
    const template = Object.values(data.templates)[0]
    expect(template.project!.categoryIds).toEqual([])
    expect(result.recovered.some((r) => r.source === 'Links')).toBe(true)
    await backupRestores(a)
  })

  it('a held task edit conflicting with B keeps B’s value and recovers A’s', async () => {
    const { a, b, task } = await setup()
    a.updateTask(task.id, { description: 'From A' })
    await holdChanges(a)
    b.updateTask(task.id, { description: 'From B' })
    await b.flush()
    const result = await reclaim(a, b)
    expect(a.getState().data.tasks[task.id].description).toBe('From B')
    expect(await recoveryText(a, result.recoveryPageId)).toContain('From A')
  })

  it('a held task deletion is skipped if B changed the task', async () => {
    const { a, b, task } = await setup()
    a.deleteTask(task.id)
    await holdChanges(a)
    b.updateTask(task.id, { title: 'Still needed (B)' })
    await b.flush()
    await reclaim(a, b)
    expect(a.getState().data.tasks[task.id].title).toBe('Still needed (B)')
  })
})
