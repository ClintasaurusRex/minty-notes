import { openDB } from 'idb'
import { describe, expect, it, vi } from 'vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { buildArchive, readArchive, sha256Hex } from '../backup/archive'
import { BackupService } from '../backup/backupService'
import { hasManualOrder, projectNotes } from '../domain/references'
import { docFromPlainText } from '../domain/richtext'
import { FORMAT_VERSION, newId, type Page, type Project } from '../domain/types'
import { createV1Stores, createV3Stores, createV4Stores, type MintyDB } from '../storage/db'
import { IdbRepository } from '../storage/repository'
import { buildProjectExport, importProjectPackage, loadExportSnapshot } from '../portable/projectTransfer'
import { readProjectPackage } from '../portable/readPackage'
import { DEFAULT_EXPORT_OPTIONS } from '../portable/selectProject'
import { freshStore } from '../test/fixtures'
import { ReadOnlyError, WorkspaceStore } from './workspaceStore'

/**
 * A, B, C are created one second apart, so Last edited deterministically shows
 * C, B, A (same-millisecond ties would fall back to creation order) and the
 * first switch to Manual starts from that visible order.
 */
async function example() {
  const { store, repo } = await freshStore()
  vi.useFakeTimers({ toFake: ['Date'] })
  let second = 0
  const at = () => vi.setSystemTime(new Date(Date.UTC(2020, 0, 1, 0, 0, ++second)))
  let project!: Project, other!: Project
  let a!: Page, b!: Page, c!: Page, ref!: Page, foreign!: Page
  try {
    at(); project = store.createProject({ name: 'Ordered project' })
    at(); a = store.createPage({ kind: 'project', projectId: project.id }, 'A')
    at(); b = store.createPage({ kind: 'project', projectId: project.id }, 'B')
    at(); c = store.createPage({ kind: 'project', projectId: project.id }, 'C')
    at(); ref = store.createPage({ kind: 'standalone' }, 'Shared reference')
    store.pinReference(project.id, ref.id)
    at(); other = store.createProject({ name: 'Other' })
    at(); foreign = store.createPage({ kind: 'project', projectId: other.id }, 'Other note')
  } finally { vi.useRealTimers() }
  await store.flush()
  const order = () => projectNotes(project.id, store.getState().data.pages, store.getState().data.projects[project.id].noteSort).map((p) => p.title)
  return { store, repo, project, a, b, c, ref, foreign, order }
}

/** Rebuild a genuine older-version archive, including its checksums, never bypassing validation. */
async function asFormat4(bytes: Uint8Array, recordFile: 'records.json' | 'project.json') {
  const files = unzipSync(bytes)
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']))
  const records = JSON.parse(new TextDecoder().decode(files[recordFile]))
  if (recordFile === 'records.json') {
    records.workspace.formatVersion = 4
    for (const p of records.projects) delete p.noteSort
  } else delete records.project.noteSort
  const body = strToU8(JSON.stringify(records))
  manifest.formatVersion = 4
  manifest.app.version = '0.4.2'
  manifest.records = { path: recordFile, size: body.length, sha256: await sha256Hex(body) }
  files[recordFile] = body
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  return zipSync(files)
}

it('defaults to Last edited; deliberate reordering freezes displayed order without editing note timestamps', async () => {
  const { store, project, a, b, c, order } = await example()
  const data = store.getState().data
  const ordered = {
    ...data.pages,
    [a.id]: { ...a, updatedAt: '2026-11-01T10:00:00.000Z' },
    [b.id]: { ...b, updatedAt: '2026-11-03T10:00:00.000Z' },
    [c.id]: { ...c, updatedAt: '2026-11-02T10:00:00.000Z' },
  }
  expect(project.noteSort).toBe('last-edited')
  expect(projectNotes(project.id, ordered).map((p) => p.title)).toEqual(['B', 'C', 'A'])
  const original = Object.fromEntries(Object.entries(data.pages).map(([id, p]) => [id, p.updatedAt]))
  const displayed = order()
  const movedId = projectNotes(project.id, data.pages)[2].id
  expect(store.nudgeProjectNote(project.id, movedId, 'up')).toBe(true)
  expect(order()).toEqual([displayed[0], displayed[2], displayed[1]])
  expect(store.getState().data.projects[project.id].noteSort).toBe('manual')
  expect(Object.fromEntries(Object.entries(store.getState().data.pages).map(([id, p]) => [id, p.updatedAt]))).toEqual(original)
  store.renamePage(projectNotes(project.id, store.getState().data.pages, 'manual')[2].id, 'Edited last')
  expect(order()[2]).toBe('Edited last')
})

