import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { beforeAll, describe, expect, it } from 'vitest'
import { sha256Hex } from '../backup/archive'
import { FORMAT_VERSION, type CanvasObject, type Page, type Project, type Task, type TextObject } from '../domain/types'
import { checkDocxContainer } from '../import/formats'
import { DOCX_PNG, makeDocx } from '../test/docFixtures'
import { freshStore, PNG_1x1 } from '../test/fixtures'
import { readTestFile } from '../test/testFiles'
import { addImage, centralRecord, deflatedEntry, declareSize, destinationWorkspace, importOriginal, rawEntriesOf, rawZip, renameEntry, repack, sourceWorkspace, storedEntry, type SourceWorkspace } from '../test/portableFixtures'
import { imageProblem, originalProblem, sniffImageType } from './attachmentCheck'
import { isSafeHref, safeOriginalName } from './cleanRecords'
import { PACKAGE_LIMITS, type PackageManifest, type PackageRecords } from './format'
import { buildProjectExport, importProjectPackage, loadExportSnapshot } from './projectTransfer'
import { readProjectPackage } from './readPackage'
import { DEFAULT_EXPORT_OPTIONS } from './selectProject'

let src: SourceWorkspace
let good: Uint8Array

beforeAll(async () => {
  src = await sourceWorkspace()
  good = (await buildProjectExport(await loadExportSnapshot(src.store), src.project.id, DEFAULT_EXPORT_OPTIONS, 'test')).bytes
})

type Parts = { files: Record<string, Uint8Array>; manifest: PackageManifest; records: PackageRecords }
const damaged = (mutate: (parts: Parts) => void | Promise<void>, fixChecksums = true) => repack(good, mutate as never, fixChecksums)

/** The package is refused with a message matching `reason`. */
async function refused(bytes: Uint8Array, reason: RegExp): Promise<string[]> {
  const result = await readProjectPackage(bytes)
  expect(result.ok, result.ok ? 'the package was accepted' : result.errors.join(' | ')).toBe(false)
  const errors = result.ok ? [] : result.errors
  expect(errors.join(' | ')).toMatch(reason)
  return errors
}

