import { describe, expect, it } from 'vitest'
import { buildArchive, readArchive } from '../backup/archive'
import { BackupService } from '../backup/backupService'
import { pageLinkIds, pageLinkState } from '../domain/pageLink'
import { docToPlainText, MAX_CELL_SPAN, validateRichTextDoc } from '../domain/richtext'
import { newId, nowIso, type RichTextDoc, type TextObject } from '../domain/types'
import { IdbRepository } from '../storage/repository'
import { freshStore } from '../test/fixtures'
import { technicalDoc } from '../test/richDocs'
import { WorkspaceStore } from './workspaceStore'

function textBox(pageId: string, doc: RichTextDoc, y = 48): TextObject {
  const at = nowIso()
  return { id: newId(), pageId, type: 'text', x: 48, y, w: 640, h: 200, z: 1, doc, createdAt: at, updatedAt: at }
}

async function reload(repo: IdbRepository) {
  const store = new WorkspaceStore(repo, { debounceMs: 5, maxWaitMs: 20 })
  await store.load()
  return store
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

/** Library page "Commissioning steps" and a project note whose table/code/link note points at it. */
async function linkedNotes() {
  const { store, repo } = await freshStore()
  const { section } = store.createNotebook('VTScada reference')
  const target = store.createPage({ kind: 'section', sectionId: section.id }, 'Commissioning steps')
  const project = store.createProject({ name: 'North pump station' })
  const note = store.createPage({ kind: 'project', projectId: project.id }, 'Pump I/O')
  const box = textBox(note.id, technicalDoc(target.id))
  store.addObjects(note.id, [box])
  await store.flush()
  return { store, repo, section, target, project, note, box }
}

describe('rich text schema (format 4)', () => {
  it('accepts tables, code blocks, inline code, and page links', () => {
    const doc = technicalDoc('page-1')
    expect(validateRichTextDoc(doc)).toBeNull()
    expect(pageLinkIds(doc)).toEqual(['page-1'])
    const text = docToPlainText(doc)
    expect(text).toContain('Local:1:I.Data.0')
    expect(text).toContain('Pump_OK := 1;')
    expect(text).toContain('commissioning steps')
  })

  it('rejects malformed table spans, page links without a target, and links without an address', () => {
    const withCell = (attrs: Record<string, unknown>): RichTextDoc => ({
      type: 'doc',
      content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs, content: [{ type: 'paragraph' }] }] }] }],
    })
    expect(validateRichTextDoc(withCell({ colspan: 1, rowspan: 1 }))).toBeNull()
    expect(validateRichTextDoc(withCell({ colspan: 99999 }))).toMatch(/column span/)
    expect(validateRichTextDoc(withCell({ colspan: MAX_CELL_SPAN + 1 }))).toMatch(/column span/)
    expect(validateRichTextDoc(withCell({ rowspan: 'abc' }))).toMatch(/row span/)
    expect(validateRichTextDoc(withCell({ colwidth: [null] }))).toMatch(/column widths/)
    const marked = (mark: { type: string; attrs?: Record<string, unknown> }): RichTextDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [mark] }] }] })
    expect(validateRichTextDoc(marked({ type: 'pageLink', attrs: { pageId: 'abc' } }))).toBeNull()
    expect(validateRichTextDoc(marked({ type: 'pageLink', attrs: { pageId: '' } }))).toMatch(/page link/)
    expect(validateRichTextDoc(marked({ type: 'pageLink', attrs: {} }))).toMatch(/page link/)
    expect(validateRichTextDoc(marked({ type: 'link', attrs: {} }))).toMatch(/address/)
    // A table row outside a table is not valid content.
    expect(validateRichTextDoc({ type: 'doc', content: [{ type: 'tableRow', content: [] }] } as RichTextDoc)).not.toBeNull()
  })
})