it('refuses cross-project/reference/trashed destinations and every read-only ordering write', async () => {
  const { store, repo, project, a, b, ref, foreign } = await example()
  const before = await repo.readAll()
  expect(store.moveProjectNote(project.id, ref.id, a.id)).toBe(false)
  expect(store.moveProjectNote(project.id, a.id, foreign.id)).toBe(false)
  expect(store.moveProjectNote(project.id, a.id, ref.id)).toBe(false)
  expect(store.moveProjectNote(project.id, a.id, a.id)).toBe(false)
  store.setProjectNoteSort(project.id, 'invalid' as never)
  expect(await repo.readAll()).toEqual(before)
  const readonly = new WorkspaceStore(repo)
  await readonly.load()
  readonly.setReadOnly(true)
  expect(() => readonly.setProjectNoteSort(project.id, 'manual')).toThrow(ReadOnlyError)
  expect(() => readonly.moveProjectNote(project.id, a.id, b.id)).toThrow(ReadOnlyError)
  expect(() => readonly.nudgeProjectNote(project.id, a.id, 'up')).toThrow(ReadOnlyError)
  store.trashPage(b.id)
  expect(store.moveProjectNote(project.id, a.id, b.id)).toBe(false)
})

it('persists manual order after reload, edits, adding a note, and full workspace backup/restore', async () => {
  const { store, repo, project, a, b, order } = await example()
  store.setProjectNoteSort(project.id, 'manual')
  expect(order()).toEqual(['C', 'B', 'A'])
  expect(store.moveProjectNote(project.id, a.id, b.id)).toBe(true)
  expect(order()).toEqual(['C', 'A', 'B'])
  store.renamePage(b.id, 'B edited')
  store.createPage({ kind: 'project', projectId: project.id }, 'D')
  await store.flush()
  const reopened = new WorkspaceStore(repo)
  await reopened.load()
  expect(projectNotes(project.id, reopened.getState().data.pages, reopened.getState().data.projects[project.id].noteSort).map((p) => p.title)).toEqual(['C', 'A', 'B edited', 'D'])
  const archive = await readArchive((await new BackupService(store, { appVersion: 'test', folderSupported: false }).createArchive()).bytes)
  if (!archive.ok) throw new Error(archive.errors.join('; '))
  const dest = await freshStore()
  await new BackupService(dest.store, { appVersion: 'test', folderSupported: false }).restore(archive)
  expect(dest.store.getState().data.projects[project.id].noteSort).toBe('manual')
  expect(projectNotes(project.id, dest.store.getState().data.pages, 'manual').map((p) => p.title)).toEqual(['C', 'A', 'B edited', 'D'])
})

it('portable round trip keeps manual mode and sequence; independent reference copies append and can move', async () => {
  const { store, project, a, b, ref } = await example()
  store.setProjectNoteSort(project.id, 'manual')
  expect(store.moveProjectNote(project.id, a.id, b.id)).toBe(true) // C, B, A → C, A, B
  const result = await buildProjectExport(await loadExportSnapshot(store), project.id, DEFAULT_EXPORT_OPTIONS, 'test')
  const pkg = await readProjectPackage(result.bytes)
  if (!pkg.ok) throw new Error(pkg.errors.join('; '))
  const dest = await freshStore()
  const imported = await importProjectPackage(dest.store, pkg)
  expect(dest.store.getState().data.projects[imported.projectId].noteSort).toBe('manual')
  const notes = () => projectNotes(imported.projectId, dest.store.getState().data.pages, dest.store.getState().data.projects[imported.projectId].noteSort)
  expect(notes().map((p) => p.title)).toEqual(['C', 'A', 'B', 'Shared reference'])
  const copy = notes()[3]
  expect(copy.copiedFrom).toMatchObject({ pageId: null, title: 'Shared reference' })
  expect(copy.id).not.toBe(ref.id)
  expect(dest.store.moveProjectNote(imported.projectId, copy.id, notes()[0].id)).toBe(true)
  expect(notes().map((p) => p.title)).toEqual(['Shared reference', 'C', 'A', 'B'])
  await dest.store.flush()
})

