import { describe, expect, it } from 'vitest'
import { readArchive } from '../backup/archive'
import { BackupService } from '../backup/backupService'
import { docFromPlainText, docToPlainText } from '../domain/richtext'
import { newId, nowIso, type PageLocation, type TextObject } from '../domain/types'
import { freshStore } from '../test/fixtures'
import { WorkspaceStore } from './workspaceStore'

/**
 * Window A loses editing while it has an unsaved text edit; window B keeps
 * working; A then takes editing back. Every step is awaited (no timers).
 */
interface SetupOptions {
  location?: PageLocation | 'notebook'
  /** Extra setup in A before B takes over. */
  prepare?: (a: WorkspaceStore) => unknown
  /** Further stale edits A makes (after the body edit) before its save is refused. */
  staleEdits?: (a: WorkspaceStore, pageId: string, prepared: unknown) => void
}

async function setup({ location = { kind: 'inbox' }, prepare, staleEdits }: SetupOptions = {}) {
  const { store: a, repo } = await freshStore()
  await a.becomeEditor()
  let loc: PageLocation = location === 'notebook' ? { kind: 'inbox' } : location
  let notebookId: string | null = null
  if (location === 'notebook') {
    const nb = a.createNotebook('Plant A')
    notebookId = nb.notebook.id
    loc = { kind: 'section', sectionId: nb.section.id }
  }
  const page = a.createPage(loc, 'Original title')
  const at = nowIso()
  const text: TextObject = { id: newId(), pageId: page.id, type: 'text', x: 40, y: 40, w: 400, h: 60, z: 1, doc: docFromPlainText('Original body'), createdAt: at, updatedAt: at }
  a.addObjects(page.id, [text])
  const prepared = prepare?.(a)
  await a.flush()

  const b = new WorkspaceStore(repo, { debounceMs: 5, maxWaitMs: 20, retryDelaysMs: [10] })
  await b.becomeEditor() // A is frozen: no handover
  await b.ensurePageObjects(page.id)

  // A wakes up and edits the body; its save is refused, so the edit is held.
  a.setTextDoc(page.id, text.id, docFromPlainText('Body edited in A'))
  staleEdits?.(a, page.id, prepared)
  expect(await a.flush()).toBe(false)
  expect(a.getState()).toMatchObject({ owner: false, readOnly: true })
  expect(a.getState().heldChanges).toBeGreaterThanOrEqual(1)
  return { a, b, repo, page, text, notebookId, prepared }
}

/** A takes editing back from B (B hands over cleanly). */
async function reclaim(a: WorkspaceStore, b: WorkspaceStore) {
  expect(await b.releaseOwnership()).toEqual({ ok: true })
  const result = await a.becomeEditor()
  expect(a.getState()).toMatchObject({ owner: true, readOnly: false, heldChanges: 0 })
  expect(a.hasUnsavedChanges).toBe(false)
  return result!
}

async function bodyOf(store: WorkspaceStore, pageId: string, id: string) {
  const objects = await store.ensurePageObjects(pageId)
  return docToPlainText((objects[id] as TextObject).doc)
}

/** A complete backup of the result is valid and restores into a clean workspace. */
async function backupRoundTrip(store: WorkspaceStore) {
  const service = new BackupService(store, { appVersion: 'test', folderSupported: false })
  const { bytes } = await service.createArchive()
  const validated = await readArchive(bytes)
  if (!validated.ok) throw new Error(`Backup failed validation: ${validated.errors.join('; ')}`)
  const clean = await freshStore()
  await clean.store.becomeEditor()
  await new BackupService(clean.store, { appVersion: 'test', folderSupported: false }).restore(validated)
  return clean.store
}

