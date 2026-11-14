import { describe, expect, it } from 'vitest'
import { buildArchive, readArchive, sha256Hex } from '../backup/archive'
import { BackupService } from '../backup/backupService'
import {
  dragHandle,
  emptyMarkup,
  hasMarkup,
  markupText,
  MAX_PEN_VALUES,
  moveItem,
  resizeBy,
  simplifyPoints,
  sizeAfterCrop,
  storedCrop,
  validateMarkup,
  visibleRect,
} from '../domain/markup'
import { search, DEFAULT_FILTERS } from '../domain/search'
import { newId, nowIso, type Annotation, type ImageObject, type Markup, type SketchObject } from '../domain/types'
import { IdbRepository } from '../storage/repository'
import { freshStore, PNG_1x1 } from '../test/fixtures'
import { WorkspaceStore } from './workspaceStore'

/** A screenshot markup with one of every annotation kind and a crop. */
function screenshotMarkup(): Markup {
  return {
    width: 1920,
    height: 1080,
    crop: { x: 100, y: 50, w: 1600, h: 900 },
    items: [
      { id: 'a1', kind: 'redact', x: 1200, y: 80, w: 300, h: 40 },
      { id: 'a2', kind: 'blur', x: 200, y: 600, w: 400, h: 120 },
      { id: 'a3', kind: 'arrow', x1: 300, y1: 300, x2: 640, y2: 420, color: '#ef4444', width: 6 },
      { id: 'a4', kind: 'line', x1: 100, y1: 900, x2: 900, y2: 900, color: '#60a5fa', width: 4 },
      { id: 'a5', kind: 'rect', x: 640, y: 400, w: 260, h: 120, color: '#ef4444', width: 6, fill: null },
      { id: 'a6', kind: 'ellipse', x: 1000, y: 500, w: 200, h: 140, color: '#f59e0b', width: 6, fill: null },
      { id: 'a7', kind: 'text', x: 660, y: 330, text: 'PLC fault bit\nchecks here', color: '#ffffff', size: 36, background: '#111111' },
      { id: 'a8', kind: 'pen', points: [100, 100, 120, 130, 150, 140], color: '#6ee7b7', width: 6 },
      { id: 'a9', kind: 'highlighter', points: [400, 200, 800, 200], color: '#facc15', width: 24 },
    ],
  }
}

async function screenshotPage() {
  const { store, repo } = await freshStore()
  const page = store.createPage({ kind: 'inbox' }, 'VTScada alarm screen')
  const at = nowIso()
  const attachmentId = newId()
  const sha = await sha256Hex(PNG_1x1)
  await store.addAttachment({ id: attachmentId, fileName: 'hmi.png', mimeType: 'image/png', size: PNG_1x1.byteLength, sha256: sha, width: 1920, height: 1080, source: 'paste', createdAt: at }, new Blob([PNG_1x1], { type: 'image/png' }))
  const image: ImageObject = { id: newId(), pageId: page.id, type: 'image', attachmentId, alt: '', x: 48, y: 48, w: 960, h: 540, z: 1, createdAt: at, updatedAt: at }
  const sketch: SketchObject = { id: newId(), pageId: page.id, type: 'sketch', x: 48, y: 640, w: 600, h: 400, z: 2, markup: { ...emptyMarkup(600, 400), items: [{ id: 's1', kind: 'line', x1: 20, y1: 20, x2: 580, y2: 20, color: '#6ee7b7', width: 3 }, { id: 's2', kind: 'text', x: 30, y: 40, text: 'X2:14 → K1', color: '#ffffff', size: 20, background: null }] }, createdAt: at, updatedAt: at }
  store.addObjects(page.id, [image, sketch])
  await store.flush()
  return { store, repo, page, image, sketch, attachmentId, sha }
}

async function restoredCopy(store: WorkspaceStore) {
  const { bytes } = await new BackupService(store, { appVersion: 'test', folderSupported: false }).createArchive()
  const validated = await readArchive(bytes)
  if (!validated.ok) throw new Error(validated.errors.join('; '))
  const clean = await freshStore()
  await clean.store.becomeEditor()
  await new BackupService(clean.store, { appVersion: 'test', folderSupported: false }).restore(validated)
  return { restored: clean.store, validated }
}

