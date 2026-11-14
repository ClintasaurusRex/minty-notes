import { describe, expect, it } from 'vitest'
import { readArchive } from '../backup/archive'
import { BackupService } from '../backup/backupService'
import { docFromPlainText, docToPlainText } from '../domain/richtext'
import { emptyChangeSet, OwnershipError } from '../storage/repository'
import { freshStore } from '../test/fixtures'
import { newId, nowIso, type TextObject } from '../domain/types'
import { ReadOnlyError, WorkspaceStore } from './workspaceStore'

/**
 * Window A loses editing (frozen, lock stolen) while holding unsaved Stage 2
 * changes; window B keeps working; A takes editing back. Fully awaited.
 */
async function setup() {
  const { store: a, repo } = await freshStore()
  await a.becomeEditor()
  const vt = a.createCategory('VTScada')
  const { section } = a.createNotebook('Library', [vt.id])
  const ref = a.createPage({ kind: 'section', sectionId: section.id }, 'Shared reference')
  const extra = a.createPage({ kind: 'standalone' }, 'Extra reference')
  const project = a.createProject({ name: 'Plant', customer: 'Original customer', site: 'Site 1', categoryIds: [vt.id] })
  await a.flush()
  const b = new WorkspaceStore(repo, { debounceMs: 5, maxWaitMs: 20, retryDelaysMs: [10] })
  await b.becomeEditor() // A is frozen: no handover
  return { a, b, repo, vt, ref, extra, project, section }
}

/** A's next save is refused by storage fencing, so its changes are held. */
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