it('migrates real-shaped format-4 backups and package-version-1 records to Last edited before validation', async () => {
  const { store, repo, project } = await example()
  const snapshot = await repo.readAll()
  const backup = await asFormat4(await buildArchive(snapshot.records, snapshot.blobs, 'test'), 'records.json')
  const read = await readArchive(backup)
  if (!read.ok) throw new Error(read.errors.join('; '))
  expect(read.records.workspace.formatVersion).toBe(FORMAT_VERSION)
  expect(read.records.projects.every((p) => p.noteSort === 'last-edited')).toBe(true)
  const result = await buildProjectExport(await loadExportSnapshot(store), project.id, DEFAULT_EXPORT_OPTIONS, 'test')
  const pkg = await readProjectPackage(await asFormat4(result.bytes, 'project.json'))
  if (!pkg.ok) throw new Error(pkg.errors.join('; '))
  expect(pkg.summary.packageVersion).toBe(1)
  expect(pkg.summary.formatVersion).toBe(4)
  expect(pkg.records.project.noteSort).toBe('last-edited')
  const dest = await freshStore()
  await importProjectPackage(dest.store, pkg)
})

it('rejects an invalid format-5 sort mode without altering a destination workspace', async () => {
  const { repo } = await example()
  const snapshot = await repo.readAll()
  const bad = structuredClone(snapshot.records)
  bad.projects[0].noteSort = 'unknown' as never
  const read = await readArchive(await buildArchive(bad, snapshot.blobs, 'test'))
  expect(read.ok).toBe(false)
  expect(await repo.readAll()).toEqual(snapshot)
})

it('refuses malformed current-package sorting before an import can touch existing records', async () => {
  const { store, project } = await example()
  const exported = await buildProjectExport(await loadExportSnapshot(store), project.id, DEFAULT_EXPORT_OPTIONS, 'test')
  const files = unzipSync(exported.bytes)
  const projectJson = JSON.parse(new TextDecoder().decode(files['project.json']))
  projectJson.project.noteSort = 'invalid'
  const body = strToU8(JSON.stringify(projectJson))
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']))
  manifest.records = { path: 'project.json', size: body.length, sha256: await sha256Hex(body) }
  files['project.json'] = body
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  const dest = await example()
  const before = await dest.repo.readAll()
  const read = await readProjectPackage(zipSync(files))
  expect(read.ok).toBe(false)
  if (!read.ok) expect(read.errors.join('; ')).toMatch(/Project #1 is invalid/)
  expect(await dest.repo.readAll()).toEqual(before)
})

async function databaseV5() {
  const { repo, project, a } = await example()
  const all = (await repo.readAll()).records
  const name = `minty-stage5-migration-${newId()}`
  const db = await openDB<MintyDB>(name, 5, { upgrade(d) { createV1Stores(d); createV3Stores(d); createV4Stores(d) } })
  const old = { ...project } as Partial<Project>
  delete old.noteSort
  await db.put('projects', old as Project)
  await db.put('pages', a)
  await db.put('settings', { ...all.workspace, formatVersion: 4 }, 'workspace')
  await db.put('settings', { revision: 42, lastChangeAt: a.updatedAt }, 'activity')
  db.close()
  return { name, old, page: a }
}

describe('DB5 → DB6 all-or-nothing migration', () => {
  it('initializes ordering while preserving IDs, timestamps, pages, and revision', async () => {
    const old = await databaseV5()
    const repo = await IdbRepository.open(old.name)
    const { records, revision } = await repo.readAll()
    expect(records.workspace.formatVersion).toBe(5)
    expect(records.projects).toEqual([{ ...old.old, noteSort: 'last-edited' }])
    expect(records.pages).toEqual([old.page])
    expect(revision).toBe(42)
    repo.close()
  })
  it('a failed project rewrite leaves DB5 and its complete records untouched', async () => {
    const old = await databaseV5()
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'projects') throw new DOMException('simulated migration failure', 'UnknownError')
      return put.apply(this, args)
    }
    try { await expect(IdbRepository.open(old.name)).rejects.toBeTruthy() } finally { IDBObjectStore.prototype.put = put }
    const db = await openDB(old.name)
    expect(db.version).toBe(5)
    expect(await db.getAll('projects')).toEqual([old.old])
    expect(await db.getAll('pages')).toEqual([old.page])
    expect(await db.get('settings', 'workspace')).toMatchObject({ formatVersion: 4 })
    expect(await db.get('settings', 'activity')).toMatchObject({ revision: 42 })
    db.close()
  })
})

