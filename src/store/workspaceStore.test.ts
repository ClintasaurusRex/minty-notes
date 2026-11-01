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
    vi.spyOn(repo, 'commit').mockImplementation(async (changes, at) => {
      if (fail) {
        fail = false
        throw new Error('disk error')
      }
      return original(changes, at)
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
