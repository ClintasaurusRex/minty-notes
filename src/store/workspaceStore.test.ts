import { describe, expect, it, vi } from 'vitest'
import { emptyDoc, docFromPlainText } from '../domain/richtext'
import { newId, nowIso, type ImageObject, type TextObject } from '../domain/types'
import { IdbRepository } from '../storage/repository'
import { freshStore } from '../test/fixtures'
import { WorkspaceStore } from './workspaceStore'

function textObject(pageId: string, x = 40, y = 40): TextObject {
  const at = nowIso()
  return { id: newId(), pageId, type: 'text', x, y, w: 400, h: 60, z: 1, doc: emptyDoc(), createdAt: at, updatedAt: at }
}

async function reopen(store: WorkspaceStore) {
  // A second store over the same database simulates a page reload.
  const repo = store.repository as IdbRepository
  const fresh = new WorkspaceStore(repo)
  await fresh.load()
  return fresh
}

describe('workspace store persistence', () => {
  it('saves an Inbox note with text and layout, and reloads it', async () => {
    const { store } = await freshStore()
    const page = store.createPage({ kind: 'inbox' })
    expect(page.title).toMatch(/^Quick note · /)
    const obj = textObject(page.id)
    store.addObjects(page.id, [obj])
    store.setTextDoc(page.id, obj.id, docFromPlainText('Pump 3 alarm wiring'))
    store.updateObjects(page.id, [{ id: obj.id, patch: { x: 120, y: 300 } }], 'Move')
    expect(store.getState().save.status).toBe('pending')
    expect(await store.flush()).toBe(true)
    expect(store.getState().save.status).toBe('saved')

    const reloaded = await reopen(store)
    const p = reloaded.getState().data.pages[page.id]
    expect(p.location).toEqual({ kind: 'inbox' })
    const objects = await reloaded.ensurePageObjects(page.id)
    expect(objects[obj.id]).toMatchObject({ x: 120, y: 300, w: 400 })
    expect((objects[obj.id] as TextObject).doc.content?.[0].content?.[0].text).toBe('Pump 3 alarm wiring')
  })

  it('creates notebooks with a default section and moves pages without changing their ID', async () => {
    const { store } = await freshStore()
    const { notebook, section } = store.createNotebook('VTScada')
    expect(section.notebookId).toBe(notebook.id)
    const page = store.createPage({ kind: 'inbox' })
    store.movePage(page.id, { kind: 'section', sectionId: section.id })
    await store.flush()
    const reloaded = await reopen(store)
    expect(reloaded.getState().data.pages[page.id].location).toEqual({ kind: 'section', sectionId: section.id })
    // Non-empty sections and notebooks cannot be deleted.
    expect(reloaded.deleteSection(section.id)).toBe(false)
    expect(reloaded.deleteNotebook(notebook.id)).toBe(false)
  })

  it('reports a failed write honestly, keeps the change, and retries', async () => {
    const { store, repo } = await freshStore()
    const page = store.createPage({ kind: 'standalone' })
    await store.flush()
    const spy = vi.spyOn(repo, 'commit').mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'))
    store.renamePage(page.id, 'Panel layout')
    expect(await store.flush()).toBe(false)
    const save = store.getState().save
    expect(save.status).toBe('error')
    expect(save.error).toMatch(/run out of storage/)
    // Nothing claims success while the change is unsaved.
    expect(store.hasUnsavedChanges).toBe(true)
    // The automatic retry succeeds once storage works again.
    await vi.waitFor(() => expect(store.getState().save.status).toBe('saved'))
    spy.mockRestore()
    const reloaded = await reopen(store)
    expect(reloaded.getState().data.pages[page.id].title).toBe('Panel layout')
  })

  it('keeps a newer edit when an older failed batch is retried', async () => {
    const { store, repo } = await freshStore()
    const page = store.createPage({ kind: 'standalone' })
    await store.flush()
    let fail = true
    const original = repo.commit.bind(repo)
    vi.spyOn(repo, 'commit').mockImplementation(async (changes, at, token) => {
      if (fail) {
        fail = false
        throw new Error('disk error')
      }
      return original(changes, at, token)
    })
    store.renamePage(page.id, 'First')
    await store.flush()
    store.renamePage(page.id, 'Second')
    await vi.waitFor(() => expect(store.getState().save.status).toBe('saved'))
    const reloaded = await reopen(store)
    expect(reloaded.getState().data.pages[page.id].title).toBe('Second')
  })

  it('rejects edits in a read-only window', async () => {
    const { store } = await freshStore()
    store.setReadOnly(true)
    expect(() => store.createPage({ kind: 'inbox' })).toThrow(/read-only/)
  })

  it('trashes and restores pages; restore falls back to Inbox if the section is gone', async () => {
    const { store } = await freshStore()
    const { notebook, section } = store.createNotebook('Temp')
    const page = store.createPage({ kind: 'section', sectionId: section.id })
    store.trashPage(page.id)
    expect(store.deleteNotebook(notebook.id)).toBe(true)
    store.restorePage(page.id)
    expect(store.getState().data.pages[page.id]).toMatchObject({ trashedAt: null, location: { kind: 'inbox' } })
  })
})