const page = (r: PackageRecords, title: string): Page => r.pages.find((p) => p.title === title)!
const objectsOf = (r: PackageRecords, title: string): CanvasObject[] => r.objects.filter((o) => o.pageId === page(r, title).id)
/** Minimal files of each picture type (headers only: enough to be recognised, nothing is decoded). */
const bytesOf = (...parts: (string | number[])[]) => Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)))
const JPEG = bytesOf([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF', [0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9])
const GIF = bytesOf('GIF89a', [1, 0, 1, 0, 0, 0, 0, 0x3b])
const WEBP = bytesOf('RIFF', [0x1a, 0, 0, 0], 'WEBPVP8L', [0x0d, 0, 0, 0, 0x2f, 0, 0, 0, 0, 0, 0, 0, 0, 0])
const BMP = bytesOf('BM', [0x3a, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, 40, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 24, 0], new Array<number>(28).fill(0))
const AVIF = bytesOf([0, 0, 0, 0x1c], 'ftypavif', [0, 0, 0, 0], 'avifmif1miaf', [0, 0, 0, 8], 'meta')
const SVG_TEXT = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#6ee7b7"/></svg>'
const SVG = strToU8(SVG_TEXT)

const pathOf = (p: Parts, fileName: string) => p.manifest.files.find((f) => f.attachmentId === p.records.attachments.find((a) => a.fileName === fileName)!.id)!.path

describe('a repacked but unchanged package still validates (the helpers do not break it)', () => {
  it('accepts the good package and its repacked twin', async () => {
    expect((await readProjectPackage(good)).ok).toBe(true)
    expect((await readProjectPackage(await damaged(() => undefined))).ok).toBe(true)
  })
})

describe('archive structure', () => {
  it('refuses files that are not a package: other data, damaged or cut-off ZIPs, other ZIPs', async () => {
    await refused(strToU8('just some text, long enough to pass the size check'), /not a Minty Notes project package \(it is not a ZIP archive\)/)
    await refused(new Uint8Array(0), /not a ZIP archive/)
    // Cut off at the end (an incomplete download): whatever the ZIP reader makes of it, it is refused readably.
    for (const cut of [40, 1000, Math.floor(good.length / 2)]) {
      const errors = await refused(good.slice(0, good.length - cut), /list of files is damaged or was cut off/)
      // eslint-disable-next-line no-control-regex
      expect(errors.join(' ')).not.toMatch(/[\u0000-\u001f\ufffd]/)
    }
    await refused(good.slice(0, 300), /list of files is damaged or was cut off/)
    const cut = good.slice()
    cut.fill(0, 200, 4000) // file data overwritten in the middle
    await refused(cut, /list of files is damaged or was cut off|contradict each other|could not be unpacked|checksum/)
    await refused(zipSync({ 'hello.txt': strToU8('hi') }), /a file Minty Notes did not put there \("hello.txt"\)/)
    await refused(zipSync({ 'README.txt': strToU8('hi') }), /no manifest.json/)
    await refused(await damaged((p) => void (p.files['manifest.json'] = strToU8('{not json'))), /manifest.json in the package is not valid/)
    await refused(await damaged((p) => void (p.files['manifest.json'] = strToU8('[1,2]'))), /manifest.json in the package is not valid/)
    await refused(await damaged((p) => void (p.manifest.format = 'something-else' as never)), /not a Minty Notes project package/)
  })

  it('refuses unsupported versions with a clear next step', async () => {
    await refused(await damaged((p) => void (p.manifest.packageVersion = 2)), /newer version of Minty Notes \(package version 2.*Update the app/)
    await refused(await damaged((p) => void (p.manifest.formatVersion = FORMAT_VERSION + 1)), /newer version of Minty Notes.*data format 5.*Update the app/)
    await refused(await damaged((p) => void (p.manifest.formatVersion = 3)), /data format 3, which project packages never used/)
    await refused(await damaged((p) => void (p.manifest.packageVersion = 0)), /version information is invalid/)
    await refused(await damaged((p) => void (p.manifest.packageVersion = '1' as never)), /version information is invalid/)
    await refused(await damaged((p) => void delete (p.manifest as Partial<PackageManifest>).files), /manifest.json in the package is incomplete/)
    await refused(await damaged((p) => void (p.manifest.records.path = 'records.json'), false), /incomplete/)
  })

  it('refuses unsafe, unexpected, duplicate, and ambiguous entry names without unpacking them', async () => {
    const withExtra = (name: string, data = strToU8('x')) => damaged((p) => void (p.files[name] = data))
    await refused(await withExtra('../evil.txt'), /unsafe file path \("..\/evil.txt"\)/)
    await refused(await withExtra('attachments/../../evil.png'), /unsafe file path/)
    await refused(await withExtra('/etc/passwd'), /unsafe file path/)
    await refused(await withExtra('C:\\Windows\\evil.dll'), /unsafe file path/)
    await refused(await withExtra('attachments\\0001.png'), /unsafe file path/)
    await refused(await withExtra('run-me.exe'), /a file Minty Notes did not put there \("run-me.exe"\).*exactly as it was exported/)
    await refused(await withExtra('attachments/payload.html'), /did not put there/)
    await refused(await withExtra('attachments/0001.png/evil.js'), /did not put there/)
    await refused(await withExtra('__MACOSX/._project.json'), /did not put there/)
    await refused(await withExtra('Manifest.json'), /differ only by letter case|did not put there/)
    await refused(await withExtra('attachments/9999.png'), /a file its manifest does not list \(attachments\/9999.png\)/)

    // The same entry name twice (a ZIP may contain that; readers disagree about which one counts).
    const twice = renameEntry(good, 'attachments/0004.png', 'attachments/0003.png')
    const errors = await refused(twice, /more than once/)
    expect(errors.join(' ')).toMatch(/"attachments\/0003\.png" more than once/)
    await refused(renameEntry(good, 'README.txt', 'readme.TXT'), /did not put there|letter case/)
  })

  it('refuses oversized and bomb-like archives from their directory alone', async () => {
    // Declared sizes (the data is small): refused before anything is inflated.
    await refused(declareSize(good, 'project.json', PACKAGE_LIMITS.recordsBytes + 1), /project data would unpack to 128 MB, more than the 128 MB limit/)
    await refused(declareSize(good, 'manifest.json', PACKAGE_LIMITS.manifestBytes + 1), /manifest is too large/)
    // An attachment that claims to expand: a stored file is exactly as long as its data.
    await refused(declareSize(good, 'attachments/0001.pdf', 1_900_000_000), /sizes recorded for "attachments\/0001.pdf" contradict each other/)
    const compressed: Zippable = {}
    const parts = await new Promise<Parts>((resolve) => void damaged((p) => resolve(structuredClone(p))))
    for (const [name, data] of Object.entries(parts.files)) compressed[name] = [data, { level: 9 }]
    await refused(zipSync(compressed), /was repacked.*is compressed.*exactly as it was exported/)

    // A real bomb: project.json that inflates to far more than it declares. It is unpacked only into
    // the declared size and refused at the first byte beyond it (more cases: zipSafety.test.ts).
    const bomb = await damaged(async (p) => {
      p.files['project.json'] = strToU8(' '.repeat(6_000_000) + '{}')
      p.manifest.records = { path: 'project.json', size: 2000, sha256: await sha256Hex(strToU8('x')) }
    })
    await refused(declareSize(bomb, 'project.json', 2000), /"project.json" unpacks to more than the package records for it/)

    // Too many entries.
    const many: Zippable = { 'manifest.json': strToU8('{}') }
    for (let i = 0; i <= PACKAGE_LIMITS.entries; i++) many[`attachments/${i}.png`] = new Uint8Array(0)
    await refused(zipSync(many, { level: 0 }), /more than 20,000 files/)
    // A file over the size limit is refused before it is even opened as a ZIP.
    const huge = { byteLength: PACKAGE_LIMITS.fileBytes + 1 } as Uint8Array
    await refused(huge, /the largest project package Minty Notes imports is 1024 MB/)
  })

  it('refuses record counts beyond the documented limits', async () => {
    const at = '2026-11-01T00:00:00.000Z'
    await refused(await damaged((p) => void (p.records.tasks = Array.from({ length: PACKAGE_LIMITS.tasks + 1 }, () => p.records.tasks[0]))), /20,001 tasks, more than Minty Notes imports \(20,000\)/)
    await refused(await damaged((p) => void (p.records.tags = Array.from({ length: PACKAGE_LIMITS.labels + 1 }, (_, i) => ({ id: `t${i}`, name: `t${i}`, createdAt: at, updatedAt: at })))), /2,001 tags, more than/)
    await refused(await damaged((p) => void (p.records.pages = undefined as never)), /missing the pages list/)
    await refused(await damaged((p) => void (p.records.project = [] as never)), /does not contain a project/)
  })
})

describe('integrity', () => {
  it('refuses changed, missing, or swapped contents', async () => {
    // project.json edited after export (checksum not updated).
    await refused(await damaged((p) => void (p.records.project.name = 'Tampered'), false), /project.json does not match its checksum/)
    await refused(await damaged((p) => void delete p.files['project.json']), /project.json is missing/)
    // An attachment file removed, changed, truncated, or exchanged for another.
    await refused(await damaged((p) => void delete p.files[pathOf(p, 'HMI screenshot.png')]), /“HMI screenshot.png” is missing from the package/)
    await refused(await damaged((p) => void (p.files[pathOf(p, 'LS7 control narrative.pdf')] = p.files[pathOf(p, 'LS7 control narrative.pdf')].slice(0, -10))), /“LS7 control narrative.pdf” is damaged \(it does not match its checksum\)/)
    await refused(
      await damaged((p) => {
        const data = p.files[pathOf(p, 'alarm-dialog.png')].slice()
        data[data.length - 5] ^= 0xff
        p.files[pathOf(p, 'alarm-dialog.png')] = data
      }),
      /“alarm-dialog.png” is damaged/,
    )
    await refused(
      await damaged((p) => {
        const a = pathOf(p, 'alarm-dialog.png')
        const b = pathOf(p, 'HMI screenshot.png')
        ;[p.files[a], p.files[b]] = [p.files[b], p.files[a]]
      }),
      /is damaged/,
    )
    // The manifest and the file agree with each other, but not with the record's own checksum.
    await refused(
      await damaged(async (p) => {
        const path = pathOf(p, 'HMI screenshot.png')
        const other = strToU8('not the screenshot')
        p.files[path] = other
        const entry = p.manifest.files.find((f) => f.path === path)!
        entry.size = other.byteLength
        entry.sha256 = await sha256Hex(other)
      }),
      /“HMI screenshot.png” is damaged/,
    )
    // Manifest entries that do not add up.
    await refused(await damaged((p) => void p.manifest.files.pop()), /a file its manifest does not list/)
    await refused(await damaged((p) => void (p.manifest.files[1] = { ...p.manifest.files[0] })), /repeats another entry/)
    await refused(await damaged((p) => void (p.manifest.files[0].path = '../outside.png')), /File entry #1 in the manifest is invalid/)
    await refused(await damaged((p) => void (p.manifest.files[0].sha256 = 'abc')), /File entry #1 in the manifest is invalid/)
  })
})

describe('records and relationships', () => {
  it('refuses duplicate record IDs', async () => {
    await refused(await damaged((p) => void p.records.pages.push({ ...p.records.pages[0] })), /Duplicate page id/)
    await refused(await damaged((p) => void (p.records.objects[1].id = p.records.objects[0].id)), /Duplicate object id/)
    await refused(await damaged((p) => void (p.records.tasks[1].id = p.records.tasks[0].id)), /Duplicate task id/)
    await refused(await damaged((p) => void (p.records.attachments[1].id = p.records.attachments[0].id)), /Duplicate attachment id|repeats|missing|damaged/)
    // The same ID used for two kinds of record.
    await refused(await damaged((p) => void (p.records.tasks[0].id = p.records.pages[0].id)), /Duplicate task id/)
    await refused(await damaged((p) => void p.records.references.push({ ...p.records.references[0] })), /Reference #4 is listed twice/)
  })

  it('refuses broken or out-of-package relationships', async () => {
    await refused(await damaged((p) => void (p.records.tasks[0].linkedPageIds = ['no-such-page'])), /links to a missing page/)
    await refused(await damaged((p) => void (p.records.tasks[0].projectId = 'other-project')), /refers to a missing project/)
    await refused(await damaged((p) => void (p.records.objects[0].pageId = 'no-such-page')), /refers to a missing page/)
    await refused(await damaged((p) => void (page(p.records, 'Commissioning notes').location = { kind: 'project', projectId: 'other-project' })), /refers to a missing project/)
    await refused(await damaged((p) => void (page(p.records, 'Commissioning notes').location = { kind: 'inbox' })), /does not belong to the packaged project/)
    await refused(await damaged((p) => void (page(p.records, 'Commissioning notes').location = { kind: 'section', sectionId: 'x' })), /refers to a missing section/)
    await refused(await damaged((p) => void (page(p.records, 'Commissioning notes').trashedAt = '2026-11-01T00:00:00.000Z')), /marked as being in the Trash/)
    await refused(await damaged((p) => void (page(p.records, 'Commissioning notes').categoryIds = ['no-such-category'])), /refers to a missing category/)
    await refused(await damaged((p) => void (page(p.records, 'Commissioning notes').tagIds = ['no-such-tag'])), /refers to a missing tag/)
    await refused(await damaged((p) => void (page(p.records, 'Commissioning notes').copiedFrom = { pageId: 'elsewhere', title: 'x', at: '2026-11-01T00:00:00.000Z' })), /copied from a missing page/)
    await refused(await damaged((p) => void (page(p.records, 'LS7 control narrative').importedFrom!.attachmentId = 'elsewhere')), /original file of imported page “LS7 control narrative” is missing/)
    await refused(await damaged((p) => void ((objectsOf(p.records, 'Commissioning notes').find((o) => o.type === 'image') as { attachmentId: string }).attachmentId = 'elsewhere')), /refers to a missing attachment/)
    await refused(await damaged((p) => void (p.records.project.pinnedPageIds = [page(p.records, 'Commissioning notes').id])), /pins a page that is not one of the package’s reference snapshots/)
    await refused(await damaged((p) => void (p.records.project.pinnedPageIds = ['elsewhere'])), /links to a missing page/)
    await refused(await damaged((p) => void (p.records.project.hiddenPageIds = [p.records.pages[0].id])), /hidden references, which a package cannot contain/)
    await refused(await damaged((p) => void (p.records.project.categoryIds = ['elsewhere'])), /refers to a missing category/)
    await refused(await damaged((p) => void (p.records.references[0].pageId = 'elsewhere')), /Reference #1 points at a page that is not in the package/)
    await refused(await damaged((p) => void (p.records.references[0].reasons = ['because'] as never)), /Reference #1 in the package is invalid/)
    // A second project, a notebook, or a template cannot ride along.
    const extra = await readProjectPackage(await damaged((p) => void Object.assign(p.records, { projects: [p.records.project, p.records.project], notebooks: [{ id: 'n' }], templates: [{ id: 't' }] })))
    expect(extra.ok && Object.keys(extra.records).sort()).toEqual(['attachments', 'categories', 'objects', 'pages', 'project', 'references', 'tags', 'tasks'])
  })

  it('refuses invalid record values', async () => {
    const project = (change: (x: Project) => void) => damaged((p) => change(p.records.project))
    await refused(await project((x) => void (x.status = 'archived' as never)), /Project #1 is invalid/)
    await refused(await project((x) => void (x.dueDate = '2026-13-45')), /Project #1 is invalid/)
    await refused(await project((x) => void (x.createdAt = 'yesterday-ish')), /invalid id or timestamp/)
    await refused(await project((x) => void (x.fileLocations[0].kind = 'exe' as never)), /Project #1 is invalid/)
    await refused(await project((x) => void (x.name = 'x'.repeat(PACKAGE_LIMITS.nameLength + 1))), /project field is longer/)
    await refused(await project((x) => void (x.contacts = Array.from({ length: PACKAGE_LIMITS.listItems + 1 }, (_, i) => ({ id: `c${i}`, name: '', role: '', phone: '', email: '' })))), /more list entries/)
    const task = (change: (x: Task) => void) => damaged((p) => change(p.records.tasks[0]))
    await refused(await task((x) => void (x.status = 'blocked' as never)), /Task #1 is invalid/)
    await refused(await task((x) => void (x.priority = 'critical' as never)), /Task #1 is invalid/)
    await refused(await task((x) => void (x.dueDate = '20261-12-15')), /Task #1 is invalid/)
    await refused(await task((x) => void (x.order = Number.NaN)), /Task #1 is invalid/) // NaN becomes null in JSON
    await refused(await damaged((p) => void (page(p.records, 'Commissioning notes').width = 5_000_000)), /invalid width/)
    await refused(await damaged((p) => void (p.records.objects[0].x = -5)), /invalid placement/)
    await refused(await damaged((p) => void (p.records.objects[0].w = 1e12)), /outside the size Minty Notes accepts/)
    await refused(await damaged((p) => void (p.records.objects[0].type = 'iframe' as never)), /unknown type/)
    await refused(await damaged((p) => void (p.records.categories[0].name = '   ')), /category or tag name is empty/)
  })

  it('refuses malformed rich text and markup', async () => {
    const text = (change: (o: TextObject) => void) => damaged((p) => change(objectsOf(p.records, 'Commissioning notes').find((o) => o.type === 'text') as TextObject))
    await refused(await text((o) => void (o.doc = { type: 'doc', content: [{ type: 'script', content: [{ type: 'text', text: 'alert(1)' }] }] })), /Text in object .* is not valid/)
    await refused(await text((o) => void (o.doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'onclick' }] }] }] })), /is not valid/)
    await refused(await text((o) => void (o.doc = { type: 'paragraph' } as never)), /is not valid/)
    await refused(await text((o) => void (o.doc = 'plain string' as never)), /is not valid/)
    await refused(await text((o) => void (o.doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'pageLink', attrs: { pageId: '' } }] }] }] })), /page link has no valid page ID/)
    await refused(await text((o) => void (o.doc = { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 99999, rowspan: 1, colwidth: null }, content: [{ type: 'paragraph' }] }] }] }] })), /invalid column span/)

    const markup = (kind: 'image' | 'sketch', change: (m: Record<string, unknown> & { items: Record<string, unknown>[] }) => void) => damaged((p) => change((objectsOf(p.records, 'Commissioning notes').find((o) => o.type === kind) as unknown as { markup: never }).markup))
    await refused(await markup('image', (m) => void (m.items[0].kind = 'script')), /unknown kind/)
    await refused(await markup('image', (m) => void (m.items[0].x1 = 'NaN')), /arrow is invalid/)
    await refused(await markup('image', (m) => void (m.items[0].color = 'javascript:red')), /arrow is invalid/)
    await refused(await markup('image', (m) => void (m.items[1].id = m.items[0].id)), /duplicate annotation id/)
    await refused(await markup('image', (m) => void (m.crop = { x: 0, y: 0, w: 9999, h: 9999 })), /invalid crop/)
    await refused(await markup('sketch', (m) => void (m.crop = { x: 0, y: 0, w: 10, h: 10 })), /sketch cannot be cropped/)
    await refused(await markup('sketch', (m) => void (m.width = 1e9)), /invalid size/)
    await refused(await markup('sketch', (m) => void (m.items = Array.from({ length: 2001 }, (_, i) => ({ ...m.items[0], id: `i${i}` })))), /invalid item list/)
  })

  it('refuses files that are not what they claim, or that nothing uses', async () => {
    const attachment = (name: string, change: (a: PackageRecords['attachments'][number]) => void) => damaged((p) => change(p.records.attachments.find((a) => a.fileName === name)!))
    /** Replace a file's bytes and make every size and checksum agree, so only its contents are wrong. */
    const withBytes = (name: string, bytes: Uint8Array, mimeType?: string) =>
      damaged(async (p) => {
        const meta = p.records.attachments.find((a) => a.fileName === name)!
        const listed = p.manifest.files.find((f) => f.attachmentId === meta.id)!
        p.files[listed.path] = bytes
        meta.size = listed.size = bytes.byteLength
        meta.sha256 = listed.sha256 = await sha256Hex(bytes)
        if (mimeType) meta.mimeType = listed.mimeType = mimeType
      })
    await refused(await attachment('HMI screenshot.png', (a) => void (a.mimeType = 'text/html')), /placed as a picture but is not an image file|file type Minty Notes does not import/)
    await refused(await attachment('HMI screenshot.png', (a) => void (a.mimeType = 'application/pdf')), /placed as a picture but is not an image file/)
    await refused(await attachment('LS7 control narrative.pdf', (a) => void (a.mimeType = 'application/x-msdownload')), /not the PDF file it claims to be/)
    await refused(await attachment('LS7 control narrative.pdf', (a) => void (a.source = 'usb' as never)), /invalid details/)
    await refused(await attachment('LS7 control narrative.pdf', (a) => void (a.size = -1)), /invalid details/)
    // A “PDF” whose bytes are something else (here: the DOCX), with every checksum made to agree.
    await refused(
      await damaged(async (p) => {
        const pdf = p.records.attachments.find((a) => a.fileName === 'LS7 control narrative.pdf')!
        const bytes = p.files[pathOf(p, 'LS7 procedure.docx')]
        const entry = p.manifest.files.find((f) => f.attachmentId === pdf.id)!
        p.files[entry.path] = bytes
        pdf.size = entry.size = bytes.byteLength
        pdf.sha256 = entry.sha256 = await sha256Hex(bytes)
      }),
      /“LS7 control narrative.pdf” is not the PDF document it claims to be/,
    )
    // ---- correctly checksummed, but not the kind of file the record declares
    await refused(await withBytes('LS7 procedure.docx', strToU8('This is plain text, not a Word document at all.')), /“LS7 procedure.docx” is not the DOCX document it claims to be/)
    await refused(await withBytes('LS7 procedure.docx', strToU8('PK\u0003\u0004 looks like a ZIP for four bytes, then plain text follows')), /“LS7 procedure.docx” is not the DOCX document it claims to be \(it is not a readable Word file\)/)
    // A real ZIP that is not a Word document (no word/document.xml).
    await refused(await withBytes('LS7 procedure.docx', zipSync({ 'hello.txt': strToU8('hi') })), /“LS7 procedure.docx” is not the DOCX document it claims to be \(it is not a readable Word file\)/)
    await refused(await withBytes('LS7 procedure.docx', src.files.pdf), /“LS7 procedure.docx” is not the DOCX document it claims to be/)
    await refused(await withBytes('LS7 control narrative.pdf', strToU8('plain text with no PDF marker in it')), /“LS7 control narrative.pdf” is not the PDF document it claims to be/)
    await refused(await withBytes('LS7 control narrative.pdf', PNG_1x1), /“LS7 control narrative.pdf” is not the PDF document it claims to be/)

    // Pictures: PNG bytes declared as SVG, SVG text declared as PNG, text or HTML declared as a picture.
    await refused(await attachment('HMI screenshot.png', (a) => void (a.mimeType = 'image/svg+xml')), /“HMI screenshot.png” is recorded as a SVG picture but is a PNG file/)
    await refused(await withBytes('HMI screenshot.png', SVG), /“HMI screenshot.png” is recorded as a PNG picture but is a SVG file/)
    await refused(await withBytes('HMI screenshot.png', strToU8('arbitrary text, long enough to be looked at')), /“HMI screenshot.png” is not the PNG picture it claims to be/)
    await refused(await withBytes('HMI screenshot.png', strToU8('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>'), 'image/svg+xml'), /“HMI screenshot.png” is not the SVG picture it claims to be/)
    await refused(await withBytes('HMI screenshot.png', strToU8('<html><svg xmlns="http://www.w3.org/2000/svg"/></html>'), 'image/svg+xml'), /is not the SVG picture it claims to be/)
    await refused(await withBytes('HMI screenshot.png', JPEG, 'image/png'), /recorded as a PNG picture but is a JPEG file/)
    await refused(await withBytes('HMI screenshot.png', PNG_1x1.slice(0, 8), 'image/png'), /is not the PNG picture it claims to be/)
    await refused(await withBytes('HMI screenshot.png', new Uint8Array(0), 'image/png'), /is not the PNG picture it claims to be/)
    // A picture type the app never stores.
    await refused(await attachment('HMI screenshot.png', (a) => void (a.mimeType = 'image/x-icon')), /placed as a picture but is not an image file Minty Notes uses \(image\/x-icon\)/)
    await refused(await attachment('HMI screenshot.png', (a) => void (a.mimeType = 'image/tiff')), /not an image file Minty Notes uses/)

    // An extra file that no note uses (smuggled content), fully listed and checksummed.
    await refused(
      await damaged(async (p) => {
        const bytes = strToU8('MZ\u0090 pretend executable')
        p.files['attachments/0099.bin'] = bytes
        p.manifest.files.push({ attachmentId: 'extra', path: 'attachments/0099.bin', size: bytes.byteLength, sha256: await sha256Hex(bytes), mimeType: 'application/octet-stream' })
        p.records.attachments.push({ id: 'extra', fileName: 'tool.exe', mimeType: 'application/octet-stream', size: bytes.byteLength, sha256: await sha256Hex(bytes), width: null, height: null, source: 'file', createdAt: '2026-11-01T00:00:00.000Z' })
      }),
      /“tool.exe” is not used by any note in the package/,
    )
  })
})

