import { describe, expect, it } from 'vitest'
import { readArchive } from '../backup/archive'
import { BackupService } from '../backup/backupService'
import { docToPlainText } from '../domain/richtext'
import { emptyChangeSet, OwnershipError } from '../storage/repository'
import { freshStore } from '../test/fixtures'
import type { TextObject } from '../domain/types'
import { WorkspaceStore } from './workspaceStore'

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