it('held manual-order edits count without timestamp changes and preserve another window’s newer title and sorting choice', async () => {
  const { store: a, repo, project, a: first, b: middle } = await example()
  await a.becomeEditor()
  a.setProjectNoteSort(project.id, 'manual')
  await a.flush()
  const b = new WorkspaceStore(repo, { debounceMs: 5, maxWaitMs: 20 })
  await b.becomeEditor()
  const beforeTimes = Object.fromEntries(Object.values(a.getState().data.pages).map((p) => [p.id, p.updatedAt]))
  expect(a.moveProjectNote(project.id, first.id, middle.id)).toBe(true) // C, B, A → C, A, B
  expect(Object.fromEntries(Object.values(a.getState().data.pages).map((p) => [p.id, p.updatedAt]))).toEqual(beforeTimes)
  expect(await a.flush()).toBe(false)
  expect(a.getState().heldChanges).toBeGreaterThan(0)
  b.renamePage(first.id, 'A renamed in B')
  b.setProjectNoteSort(project.id, 'last-edited')
  await b.flush()
  expect(await b.releaseOwnership()).toEqual({ ok: true })
  await a.becomeEditor()
  expect(a.getState().data.projects[project.id].noteSort).toBe('last-edited')
  expect(projectNotes(project.id, a.getState().data.pages, 'manual').map((p) => p.title)).toEqual(['C', 'A renamed in B', 'B'])
  const read = await readArchive((await new BackupService(a, { appVersion: 'test', folderSupported: false }).createArchive()).bytes)
  if (!read.ok) throw new Error(read.errors.join('; '))
  const dest = await freshStore()
  await new BackupService(dest.store, { appVersion: 'test', folderSupported: false }).restore(read)
  expect(dest.store.getState().data.projects[project.id].noteSort).toBe('last-edited')
  expect(projectNotes(project.id, dest.store.getState().data.pages, 'manual').map((p) => p.title)).toEqual(['C', 'A renamed in B', 'B'])
})