describe('reclaiming held edits', () => {
  it('case 1: a held body edit keeps the newer title saved by the other window', async () => {
    const { a, b, page, text } = await setup()
    b.renamePage(page.id, 'Renamed in B')
    await b.flush()

    const result = await reclaim(a, b)
    expect(result.recovered).toEqual([])
    expect(a.getState().data.pages[page.id].title).toBe('Renamed in B')
    expect(await bodyOf(a, page.id, text.id)).toBe('Body edited in A')

    const restored = await backupRoundTrip(a)
    expect(restored.getState().data.pages[page.id].title).toBe('Renamed in B')
    expect(await bodyOf(restored, page.id, text.id)).toBe('Body edited in A')
  })

  it('case 2: a held body edit does not undo Trash, relocation, or a deleted notebook', async () => {
    const { a, b, page, text, notebookId } = await setup({ location: 'notebook' })
    b.trashPage(page.id)
    expect(b.deleteNotebook(notebookId!)).toBe(true)
    await b.flush()
    expect(b.getState().data.pages[page.id]).toMatchObject({ location: { kind: 'inbox' }, trashedAt: expect.any(String) })

    const result = await reclaim(a, b)
    expect(result.recovered).toEqual([])
    const data = a.getState().data
    expect(data.notebooks[notebookId!]).toBeUndefined()
    expect(Object.values(data.sections)).toHaveLength(0)
    expect(data.pages[page.id]).toMatchObject({ location: { kind: 'inbox' }, trashedAt: expect.any(String), title: 'Original title' })
    // The body edit itself is kept, on the page in the Trash.
    expect(await bodyOf(a, page.id, text.id)).toBe('Body edited in A')

    const restored = await backupRoundTrip(a)
    expect(restored.getState().data.pages[page.id]).toMatchObject({ location: { kind: 'inbox' }, trashedAt: expect.any(String) })
    expect(await bodyOf(restored, page.id, text.id)).toBe('Body edited in A')
  })

  it('both windows changed the same text: the stored text stays, the held text goes to a recovery note', async () => {
    const { a, b, page, text } = await setup()
    b.setTextDoc(page.id, text.id, docFromPlainText('Body edited in B'))
    await b.flush()

    const result = await reclaim(a, b)
    expect(result.recovered).toHaveLength(1)
    expect(await bodyOf(a, page.id, text.id)).toBe('Body edited in B')
    const recovery = a.getState().data.pages[result.recoveryPageId!]
    expect(recovery).toMatchObject({ location: { kind: 'inbox' }, trashedAt: null, title: expect.stringMatching(/^Recovered changes/) })
    const recoveredText = Object.values(await a.ensurePageObjects(recovery.id))
      .map((o) => (o.type === 'text' ? docToPlainText(o.doc) : ''))
      .join('\n')
    expect(recoveredText).toContain('Body edited in A')
    expect(recoveredText).toContain('Original title')

    const restored = await backupRoundTrip(a)
    expect(restored.getState().data.pages[recovery.id]).toBeDefined()
  })

  it('an edit to a page deleted elsewhere is recovered, not resurrected', async () => {
    const { a, b, page } = await setup()
    b.trashPage(page.id)
    await b.deletePageForever(page.id)
    await b.flush()

    const result = await reclaim(a, b)
    expect(a.getState().data.pages[page.id]).toBeUndefined()
    expect(await a.repository.loadPageObjects(page.id)).toEqual([])
    expect(result.recovered).toHaveLength(1)
    const objects = Object.values(await a.ensurePageObjects(result.recoveryPageId!))
    expect(objects.map((o) => (o.type === 'text' ? docToPlainText(o.doc) : '')).join('\n')).toContain('Body edited in A')
    await backupRoundTrip(a)
  })

  it('a held rename that conflicts keeps the other title and records this one', async () => {
    const { a, b, page, text } = await setup({ staleEdits: (a, pageId) => a.renamePage(pageId, 'Title from A') })
    b.renamePage(page.id, 'Title from B')
    await b.flush()

    const result = await reclaim(a, b)
    expect(a.getState().data.pages[page.id].title).toBe('Title from B')
    expect(result.recovered).toEqual([expect.objectContaining({ type: 'note', detail: expect.stringContaining('Title from A') })])
    // The non-conflicting body edit was still applied.
    expect(await bodyOf(a, page.id, text.id)).toBe('Body edited in A')
    await backupRoundTrip(a)
  })

  it('a held rename with no conflict is applied without touching newer content', async () => {
    const { a, b, page, text } = await setup({ staleEdits: (a, pageId) => a.renamePage(pageId, 'Title from A') })
    b.addObjects(page.id, [{ ...text, id: newId(), y: 200, doc: docFromPlainText('Added in B') }])
    await b.flush()

    const result = await reclaim(a, b)
    expect(result.recovered).toEqual([])
    expect(a.getState().data.pages[page.id].title).toBe('Title from A')
    const bodies = Object.values(await a.ensurePageObjects(page.id)).map((o) => (o.type === 'text' ? docToPlainText(o.doc) : ''))
    expect(bodies.sort()).toEqual(['Added in B', 'Body edited in A'])
    await backupRoundTrip(a)
  })

  it('a held move into a section deleted elsewhere keeps the stored location', async () => {
    const { a, b, page } = await setup({
      prepare: (a) => a.createNotebook('Temporary').section.id,
      staleEdits: (a, pageId, sectionId) => a.movePage(pageId, { kind: 'section', sectionId: sectionId as string }),
    })
    const sectionId = Object.values(b.getState().data.sections)[0].id
    expect(b.deleteSection(sectionId)).toBe(true)
    await b.flush()

    const result = await reclaim(a, b)
    expect(a.getState().data.pages[page.id].location).toEqual({ kind: 'inbox' })
    expect(result.recovered).toEqual([expect.objectContaining({ type: 'note', detail: expect.stringContaining('deleted section') })])
    await backupRoundTrip(a)
  })
})