describe('markup rules', () => {
  it('validates every annotation kind and rejects damaged markup', () => {
    expect(validateMarkup(screenshotMarkup(), true)).toBeNull()
    const bad = (patch: (m: Markup) => unknown) => validateMarkup(patch(structuredClone(screenshotMarkup())), true)
    expect(bad((m) => ({ ...m, crop: { x: 1800, y: 0, w: 500, h: 100 } }))).toMatch(/crop/)
    expect(bad((m) => ({ ...m, items: [...m.items, { ...m.items[2] }] }))).toMatch(/duplicate/)
    expect(bad((m) => ({ ...m, items: [{ id: 'z', kind: 'arrow', x1: NaN, y1: 0, x2: 1, y2: 1, color: '#ef4444', width: 2 }] }))).toMatch(/arrow/)
    expect(bad((m) => ({ ...m, items: [{ id: 'z', kind: 'rect', x: 0, y: 0, w: 5, h: 5, color: 'red', width: 2, fill: null }] }))).toMatch(/rect/)
    expect(bad((m) => ({ ...m, items: [{ id: 'z', kind: 'script', x: 0 }] }))).toMatch(/unknown kind/)
    expect(bad((m) => ({ ...m, items: [{ id: 'z', kind: 'pen', points: new Array(MAX_PEN_VALUES + 2).fill(1), color: '#ffffff', width: 2 }] }))).toMatch(/pen/)
    expect(bad((m) => ({ ...m, width: 0 }))).toMatch(/size/)
    // Sketches are never cropped.
    expect(validateMarkup({ ...emptyMarkup(600, 400), crop: { x: 0, y: 0, w: 10, h: 10 } }, false)).toMatch(/sketch/)
    expect(markupText(screenshotMarkup())).toBe('PLC fault bit\nchecks here')
  })

  it('moves, resizes, crops, and simplifies in markup coordinates', () => {
    const rect: Annotation = { id: 'r', kind: 'rect', x: 10, y: 10, w: 100, h: 50, color: '#ef4444', width: 2, fill: null }
    expect(dragHandle(rect, 'nw', 50, 0)).toMatchObject({ x: 50, y: 0, w: 60, h: 60 }) // opposite corner (110, 60) fixed
    expect(dragHandle(rect, 'se', 0, 0)).toMatchObject({ x: 0, y: 0, w: 10, h: 10 }) // dragged past the other corner
    expect(moveItem(rect, 5, -5)).toMatchObject({ x: 15, y: 5 })
    expect(resizeBy(rect, 10, -100)).toMatchObject({ w: 110, h: 1 })
    const arrow: Annotation = { id: 'a', kind: 'arrow', x1: 0, y1: 0, x2: 10, y2: 10, color: '#ef4444', width: 2 }
    expect(dragHandle(arrow, 'end', 40, 50)).toMatchObject({ x1: 0, y1: 0, x2: 40, y2: 50 })
    expect(simplifyPoints([0, 0, 0.2, 0.2, 0.4, 0.4, 10, 10, 10.1, 10.1, 20, 20], 1)).toEqual([0, 0, 10, 10, 20, 20])
    // Cropping keeps the display scale (0.5 page px per image px) and stays on the page.
    expect(sizeAfterCrop({ x: 48, w: 960, h: 540 }, { x: 0, y: 0, w: 1920, h: 1080 }, { x: 100, y: 50, w: 1600, h: 900 }, 1200)).toEqual({ x: 48, w: 800, h: 450 })
    expect(sizeAfterCrop({ x: 600, w: 960, h: 540 }, { x: 0, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 1920, h: 1080 }, 1200)).toEqual({ x: 240, w: 960, h: 540 })
    expect(storedCrop({ x: 0, y: 0, w: 1920, h: 1080 }, 1920, 1080)).toBeNull()
    expect(storedCrop({ x: -20, y: 10, w: 5000, h: 100 }, 1920, 1080)).toEqual({ x: 0, y: 10, w: 1920, h: 100 })
    expect(visibleRect(screenshotMarkup())).toEqual({ x: 100, y: 50, w: 1600, h: 900 })
    expect(hasMarkup(emptyMarkup(10, 10))).toBe(false)
  })
})

