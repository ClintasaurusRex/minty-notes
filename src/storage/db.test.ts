import { openDB } from 'idb'
import { describe, expect, it } from 'vitest'
import { readArchive } from '../backup/archive'
import { BackupService } from '../backup/backupService'
import { docFromPlainText, docToPlainText } from '../domain/richtext'
import { FORMAT_VERSION, newId, nowIso, type TextObject } from '../domain/types'
import { freshStore } from '../test/fixtures'
import { WorkspaceStore } from '../store/workspaceStore'
import { createV1Stores, createV3Stores, DB_VERSION, type MintyDB } from './db'
import { emptyChangeSet, IdbRepository } from './repository'

let n = 0

/** Records exactly as app versions 0.1.x stored them (before Stage 2 fields existed). */
function stage1Records() {
  const at = '2026-10-30T09:15:00.000Z'
  const notebook = { id: newId(), title: 'Kept', order: 1, createdAt: at, updatedAt: at }
  const section = { id: newId(), notebookId: notebook.id, title: 'General', order: 1, createdAt: at, updatedAt: at }
  const base = { order: 1, width: 1200, createdAt: at, updatedAt: at }
  const live = { ...base, id: newId(), title: 'Live', location: { kind: 'section', sectionId: section.id }, trashedAt: null }
  const inbox = { ...base, id: newId(), title: 'Quick note', location: { kind: 'inbox' }, trashedAt: null }
  const orphan = { ...base, id: newId(), title: 'Trashed orphan', location: { kind: 'section', sectionId: 'deleted' }, trashedAt: at }
  const attachmentId = newId()
  const text: TextObject = { id: newId(), pageId: live.id, type: 'text', x: 40, y: 64, w: 420, h: 80, z: 1, doc: docFromPlainText('Stage 1 text'), createdAt: at, updatedAt: at }
  const image = { id: newId(), pageId: inbox.id, type: 'image', attachmentId, alt: '', x: 500, y: 120, w: 320, h: 200, z: 2, createdAt: at, updatedAt: at }
  const attachment = { id: attachmentId, fileName: 'screenshot.png', mimeType: 'image/png', size: 3, sha256: 'x', width: 1, height: 1, source: 'paste', createdAt: at }
  return { at, notebook, section, live, inbox, orphan, text, image, attachment }
}

/** Write a database exactly as app version 0.1.0 (schema 1) or 0.1.1–0.1.2 (schema 2) left it. */
async function makeLegacyDatabase(version: 1 | 2, withActivity: boolean) {
  const name = `minty-v${version}-${Date.now()}-${n++}`
  const db = await openDB<MintyDB>(name, version, { upgrade: (d) => createV1Stores(d) })
  const r = stage1Records()
  const put = (store: string, value: unknown, key?: string) => (db.put as (s: string, v: unknown, k?: string) => Promise<unknown>)(store, value, key)
  await put('notebooks', r.notebook)
  await put('sections', r.section)
  await put('pages', r.live)
  await put('pages', r.inbox)
  if (version === 1) await put('pages', r.orphan)
  await put('objects', r.text)
  await put('objects', r.image)
  await put('attachments', r.attachment)
  await put('blobs', new Blob([new Uint8Array([1, 2, 3])]), r.attachment.id)
  await put('settings', { workspaceId: 'ws-stage1', formatVersion: 1, createdAt: r.at }, 'workspace')
  if (withActivity) await put('settings', version === 1 ? { lastChangeAt: r.at } : { lastChangeAt: r.at, revision: 7 }, 'activity')
  db.close()
  return { name, ...r }
}

