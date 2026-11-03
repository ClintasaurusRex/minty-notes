import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildArchive, readArchive, sha256Hex } from '../backup/archive'
import { BackupService } from '../backup/backupService'
import { docFromPlainText, docToPlainText, validateRichTextDoc } from '../domain/richtext'
import { DEFAULT_FILTERS, search } from '../domain/search'
import { newId, nowIso, type AttachmentMeta, type TextObject } from '../domain/types'
import { freshStore } from '../test/fixtures'
import { makeDocx, makeTechnicalPdf } from '../test/docFixtures'
import { WorkspaceStore } from '../store/workspaceStore'
import { checkDocxContainer, detectFormat, DOCX_MIME, MAX_IMPORT_BYTES, PDF_MIME, titleFromFileName } from './formats'
import { linesOf, pdfToDocs, type PdfRun } from './pdfText'

describe('import format detection and limits', () => {
  it('recognises DOCX and PDF by their bytes and refuses everything else with a reason', () => {
    expect(detectFormat('a.pdf', makeTechnicalPdf())).toEqual({ ok: true, format: 'pdf' })
    expect(detectFormat('renamed.txt', makeTechnicalPdf())).toEqual({ ok: true, format: 'pdf' }) // the name does not matter
    expect(detectFormat('a.docx', makeDocx())).toEqual({ ok: true, format: 'docx' })
    expect(detectFormat('old.doc', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toMatchObject({ ok: false, reason: expect.stringMatching(/older Word \(\.doc\)/) })
    expect(detectFormat('a.rtf', strToU8('{\\rtf1 hello}'))).toMatchObject({ ok: false, reason: expect.stringMatching(/RTF/) })
    expect(detectFormat('empty.pdf', new Uint8Array())).toMatchObject({ ok: false, reason: expect.stringMatching(/empty/) })
    expect(detectFormat('notes.txt', strToU8('just text'))).toMatchObject({ ok: false, reason: expect.stringMatching(/not a \.docx or PDF/) })
    const huge = new Uint8Array(MAX_IMPORT_BYTES + 1)
    huge.set(strToU8('%PDF-1.4'))
    expect(detectFormat('huge.pdf', huge)).toMatchObject({ ok: false, reason: expect.stringMatching(/import limit is 50 MB/) })
    expect(titleFromFileName('Pump_spec v2.docx')).toBe('Pump spec v2')
  })

  it('checks a DOCX container without unpacking it (ZIP bombs, wrong ZIPs, macros, damage)', async () => {
    expect(await checkDocxContainer('a.docx', makeDocx())).toEqual({ ok: true, macros: false })
    expect(await checkDocxContainer('m.docx', makeDocx({ withMacros: true }))).toEqual({ ok: true, macros: true })
    expect(await checkDocxContainer('photos.zip', zipSync({ 'a.txt': strToU8('x') }))).toMatchObject({ ok: false, reason: expect.stringMatching(/not a Word document/) })
    expect(await checkDocxContainer('bad.docx', new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9]))).toMatchObject({ ok: false, reason: expect.stringMatching(/not a readable/) })
    // A declared unpacked size far beyond the limit (ZIP bomb) is refused before anything is unpacked.
    const files = unzipSync(makeDocx())
    const zipped = zipSync(files)
    const view = new DataView(zipped.buffer, zipped.byteOffset, zipped.byteLength)
    for (let i = 0; i < zipped.byteLength - 4; i++) {
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 0x7fffffff, true) // central directory: uncompressed size
    }
    expect(await checkDocxContainer('bomb.docx', zipped)).toMatchObject({ ok: false })
  })
})

const run = (str: string, x: number, y: number, size = 11, width = str.length * size * 0.5): PdfRun => ({ str, x, y, size, width })

describe('PDF text → editable draft', () => {
  it('rebuilds lines, paragraphs, headings, hyphenation, and bullets from positioned text', () => {
    const runs = [
      run('Lift Station 7', 72, 720, 22),
      run('The duty pump starts when the', 72, 680),
      run('level rises. Alter-', 72, 666),
      run('nating balances hours.', 72, 652),
      run('Second', 72, 600),
      run('paragraph', 112, 600),
      run('- First check', 72, 560),
      run('- Second check that', 72, 544),
      run('wraps to two lines', 84, 530),
    ]
    expect(linesOf(runs.slice(4, 6)).map((l) => l.text)).toEqual(['Second paragraph'])
    const draft = pdfToDocs([{ number: 1, runs }, { number: 2, runs: [] }], 1_000_000)
    expect(draft.emptyPages).toEqual([2])
    expect(draft.pages).toHaveLength(1)
    const doc = draft.pages[0].doc
    expect(validateRichTextDoc(doc)).toBeNull()
    const types = doc.content!.map((n) => n.type)
    expect(types).toEqual(['paragraph', 'heading', 'paragraph', 'paragraph', 'bulletList'])
    expect(docToPlainText(doc)).toContain('The duty pump starts when the level rises. Alternating balances hours.')
    expect(doc.content![4].content).toHaveLength(2)
    expect(docToPlainText(doc)).toContain('Second check that wraps to two lines')
    expect(docToPlainText({ type: 'doc', content: [doc.content![0]] })).toBe('Page 1')
  })

  it('strips control characters and stops at the text limit', () => {
    const draft = pdfToDocs([{ number: 1, runs: [run('Bad\u0000chars\u0007 here', 72, 700)] }, { number: 2, runs: [run('More', 72, 700)] }], 5)
    expect(docToPlainText(draft.pages[0].doc)).toContain('Badchars here')
    expect(draft.truncated).toBe(true)
    expect(draft.pages).toHaveLength(1)
  })
})