describe('marked-up screenshots and sketches', () => {
  it('persist across reload and backup → clean restore; the original image bytes never change', async () => {
    const { store, repo, page, image, sketch, attachmentId, sha } = await screenshotPage()
    store.updateObjects(page.id, [{ id: image.id, patch: { markup: screenshotMarkup(), w: 800, h: 450 } }], 'Mark up image')
    await store.flush()
    // Undo removes the markup as one step; redo brings it back.
    store.undo(page.id)
    expect((store.getObject(page.id, image.id) as ImageObject).markup).toBeUndefined()
    store.redo(page.id)
    await store.flush()

    const again = new WorkspaceStore(repo, { debounceMs: 5, maxWaitMs: 20 })
    await again.load()
    const objects = await again.ensurePageObjects(page.id)
    expect((objects[image.id] as ImageObject).markup).toEqual(screenshotMarkup())
    expect((objects[sketch.id] as SketchObject).markup).toEqual(sketch.markup)

    const { restored, validated } = await restoredCopy(store)
    const back = await restored.ensurePageObjects(page.id)
    expect((back[image.id] as ImageObject).markup).toEqual(screenshotMarkup())
    expect(back[image.id]).toMatchObject({ w: 800, h: 450, attachmentId })
    expect((back[sketch.id] as SketchObject).markup).toEqual(sketch.markup)
    // The original screenshot is stored unchanged (the backup holds it too).
    const blob = await restored.getBlob(attachmentId)
    expect(await sha256Hex(new Uint8Array(await blob!.arrayBuffer()))).toBe(sha)
    expect(validated.records.attachments[0].sha256).toBe(sha)
  })

  it('labels are searchable; templates and project copies keep markup and sketches', async () => {
    const { store, page, image } = await screenshotPage()
    store.updateObjects(page.id, [{ id: image.id, patch: { markup: screenshotMarkup() } }], 'Mark up image')
    const texts = await store.loadSearchTexts()
    const { data } = store.getState()
    const hits = search('fault bit', DEFAULT_FILTERS, data, texts)
    expect(hits.map((h) => h.pageId)).toContain(page.id)
    expect(search('K1', DEFAULT_FILTERS, data, texts).map((h) => h.pageId)).toContain(page.id)

    const template = await store.createTemplateFromPage(page.id, 'HMI markup')
    const made = store.createPageFromTemplate(template.id, { kind: 'inbox' })
    const objs = Object.values(await store.ensurePageObjects(made.id))
    expect(objs.find((o) => o.type === 'image')).toMatchObject({ markup: screenshotMarkup() })
    expect(objs.find((o) => o.type === 'sketch')).toBeTruthy()
    const project = store.createProject({ name: 'Lift station' })
    store.movePage(page.id, { kind: 'section', sectionId: store.createNotebook('Ref').section.id })
    const copy = await store.makeProjectCopy(project.id, page.id)
    const copied = Object.values(await store.ensurePageObjects(copy.id))
    expect(copied.find((o) => o.type === 'image')).toMatchObject({ markup: screenshotMarkup() })
    await store.flush()
    await restoredCopy(store)
  })

  it('restore refuses damaged markup or sketches without changing anything', async () => {
    const { store, image } = await screenshotPage()
    const { records, blobs } = await store.repository.readAll()
    const bad = { ...records, objects: records.objects.map((o) => (o.id === image.id ? { ...o, markup: { ...screenshotMarkup(), items: [{ id: 'x', kind: 'text', x: 0, y: 0, text: 'x'.repeat(5000), color: '#ffffff', size: 10, background: null }] } } : o)) }
    expect(await readArchive(await buildArchive(bad as typeof records, blobs, 'test'))).toMatchObject({ ok: false, errors: [expect.stringMatching(/Markup on image .* label/)] })
    const badSketch = { ...records, objects: records.objects.map((o) => (o.type === 'sketch' ? { ...o, markup: { ...o.markup, crop: { x: 0, y: 0, w: 5, h: 5 } } } : o)) }
    expect(await readArchive(await buildArchive(badSketch, blobs, 'test'))).toMatchObject({ ok: false, errors: [expect.stringMatching(/Sketch .* cropped/)] })
  })

  it('a held markup edit that conflicts with the other window is recovered, not lost', async () => {
    const { store: a, repo, page, image } = await screenshotPage()
    await a.becomeEditor()
    await a.ensurePageObjects(page.id)
    const b = new WorkspaceStore(repo as IdbRepository, { debounceMs: 5, maxWaitMs: 20, retryDelaysMs: [10] })
    await b.becomeEditor()
    await b.ensurePageObjects(page.id)
    // A (frozen) adds its markup; its save is refused, so it is held.
    a.updateObjects(page.id, [{ id: image.id, patch: { markup: screenshotMarkup() } }], 'Mark up image')
    expect(await a.flush()).toBe(false)
    // B marks the same image differently.
    const bMarkup: Markup = { ...emptyMarkup(1920, 1080), items: [{ id: 'b1', kind: 'redact', x: 0, y: 0, w: 100, h: 100 }] }
    b.updateObjects(page.id, [{ id: image.id, patch: { markup: bMarkup } }], 'Mark up image')
    await b.flush()
    expect(await b.releaseOwnership()).toEqual({ ok: true })
    const result = await a.becomeEditor()
    expect(result?.recovered.length).toBeGreaterThan(0)
    const kept = (await a.ensurePageObjects(page.id))[image.id] as ImageObject
    expect(kept.markup).toEqual(bMarkup)
    const recoveredPage = Object.values(a.getState().data.pages).find((p) => p.title.startsWith('Recovered changes'))!
    const recoveredObjects = Object.values(await a.ensurePageObjects(recoveredPage.id))
    expect(recoveredObjects.find((o) => o.type === 'image')).toMatchObject({ attachmentId: image.attachmentId, markup: screenshotMarkup() })
    await restoredCopy(a)
  })
})