it('conflicting held reorders merge order fields exactly, recover conflicts and preserve the sequence through reload/backup/import', async () => {
  const { store: a, repo, project, a: first, b: middle, c: last } = await example()
  await a.becomeEditor()
  a.setProjectNoteSort(project.id, 'manual')
  await a.flush()
  const b = new WorkspaceStore(repo, { debounceMs: 5, maxWaitMs: 20 })
  await b.becomeEditor()
  // From C, B, A: this window moves A first (A, C, B); the other moves B first (B, C, A).
  expect(a.moveProjectNote(project.id, first.id, last.id)).toBe(true)
  expect(await a.flush()).toBe(false)
  expect(b.moveProjectNote(project.id, middle.id, last.id)).toBe(true)
  await b.flush()
  expect(await b.releaseOwnership()).toEqual({ ok: true })
  const merged = await a.becomeEditor()
  expect(merged!.recovered).toHaveLength(1)
  expect(merged!.recovered[0]).toMatchObject({ type: 'note', detail: 'Order: this window had 3; kept 1' })
  // Existing field-wise policy: A's non-conflicting 3→1 applies; B's conflicting
  // 2→3 loses to stored 1; C is 2 in both windows. Equal orders use creation/ID
  // ties, so A precedes B. This does not promise either whole-window sequence.
  expect([first, middle, last].map((p) => a.getState().data.pages[p.id].order)).toEqual([1, 1, 2])
  const expected = [first.id, middle.id, last.id]
  const ids = (store: WorkspaceStore, id = project.id) => projectNotes(id, store.getState().data.pages, store.getState().data.projects[id].noteSort).map((p) => p.id)
  expect(ids(a)).toEqual(expected)
  const reopened = new WorkspaceStore(repo)
  await reopened.load()
  expect(ids(reopened)).toEqual(expected)
  const read = await readArchive((await new BackupService(a, { appVersion: 'test', folderSupported: false }).createArchive()).bytes)
  if (!read.ok) throw new Error(read.errors.join('; '))
  const dest = await freshStore()
  await new BackupService(dest.store, { appVersion: 'test', folderSupported: false }).restore(read)
  expect(projectNotes(project.id, dest.store.getState().data.pages, 'manual').map((p) => p.id)).toEqual(expected)
  const exported = await buildProjectExport(await loadExportSnapshot(a), project.id, { ...DEFAULT_EXPORT_OPTIONS, includePinned: false, includeSuggested: false }, 'test')
  const pkg = await readProjectPackage(exported.bytes)
  if (!pkg.ok) throw new Error(pkg.errors.join('; '))
  const imported = await importProjectPackage(dest.store, pkg)
  expect(projectNotes(imported.projectId, dest.store.getState().data.pages, 'manual').map((p) => p.title)).toEqual(['A', 'B', 'C'])
  // The merged tie (A and B both 1) is resolved by the next move: dense 1…n again.
  expect(a.nudgeProjectNote(project.id, last.id, 'up')).toBe(true)
  expect(ids(a)).toEqual([first.id, last.id, middle.id])
  expect([first, middle, last].map((p) => a.getState().data.pages[p.id].order)).toEqual([1, 3, 2])
  expect(await a.flush()).toBe(true)
  const again = new WorkspaceStore(repo)
  await again.load()
  expect(ids(again)).toEqual([first.id, last.id, middle.id])
})

