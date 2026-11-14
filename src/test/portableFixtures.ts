import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { sha256Hex } from '../backup/archive'
import { docFromPlainText } from '../domain/richtext'
import { newId, nowIso, type ImageObject, type Markup, type RichTextDoc, type RichTextNode, type SketchObject, type TextObject } from '../domain/types'
import { DOCX_MIME, PDF_MIME } from '../import/formats'
import type { WorkspaceStore } from '../store/workspaceStore'
import { DOCX_PNG, makeDocx, makeTechnicalPdf } from './docFixtures'
import { freshStore, PNG_1x1 } from './fixtures'
import { concatBytes } from './rawZip'
import { technicalDoc } from './richDocs'

/**
 * A realistic synthetic workspace for portable-project tests (no real data):
 * the project “Lift Station 7 upgrade” with notes, tasks, a marked-up
 * screenshot, a sketch, an imported PDF and DOCX, and links into a reference
 * library and another project — plus unrelated records that must never travel.
 */

const text = (t: string, marks?: RichTextNode['marks']): RichTextNode => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t })
const para = (...content: RichTextNode[]): RichTextNode => ({ type: 'paragraph', content })
const pageLink = (label: string, pageId: string) => text(label, [{ type: 'pageLink', attrs: { pageId } }])

export function textBox(pageId: string, doc: RichTextDoc | string, y = 48): TextObject {
  const at = nowIso()
  return { id: newId(), pageId, type: 'text', x: 48, y, w: 560, h: 120, z: 1, doc: typeof doc === 'string' ? docFromPlainText(doc) : doc, createdAt: at, updatedAt: at }
}

export async function addImage(store: WorkspaceStore, pageId: string, bytes: Uint8Array, fileName: string, markup?: Markup, y = 320, mimeType = 'image/png'): Promise<ImageObject> {
  const at = nowIso()
  const attachmentId = newId()
  await store.addAttachment({ id: attachmentId, fileName, mimeType, size: bytes.byteLength, sha256: await sha256Hex(bytes), width: 16, height: 8, source: 'paste', createdAt: at }, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }))
  const image: ImageObject = { id: newId(), pageId, type: 'image', attachmentId, alt: fileName, x: 48, y, w: 320, h: 160, z: 2, createdAt: at, updatedAt: at, ...(markup ? { markup } : {}) }
  store.addObjects(pageId, [image])
  return image
}

/** An imported PDF/DOCX in a project: the original file plus a converted draft (as “Import document” stores it). */
export async function importOriginal(store: WorkspaceStore, projectId: string, bytes: Uint8Array, fileName: string, format: 'pdf' | 'docx', body: string) {
  const id = newId()
  const meta = { id, fileName, mimeType: format === 'pdf' ? PDF_MIME : DOCX_MIME, size: bytes.byteLength, sha256: await sha256Hex(bytes), width: null, height: null, source: 'import' as const, createdAt: nowIso() }
  return store.createImportedPage(
    { kind: 'project', projectId },
    {
      title: fileName.replace(/\.[a-z]+$/, ''),
      importedFrom: { attachmentId: id, fileName, format, notes: ['Page layout is not reproduced.'] },
      files: [{ meta, blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: meta.mimeType }) }],
      objects: [{ type: 'text', x: 48, y: 48, w: 860, h: 200, doc: docFromPlainText(body) }],
    },
  )
}

export const SCREENSHOT_MARKUP: Markup = {
  width: 16,
  height: 8,
  crop: { x: 1, y: 1, w: 14, h: 6 },
  items: [
    { id: 'a1', kind: 'arrow', x1: 2, y1: 2, x2: 9, y2: 5, color: '#ef4444', width: 1 },
    { id: 'a2', kind: 'redact', x: 8, y: 1, w: 6, h: 3 },
    { id: 'a3', kind: 'text', x: 2, y: 5, text: 'PLC IP hidden', color: '#ffffff', size: 2, background: '#111111' },
  ],
}