describe('attachment contents are judged from their bytes', () => {
  it('recognises the seven picture types the app accepts, and nothing else', () => {
    expect(sniffImageType(PNG_1x1)).toBe('image/png')
    expect(sniffImageType(DOCX_PNG)).toBe('image/png')
    expect(sniffImageType(JPEG)).toBe('image/jpeg')
    expect(sniffImageType(GIF)).toBe('image/gif')
    expect(sniffImageType(WEBP)).toBe('image/webp')
    expect(sniffImageType(BMP)).toBe('image/bmp')
    expect(sniffImageType(AVIF)).toBe('image/avif')
    expect(sniffImageType(SVG)).toBe('image/svg+xml')
    // SVG as real files start: declaration, comment, DOCTYPE, byte-order mark, a namespace prefix, UTF-16.
    const svg = (text: string) => sniffImageType(strToU8(text))
    expect(svg('<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by a drawing tool -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe('image/svg+xml')
    expect(svg('\ufeff<svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>')).toBe('image/svg+xml')
    expect(svg('  \n<svg/>')).toBe('image/svg+xml')
    const utf16 = new Uint8Array(2 + SVG_TEXT.length * 2)
    utf16.set([0xff, 0xfe])
    for (let i = 0; i < SVG_TEXT.length; i++) utf16[2 + i * 2] = SVG_TEXT.charCodeAt(i)
    expect(sniffImageType(utf16)).toBe('image/svg+xml')
    // Not pictures, or not ones the app stores.
    expect(svg('<svgx xmlns="http://www.w3.org/2000/svg"/>')).toBeNull()
    expect(svg('<html><svg/></html>')).toBeNull()
    expect(svg('<!-- <svg> --><p>text</p>')).toBeNull()
    expect(svg('just text that mentions <svg> somewhere')).toBeNull()
    expect(sniffImageType(strToU8('<svg>\u0000</svg>'))).toBeNull()
    expect(sniffImageType(new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 1, 2, 3, 4, 5, 6]))).toBeNull()
    expect(sniffImageType(src.files.pdf)).toBeNull()
    expect(sniffImageType(src.files.docx)).toBeNull()
    expect(sniffImageType(strToU8('MZ\u0090\u0000 pretend executable'))).toBeNull()
    expect(sniffImageType(Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 0, 0]))).toBeNull() // TIFF
    expect(sniffImageType(Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0]))).toBeNull() // ICO
    expect(sniffImageType(strToU8('....ftypmp42....mp42isom'))).toBeNull() // MP4, the same container family as AVIF
    expect(sniffImageType(new Uint8Array(3))).toBeNull()
    expect(imageProblem('image/png', PNG_1x1)).toBeNull()
    expect(imageProblem('image/svg+xml', PNG_1x1)).toMatch(/recorded as a SVG picture but is a PNG file/)
    expect(imageProblem('image/x-icon', PNG_1x1)).toMatch(/picture type Minty Notes does not use/)
  })

  it('documents are checked the way “Import document” checks them', async () => {
    expect(await originalProblem('pdf', 'a.pdf', src.files.pdf)).toBeNull()
    expect(await originalProblem('docx', 'a.docx', src.files.docx)).toBeNull()
    expect(await originalProblem('docx', 'a.docx', src.files.pdf)).toMatch(/not the DOCX document/)
    expect(await originalProblem('pdf', 'a.pdf', src.files.docx)).toMatch(/not the PDF document/)
    expect(await originalProblem('docx', 'a.docx', zipSync({ 'word/other.xml': strToU8('<x/>') }))).toMatch(/not a readable Word file/)
    expect(await originalProblem('docx', 'a.docx', new Uint8Array(0))).toMatch(/not the DOCX document/)
  })

  it('every supported picture type travels: exported, validated, and imported with its own type and bytes', async () => {
    const { store } = await freshStore()
    const project = store.createProject({ name: 'Picture types' })
    const note = store.createPage({ kind: 'project', projectId: project.id }, 'Pictures')
    const samples: [string, string, Uint8Array][] = [
      ['a.png', 'image/png', PNG_1x1],
      ['b.jpg', 'image/jpeg', JPEG],
      ['c.gif', 'image/gif', GIF],
      ['d.webp', 'image/webp', WEBP],
      ['e.bmp', 'image/bmp', BMP],
      ['f.avif', 'image/avif', AVIF],
      ['g.svg', 'image/svg+xml', SVG],
    ]
    let y = 40
    for (const [name, type, bytes] of samples) await addImage(store, note.id, bytes, name, undefined, (y += 200), type)
    await store.flush()
    const out = await buildProjectExport(await loadExportSnapshot(store), project.id, DEFAULT_EXPORT_OPTIONS, 'test')
    const pkg = await readProjectPackage(out.bytes)
    if (!pkg.ok) throw new Error(pkg.errors.join('\n'))
    // One file per picture, numbered, each with the extension of its own type.
    const packed = Object.keys(unzipSync(out.bytes)).filter((n) => n.startsWith('attachments/'))
    expect(packed.map((n) => n.replace(/^attachments\/\d{4}\./, '')).sort()).toEqual(['avif', 'bmp', 'gif', 'jpg', 'png', 'svg', 'webp'])

    const dest = await destinationWorkspace()
    const result = await importProjectPackage(dest.store, pkg)
    const after = await dest.repo.readAll()
    for (const [name, type, bytes] of samples) {
      const meta = after.records.attachments.find((a) => a.fileName === name)!
      expect(meta.mimeType, name).toBe(type)
      const blob = after.blobs.get(meta.id)!
      expect(blob.type, name).toBe(type)
      expect(await sha256Hex(new Uint8Array(await blob.arrayBuffer())), name).toBe(await sha256Hex(bytes))
    }
    expect(result.counts.attachments).toBe(7)
  })

  it('a picture the workspace holds under the wrong type is packaged as what it is; the workspace is not changed', async () => {
    // A browser shows a JPEG that was saved as “photo.png” (it looks at the bytes), so a workspace can contain one.
    const { store, repo } = await freshStore()
    const project = store.createProject({ name: 'Mislabelled' })
    const note = store.createPage({ kind: 'project', projectId: project.id }, 'Photos')
    await addImage(store, note.id, JPEG, 'photo.png', undefined, 100, 'image/png')
    await store.flush()
    const before = JSON.stringify((await repo.readAll()).records)
    const out = await buildProjectExport(await loadExportSnapshot(store), project.id, DEFAULT_EXPORT_OPTIONS, 'test')
    expect(JSON.stringify((await repo.readAll()).records)).toBe(before)
    const files = unzipSync(out.bytes)
    expect(Object.keys(files).filter((n) => n.startsWith('attachments/'))).toEqual(['attachments/0001.jpg'])
    expect(files['attachments/0001.jpg']).toEqual(JPEG)
    const pkg = await readProjectPackage(out.bytes)
    if (!pkg.ok) throw new Error(pkg.errors.join('\n'))
    expect(pkg.records.attachments[0]).toMatchObject({ fileName: 'photo.png', mimeType: 'image/jpeg', size: JPEG.byteLength })
  })

  it('a “picture” that is no picture at all stops the export with the name of the note, instead of making a package that cannot be imported', async () => {
    const { store, repo } = await freshStore()
    const project = store.createProject({ name: 'Broken picture' })
    const note = store.createPage({ kind: 'project', projectId: project.id }, 'Site photos')
    await addImage(store, note.id, strToU8('not an image, though the workspace says image/svg+xml'), 'drawing.svg', undefined, 100, 'image/svg+xml')
    await store.flush()
    const before = JSON.stringify((await repo.readAll()).records)
    await expect(buildProjectExport(await loadExportSnapshot(store), project.id, DEFAULT_EXPORT_OPTIONS, 'test')).rejects.toThrow(/The picture “drawing.svg” on the note “Site photos” is not a PNG, JPEG, GIF, WebP, BMP, AVIF, or SVG file.*cannot be exported as a package/)
    expect(JSON.stringify((await repo.readAll()).records)).toBe(before)
  })
})