describe('undo and redo', () => {
  it('undoes and redoes add, move, and delete as separate steps', async () => {
    const { store } = await freshStore()
    const page = store.createPage({ kind: 'inbox' })
    const obj = textObject(page.id)
    store.addObjects(page.id, [obj])
    store.updateObjects(page.id, [{ id: obj.id, patch: { x: 300 } }], 'Move')
    store.removeObjects(page.id, [obj.id])
    expect(store.getObject(page.id, obj.id)).toBeUndefined()

    store.undo(page.id)
    expect(store.getObject(page.id, obj.id)?.x).toBe(300)
    store.undo(page.id)
    expect(store.getObject(page.id, obj.id)?.x).toBe(40)
    store.undo(page.id)
    expect(store.getObject(page.id, obj.id)).toBeUndefined()
    expect(store.canUndo(page.id)).toBe(false)
    store.redo(page.id)
    store.redo(page.id)
    expect(store.getObject(page.id, obj.id)?.x).toBe(300)
    // Undo results are saved too.
    await store.flush()
    const reloaded = await reopen(store)
    expect((await reloaded.ensurePageObjects(page.id))[obj.id].x).toBe(300)
  })

  it('records a pointer gesture as one step', async () => {
    const { store } = await freshStore()
    const page = store.createPage({ kind: 'inbox' })
    const obj = textObject(page.id)
    store.addObjects(page.id, [obj])
    const before = store.getObject(page.id, obj.id)!
    for (let i = 1; i <= 10; i++) store.previewObject(page.id, obj.id, { x: 40 + i * 10 })
    store.commitGesture(page.id, 'Move', before)
    expect(store.getObject(page.id, obj.id)?.x).toBe(140)
    store.undo(page.id)
    expect(store.getObject(page.id, obj.id)?.x).toBe(40)
  })

  it('coalesces rapid keyboard nudges', async () => {
    const { store } = await freshStore()
    const page = store.createPage({ kind: 'inbox' })
    const obj = textObject(page.id)
    store.addObjects(page.id, [obj])
    for (let i = 1; i <= 5; i++) store.updateObjects(page.id, [{ id: obj.id, patch: { x: 40 + i } }], 'Nudge', `nudge:${obj.id}`)
    store.undo(page.id)
    expect(store.getObject(page.id, obj.id)?.x).toBe(40)
  })

  it('groups a text editing session into one step without reverting later moves', async () => {
    const { store } = await freshStore()
    const page = store.createPage({ kind: 'inbox' })
    const obj = textObject(page.id)
    store.addObjects(page.id, [obj])
    store.beginTextSession(page.id, obj.id)
    store.setTextDoc(page.id, obj.id, docFromPlainText('a'))
    store.setTextDoc(page.id, obj.id, docFromPlainText('ab'))
    // Moving while editing commits the text step first.
    const before = store.getObject(page.id, obj.id)!
    store.previewObject(page.id, obj.id, { x: 500 })
    store.commitGesture(page.id, 'Move', before)
    store.setTextDoc(page.id, obj.id, docFromPlainText('abc'))
    store.endTextSession()

    const text = () => (store.getObject(page.id, obj.id) as TextObject).doc.content?.[0].content?.[0].text
    expect(text()).toBe('abc')
    store.undo(page.id) // text after the move
    expect(text()).toBe('ab')
    expect(store.getObject(page.id, obj.id)?.x).toBe(500)
    store.undo(page.id) // the move
    expect(store.getObject(page.id, obj.id)?.x).toBe(40)
    expect(text()).toBe('ab')
    store.undo(page.id) // text before the move
    expect(text()).toBeUndefined()
    expect(store.getObject(page.id, obj.id)?.x).toBe(40)
  })

  it('keeps image bytes available for undo after deleting the image object', async () => {
    const { store } = await freshStore()
    const page = store.createPage({ kind: 'inbox' })
    const attachmentId = newId()
    await store.addAttachment(
      { id: attachmentId, fileName: 'shot.png', mimeType: 'image/png', size: 3, sha256: 'x', width: 1, height: 1, source: 'paste', createdAt: nowIso() },
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    )
    const at = nowIso()
    const img: ImageObject = { id: newId(), pageId: page.id, type: 'image', attachmentId, alt: '', x: 0, y: 0, w: 10, h: 10, z: 1, createdAt: at, updatedAt: at }
    store.addObjects(page.id, [img])
    store.removeObjects(page.id, [img.id])
    store.undo(page.id)
    expect(store.getObject(page.id, img.id)).toBeDefined()
    expect(await store.getBlob(attachmentId)).toBeInstanceOf(Blob)
  })
})