export const SKETCH_MARKUP: Markup = {
  width: 600,
  height: 300,
  crop: null,
  items: [
    { id: 's1', kind: 'line', x1: 40, y1: 150, x2: 560, y2: 150, color: '#6ee7b7', width: 3 },
    { id: 's2', kind: 'rect', x: 80, y: 60, w: 160, h: 90, color: '#60a5fa', width: 3, fill: null },
    { id: 's3', kind: 'pen', points: [300, 80, 320, 120, 350, 90, 380, 140], color: '#facc15', width: 4 },
    { id: 's4', kind: 'text', x: 90, y: 70, text: 'LSH-101 → PLC DI 4', color: '#ffffff', size: 18, background: null },
  ],
}

/** ID that belongs to no page (a link to a page deleted forever). */
export const DELETED_PAGE_ID = '00000000-dead-4000-8000-000000000000'

export async function sourceWorkspace() {
  const { store, repo } = await freshStore()
  const vt = store.createCategory('VTScada')
  const panel = store.createCategory('Panel building')
  const studio = store.createCategory('Studio 5000')
  const tagComm = store.createTag('commissioning')
  const tagIo = store.createTag('io-list')

  // ---- reference library
  const { notebook, section } = store.createNotebook('VTScada reference', [vt.id])
  const alarm = store.createPage({ kind: 'section', sectionId: section.id }, 'Alarm setup')
  const deep = store.createPage({ kind: 'section', sectionId: section.id }, 'Alarm priorities (deep)')
  const tagNaming = store.createPage({ kind: 'section', sectionId: section.id }, 'Tag naming')
  const hidden = store.createPage({ kind: 'section', sectionId: section.id }, 'Old driver hint')
  store.addObjects(alarm.id, [textBox(alarm.id, { type: 'doc', content: [para(text('Use the alarm priority list. See '), pageLink('priorities', deep.id), text('.'))] })])
  const alarmImage = await addImage(store, alarm.id, DOCX_PNG, 'alarm-dialog.png')
  store.addObjects(deep.id, [textBox(deep.id, '1 critical, 2 high, 3 low')])
  store.addObjects(tagNaming.id, [textBox(tagNaming.id, 'Area_Equipment_Signal, e.g. LS7_P101_RUN')])
  store.addObjects(hidden.id, [textBox(hidden.id, 'Only for the legacy driver')])
  const ladder = store.createPage({ kind: 'standalone' }, 'Ladder tips')
  store.setCategories('pages', ladder.id, [studio.id])
  store.addObjects(ladder.id, [textBox(ladder.id, 'Keep rungs short; one output per rung')])
  const trashedTarget = store.createPage({ kind: 'inbox' }, 'Scratch numbers')
  store.addObjects(trashedTarget.id, [textBox(trashedTarget.id, 'temporary')])

  // ---- an unrelated project that must never be exported
  const other = store.createProject({ name: 'North pump station', customer: 'Other Customer Ltd', jobNumber: 'J-0001' })
  const otherNote = store.createPage({ kind: 'project', projectId: other.id }, 'North station wiring check')
  store.addObjects(otherNote.id, [textBox(otherNote.id, 'Terminal strip X1 verified')])
  const otherSecret = store.createPage({ kind: 'project', projectId: other.id }, 'North station pricing')
  store.addObjects(otherSecret.id, [textBox(otherSecret.id, 'CONFIDENTIAL-OTHER-PROJECT')])
  const otherTask = store.createTask(other.id, { title: 'Order North station spares' })
  const inboxNote = store.createPage({ kind: 'inbox' }, 'Unrelated inbox note')
  store.addObjects(inboxNote.id, [textBox(inboxNote.id, 'UNRELATED-INBOX-TEXT')])

  // ---- the project
  const project = store.createProject({
    name: 'Lift Station 7 upgrade',
    customer: 'City of Example',
    site: 'Lift Station 7',
    jobNumber: 'J-2207',
    status: 'active',
    dueDate: '2026-12-15',
    description: 'Replace the PLC and move the HMI to VTScada.',
    contacts: [{ id: newId(), name: 'Dana Field', role: 'Operator', phone: '555-0100', email: 'dana@example.com' }],
    equipment: [{ id: newId(), name: 'PLC', detail: '1756-L83E' }],
    software: [{ id: newId(), name: 'VTScada', detail: '12.1.40' }],
    fileLocations: [
      { id: newId(), label: 'Job folder', kind: 'path', value: 'C:\\Jobs\\J-2207', description: 'Drawings and backups' },
      { id: newId(), label: 'Dropbox', kind: 'url', value: 'https://www.dropbox.com/home/J-2207', description: 'Shared with the customer' },
    ],
    categoryIds: [vt.id, panel.id],
  })
  store.pinReference(project.id, alarm.id)
  store.hideReference(project.id, hidden.id)

  // The exact bytes stored (a generated DOCX embeds its creation time, so it is made once).
  const files = { pdf: makeTechnicalPdf(), docx: makeDocx() }
  const narrative = await importOriginal(store, project.id, files.pdf, 'LS7 control narrative.pdf', 'pdf', 'Lead pump starts at LSH-101.')
  const procedure = await importOriginal(store, project.id, files.docx, 'LS7 procedure.docx', 'docx', 'Verify 24 VDC at terminal X2:14.')

  const notes = store.createPage({ kind: 'project', projectId: project.id }, 'Commissioning notes')
  store.setPageTags(notes.id, [tagComm.id, tagIo.id])
  store.setCategories('pages', notes.id, [panel.id])
  const technical = textBox(notes.id, technicalDoc(narrative.id))
  const links = textBox(
    notes.id,
    {
      type: 'doc',
      content: [
        para(text('Alarms: '), pageLink('alarm setup', alarm.id), text(' · other job: '), pageLink('wiring check', otherNote.id)),
        para(text('Scratch: '), pageLink('numbers', trashedTarget.id), text(' · gone: '), pageLink('old page', DELETED_PAGE_ID)),
        para(text('Vendor: '), text('manual', [{ type: 'link', attrs: { href: 'https://example.com/manual', target: '_blank', rel: 'noopener noreferrer nofollow', class: null, title: null } }])),
      ],
    },
    200,
  )
  store.addObjects(notes.id, [technical, links])
  const screenshot = await addImage(store, notes.id, PNG_1x1, 'HMI screenshot.png', SCREENSHOT_MARKUP)
  const at = nowIso()
  const sketch: SketchObject = { id: newId(), pageId: notes.id, type: 'sketch', x: 48, y: 520, w: 600, h: 300, z: 3, markup: SKETCH_MARKUP, createdAt: at, updatedAt: at }
  store.addObjects(notes.id, [sketch])

  // A project copy whose original is also pinned again afterwards (so both travel).
  const copy = await store.makeProjectCopy(project.id, tagNaming.id)
  store.pinReference(project.id, tagNaming.id)
  const trashedNote = store.createPage({ kind: 'project', projectId: project.id }, 'Abandoned draft')
  store.addObjects(trashedNote.id, [textBox(trashedNote.id, 'TRASHED-NOTE-TEXT')])
  store.trashPage(trashedNote.id)
  store.trashPage(trashedTarget.id)

  const t1 = store.createTask(project.id, { title: 'Check I/O list', description: 'Compare with drawings', priority: 'high', dueDate: '2026-11-20', linkedPageIds: [notes.id, ladder.id] })
  const t2 = store.createTask(project.id, { title: 'Configure alarms', priority: 'urgent', linkedPageIds: [alarm.id, trashedTarget.id] })
  const t3 = store.createTask(project.id, { title: 'Site acceptance test', priority: 'low', dueDate: '2026-12-10' })
  const t4 = store.createTask(project.id, { title: 'Order panel parts', linkedPageIds: [narrative.id] })
  store.moveTask(t2.id, 'doing', null)
  store.setTaskDone(t4.id, true)
  store.moveTask(t3.id, 'todo', t1.id) // t3 before t1 in To do

  await store.flush()
  return {
    store,
    repo,
    project,
    other,
    categories: { vt, panel, studio },
    tags: { tagComm, tagIo },
    library: { notebook, section, alarm, deep, tagNaming, hidden, ladder, trashedTarget, alarmImage },
    notes: { narrative, procedure, notes, copy, trashedNote, technical, links, screenshot, sketch },
    otherProject: { otherNote, otherSecret, otherTask, inboxNote },
    tasks: { t1, t2, t3, t4 },
    files,
  }
}