describe('content is cleaned, never executed', () => {
  it('removes unsafe link addresses (the words stay), drops unknown fields, and gives originals an honest file name', async () => {
    const bytes = await damaged((p) => {
      const links = objectsOf(p.records, 'Commissioning notes').find((o) => o.type === 'text' && JSON.stringify(o.doc).includes('Vendor: ')) as TextObject
      const paragraph = links.doc.content![2]
      paragraph.content!.push(
        { type: 'text', text: 'click me', marks: [{ type: 'link', attrs: { href: 'javascript:alert(document.cookie)', target: '_blank', rel: null, class: null, title: null } }] },
        { type: 'text', text: 'sneaky', marks: [{ type: 'link', attrs: { href: ' jAvA\tscript:alert(1)', target: null, rel: null, class: null, title: null } }] },
        { type: 'text', text: 'data', marks: [{ type: 'link', attrs: { href: 'data:text/html,<script>alert(1)</script>', target: null, rel: null, class: null, title: null } }] },
        { type: 'text', text: 'mail', marks: [{ type: 'link', attrs: { href: 'mailto:dana@example.com', target: null, rel: null, class: null, title: null } }] },
        { type: 'text', text: 'opener', marks: [{ type: 'link', attrs: { href: 'https://example.com/x', target: '_top', rel: 'opener', class: 'evil-class', title: 'T' } }] },
      )
      // Fields the app does not know, on several kinds of record.
      Object.assign(p.records.project, { onload: 'alert(1)', __proto__x: { polluted: true }, script: '<script>alert(1)</script>' })
      Object.assign(p.records.pages[0], { html: '<img src=x onerror=alert(1)>' })
      Object.assign(p.records.objects[0], { eval: 'alert(1)' })
      Object.assign(p.records.tasks[0], { hook: 'x' })
      Object.assign(p.records.project.fileLocations[1], { value: 'javascript:alert(1)', autoOpen: true })
      // A document that would download under a misleading name.
      const narrative = page(p.records, 'LS7 control narrative')
      narrative.importedFrom!.fileName = 'invoice.pdf.exe'
      p.records.attachments.find((a) => a.id === narrative.importedFrom!.attachmentId)!.fileName = '..\\..\\invoice.pdf.exe'
    })
    const result = await readProjectPackage(bytes)
    if (!result.ok) throw new Error(result.errors.join('\n'))
    expect(result.warnings.join(' | ')).toMatch(/3 links have an address that is not a normal web or e-mail address. They were removed; the linked words are kept/)
    expect(result.warnings.join(' | ')).toMatch(/1 original document was renamed so that the file name ends with its real type/)
    expect(result.warnings.join(' | ')).toMatch(/1 saved web link does not start with http:\/\/ or https:\/\/. It is kept as text and will not open/)

    const json = JSON.stringify(result.records)
    for (const bad of ['javascript:alert(document', 'jAvA', 'data:text/html', 'onload', 'polluted', '<script>alert(1)</script>"', 'onerror', '"eval"', '"hook"', 'autoOpen']) expect(json.includes(bad), bad).toBe(false)
    expect(json).toContain('click me')
    expect(json).toContain('sneaky')
    expect(json).toContain('"href":"mailto:dana@example.com"')
    // Kept links open like the editor's own: new tab, no access to the app's window, no foreign class.
    expect(json).toContain('{"type":"link","attrs":{"href":"https://example.com/x","target":"_blank","rel":"noopener noreferrer nofollow","class":null,"title":"T"}}')
    for (const bad of ['_top', '"rel":"opener"', 'evil-class']) expect(json.includes(bad), bad).toBe(false)
    expect(json).toContain('"href":"https://example.com/manual"')
    const narrative = page(result.records, 'LS7 control narrative')
    expect(narrative.importedFrom!.fileName).toBe('invoice.pdf.exe.pdf')
    expect(result.records.attachments.find((a) => a.id === narrative.importedFrom!.attachmentId)!.fileName).toBe('invoice.pdf.exe.pdf')
    // The odd address is kept only as text in the Files list, where the app never makes it a link.
    expect(result.records.project.fileLocations[1]).toEqual({ id: expect.any(String), label: 'Dropbox', kind: 'url', value: 'javascript:alert(1)', description: 'Shared with the customer' })

    // And it imports like that.
    const dest = await destinationWorkspace()
    const done = await importProjectPackage(dest.store, result)
    const stored = JSON.stringify((await dest.repo.readAll()).records)
    expect(stored.includes('javascript:alert(document')).toBe(false)
    expect(stored.includes('onerror')).toBe(false)
    expect(dest.store.getState().data.projects[done.projectId].name).toBe('Lift Station 7 upgrade (imported)')
  })

  it('judges link addresses like the editor does', () => {
    for (const ok of ['https://example.com', 'HTTP://EXAMPLE.COM', 'mailto:a@b.c', 'tel:+15550100', 'example.com/page', '/relative', '#anchor', 'ftp://host/file']) expect(isSafeHref(ok), ok).toBe(true)
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)', 'java\u0000script:x', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', 'blob:https://x/y', 'chrome://settings']) expect(isSafeHref(bad), bad).toBe(false)
    expect(safeOriginalName('manual.PDF', 'pdf')).toBe('manual.PDF')
    expect(safeOriginalName('manual', 'docx')).toBe('manual.docx')
    expect(safeOriginalName('a/b\\c:d*e?.exe', 'pdf')).toBe('a_b_c_d_e_.exe.pdf')
    expect(safeOriginalName('\u0000\u001f', 'pdf')).toBe('__.pdf')
    expect(safeOriginalName('   ', 'pdf')).toBe('document.pdf')
  })

  it('keeps an “original only” page recognisable when its file had to be renamed', async () => {
    const bytes = await damaged((p) => {
      const narrative = page(p.records, 'LS7 control narrative')
      narrative.importedFrom!.fileName = 'scan'
      narrative.importedFrom!.notes = ['“scan” could not be converted: it has no text (scanned pages).']
      p.records.attachments.find((a) => a.id === narrative.importedFrom!.attachmentId)!.fileName = 'scan'
    })
    const result = await readProjectPackage(bytes)
    if (!result.ok) throw new Error(result.errors.join('\n'))
    expect(page(result.records, 'LS7 control narrative').importedFrom).toMatchObject({ fileName: 'scan.pdf', notes: ['“scan.pdf” could not be converted: it has no text (scanned pages).'] })
  })

  it('an invalid package cannot be imported and leaves the workspace as it was', async () => {
    const dest = await destinationWorkspace()
    const before = await dest.repo.readAll()
    const bad = await readProjectPackage(await damaged((p) => void (p.records.tasks[0].linkedPageIds = ['no-such-page'])))
    expect(bad.ok).toBe(false)
    // There is nothing to pass to the importer: an invalid result has no records at all.
    expect('records' in bad).toBe(false)
    // Even a hand-made “valid” result with a broken relationship is stopped by the final check, before any write.
    const ok = await readProjectPackage(good)
    if (!ok.ok) throw new Error('unexpected')
    const forged = { ...ok, records: { ...ok.records, tasks: ok.records.tasks.map((t, i) => (i === 0 ? { ...t, linkedPageIds: ['no-such-page'] } : t)) } }
    const result = await importProjectPackage(dest.store, forged)
    // The unknown link is simply not carried over (it maps to nothing); no record points outside the import.
    const after = await dest.repo.readAll()
    expect(JSON.stringify(after.records).includes('no-such-page')).toBe(false)
    expect(after.records.tasks.filter((t) => t.projectId === result.projectId)).toHaveLength(4)
    for (const kind of ['projects', 'pages', 'objects', 'tasks', 'attachments'] as const) {
      const ids = new Set((after.records[kind] as { id: string }[]).map((r) => r.id))
      for (const r of before.records[kind] as { id: string }[]) expect(ids.has(r.id)).toBe(true)
    }
  })
})