describe('editing ownership', () => {
  /** Two windows (stores) over the same database. */
  async function twoWindows() {
    const a = await freshStore()
    const b = new WorkspaceStore(a.repo, { debounceMs: 5, maxWaitMs: 20, retryDelaysMs: [10] })
    await a.store.becomeEditor()
    await b.load()
    b.revokeOwnership()
    return { a: a.store, b, repo: a.repo }
  }

  it('refuses a handover when unsaved work cannot be saved, and keeps editing', async () => {
    const { a, repo } = await twoWindows()
    const page = a.createPage({ kind: 'inbox' }, 'Before')
    await a.flush()
    const spy = vi.spyOn(repo, 'commit').mockRejectedValue(new DOMException('full', 'QuotaExceededError'))
    a.renamePage(page.id, 'Unsaved edit')
    const result = await a.releaseOwnership()
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/storage space/) })
    expect(a.getState()).toMatchObject({ owner: true, readOnly: false })
    expect(a.hasUnsavedChanges).toBe(true)
    spy.mockRestore()
    expect(await a.flush()).toBe(true)
    expect((await reopen(a)).getState().data.pages[page.id].title).toBe('Unsaved edit')
  })

  it('a successful handover saves everything first, then stops all writes', async () => {
    const { a, b, repo } = await twoWindows()
    const page = a.createPage({ kind: 'inbox' }, 'Saved before handover')
    expect(await a.releaseOwnership()).toEqual({ ok: true })
    expect(a.getState()).toMatchObject({ owner: false, readOnly: true })
    expect(() => a.renamePage(page.id, 'late')).toThrow(/read-only/)
    const commit = vi.spyOn(repo, 'commit')
    await b.becomeEditor()
    expect(b.getState().data.pages[page.id].title).toBe('Saved before handover')
    expect(commit).not.toHaveBeenCalled()
  })

  it('storage refuses stale writes from a window whose editing was taken over', async () => {
    const { a, b } = await twoWindows()
    const page = a.createPage({ kind: 'inbox' }, 'Original')
    await a.flush()
    // b takes over without a handover (a is frozen), then edits and saves.
    await b.becomeEditor()
    b.renamePage(page.id, 'Newer work in B')
    await b.flush()
    // a wakes up with a queued edit of the same page.
    a.renamePage(page.id, 'Stale edit in A')
    expect(await a.flush()).toBe(false)
    expect(a.getState()).toMatchObject({ owner: false, readOnly: true, heldChanges: 1 })
    expect((await reopen(b)).getState().data.pages[page.id].title).toBe('Newer work in B')
  })

  it('losing ownership cancels queued retries; held edits are never written', async () => {
    // Only timers are faked; fake-indexeddb runs on setImmediate.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { a, repo } = await twoWindows()
      const page = a.createPage({ kind: 'inbox' }, 'Original')
      await a.flush()
      const commit = vi.spyOn(repo, 'commit').mockRejectedValueOnce(new Error('disk error'))
      a.renamePage(page.id, 'Held edit')
      await a.flush()
      expect(a.getState().save.status).toBe('error')
      expect(vi.getTimerCount()).toBe(1) // the scheduled retry
      a.revokeOwnership() // e.g. the lock was stolen
      expect(vi.getTimerCount()).toBe(0)
      const calls = commit.mock.calls.length
      vi.runAllTimers()
      await a.flush()
      expect(commit.mock.calls.length).toBe(calls)
      expect(a.getState()).toMatchObject({ owner: false, heldChanges: 1 })
      expect((await reopen(a)).getState().data.pages[page.id].title).toBe('Original')
    } finally {
      vi.useRealTimers()
    }
  })

  it('taking editing back saves held edits on top of the latest data', async () => {
    const { a, b } = await twoWindows()
    const p1 = a.createPage({ kind: 'inbox' }, 'P1')
    const p2 = a.createPage({ kind: 'inbox' }, 'P2')
    await a.flush()
    await b.becomeEditor()
    b.renamePage(p2.id, 'P2 edited in B')
    await b.flush()
    a.renamePage(p1.id, 'P1 edited in A (held)')
    await a.flush()
    expect(a.getState().heldChanges).toBe(1)
    // a asks to edit again (b handed over).
    expect(await b.releaseOwnership()).toEqual({ ok: true })
    await a.becomeEditor()
    expect(a.getState()).toMatchObject({ owner: true, readOnly: false, heldChanges: 0 })
    expect(a.getState().data.pages[p2.id].title).toBe('P2 edited in B')
    expect(a.getState().data.pages[p1.id].title).toBe('P1 edited in A (held)')
    const stored = (await reopen(a)).getState().data.pages
    expect(stored[p1.id].title).toBe('P1 edited in A (held)')
    expect(stored[p2.id].title).toBe('P2 edited in B')
  })

  it('held edits can be discarded explicitly', async () => {
    const { a, b } = await twoWindows()
    const page = a.createPage({ kind: 'inbox' }, 'Original')
    await a.flush()
    await b.becomeEditor()
    a.renamePage(page.id, 'Held')
    await a.flush()
    await a.discardHeldChanges()
    expect(a.hasUnsavedChanges).toBe(false)
    expect(a.getState().data.pages[page.id].title).toBe('Original')
  })

  it('counts revisions per committed change', async () => {
    const { store } = await freshStore()
    const r0 = store.getState().data.revision
    store.createPage({ kind: 'inbox' })
    await store.flush()
    expect(store.getState().data.revision).toBe(r0 + 1)
  })
})