export type SourceWorkspace = Awaited<ReturnType<typeof sourceWorkspace>>

/** Valid PNG files with a recognisable tail, so a test can look for their bytes inside a package. */
export const HIDDEN_PNG = concatBytes(PNG_1x1, strToU8('HIDDEN-IMAGE-BYTES'))
export const OTHER_PROJECT_PNG = concatBytes(PNG_1x1, strToU8('OTHER-PROJECT-IMAGE-BYTES'))

/**
 * Adds to the source workspace everything that must never travel even though
 * the project points straight at it: pages hidden for the project (one with a
 * picture) that a note and a task link to, and pages of the other project that
 * are pinned to this project and linked from a note and a task.
 */
export async function addPrivateLinks(src: SourceWorkspace) {
  const { store, project } = src
  const section = { kind: 'section' as const, sectionId: src.library.section.id }
  const hiddenLinked = store.createPage(section, 'Customer passwords (hidden)')
  store.addObjects(hiddenLinked.id, [textBox(hiddenLinked.id, 'HIDDEN-PAGE-SECRET-TEXT')])
  const hiddenImage = await addImage(store, hiddenLinked.id, HIDDEN_PNG, 'hidden-wiring-photo.png')
  store.hideReference(project.id, hiddenLinked.id)
  // Pinned once, hidden later (hiding removes the pin).
  const hiddenPinned = store.createPage(section, 'Old site contacts (was pinned)')
  store.addObjects(hiddenPinned.id, [textBox(hiddenPinned.id, 'HIDDEN-PINNED-TEXT')])
  store.pinReference(project.id, hiddenPinned.id)
  store.hideReference(project.id, hiddenPinned.id)

  const { otherSecret } = src.otherProject
  const otherImage = await addImage(store, otherSecret.id, OTHER_PROJECT_PNG, 'pricing-sheet.png')
  store.pinReference(project.id, otherSecret.id)

  const access = store.createPage({ kind: 'project', projectId: project.id }, 'Site access')
  const accessText = textBox(access.id, {
    type: 'doc',
    content: [para(text('Passwords: '), pageLink('see the hidden page', hiddenLinked.id), text(' · contacts: '), pageLink('old list', hiddenPinned.id)), para(text('Pricing: '), pageLink('other job', otherSecret.id), text(' · library: '), pageLink('ladder tips', src.library.ladder.id))],
  })
  store.addObjects(access.id, [accessText])
  const task = store.createTask(project.id, { title: 'Ask for site access', linkedPageIds: [hiddenLinked.id, otherSecret.id, access.id] })
  await store.flush()
  return { hiddenLinked, hiddenPinned, hiddenImage, otherImage, access, accessText, task }
}