describe('IndexedDB migrations', () => {
  it('1 → 4: adds the revision, repairs the trashed orphan, and adds Stage 2 and 3 fields', async () => {
    expect(DB_VERSION).toBe(4)
    const v1 = await makeLegacyDatabase(1, true)
    const repo = await IdbRepository.open(v1.name)
    const index = await repo.loadIndex()
    const pages = Object.fromEntries(index.pages.map((p) => [p.id, p]))
    expect(pages[v1.orphan.id]).toMatchObject({ location: { kind: 'inbox' }, trashedAt: v1.orphan.trashedAt, title: 'Trashed orphan', categoryIds: [], tagIds: [], copiedFrom: null })
    expect(pages[v1.live.id].location).toEqual({ kind: 'section', sectionId: v1.section.id })
    expect(index.activity.revision).toBe(1)
    expect(index.projects).toEqual([])
    expect(index.workspace).toMatchObject({ workspaceId: 'ws-stage1', formatVersion: FORMAT_VERSION })
    expect(await repo.commit(emptyChangeSet(), nowIso(), null)).toBe(2)
    repo.close()
  })

  it('starts the revision at 0 when nothing was ever saved', async () => {
    const v1 = await makeLegacyDatabase(1, false)
    const repo = await IdbRepository.open(v1.name)
    expect((await repo.loadIndex()).activity.revision).toBe(0)
    repo.close()
  })

  it('2 → 4: keeps every Stage 1 note, ID, attachment, and layout; the result backs up and restores', async () => {
    const v2 = await makeLegacyDatabase(2, true)
    const repo = await IdbRepository.open(v2.name)
    const store = new WorkspaceStore(repo, { debounceMs: 5, maxWaitMs: 20 })
    await store.load()
    await store.becomeEditor()
    const { data } = store.getState()
    expect(data.revision).toBe(7) // the stored revision is kept
    expect(Object.keys(data.pages).sort()).toEqual([v2.live.id, v2.inbox.id].sort())
    expect(data.pages[v2.live.id]).toMatchObject({ title: 'Live', createdAt: v2.at, updatedAt: v2.at, categoryIds: [], tagIds: [], copiedFrom: null })
    expect(data.notebooks[v2.notebook.id].categoryIds).toEqual([])
    expect(data.sections[v2.section.id].categoryIds).toEqual([])
    const live = await store.ensurePageObjects(v2.live.id)
    expect(live[v2.text.id]).toMatchObject({ x: 40, y: 64, w: 420, h: 80 })
    expect(docToPlainText((live[v2.text.id] as TextObject).doc)).toBe('Stage 1 text')
    const inbox = await store.ensurePageObjects(v2.inbox.id)
    expect(inbox[v2.image.id]).toMatchObject({ attachmentId: v2.attachment.id, x: 500, y: 120, w: 320, h: 200 })
    expect(new Uint8Array(await (await store.getBlob(v2.attachment.id))!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))

    // Stage 2 features work on migrated data, and a full backup of it validates and restores.
    const project = store.createProject({ name: 'Migrated plant' })
    store.pinReference(project.id, v2.live.id)
    await store.flush()
    const service = new BackupService(store, { appVersion: 'test', folderSupported: false })
    // The fixture's attachment checksum is a placeholder; the archive computes real ones.
    const { bytes } = await service.createArchive()
    const validated = await readArchive(bytes)
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    const clean = await freshStore()
    await clean.store.becomeEditor()
    await new BackupService(clean.store, { appVersion: 'test', folderSupported: false }).restore(validated)
    const restored = clean.store.getState().data
    expect(restored.projects[project.id].pinnedPageIds).toEqual([v2.live.id])
    expect(restored.pages[v2.live.id].title).toBe('Live')
    repo.close()
  })

  it('a failed data migration leaves the older database untouched', async () => {
    const v2 = await makeLegacyDatabase(2, true)
    // Make the second page write of the version-3 migration fail.
    const original = IDBObjectStore.prototype.put
    let calls = 0
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'pages' && ++calls === 2) throw new DOMException('simulated failure', 'UnknownError')
      return original.apply(this, args)
    }
    try {
      await expect(IdbRepository.open(v2.name)).rejects.toBeTruthy()
    } finally {
      IDBObjectStore.prototype.put = original
    }
    const after = await openDB(v2.name)
    expect(after.version).toBe(2)
    expect(after.objectStoreNames.contains('projects')).toBe(false)
    const pages = (await after.getAll('pages')) as Record<string, unknown>[]
    expect(pages.every((p) => !('categoryIds' in p))).toBe(true)
    after.close()
  })

  it('3 → 4: keeps every Stage 2 record; adds task and template stores and file-location descriptions', async () => {
    const name = `minty-v3-${Date.now()}-${n++}`
    const db = await openDB<MintyDB>(name, 3, { upgrade: (d) => {
      createV1Stores(d)
      createV3Stores(d)
    } })
    const r = stage1Records()
    const put = (store: string, value: unknown, key?: string) => (db.put as (s: string, v: unknown, k?: string) => Promise<unknown>)(store, value, key)
    const category = { id: newId(), name: 'VTScada', order: 1, createdAt: r.at, updatedAt: r.at }
    const project = {
      id: newId(), name: 'Stage 2 plant', customer: 'C', site: 'S', jobNumber: 'J-1', description: '', status: 'active', dueDate: '2026-12-15',
      contacts: [], equipment: [], software: [],
      fileLocations: [{ id: newId(), label: 'Folder', kind: 'path', value: 'C:\\Jobs\\J-1' }, { id: newId(), label: 'Dropbox', kind: 'url', value: 'https://www.dropbox.com/home' }],
      categoryIds: [category.id], pinnedPageIds: [r.live.id], hiddenPageIds: [], order: 1, archivedAt: null, trashedAt: null, createdAt: r.at, updatedAt: r.at,
    }
    await put('categories', category)
    await put('projects', project)
    await put('notebooks', { ...r.notebook, categoryIds: [category.id] })
    await put('sections', { ...r.section, categoryIds: [] })
    await put('pages', { ...r.live, categoryIds: [], tagIds: [], copiedFrom: null })
    await put('pages', { ...r.inbox, location: { kind: 'project', projectId: project.id }, categoryIds: [], tagIds: [], copiedFrom: null })
    await put('objects', r.text)
    await put('settings', { workspaceId: 'ws-stage2', formatVersion: 2, createdAt: r.at }, 'workspace')
    await put('settings', { lastChangeAt: r.at, revision: 42 }, 'activity')
    db.close()

    const repo = await IdbRepository.open(name)
    const store = new WorkspaceStore(repo, { debounceMs: 5, maxWaitMs: 20 })
    await store.load()
    await store.becomeEditor()
    const { data } = store.getState()
    expect(data.revision).toBe(42)
    expect(data.workspace).toMatchObject({ workspaceId: 'ws-stage2', formatVersion: 3 })
    expect(data.tasks).toEqual({})
    expect(data.templates).toEqual({})
    const migrated = data.projects[project.id]
    expect(migrated).toMatchObject({ name: 'Stage 2 plant', dueDate: '2026-12-15', categoryIds: [category.id], pinnedPageIds: [r.live.id], updatedAt: r.at })
    expect(migrated.fileLocations).toEqual(project.fileLocations.map((f) => ({ ...f, description: '' })))
    expect(data.pages[r.inbox.id].location).toEqual({ kind: 'project', projectId: project.id })
    expect(docToPlainText(((await store.ensurePageObjects(r.live.id))[r.text.id] as TextObject).doc)).toBe('Stage 1 text')

    // Stage 3 features work on the migrated workspace, and it backs up and restores.
    const task = store.createTask(project.id, { title: 'First Stage 3 task', dueDate: '2026-11-20' })
    store.linkTaskPage(task.id, r.inbox.id)
    await store.flush()
    const reopened = new WorkspaceStore(await IdbRepository.open(name), { debounceMs: 5, maxWaitMs: 20 })
    await reopened.load()
    expect(reopened.getState().data.tasks[task.id]).toMatchObject({ linkedPageIds: [r.inbox.id], dueDate: '2026-11-20' })
    const { bytes } = await new BackupService(store, { appVersion: 'test', folderSupported: false }).createArchive()
    const validated = await readArchive(bytes)
    if (!validated.ok) throw new Error(validated.errors.join('; '))
    expect(validated.records.tasks).toHaveLength(1)
    repo.close()
  })

  it('a failed version-4 migration leaves the version-3 database untouched', async () => {
    const name = `minty-v3-fail-${Date.now()}-${n++}`
    const db = await openDB<MintyDB>(name, 3, { upgrade: (d) => {
      createV1Stores(d)
      createV3Stores(d)
    } })
    const at = nowIso()
    const project = { id: newId(), name: 'Keep me', customer: '', site: '', jobNumber: '', description: '', status: 'active', dueDate: null, contacts: [], equipment: [], software: [], fileLocations: [{ id: 'f1', label: 'F', kind: 'path', value: 'C:\\x' }], categoryIds: [], pinnedPageIds: [], hiddenPageIds: [], order: 1, archivedAt: null, trashedAt: null, createdAt: at, updatedAt: at }
    await (db.put as (s: string, v: unknown) => Promise<unknown>)('projects', project)
    db.close()
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'projects') throw new DOMException('simulated failure', 'UnknownError')
      return original.apply(this, args)
    }
    try {
      await expect(IdbRepository.open(name)).rejects.toBeTruthy()
    } finally {
      IDBObjectStore.prototype.put = original
    }
    const after = await openDB(name)
    expect(after.version).toBe(3)
    expect(after.objectStoreNames.contains('tasks')).toBe(false)
    expect(((await after.getAll('projects')) as { fileLocations: object[] }[])[0].fileLocations[0]).not.toHaveProperty('description')
    after.close()
  })
})