describe('held Stage 2 edits', () => {
  it('storage refuses a stale project write from a window that lost editing', async () => {
    const { a, repo, project } = await setup()
    a.updateProject(project.id, { customer: 'Stale' })
    await holdChanges(a)
    const stored = await repo.loadIndex()
    expect(stored.projects[0].customer).toBe('Original customer')
    await expect(repo.commit(emptyChangeSet(), new Date().toISOString(), 'not-the-owner')).rejects.toBeInstanceOf(OwnershipError)
  })

  it('merges project fields: A’s detail edit and B’s rename both survive; pins and hides merge as sets', async () => {
    const { a, b, project, ref, extra } = await setup()
    a.updateProject(project.id, { customer: 'Customer from A', dueDate: '2026-12-01' })
    a.pinReference(project.id, extra.id)
    await holdChanges(a)
    b.updateProject(project.id, { name: 'Plant (renamed in B)' })
    b.hideReference(project.id, ref.id)
    await b.flush()

    const result = await reclaim(a, b)
    expect(result.recovered).toEqual([])
    const p = a.getState().data.projects[project.id]
    expect(p).toMatchObject({ name: 'Plant (renamed in B)', customer: 'Customer from A', dueDate: '2026-12-01', pinnedPageIds: [extra.id], hiddenPageIds: [ref.id] })
    const restored = await backupRestores(a)
    expect(restored.getState().data.projects[project.id]).toMatchObject({ pinnedPageIds: [extra.id], hiddenPageIds: [ref.id] })
  })

  it('a conflicting project field keeps B’s value and records A’s in “Recovered changes”', async () => {
    const { a, b, project } = await setup()
    a.updateProject(project.id, { customer: 'Customer from A' })
    await holdChanges(a)
    b.updateProject(project.id, { customer: 'Customer from B' })
    await b.flush()
    const result = await reclaim(a, b)
    expect(a.getState().data.projects[project.id].customer).toBe('Customer from B')
    expect(result.recovered).toHaveLength(1)
    expect(await recoveryText(a, result.recoveryPageId)).toMatch(/Customer: this window had Customer from A; kept Customer from B/)
  })

  it('a note created in A for a project B deleted forever goes to the Inbox; edits to the deleted project are recovered', async () => {
    const { a, b, project } = await setup()
    const note = a.createPage({ kind: 'project', projectId: project.id }, 'Site walk')
    a.updateProject(project.id, { site: 'Edited in A' })
    await holdChanges(a)
    b.trashProject(project.id)
    b.deleteProjectForever(project.id)
    await b.flush()

    const result = await reclaim(a, b)
    const data = a.getState().data
    expect(data.projects[project.id]).toBeUndefined() // never resurrected
    expect(data.pages[note.id]).toMatchObject({ title: 'Site walk', location: { kind: 'inbox' }, trashedAt: null })
    const text = await recoveryText(a, result.recoveryPageId)
    expect(text).toMatch(/Project “Plant”/)
    expect(text).toMatch(/deleted in the other window/)
    await backupRestores(a)
  })

  it('a pin to a page B deleted forever, and a category B deleted, leave no dangling links', async () => {
    const { a, b, project, extra, vt, ref } = await setup()
    a.pinReference(project.id, extra.id)
    a.setCategories('pages', ref.id, [vt.id])
    await holdChanges(a)
    b.trashPage(extra.id)
    await b.deletePageForever(extra.id)
    b.deleteCategory(vt.id)
    await b.flush()

    const result = await reclaim(a, b)
    const data = a.getState().data
    expect(data.pages[extra.id]).toBeUndefined()
    expect(data.projects[project.id].pinnedPageIds).toEqual([])
    expect(data.projects[project.id].categoryIds).toEqual([])
    expect(data.pages[ref.id].categoryIds).toEqual([])
    expect(data.categories[vt.id]).toBeUndefined()
    expect(result.recovered.some((r) => r.type === 'note' && /link/.test(r.reason))).toBe(true)
    await backupRestores(a)
  })

  it('a held project deletion is not applied if B added a note to that project', async () => {
    const { a, b, project } = await setup()
    a.trashProject(project.id)
    a.deleteProjectForever(project.id)
    await holdChanges(a)
    b.createPage({ kind: 'project', projectId: project.id }, 'Added in B')
    await b.flush()
    const result = await reclaim(a, b)
    expect(a.getState().data.projects[project.id]).toBeDefined()
    expect(result.recovered.some((r) => /still in use/.test(r.reason))).toBe(true)
    await backupRestores(a)
  })

  it('a held project copy is saved with its own objects when editing is taken back', async () => {
    const { a, b, project, ref } = await setup()
    const copy = await a.makeProjectCopy(project.id, ref.id)
    await holdChanges(a)
    b.renamePage(ref.id, 'Renamed original in B')
    await b.flush()
    await reclaim(a, b)
    const data = a.getState().data
    expect(data.pages[copy.id]).toMatchObject({ location: { kind: 'project', projectId: project.id }, title: 'Shared reference', copiedFrom: { pageId: ref.id } })
    expect(data.pages[ref.id].title).toBe('Renamed original in B')
    expect(data.projects[project.id].hiddenPageIds).toEqual([ref.id])
    await backupRestores(a)
  })
})

/** A new window takes editing from `a` without a handover (as if `a` were frozen). */
async function steal(a: WorkspaceStore) {
  const c = new WorkspaceStore(a.repository, { debounceMs: 5, maxWaitMs: 20, retryDelaysMs: [10] })
  await c.becomeEditor()
  return c
}