/** A second workspace with its own unrelated projects, notes, tasks, references, and a same-named category. */
export async function destinationWorkspace() {
  const { store, repo } = await freshStore()
  const vt = store.createCategory('vtscada') // same name, different spelling and ID
  const safety = store.createCategory('Safety')
  const tag = store.createTag('Commissioning')
  const { section } = store.createNotebook('My VTScada notes', [vt.id])
  const libraryPage = store.createPage({ kind: 'section', sectionId: section.id }, 'Alarm setup') // same title as a packaged reference
  store.addObjects(libraryPage.id, [textBox(libraryPage.id, 'DESTINATION-OWN-ALARM-PAGE')])
  const existing = store.createProject({ name: 'Lift Station 7 upgrade', customer: 'Somebody Else', categoryIds: [vt.id] }) // same name
  const existingNote = store.createPage({ kind: 'project', projectId: existing.id }, 'Commissioning notes')
  store.addObjects(existingNote.id, [textBox(existingNote.id, 'DESTINATION-OWN-NOTE')])
  const image = await addImage(store, existingNote.id, PNG_1x1, 'existing.png')
  const task = store.createTask(existing.id, { title: 'Existing task', linkedPageIds: [existingNote.id, libraryPage.id] })
  store.pinReference(existing.id, libraryPage.id)
  const template = await store.createTemplateFromProject(existing.id, 'Existing template')
  const inbox = store.createPage({ kind: 'inbox' }, 'Destination inbox note')
  store.addObjects(inbox.id, [textBox(inbox.id, 'destination inbox')])
  await store.flush()
  return { store, repo, vt, safety, tag, libraryPage, existing, existingNote, image, task, template, inbox }
}