describe('imported Word originals must be real Word files, whatever their checksums say', () => {
  /** The package with the DOCX original replaced by `bytes`, every size and checksum made to agree. */
  const withDocx = (bytes: Uint8Array) =>
    damaged(async (p) => {
      const meta = p.records.attachments.find((a) => a.fileName === 'LS7 procedure.docx')!
      const listed = p.manifest.files.find((f) => f.attachmentId === meta.id)!
      p.files[listed.path] = bytes
      meta.size = listed.size = bytes.byteLength
      meta.sha256 = listed.sha256 = await sha256Hex(bytes)
    })
  const parts = () => rawEntriesOf(makeDocx())
  const doc = (list: ReturnType<typeof parts>) => list.findIndex((e) => e.name === 'word/document.xml')

  it('the audited 138-byte container and other broken ones are refused, and the destination stays as it was', async () => {
    const all = parts()
    const zeros = new Uint8Array(4 * 1024 * 1024)
    const broken: [string, Uint8Array][] = [
      ['the audited file: word/document.xml listed at byte 1,048,576, past the end', rawZip([{ ...storedEntry('word/document.xml', strToU8('<w:d/>')), offset: 1_048_576 }])],
      ['a part whose header contradicts the directory', rawZip(all.map((e, i) => (i === doc(all) ? { ...e, local: { crc: 1 } } : e)))],
      ['one piece of data listed as two parts', rawZip(all, (offsets) => [...all.map((e, i) => centralRecord(e, offsets[i])), centralRecord(all[doc(all)], offsets[doc(all)])])],
      ['a part that unpacks to far more than recorded', rawZip(all.map((e, i) => (i === doc(all) ? { ...deflatedEntry(e.name, zeros), size: 40 } : e)))],
      ['a part with a wrong CRC', rawZip(all.map((e, i) => (i === doc(all) ? { ...e, crc: e.crc ^ 1 } : e)))],
    ]
    const dest = await destinationWorkspace()
    const before = await dest.repo.readAll()
    for (const [label, bytes] of broken) {
      // What the import dialog does: read and check the whole package; import only a valid one.
      const result = await readProjectPackage(await withDocx(bytes))
      expect(result.ok, label).toBe(false)
      if (!result.ok) expect(result.errors.join(' | '), label).toMatch(/The file “LS7 procedure\.docx” is not the DOCX document it claims to be \(it is not a readable Word file\)/)
      if (result.ok) await importProjectPackage(dest.store, result)
    }
    const after = await dest.repo.readAll()
    expect(after.revision).toBe(before.revision)
    expect(after.records).toEqual(before.records)
    expect([...after.blobs.keys()].sort()).toEqual([...before.blobs.keys()].sort())
  })

  it('genuine Word documents from five writers survive export and import byte for byte, and stay readable', async () => {
    const genuine = [
      ['Word tables.docx', '../../node_modules/mammoth/test/test-data/tables.docx'],
      ['Word footnotes.docx', '../../node_modules/mammoth/test/test-data/footnotes.docx'],
      ['LibreOffice procedure.docx', '../test/files/docx/libreoffice-24.2.docx'],
      ['Info-ZIP ZIP64 procedure.docx', '../test/files/docx/infozip-zip64.docx'],
      ['Python streamed procedure.docx', '../test/files/docx/python-stream-zip64.docx'],
    ].map(([name, path]) => ({ name, bytes: readTestFile(new URL(path, import.meta.url)) }))
    const { store } = await freshStore()
    const project = store.createProject({ name: 'Word originals' })
    for (const g of genuine) await importOriginal(store, project.id, g.bytes, g.name, 'docx', `Draft of ${g.name}`)
    await store.flush()
    const pkg = await readProjectPackage((await buildProjectExport(await loadExportSnapshot(store), project.id, DEFAULT_EXPORT_OPTIONS, 'test')).bytes)
    if (!pkg.ok) throw new Error(pkg.errors.join('\n'))
    expect(pkg.summary.originals).toBe(genuine.length)
    const dest = await destinationWorkspace()
    const result = await importProjectPackage(dest.store, pkg)
    const after = await dest.repo.readAll()
    for (const g of genuine) {
      const meta = after.records.attachments.find((a) => a.fileName === g.name)!
      const page = after.records.pages.find((p) => p.importedFrom?.attachmentId === meta.id)!
      expect(page.location).toEqual({ kind: 'project', projectId: result.projectId })
      const bytes = new Uint8Array(await after.blobs.get(meta.id)!.arrayBuffer())
      expect(await sha256Hex(bytes), g.name).toBe(await sha256Hex(g.bytes))
      expect(await checkDocxContainer(g.name, bytes), g.name).toEqual({ ok: true, macros: false })
    }
  })
})