describe('a refused held deletion is not partly applied', () => {
  it('project deletion refused because the other window changed the project: its notes stay in the project', async () => {
    const { a, b, project } = await setup()
    // Give the project a note first (B is the editor), then hand editing back to A.
    const note = b.createPage({ kind: 'project', projectId: project.id }, 'Commissioning')
    await b.flush()
    await reclaim(a, b)
    a.trashProject(project.id)
    a.deleteProjectForever(project.id) // moves the note to the Trash, then removes the project
    const c = await steal(a)
    await holdChanges(a)
    c.updateProject(project.id, { customer: 'Changed in C' })
    await c.flush()

    const result = await reclaim(a, c)
    const data = a.getState().data
    expect(data.projects[project.id]).toMatchObject({ customer: 'Changed in C' })
    expect(data.pages[note.id]).toMatchObject({ location: { kind: 'project', projectId: project.id }, trashedAt: null })
    expect(result.recovered.some((r) => /Project “Plant”/.test(r.source) && /kept/.test(r.reason))).toBe(true)
    await backupRestores(a)
  })

  it('category and tag deletions refused because they were renamed elsewhere: they stay on every record', async () => {
    const { a, b, vt, project, ref } = await setup()
    const tag = b.createTag('alarms')
    b.setPageTags(ref.id, [tag.id])
    b.setCategories('pages', ref.id, [vt.id])
    await b.flush()
    await reclaim(a, b)
    a.deleteCategory(vt.id)
    a.deleteTag(tag.id)
    const c = await steal(a)
    await holdChanges(a)
    c.renameCategory(vt.id, 'VTScada 12')
    c.renameTag(tag.id, 'alarm-list')
    await c.flush()

    await reclaim(a, c)
    const data = a.getState().data
    expect(data.categories[vt.id].name).toBe('VTScada 12')
    expect(data.tags[tag.id].name).toBe('alarm-list')
    expect(data.projects[project.id].categoryIds).toEqual([vt.id])
    expect(data.pages[ref.id]).toMatchObject({ categoryIds: [vt.id], tagIds: [tag.id] })
    expect(Object.values(data.notebooks)[0].categoryIds).toEqual([vt.id])
    await backupRestores(a)
  })

  it('page deletion refused because it was renamed elsewhere: content, pins, hides, and copies’ source link stay', async () => {
    const { a, b, project, ref } = await setup()
    const other = b.createProject({ name: 'Other plant' })
    b.pinReference(other.id, ref.id)
    b.hideReference(project.id, ref.id)
    await b.flush()
    await reclaim(a, b)
    const at = nowIso()
    const body: TextObject = { id: newId(), pageId: ref.id, type: 'text', x: 40, y: 40, w: 300, h: 40, z: 1, doc: docFromPlainText('Reference body'), createdAt: at, updatedAt: at }
    a.addObjects(ref.id, [body])
    const copy = await a.makeProjectCopy(other.id, ref.id)
    a.pinReference(other.id, ref.id) // keep the original linked as well
    await a.flush()
    a.trashPage(ref.id)
    await a.deletePageForever(ref.id)
    const c = await steal(a)
    await holdChanges(a)
    await c.ensurePageObjects(ref.id)
    c.renamePage(ref.id, 'Renamed in C')
    await c.flush()

    await reclaim(a, c)
    const data = a.getState().data
    expect(data.pages[ref.id].title).toBe('Renamed in C')
    expect(Object.values(await a.ensurePageObjects(ref.id)).map((o) => docToPlainText((o as TextObject).doc))).toEqual(['Reference body'])
    expect(data.projects[other.id].pinnedPageIds).toEqual([ref.id])
    expect(data.projects[project.id].hiddenPageIds).toEqual([ref.id])
    expect(data.pages[copy.id].copiedFrom?.pageId).toBe(ref.id)
    await backupRestores(a)
  })
})

describe('ownership of Stage 2 data', () => {
  it('a read-only window cannot change projects, categories, tags, pins, or hides', async () => {
    const { a, b, project, ref, vt } = await setup()
    a.revokeOwnership() // B took the lock: A is read-only
    expect(a.getState()).toMatchObject({ readOnly: true, owner: false })
    const attempts: (() => unknown)[] = [
      () => a.createProject({ name: 'X' }),
      () => a.updateProject(project.id, { customer: 'X' }),
      () => a.setProjectArchived(project.id, true),
      () => a.trashProject(project.id),
      () => a.deleteProjectForever(project.id),
      () => a.pinReference(project.id, ref.id),
      () => a.hideReference(project.id, ref.id),
      () => a.createCategory('X'),
      () => a.deleteCategory(vt.id),
      () => a.createTag('x'),
      () => a.setCategories('projects', project.id, []),
      () => a.setPageTags(ref.id, []),
    ]
    for (const attempt of attempts) expect(attempt).toThrow(ReadOnlyError)
    await expect(a.makeProjectCopy(project.id, ref.id)).rejects.toBeInstanceOf(ReadOnlyError)
    expect(a.hasUnsavedChanges).toBe(false)
    const stored = await b.repository.loadIndex()
    expect(stored.projects).toEqual([b.getState().data.projects[project.id]])
    expect(stored.categories).toHaveLength(1)
  })
})