const dec = new TextDecoder()

/**
 * Unpack a package, let a test damage it, and pack it again. Unless
 * `fixChecksums` is false, the manifest's checksum of project.json is updated,
 * so the change under test is the only thing wrong with the package.
 */
export async function repack(
  bytes: Uint8Array,
  mutate: (parts: { files: Record<string, Uint8Array>; manifest: Record<string, unknown>; records: Record<string, unknown> }) => void | Promise<void>,
  fixChecksums = true,
): Promise<Uint8Array> {
  const files = unzipSync(bytes) as Record<string, Uint8Array>
  const manifest = JSON.parse(dec.decode(files['manifest.json'])) as Record<string, unknown>
  const records = JSON.parse(dec.decode(files['project.json'])) as Record<string, unknown>
  const before = { manifest: files['manifest.json'], records: files['project.json'] }
  await mutate({ files, manifest, records })
  // A test may replace or delete the JSON files directly; then they are used as they are.
  if (files['project.json'] === before.records) {
    const recordBytes = strToU8(JSON.stringify(records, null, 1))
    files['project.json'] = recordBytes
    if (fixChecksums) manifest.records = { path: 'project.json', size: recordBytes.byteLength, sha256: await sha256Hex(recordBytes) }
  }
  if (files['manifest.json'] === before.manifest) files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  const out: Zippable = {}
  for (const [name, data] of Object.entries(files)) out[name] = [data, { level: name.startsWith('attachments/') ? 0 : 6 }]
  return zipSync(out)
}

const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0

/**
 * Change the unpacked size a ZIP records for one entry — in its directory and
 * in the header in front of the data, so the forgery is consistent. The data
 * is not changed.
 */
export function declareSize(zip: Uint8Array, name: string, size: number): Uint8Array {
  const out = zip.slice()
  const view = new DataView(out.buffer)
  for (let i = 0; i + 46 < out.length; i++) {
    if (u32(out, i) !== 0x02014b50) continue
    const length = out[i + 28] | (out[i + 29] << 8)
    if (dec.decode(out.subarray(i + 46, i + 46 + length)) !== name) continue
    view.setUint32(i + 24, size, true)
    view.setUint32(u32(out, i + 42) + 22, size, true)
  }
  return out
}

/** Rename one ZIP entry in place (same length), in the local header and the directory. */
export function renameEntry(zip: Uint8Array, from: string, to: string): Uint8Array {
  if (from.length !== to.length) throw new Error('same length only')
  const out = zip.slice()
  const a = strToU8(from)
  const b = strToU8(to)
  for (let i = 0; i + a.length <= out.length; i++) {
    let match = true
    for (let j = 0; j < a.length; j++) {
      if (out[i + j] !== a[j]) {
        match = false
        break
      }
    }
    if (match) out.set(b, i)
  }
  return out
}

export * from './rawZip'