describe('Manual arrival, Trash and end placement', () => {
  it('appends a moved note after destination siblings, preserving identity, content and task links', async () => {
    const { store, repo, project, foreign, order } = await example()
    store.setProjectNoteSort(project.id, 'manual')
    const task = store.createTask(project.id, { title: 'Linked task', linkedPageIds: [foreign.id] })
    store.addObjects(foreign.id, [{ id: newId(), pageId: foreign.id, type: 'text', x: 48, y: 48, w: 400, h: 80, z: 1, doc: docFromPlainText('Moved content stays intact'), createdAt: foreign.createdAt, updatedAt: foreign.updatedAt }])
    const objects = await store.ensurePageObjects(foreign.id)
    store.movePage(foreign.id, { kind: 'project', projectId: project.id })
    expect(order()).toEqual(['C', 'B', 'A', 'Other note'])
    expect(store.getState().data.pages[foreign.id]).toMatchObject({ id: foreign.id, order: 4, createdAt: foreign.createdAt })
    expect(await store.ensurePageObjects(foreign.id)).toEqual(objects)
    expect(store.getState().data.tasks[task.id].linkedPageIds).toEqual([foreign.id])
    await store.flush()
    const reopened = new WorkspaceStore(repo)
    await reopened.load()
    expect(projectNotes(project.id, reopened.getState().data.pages, 'manual').map((p) => p.title)).toEqual(['C', 'B', 'A', 'Other note'])
    expect(await reopened.ensurePageObjects(foreign.id)).toEqual(objects)
  })

  it('restores a trashed note at its retained Manual position without moving siblings', async () => {
    const { store, project, b, order } = await example()
    store.setProjectNoteSort(project.id, 'manual')
    store.trashPage(b.id)
    expect(order()).toEqual(['C', 'A'])
    store.restorePage(b.id)
    expect(order()).toEqual(['C', 'B', 'A'])
    expect(store.getState().data.pages[b.id]).toMatchObject({ order: 2, trashedAt: null, location: { kind: 'project', projectId: project.id } })
    await store.flush()
  })

  it('uses existing deterministic ties when live notes were renumbered while a note was trashed', async () => {
    const { store, project, a, b, c, order } = await example()
    store.setProjectNoteSort(project.id, 'manual') // C1, B2, A3
    store.trashPage(b.id)
    expect(store.moveProjectNote(project.id, a.id, c.id)).toBe(true) // A1, C2
    store.restorePage(b.id) // B retains 2; B was created before C
    expect(order()).toEqual(['A', 'B', 'C'])
    expect([a, b, c].map((p) => store.getState().data.pages[p.id].order)).toEqual([1, 2, 2])
    // The tie is harmless: the next move renumbers the displayed sequence densely.
    expect(store.nudgeProjectNote(project.id, c.id, 'up')).toBe(true)
    expect(order()).toEqual(['A', 'C', 'B'])
    expect([a, b, c].map((p) => store.getState().data.pages[p.id].order)).toEqual([1, 3, 2])
    await store.flush()
  })

  it('moves to the very end, preserves timestamps and refuses an already-last no-op', async () => {
    const { store, project, a, c, order } = await example()
    const times = Object.values(store.getState().data.pages).map((p) => [p.id, p.updatedAt])
    expect(store.moveProjectNote(project.id, c.id, null)).toBe(true)
    expect(order()).toEqual(['B', 'A', 'C'])
    expect(store.moveProjectNote(project.id, c.id, null)).toBe(false)
    expect(store.moveProjectNote(project.id, a.id, null)).toBe(true)
    expect(order()).toEqual(['B', 'C', 'A'])
    expect(Object.values(store.getState().data.pages).map((p) => [p.id, p.updatedAt])).toEqual(times)
    await store.flush()
  })
})