describe('tables, code, and internal page links in notes', () => {
  it('persist across reload, project copies, templates, and a full backup → clean restore', async () => {
    const { store, repo, target, project, note, box } = await linkedNotes()
    const again = await reload(repo)
    const saved = (await again.ensurePageObjects(note.id))[box.id] as TextObject
    expect(saved.doc).toEqual(technicalDoc(target.id))

    // A project copy and a note template keep the table, code, and the link (by ID).
    const copy = await store.makeProjectCopy(project.id, note.id)
    const copied = Object.values(await store.ensurePageObjects(copy.id))[0] as TextObject
    expect(pageLinkIds(copied.doc)).toEqual([target.id])
    const template = await store.createTemplateFromPage(note.id, 'I/O list')
    const fromTemplate = store.createPageFromTemplate(template.id, { kind: 'inbox' })
    const made = Object.values(await store.ensurePageObjects(fromTemplate.id))[0] as TextObject
    expect(docToPlainText(made.doc)).toBe(docToPlainText(saved.doc))
    await store.flush()

    const { restored, validated } = await backupRestores(store)
    expect(validated.warnings.join(' ')).not.toMatch(/deleted forever/)
    expect(((await restored.ensurePageObjects(note.id))[box.id] as TextObject).doc).toEqual(technicalDoc(target.id))
    expect(pageLinkState(target.id, restored.getState().data.pages)).toEqual({ state: 'ok', title: 'Commissioning steps' })
  })

  it('a link follows its page through move, rename, Trash, restore, and delete forever', async () => {
    const { store, target, note, box } = await linkedNotes()
    const pages = () => store.getState().data.pages
    expect(await store.pagesLinkingTo(target.id)).toEqual([expect.objectContaining({ id: note.id })])

    store.movePage(target.id, { kind: 'standalone' })
    store.renamePage(target.id, 'Commissioning steps v2')
    expect(pageLinkState(target.id, pages())).toEqual({ state: 'ok', title: 'Commissioning steps v2' })

    store.trashPage(target.id)
    expect(pageLinkState(target.id, pages()).state).toBe('trashed')
    store.restorePage(target.id)
    expect(pageLinkState(target.id, pages()).state).toBe('ok')

    store.trashPage(target.id)
    await store.deletePageForever(target.id)
    expect(pageLinkState(target.id, pages()).state).toBe('missing')
    // The linking note keeps its text and the link (shown as a deleted-page link).
    const kept = store.getObject(note.id, box.id) as TextObject
    expect(kept.doc).toEqual(technicalDoc(target.id))
    await store.flush()

    // A backup with a link to a deleted page still restores, with a warning.
    const { restored, validated } = await backupRestores(store)
    expect(validated.warnings.join(' ')).toMatch(/1 note links to a page that was deleted forever/)
    expect(((await restored.ensurePageObjects(note.id))[box.id] as TextObject).doc).toEqual(technicalDoc(target.id))
  })

  it('lists linking pages from unsaved edits and ignores trashed ones', async () => {
    const { store, target, note } = await linkedNotes()
    const other = store.createPage({ kind: 'inbox' }, 'Unsaved link')
    store.addObjects(other.id, [textBox(other.id, technicalDoc(target.id))])
    expect((await store.pagesLinkingTo(target.id)).map((p) => p.title)).toEqual(['Pump I/O', 'Unsaved link'])
    store.trashPage(note.id)
    expect((await store.pagesLinkingTo(target.id)).map((p) => p.title)).toEqual(['Unsaved link'])
  })

  it('restore refuses a backup whose table span would make the table map huge', async () => {
    const { store, note, box } = await linkedNotes()
    const { records, blobs } = await store.repository.readAll()
    const doc = structuredClone(technicalDoc('x'))
    ;(doc.content![1].content![0].content![0].attrs as Record<string, unknown>).colspan = 1_000_000
    const bad = { ...records, objects: records.objects.map((o) => (o.id === box.id ? { ...o, doc } : o)) }
    const result = await readArchive(await buildArchive(bad, blobs, 'test'))
    expect(result).toMatchObject({ ok: false, errors: [expect.stringMatching(/column span/)] })
    expect(note.id).toBeTruthy()
  })
})