async function importedPage(store: WorkspaceStore, location: Parameters<WorkspaceStore['createImportedPage']>[0] = { kind: 'inbox' }) {
  const bytes = makeTechnicalPdf()
  const original: AttachmentMeta = { id: newId(), fileName: 'Lift station 7 narrative.pdf', mimeType: PDF_MIME, size: bytes.byteLength, sha256: await sha256Hex(bytes), width: null, height: null, source: 'import', createdAt: nowIso() }
  const page = await store.createImportedPage(location, {
    title: 'Lift station 7 narrative',
    importedFrom: { attachmentId: original.id, fileName: original.fileName, format: 'pdf', notes: ['Page 3 has no selectable text.'] },
    files: [{ meta: original, blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: PDF_MIME }) }],
    objects: [{ type: 'text', x: 48, y: 48, w: 860, h: 200, doc: docFromPlainText('The duty pump starts on high level.') }],
  })
  return { page, original, bytes }
}

describe('imported drafts in the workspace', () => {
  it('keep the original unchanged through reload, project copy, and backup → clean restore', async () => {
    const { store, repo } = await freshStore()
    const { page, original, bytes } = await importedPage(store)
    expect(page.importedFrom).toMatchObject({ attachmentId: original.id, format: 'pdf', fileName: original.fileName })
    await store.flush()

    const again = new WorkspaceStore(repo, { debounceMs: 5, maxWaitMs: 20 })
    await again.load()
    expect(again.getState().data.pages[page.id].importedFrom).toEqual(page.importedFrom)
    const text = Object.values(await again.ensurePageObjects(page.id))[0] as TextObject
    expect(docToPlainText(text.doc)).toContain('duty pump')

    // Search finds the draft by the original file name.
    const texts = await store.loadSearchTexts()
    expect(search('narrative.pdf', DEFAULT_FILTERS, { ...store.getState().data }, texts).some((r) => r.pageId === page.id)).toBe(true)

    // A project copy keeps the link to the same original file.
    const project = store.createProject({ name: 'Lift station 7' })
    const { section } = store.createNotebook('Narratives')
    store.movePage(page.id, { kind: 'section', sectionId: section.id })
    const copy = await store.makeProjectCopy(project.id, page.id)
    expect(copy.importedFrom?.attachmentId).toBe(original.id)
    await store.flush()

    const { bytes: zip } = await new BackupService(store, { appVersion: 'test', folderSupported: false }).createArchive()
    expect(Object.keys(unzipSync(zip)).some((p) => p === `attachments/${original.id}.pdf`)).toBe(true)
    const validated = await readArchive(zip)
    if (!validated.ok) throw new Error(validated.errors.join('; '))
    expect(validated.warnings.join(' ')).not.toMatch(/not placed on any page/)
    const clean = await freshStore()
    await clean.store.becomeEditor()
    await new BackupService(clean.store, { appVersion: 'test', folderSupported: false }).restore(validated)
    expect(clean.store.getState().data.pages[page.id].importedFrom).toEqual(page.importedFrom)
    const blob = await clean.store.getBlob(original.id)
    expect(await sha256Hex(new Uint8Array(await blob!.arrayBuffer()))).toBe(await sha256Hex(bytes))
  })

  it('refuses a draft without its original, and restore refuses broken import details', async () => {
    const { store } = await freshStore()
    await expect(store.createImportedPage({ kind: 'inbox' }, { title: 'x', importedFrom: { attachmentId: 'missing', fileName: 'x.pdf', format: 'pdf', notes: [] }, files: [], objects: [] })).rejects.toThrow(/original file is missing/)
    const { page, original } = await importedPage(store)
    await store.flush()
    const { records, blobs } = await store.repository.readAll()
    const missing = { ...records, attachments: [], pages: records.pages }
    expect(await readArchive(await buildArchive(missing, new Map(), 'test'))).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringMatching(/original file of imported page/)]) })
    const badFormat = { ...records, pages: records.pages.map((p) => (p.id === page.id ? { ...p, importedFrom: { ...p.importedFrom!, format: 'exe' } } : p)) }
    expect(await readArchive(await buildArchive(badFormat as typeof records, blobs, 'test'))).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringMatching(/invalid import details/)]) })
    expect(original.mimeType).toBe(PDF_MIME)
    expect(DOCX_MIME).toContain('wordprocessingml')
  })

  it('a format-3 backup (before imports existed) still restores into format 4', async () => {
    const { store } = await freshStore()
    const page = store.createPage({ kind: 'inbox' }, 'Before Stage 4')
    const at = nowIso()
    store.addObjects(page.id, [{ id: newId(), pageId: page.id, type: 'text', x: 48, y: 48, w: 400, h: 40, z: 1, doc: docFromPlainText('Stage 3 note'), createdAt: at, updatedAt: at }])
    await store.flush()
    const { records, blobs } = await store.repository.readAll()
    const zip = unzipSync(await buildArchive({ ...records, workspace: { ...records.workspace, formatVersion: 3 } }, blobs, '0.3.0'))
    const manifest = JSON.parse(new TextDecoder().decode(zip['manifest.json'])) as { formatVersion: number; app: { version: string } }
    manifest.formatVersion = 3
    manifest.app.version = '0.3.0'
    zip['manifest.json'] = strToU8(JSON.stringify(manifest))
    const validated = await readArchive(zipSync(zip))
    if (!validated.ok) throw new Error(validated.errors.join('; '))
    expect(validated.summary.formatVersion).toBe(3)
    expect(validated.records.workspace.formatVersion).toBe(4)
    expect(validated.records.pages[0].importedFrom).toBeUndefined()
  })
})