describe('Manual initialization (audit M1)', () => {
  /** A, B, C created in that order, then edited so Last edited shows B, A, C. */
  async function edited() {
    const ex = await example()
    const { store, a, b, c } = ex
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2020-01-01T10:00:00.000Z'))
      store.renamePage(c.id, 'C')
      store.renamePage(c.id, 'C1')
      vi.setSystemTime(new Date('2020-01-01T11:00:00.000Z'))
      store.renamePage(a.id, 'A1')
      vi.setSystemTime(new Date('2020-01-01T12:00:00.000Z'))
      store.renamePage(b.id, 'B1')
    } finally { vi.useRealTimers() }
    await store.flush()
    expect(ex.order()).toEqual(['B1', 'A1', 'C1'])
    return ex
  }
  /** Edit at a fixed time so Last edited never depends on same-millisecond ties. */
  const renameAt = (store: WorkspaceStore, id: string, title: string, iso: string) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(iso))
      store.renamePage(id, title)
    } finally { vi.useRealTimers() }
  }
  const times = (store: WorkspaceStore) => Object.fromEntries(Object.values(store.getState().data.pages).map((p) => [p.id, p.updatedAt]))
  const titlesIn = (store: WorkspaceStore, projectId: string, sort?: Project['noteSort']) =>
    projectNotes(projectId, store.getState().data.pages, sort ?? store.getState().data.projects[projectId].noteSort).map((p) => p.title)

  it('the first switch keeps the visible Last edited order and changes no edit timestamps', async () => {
    const { store, repo, project, order } = await edited()
    expect(titlesIn(store, project.id, 'manual')).toEqual(['A1', 'B1', 'C1']) // creation order before the switch
    expect(store.getState().data.projects[project.id].manualOrderSet).toBeUndefined()
    const before = times(store)
    store.setProjectNoteSort(project.id, 'manual')
    expect(order()).toEqual(['B1', 'A1', 'C1'])
    expect(times(store)).toEqual(before)
    expect(store.getState().data.projects[project.id]).toMatchObject({ noteSort: 'manual', manualOrderSet: true })
    await store.flush()
    const reopened = new WorkspaceStore(repo)
    await reopened.load()
    expect(titlesIn(reopened, project.id)).toEqual(['B1', 'A1', 'C1'])
    expect(times(reopened)).toEqual(before)
  })

  it('switching back and forth keeps the established Manual order instead of reinitializing it', async () => {
    const { store, repo, project, a, c, order } = await edited()
    store.setProjectNoteSort(project.id, 'manual')
    expect(store.moveProjectNote(project.id, c.id, null)).toBe(false) // already last
    expect(store.nudgeProjectNote(project.id, c.id, 'up')).toBe(true)
    expect(order()).toEqual(['B1', 'C1', 'A1'])
    store.setProjectNoteSort(project.id, 'last-edited')
    renameAt(store, c.id, 'C2', '2020-01-02T10:00:00.000Z') // now newest
    expect(order()).toEqual(['C2', 'B1', 'A1'])
    renameAt(store, a.id, 'A2', '2020-01-02T11:00:00.000Z') // newest again
    expect(order()).toEqual(['A2', 'C2', 'B1'])
    const before = times(store)
    store.setProjectNoteSort(project.id, 'manual')
    expect(order()).toEqual(['B1', 'C2', 'A2'])
    expect(times(store)).toEqual(before)
    store.setProjectNoteSort(project.id, 'last-edited')
    store.setProjectNoteSort(project.id, 'manual')
    expect(order()).toEqual(['B1', 'C2', 'A2'])
    // The same holds after reloading in Last edited.
    store.setProjectNoteSort(project.id, 'last-edited')
    await store.flush()
    const reopened = new WorkspaceStore(repo)
    await reopened.load()
    expect(reopened.getState().data.projects[project.id]).toMatchObject({ noteSort: 'last-edited', manualOrderSet: true })
    reopened.setProjectNoteSort(project.id, 'manual')
    expect(titlesIn(reopened, project.id)).toEqual(['B1', 'C2', 'A2'])
    expect(times(reopened)).toEqual(times(store))
  })

  it('a reorder made while Last edited is shown starts from the visible order and becomes the Manual order', async () => {
    const { store, project, a, order } = await edited()
    store.setProjectNoteSort(project.id, 'manual')
    store.setProjectNoteSort(project.id, 'last-edited')
    const before = times(store)
    expect(store.nudgeProjectNote(project.id, a.id, 'down')).toBe(true)
    expect(order()).toEqual(['B1', 'C1', 'A1'])
    expect(store.getState().data.projects[project.id].noteSort).toBe('manual')
    expect(times(store)).toEqual(before)
    store.setProjectNoteSort(project.id, 'last-edited')
    store.setProjectNoteSort(project.id, 'manual')
    expect(order()).toEqual(['B1', 'C1', 'A1'])
  })

  it('a new note appends to an established Manual order while Last edited is selected', async () => {
    const { store, project, order } = await edited()
    store.setProjectNoteSort(project.id, 'manual')
    store.setProjectNoteSort(project.id, 'last-edited')
    store.createPage({ kind: 'project', projectId: project.id }, 'D')
    expect(order()[0]).toBe('D')
    store.setProjectNoteSort(project.id, 'manual')
    expect(order()).toEqual(['B1', 'A1', 'C1', 'D'])
  })

  it('full backup/restore keeps the established order while Last edited is selected', async () => {
    const { store, project, c } = await edited()
    store.setProjectNoteSort(project.id, 'manual')
    store.nudgeProjectNote(project.id, c.id, 'up')
    store.setProjectNoteSort(project.id, 'last-edited')
    const read = await readArchive((await new BackupService(store, { appVersion: 'test', folderSupported: false }).createArchive()).bytes)
    if (!read.ok) throw new Error(read.errors.join('; '))
    expect(read.records.projects.find((p) => p.id === project.id)).toMatchObject({ noteSort: 'last-edited', manualOrderSet: true })
    const dest = await freshStore()
    await new BackupService(dest.store, { appVersion: 'test', folderSupported: false }).restore(read)
    expect(titlesIn(dest.store, project.id)).toEqual(['B1', 'A1', 'C1'])
    const before = times(dest.store)
    dest.store.setProjectNoteSort(project.id, 'manual')
    expect(titlesIn(dest.store, project.id)).toEqual(['B1', 'C1', 'A1'])
    expect(times(dest.store)).toEqual(before)
  })

  it('a restored project that never used Manual initializes from its visible order', async () => {
    const { store, project } = await edited()
    const read = await readArchive((await new BackupService(store, { appVersion: 'test', folderSupported: false }).createArchive()).bytes)
    if (!read.ok) throw new Error(read.errors.join('; '))
    const dest = await freshStore()
    await new BackupService(dest.store, { appVersion: 'test', folderSupported: false }).restore(read)
    dest.store.setProjectNoteSort(project.id, 'manual')
    expect(titlesIn(dest.store, project.id)).toEqual(['B1', 'A1', 'C1'])
  })

  it('portable transfer keeps the established order while Last edited is selected, and initializes a never-manual project from its visible order', async () => {
    const { store, project, c } = await edited()
    const transfer = async () => {
      const result = await buildProjectExport(await loadExportSnapshot(store), project.id, DEFAULT_EXPORT_OPTIONS, 'test')
      const pkg = await readProjectPackage(result.bytes)
      if (!pkg.ok) throw new Error(pkg.errors.join('; '))
      const dest = await freshStore()
      const { projectId } = await importProjectPackage(dest.store, pkg)
      return { dest: dest.store, projectId }
    }
    // Never Manual: the import shows Last edited (the reference copy keeps its older
    // edit time, so it is last); the first switch keeps exactly that order.
    const fresh = await transfer()
    expect(fresh.dest.getState().data.projects[fresh.projectId].manualOrderSet).toBeUndefined()
    expect(titlesIn(fresh.dest, fresh.projectId, 'last-edited')).toEqual(['B1', 'A1', 'C1', 'Shared reference'])
    fresh.dest.setProjectNoteSort(fresh.projectId, 'manual')
    expect(titlesIn(fresh.dest, fresh.projectId)).toEqual(['B1', 'A1', 'C1', 'Shared reference'])
    // Established Manual order, exported while Last edited is selected.
    store.setProjectNoteSort(project.id, 'manual')
    store.nudgeProjectNote(project.id, c.id, 'up')
    store.setProjectNoteSort(project.id, 'last-edited')
    const kept = await transfer()
    expect(kept.dest.getState().data.projects[kept.projectId]).toMatchObject({ noteSort: 'last-edited', manualOrderSet: true })
    const before = times(kept.dest)
    kept.dest.setProjectNoteSort(kept.projectId, 'manual')
    expect(titlesIn(kept.dest, kept.projectId)).toEqual(['B1', 'C1', 'A1', 'Shared reference'])
    expect(times(kept.dest)).toEqual(before)
  })

  it('treats a format-5 Manual project saved before the flag existed as established', async () => {
    const { store, repo, project, order } = await edited()
    store.setProjectNoteSort(project.id, 'manual')
    store.setProjectNoteSort(project.id, 'last-edited')
    store.setProjectNoteSort(project.id, 'manual')
    await store.flush()
    const stored = (await repo.readAll()).records.projects.find((p) => p.id === project.id)!
    const legacy = { ...stored }
    delete legacy.manualOrderSet
    expect(order()).toEqual(['B1', 'A1', 'C1'])
    expect(hasManualOrder(legacy)).toBe(true)
    expect(hasManualOrder({ ...legacy, noteSort: 'last-edited' })).toBe(false)
  })

  it('refuses a malformed manualOrderSet in a backup', async () => {
    const { repo } = await example()
    const snapshot = await repo.readAll()
    const bad = structuredClone(snapshot.records)
    ;(bad.projects[0] as unknown as Record<string, unknown>).manualOrderSet = 'yes'
    const read = await readArchive(await buildArchive(bad, snapshot.blobs, 'test'))
    expect(read.ok).toBe(false)
  })
})
