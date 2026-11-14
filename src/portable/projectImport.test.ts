import { describe, expect, it, vi } from 'vitest'
import { readArchive, sha256Hex } from '../backup/archive'
import { BackupService } from '../backup/backupService'
import { pageLinkIds } from '../domain/pageLink'
import { projectNotes, projectReferences } from '../domain/references'
import { docFromPlainText, docToPlainText } from '../domain/richtext'
import { newId, type CanvasObject, type Page, type RichTextDoc, type TextObject, type WorkspaceRecords } from '../domain/types'
import { emptyChangeSet, IdbRepository, ImportConflictError, OwnershipError } from '../storage/repository'
import { ReadOnlyError, WorkspaceStore } from '../store/workspaceStore'
import { DOCX_PNG } from '../test/docFixtures'
import { freshStore, PNG_1x1 } from '../test/fixtures'
import { DELETED_PAGE_ID, destinationWorkspace, SCREENSHOT_MARKUP, SKETCH_MARKUP, sourceWorkspace, textBox, type SourceWorkspace } from '../test/portableFixtures'
import { technicalDoc } from '../test/richDocs'
import { cleanDoc } from './cleanRecords'
import { planProjectImport, previewProjectImport, uniqueProjectName, verifyImportPlan } from './importPlan'
import { buildProjectExport, importProjectPackage, loadExportSnapshot } from './projectTransfer'
import { readProjectPackage, type ValidPackage } from './readPackage'
import { DEFAULT_EXPORT_OPTIONS } from './selectProject'

async function packageOf(src: SourceWorkspace, options = DEFAULT_EXPORT_OPTIONS): Promise<{ bytes: Uint8Array; pkg: ValidPackage }> {
  const out = await buildProjectExport(await loadExportSnapshot(src.store), src.project.id, options, 'test')
  const pkg = await readProjectPackage(out.bytes)
  if (!pkg.ok) throw new Error(pkg.errors.join('\n'))
  return { bytes: out.bytes, pkg }
}

async function hashes(blobs: Map<string, Blob>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [id, blob] of blobs) out[id] = await sha256Hex(new Uint8Array(await blob.arrayBuffer()))
  return out
}

const KINDS = ['projects', 'tasks', 'templates', 'categories', 'tags', 'notebooks', 'sections', 'pages', 'objects', 'attachments'] as const

/** Every record that existed before is still there and identical; returns the IDs that are new. */
function expectOnlyAdded(before: WorkspaceRecords, after: WorkspaceRecords): Set<string> {
  const added = new Set<string>()
  expect(after.workspace).toEqual(before.workspace)
  for (const kind of KINDS) {
    const old = new Map((before[kind] as { id: string }[]).map((r) => [r.id, r]))
    const kept = (after[kind] as { id: string }[]).filter((r) => old.has(r.id))
    expect(kept.length, kind).toBe(old.size)
    for (const r of kept) expect(r, `${kind} ${r.id}`).toEqual(old.get(r.id))
    for (const r of after[kind] as { id: string }[]) if (!old.has(r.id)) added.add(r.id)
  }
  return added
}

const allIds = (records: WorkspaceRecords) => new Set(KINDS.flatMap((kind) => (records[kind] as { id: string }[]).map((r) => r.id)))
const sorted = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => a.id.localeCompare(b.id))
const canonical = (doc: RichTextDoc) => cleanDoc(doc, { links: 0 })

function inProject(records: WorkspaceRecords, projectId: string) {
  const pages = records.pages.filter((p) => p.location.kind === 'project' && p.location.projectId === projectId)
  const page = (title: string): Page => {
    const found = pages.filter((p) => p.title === title)
    if (found.length !== 1) throw new Error(`${found.length} pages titled ${title}`)
    return found[0]
  }
  const objects = (pageId: string): CanvasObject[] => records.objects.filter((o) => o.pageId === pageId).sort((a, b) => a.y - b.y)
  return { pages, page, objects, tasks: records.tasks.filter((t) => t.projectId === projectId), project: records.projects.find((p) => p.id === projectId)! }
}

describe('project package round trip into another workspace', () => {
  it('imports an independent project with new IDs, rebuilt links, and identical content — and changes nothing that was there', async () => {
    const src = await sourceWorkspace()
    const { pkg } = await packageOf(src)
    const dest = await destinationWorkspace()
    const before = await dest.repo.readAll()
    const beforeHashes = await hashes(before.blobs)

    const result = await importProjectPackage(dest.store, pkg)
    const after = await dest.repo.readAll()

    // ---- nothing existing changed; exactly one revision step
    const added = expectOnlyAdded(before.records, after.records)
    expect(after.revision).toBe(before.revision + 1)
    const afterHashes = await hashes(after.blobs)
    for (const [id, hash] of Object.entries(beforeHashes)) expect(afterHashes[id]).toBe(hash)

    // ---- every imported record has a new ID: none of the package's, none that existed
    const packageIds = new Set([pkg.records.project.id, ...pkg.records.pages.map((p) => p.id), ...pkg.records.objects.map((o) => o.id), ...pkg.records.tasks.map((t) => t.id), ...pkg.records.attachments.map((a) => a.id), ...pkg.records.categories.map((c) => c.id), ...pkg.records.tags.map((t) => t.id)])
    const existed = allIds(before.records)
    for (const id of added) {
      expect(packageIds.has(id)).toBe(false)
      expect(existed.has(id)).toBe(false)
    }
    expect(result.counts).toEqual({ notes: 4, snapshots: 3, linkedExisting: 0, tasks: 4, objects: pkg.records.objects.length, attachments: 4, newCategories: 2, newTags: 1, unresolvedLinks: 4 })
    expect(added.size).toBe(1 + 7 + pkg.records.objects.length + 4 + 4 + 2 + 1)

    // ---- the project: same details, a distinguishable name, its own item IDs
    const got = inProject(after.records, result.projectId)
    expect(result.projectName).toBe('Lift Station 7 upgrade (imported)')
    expect(got.project).toMatchObject({ name: 'Lift Station 7 upgrade (imported)', customer: 'City of Example', site: 'Lift Station 7', jobNumber: 'J-2207', status: 'active', dueDate: '2026-12-15', description: 'Replace the PLC and move the HMI to VTScada.', pinnedPageIds: [], hiddenPageIds: [], archivedAt: null, trashedAt: null })
    expect(got.project.contacts.map(({ name, role, phone, email }) => ({ name, role, phone, email }))).toEqual([{ name: 'Dana Field', role: 'Operator', phone: '555-0100', email: 'dana@example.com' }])
    expect(got.project.equipment.map((x) => [x.name, x.detail])).toEqual([['PLC', '1756-L83E']])
    expect(got.project.software.map((x) => [x.name, x.detail])).toEqual([['VTScada', '12.1.40']])
    expect(got.project.fileLocations.map((f) => [f.label, f.kind, f.value, f.description])).toEqual([
      ['Job folder', 'path', 'C:\\Jobs\\J-2207', 'Drawings and backups'],
      ['Dropbox', 'url', 'https://www.dropbox.com/home/J-2207', 'Shared with the customer'],
    ])
    const sourceItemIds = new Set([...src.project.contacts, ...src.project.equipment, ...src.project.software, ...src.project.fileLocations].map((x) => x.id))
    for (const item of [...got.project.contacts, ...got.project.equipment, ...got.project.software, ...got.project.fileLocations]) expect(sourceItemIds.has(item.id)).toBe(false)
    expect(got.project.order).toBeGreaterThan(dest.existing.order)

    // ---- categories and tags: the same-named ones here are used as they are; the others are new
    const categoryName = (id: string) => after.records.categories.find((c) => c.id === id)!.name
    expect(got.project.categoryIds.map(categoryName)).toEqual(['vtscada', 'Panel building'])
    expect(got.project.categoryIds[0]).toBe(dest.vt.id)
    expect(after.records.categories.map((c) => c.name).sort()).toEqual(['Panel building', 'Safety', 'Studio 5000', 'vtscada'])
    const notes = got.page('Commissioning notes')
    expect(notes.tagIds.map((id) => after.records.tags.find((t) => t.id === id)!.name)).toEqual(['Commissioning', 'io-list'])
    expect(notes.tagIds[0]).toBe(dest.tag.id)
    expect(notes.categoryIds.map(categoryName)).toEqual(['Panel building'])

    // ---- pages: notes and reference snapshots all belong to the new project
    expect([...got.pages].sort((a, b) => a.order - b.order).map((p) => p.title)).toEqual(['LS7 control narrative', 'LS7 procedure', 'Commissioning notes', 'Tag naming', 'Alarm setup', 'Tag naming', 'Ladder tips'])
    expect(got.pages.map((p) => p.order).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(got.pages.every((p) => p.trashedAt === null)).toBe(true)
    const alarm = got.page('Alarm setup')
    // The other project's page that a note links to was never in the package.
    expect(got.pages.some((p) => p.title === 'North station wiring check')).toBe(false)
    expect(JSON.stringify(after.records)).not.toContain('Terminal strip X1 verified')
    const ladder = got.page('Ladder tips')
    const narrative = got.page('LS7 control narrative')
    const procedure = got.page('LS7 procedure')
    const [copy, tagNaming] = got.pages.filter((p) => p.title === 'Tag naming').sort((a, b) => a.order - b.order)
    expect(alarm.copiedFrom).toMatchObject({ pageId: null, title: 'Alarm setup' })
    expect(ladder.copiedFrom).toMatchObject({ pageId: null, title: 'Ladder tips' })
    expect(alarm.categoryIds).toEqual([dest.vt.id])
    // The project copy points at the imported snapshot of its original — not at anything else.
    expect(copy.copiedFrom).toMatchObject({ pageId: tagNaming.id, title: 'Tag naming' })
    expect(result.idMap.pages.get(src.library.alarm.id)).toBe(alarm.id)

    // ---- rich text: identical content; page links lead to the imported pages
    const [technical, links, screenshot, sketch] = got.objects(notes.id)
    expect((technical as TextObject).doc).toEqual(technicalDoc(narrative.id))
    expect(canonical(technicalDoc(narrative.id))).toEqual(technicalDoc(narrative.id)) // the import's clean-up changes nothing in a normal note
    expect(docToPlainText((technical as TextObject).doc)).toBe(docToPlainText(src.notes.technical.doc))
    const linkIds = pageLinkIds((links as TextObject).doc)
    expect(linkIds[0]).toBe(alarm.id)
    // Links to pages that did not come along lead nowhere — never to a page of this workspace.
    const [deadOther, deadTrash, deadDeleted] = linkIds.slice(1)
    for (const id of [deadOther, deadTrash, deadDeleted]) {
      expect(after.records.pages.some((p) => p.id === id)).toBe(false)
      expect([src.otherProject.otherNote.id, src.library.trashedTarget.id, DELETED_PAGE_ID]).not.toContain(id)
    }
    expect(result.idMap.unresolvedLinks.get(src.otherProject.otherNote.id)).toBe(deadOther)
    expect(result.idMap.unresolvedLinks.get(src.library.trashedTarget.id)).toBe(deadTrash)
    expect(docToPlainText((links as TextObject).doc)).toBe(docToPlainText(src.notes.links.doc))
    expect(JSON.stringify((links as TextObject).doc)).toContain('"href":"https://example.com/manual"')
    // The snapshot's own link (to a page that was not included) is dead too; the destination's same-titled page is not involved.
    const alarmText = got.objects(alarm.id)[0] as TextObject
    expect(pageLinkIds(alarmText.doc)).toEqual([result.idMap.unresolvedLinks.get(src.library.deep.id)])
    expect(JSON.stringify(after.records.objects.filter((o) => added.has(o.id)))).not.toContain(dest.libraryPage.id)

    // ---- images, markup, sketch: same geometry and annotations; bytes identical under new attachment IDs
    expect(screenshot).toMatchObject({ type: 'image', alt: 'HMI screenshot.png', x: 48, y: 320, w: 320, h: 160, markup: SCREENSHOT_MARKUP })
    expect(sketch).toMatchObject({ type: 'sketch', x: 48, y: 520, w: 600, h: 300, markup: SKETCH_MARKUP })
    const attachmentId = (screenshot as { attachmentId: string }).attachmentId
    expect(attachmentId).not.toBe(src.notes.screenshot.attachmentId)
    expect(attachmentId).not.toBe(dest.image.attachmentId) // same bytes as an image that was already here, still its own file
    expect(afterHashes[attachmentId]).toBe(await sha256Hex(PNG_1x1))
    expect(after.records.attachments.find((a) => a.id === attachmentId)).toMatchObject({ fileName: 'HMI screenshot.png', mimeType: 'image/png', size: PNG_1x1.byteLength, sha256: await sha256Hex(PNG_1x1), source: 'paste' })
    const alarmImage = got.objects(alarm.id)[1] as { attachmentId: string }
    expect(afterHashes[alarmImage.attachmentId]).toBe(await sha256Hex(DOCX_PNG))

    // ---- imported documents: the originals are attached to the imported drafts, byte for byte
    expect(narrative.importedFrom).toMatchObject({ fileName: 'LS7 control narrative.pdf', format: 'pdf', notes: ['Page layout is not reproduced.'] })
    expect(afterHashes[narrative.importedFrom!.attachmentId]).toBe(await sha256Hex(src.files.pdf))
    expect(after.blobs.get(narrative.importedFrom!.attachmentId)!.type).toBe('application/pdf')
    expect(procedure.importedFrom).toMatchObject({ fileName: 'LS7 procedure.docx', format: 'docx' })
    expect(afterHashes[procedure.importedFrom!.attachmentId]).toBe(await sha256Hex(src.files.docx))
    expect(narrative.importedFrom!.attachmentId).not.toBe(src.notes.narrative.importedFrom!.attachmentId)

    // ---- tasks: status, order, priority, date-only due dates, and links to the imported pages
    const task = (title: string) => got.tasks.find((t) => t.title === title)!
    expect(got.tasks).toHaveLength(4)
    expect(task('Check I/O list')).toMatchObject({ status: 'todo', order: 2, priority: 'high', dueDate: '2026-11-20', description: 'Compare with drawings', linkedPageIds: [notes.id, ladder.id], completedAt: null })
    expect(task('Site acceptance test')).toMatchObject({ status: 'todo', order: 1, priority: 'low', dueDate: '2026-12-10' })
    expect(task('Configure alarms')).toMatchObject({ status: 'doing', priority: 'urgent', linkedPageIds: [alarm.id] })
    expect(task('Order panel parts')).toMatchObject({ status: 'done', linkedPageIds: [narrative.id] })
    expect(task('Order panel parts').completedAt).toBe(src.store.getState().data.tasks[src.tasks.t4.id].completedAt)

    // ---- in this window right away, and after a reload from storage
    const live = dest.store.getState().data
    expect(live.revision).toBe(after.revision)
    expect(live.projects[result.projectId].name).toBe('Lift Station 7 upgrade (imported)')
    expect(projectNotes(result.projectId, live.pages)).toHaveLength(7)
    expect(dest.store.getState().save.status).toBe('saved')
    // The destination's own library is suggested by the shared category; nothing is pinned or silently linked.
    const refs = projectReferences(live.projects[result.projectId], live)
    expect(refs.pinned).toEqual([])
    expect(refs.suggested.map((p) => p.id)).toEqual([dest.libraryPage.id])
    const reloaded = new WorkspaceStore(dest.repo)
    await reloaded.load()
    expect(reloaded.getState().data.projects[result.projectId]).toEqual(live.projects[result.projectId])
    expect(Object.values(await reloaded.ensurePageObjects(notes.id))).toHaveLength(4)
    expect(await reloaded.getBlob(attachmentId)).toBeDefined()
    expect((await reloaded.pagesLinkingTo(narrative.id)).map((p) => p.id)).toEqual([notes.id])

    // ---- a full backup made after the import validates and restores into a clean workspace
    const backup = new BackupService(dest.store, { appVersion: 'test', folderSupported: false })
    const archive = await readArchive((await backup.createArchive()).bytes)
    if (!archive.ok) throw new Error(archive.errors.join('\n'))
    expect(archive.summary.counts.projects).toBe(before.records.projects.length + 1)
    expect(archive.warnings.join(' ')).toMatch(/2 notes link to a page that was deleted forever/)
    const clean = await freshStore()
    await new BackupService(clean.store, { appVersion: 'test', folderSupported: false }).restore(archive)
    const restored = await clean.repo.readAll()
    for (const kind of KINDS) expect(sorted(restored.records[kind] as { id: string }[]), kind).toEqual(sorted(after.records[kind] as { id: string }[]))
    expect(await hashes(restored.blobs)).toEqual(afterHashes)
  })

  it('the imported copy and the source are independent in both directions', async () => {
    const src = await sourceWorkspace()
    const { pkg } = await packageOf(src)
    // Import into the very workspace it came from: every package ID already exists here.
    const before = await src.repo.readAll()
    const result = await importProjectPackage(src.store, pkg)
    const mid = await src.repo.readAll()
    const added = expectOnlyAdded(before.records, mid.records)
    expect(result.projectName).toBe('Lift Station 7 upgrade (imported)')
    expect(added.has(src.project.id)).toBe(false)

    // Edit the imported copy thoroughly.
    const copy = inProject(mid.records, result.projectId)
    const notes = copy.page('Commissioning notes')
    const objects = await src.store.ensurePageObjects(notes.id)
    const text = Object.values(objects).find((o) => o.type === 'text')!
    src.store.updateObjects(notes.id, [{ id: text.id, patch: { doc: docFromPlainText('Changed only in the imported copy') } }], 'Edit')
    const image = Object.values(objects).find((o) => o.type === 'image')!
    src.store.updateObjects(notes.id, [{ id: image.id, patch: { markup: { ...SCREENSHOT_MARKUP, items: [] } } }], 'Mark up')
    src.store.renamePage(notes.id, 'Commissioning notes (copy)')
    src.store.updateProject(result.projectId, { customer: 'Another customer', dueDate: '2027-01-31' })
    const task = copy.tasks.find((t) => t.title === 'Check I/O list')!
    src.store.setTaskDone(task.id, true)
    src.store.deleteTask(copy.tasks.find((t) => t.title === 'Site acceptance test')!.id)
    src.store.trashPage(copy.page('Alarm setup').id)
    await src.store.deletePageForever(copy.page('LS7 procedure').id)
    await src.store.flush()
    // …and the source project: the copy must not follow.
    src.store.renamePage(src.notes.narrative.id, 'LS7 control narrative (source edit)')
    src.store.updateObjects(src.library.alarm.id, [{ id: Object.keys(await src.store.ensurePageObjects(src.library.alarm.id))[0], patch: { x: 99 } }], 'Move')
    await src.store.flush()

    const after = await src.repo.readAll()
    const strip = (records: WorkspaceRecords) => ({
      project: records.projects.find((p) => p.id === src.project.id),
      pages: sorted(records.pages.filter((p) => !added.has(p.id) && p.id !== src.notes.narrative.id && p.id !== src.library.alarm.id)),
      objects: sorted(records.objects.filter((o) => !added.has(o.id) && o.pageId !== src.library.alarm.id)),
      tasks: sorted(records.tasks.filter((t) => !added.has(t.id))),
      attachments: sorted(records.attachments.filter((a) => !added.has(a.id))),
      other: records.projects.find((p) => p.id === src.other.id),
    })
    expect(strip(after.records)).toEqual(strip(before.records))
    const edited = inProject(after.records, result.projectId)
    expect(edited.page('LS7 control narrative').title).toBe('LS7 control narrative') // the copy did not follow the source's rename
    expect(edited.objects(mid.records.pages.find((p) => p.id === result.idMap.pages.get(src.library.alarm.id))!.id)[0].x).toBe(48)
    // The source's files are all still there (the copy has its own).
    for (const a of before.records.attachments) expect(after.blobs.has(a.id)).toBe(true)
    // A backup of the result still validates.
    const archive = await readArchive((await new BackupService(src.store, { appVersion: 'test', folderSupported: false }).createArchive()).bytes)
    expect(archive.ok).toBe(true)
  })

  it('names never collide: “(imported)”, then “(imported 2)”, compared without case or accents', async () => {
    const src = await sourceWorkspace()
    const { pkg } = await packageOf(src)
    const dest = await freshStore()
    const names: string[] = []
    for (let i = 0; i < 3; i++) names.push((await importProjectPackage(dest.store, pkg)).projectName)
    expect(names).toEqual(['Lift Station 7 upgrade', 'Lift Station 7 upgrade (imported)', 'Lift Station 7 upgrade (imported 2)'])
    const projects = Object.values(dest.store.getState().data.projects)
    expect(projects).toHaveLength(3)
    expect(new Set(projects.map((p) => p.id)).size).toBe(3)
    expect(Object.keys(dest.store.getState().data.pages)).toHaveLength(21)
    // Three independent sets of files.
    expect(Object.keys(dest.store.getState().data.attachments)).toHaveLength(12)

    expect(uniqueProjectName('Café Pump', [{ name: 'cafe pump' }])).toBe('Café Pump (imported)')
    expect(uniqueProjectName('  ', [])).toBe('Untitled project')
    expect(uniqueProjectName('A', [{ name: 'a' }, { name: 'A (IMPORTED)' }, { name: 'a (imported 2)' }])).toBe('A (imported 3)')
    // A project in the Trash or archived still keeps its name to itself.
    dest.store.trashProject(projects[0].id)
    dest.store.setProjectArchived(projects[1].id, true)
    expect(previewProjectImport(pkg, dest.store.getState().data)).toMatchObject({ projectName: 'Lift Station 7 upgrade (imported 3)', renamedFrom: 'Lift Station 7 upgrade' })
  })
})

describe('ID mapping', () => {
  it('is explicit and deterministic, and every relationship resolves inside the import', async () => {
    const src = await sourceWorkspace()
    const { pkg } = await packageOf(src)
    const dest = await destinationWorkspace()
    const counter = () => {
      let n = 0
      return () => `new-${String(++n).padStart(4, '0')}`
    }
    const data = dest.store.getState().data
    const a = planProjectImport(pkg, data, undefined, counter(), '2026-11-11T12:00:00.000Z')
    const b = planProjectImport(pkg, data, undefined, counter(), '2026-11-11T12:00:00.000Z')
    const flat = (plan: typeof a) => JSON.stringify({ changes: Object.fromEntries(Object.entries(plan.batch.changes).map(([k, m]) => [k, [...m.entries()]])), attachments: plan.batch.attachments.map((x) => x.meta), mustExist: plan.batch.mustExist, id: plan.projectId })
    expect(flat(a)).toBe(flat(b))
    expect(a.projectId).toBe('new-0001')
    verifyImportPlan(a, data)

    // One mapping entry per packaged record.
    expect(a.idMap.pages.size).toBe(pkg.records.pages.length)
    expect(a.idMap.objects.size).toBe(pkg.records.objects.length)
    expect(a.idMap.tasks.size).toBe(pkg.records.tasks.length)
    expect(a.idMap.attachments.size).toBe(pkg.records.attachments.length)
    expect(a.idMap.categories.size).toBe(pkg.records.categories.length)
    expect(a.idMap.tags.size).toBe(pkg.records.tags.length)
    expect([...a.idMap.unresolvedLinks.keys()].sort()).toEqual([DELETED_PAGE_ID, src.library.deep.id, src.library.trashedTarget.id, src.otherProject.otherNote.id].sort())
    // The existing records the import relies on are exactly the same-named labels.
    expect(a.batch.mustExist).toEqual([
      { store: 'categories', id: dest.vt.id },
      { store: 'tags', id: dest.tag.id },
    ])

    // No packaged ID survives anywhere in the new records.
    const json = flat(a)
    for (const id of [pkg.records.project.id, ...pkg.records.pages.map((p) => p.id), ...pkg.records.objects.map((o) => o.id), ...pkg.records.tasks.map((t) => t.id), ...pkg.records.attachments.map((x) => x.id), ...pkg.records.categories.map((c) => c.id), DELETED_PAGE_ID, src.library.deep.id]) {
      expect(json.includes(id), id).toBe(false)
    }
  })

  it('never lands on an ID that is already used: colliding IDs are asked for again, and hopeless ID sources are refused', async () => {
    const src = await sourceWorkspace()
    const { pkg } = await packageOf(src)
    const dest = await destinationWorkspace()
    const before = await dest.repo.readAll()
    // An ID source that first offers IDs that exist in the workspace and in the package.
    const taken = [dest.existing.id, dest.existingNote.id, dest.image.attachmentId, dest.task.id, dest.vt.id, pkg.records.project.id, pkg.records.pages[0].id, '', DELETED_PAGE_ID]
    let i = 0
    const result = await importProjectPackage(dest.store, pkg, undefined, { makeId: () => taken[i++] ?? newId() })
    expect(i).toBeGreaterThan(taken.length)
    const after = await dest.repo.readAll()
    const added = expectOnlyAdded(before.records, after.records)
    for (const id of taken) expect(added.has(id)).toBe(false)
    expect(after.records.projects.find((p) => p.id === result.projectId)!.name).toBe('Lift Station 7 upgrade (imported)')

    // An ID source that only ever returns a used ID: nothing is written.
    const mid = await dest.repo.readAll()
    await expect(importProjectPackage(dest.store, pkg, undefined, { makeId: () => dest.existing.id })).rejects.toThrow(/could not create unused IDs/)
    const end = await dest.repo.readAll()
    expect(end.records).toEqual(mid.records)
    expect(end.revision).toBe(mid.revision)
  })

  it('a workspace record that happens to share a packaged ID is neither overwritten nor linked', async () => {
    const src = await sourceWorkspace()
    const { pkg } = await packageOf(src)
    const dest = await destinationWorkspace()
    // Pretend this other workspace has pages, a task, and a category under the very IDs the package uses.
    const data = structuredClone(dest.store.getState().data)
    const alien = (id: string, title: string): Page => ({ ...data.pages[dest.inbox.id], id, title })
    data.pages[src.library.alarm.id] = alien(src.library.alarm.id, 'ALIEN alarm page')
    data.pages[src.notes.narrative.id] = alien(src.notes.narrative.id, 'ALIEN narrative')
    data.pages[DELETED_PAGE_ID] = alien(DELETED_PAGE_ID, 'ALIEN page under the deleted link')
    data.categories[src.categories.panel.id] = { ...data.categories[dest.safety.id], id: src.categories.panel.id, name: 'ALIEN category' }
    data.tasks[src.tasks.t1.id] = { ...data.tasks[dest.task.id], id: src.tasks.t1.id }

    expect(previewProjectImport(pkg, data).reuseCandidates).toEqual([]) // another workspace: an equal ID means nothing
    const plan = planProjectImport(pkg, data, { reuseExisting: true })
    verifyImportPlan(plan, data)
    const json = JSON.stringify([...plan.batch.changes.pages.values(), ...plan.batch.changes.objects.values(), ...plan.batch.changes.tasks.values(), ...plan.batch.changes.projects.values()])
    for (const id of [src.library.alarm.id, src.notes.narrative.id, DELETED_PAGE_ID, src.categories.panel.id, src.tasks.t1.id]) expect(json.includes(id), id).toBe(false)
    expect(plan.batch.mustExist.map((m) => m.id)).toEqual([dest.vt.id, dest.tag.id])
    // “Panel building” is matched by name only: the alien category with its ID is not used.
    expect([...plan.batch.changes.categories.values()].map((c) => c!.name).sort()).toEqual(['Panel building', 'Studio 5000'])
  })

  it('reference pages can be linked to the same pages of this library — only when asked, and only in the workspace they came from', async () => {
    const src = await sourceWorkspace()
    const { pkg } = await packageOf(src)
    const data = src.store.getState().data
    // Same workspace: the three library pages qualify; the other project's note does not.
    expect(previewProjectImport(pkg, data).reuseCandidates.map((c) => c.title)).toEqual(['Alarm setup', 'Tag naming', 'Ladder tips'])
    // Not when a page was created at another time (another record under the same ID), or is in the Trash.
    const changed = structuredClone(data)
    changed.pages[src.library.alarm.id].createdAt = '2020-01-01T00:00:00.000Z'
    changed.pages[src.library.ladder.id].trashedAt = '2026-11-01T00:00:00.000Z'
    expect(previewProjectImport(pkg, changed).reuseCandidates.map((c) => c.title)).toEqual(['Tag naming'])

    const before = await src.repo.readAll()
    const result = await importProjectPackage(src.store, pkg, { reuseExisting: true })
    const after = await src.repo.readAll()
    expectOnlyAdded(before.records, after.records) // the reused library pages are untouched
    expect(result.counts).toMatchObject({ notes: 4, snapshots: 0, linkedExisting: 3, attachments: 3 })
    const got = inProject(after.records, result.projectId)
    expect(got.pages.map((p) => p.title).sort()).toEqual(['Commissioning notes', 'LS7 control narrative', 'LS7 procedure', 'Tag naming'])
    expect(got.project.pinnedPageIds.sort()).toEqual([src.library.alarm.id, src.library.tagNaming.id, src.library.ladder.id].sort())
    const links = got.objects(got.page('Commissioning notes').id)[1] as TextObject
    // The link to the library page leads to that page again; the link to the other project's page was not
    // packaged, so it is unavailable — even here, where that very page still exists under its old ID.
    const [toAlarm, toWiring] = pageLinkIds(links.doc)
    expect(toAlarm).toBe(src.library.alarm.id)
    expect(toWiring).not.toBe(src.otherProject.otherNote.id)
    expect(after.records.pages.some((p) => p.id === toWiring)).toBe(false)
    expect(got.tasks.find((t) => t.title === 'Configure alarms')!.linkedPageIds).toEqual([src.library.alarm.id])
    expect(got.page('Tag naming').copiedFrom?.pageId).toBe(src.library.tagNaming.id)
    const live = src.store.getState().data
    expect(projectReferences(live.projects[result.projectId], live).pinned.map((p) => p.title).sort()).toEqual(['Alarm setup', 'Ladder tips', 'Tag naming'])

    // Without asking, the same import makes independent snapshots.
    const plain = await importProjectPackage(src.store, pkg)
    expect(plain.counts).toMatchObject({ snapshots: 3, linkedExisting: 0 })
  })
})

describe('a failed import changes nothing', () => {
  async function setup() {
    const src = await sourceWorkspace()
    const { pkg } = await packageOf(src)
    const dest = await destinationWorkspace()
    const before = await dest.repo.readAll()
    const beforeHashes = await hashes(before.blobs)
    const unchanged = async () => {
      const now = await dest.repo.readAll()
      expect(now.records).toEqual(before.records)
      expect(now.revision).toBe(before.revision)
      expect(await hashes(now.blobs)).toEqual(beforeHashes)
      // The window still shows exactly what is stored.
      const live = dest.store.getState().data
      expect(Object.keys(live.projects).sort()).toEqual(before.records.projects.map((p) => p.id).sort())
      expect(Object.keys(live.pages).sort()).toEqual(before.records.pages.map((p) => p.id).sort())
      expect(Object.keys(live.attachments).sort()).toEqual(before.records.attachments.map((a) => a.id).sort())
      expect(live.revision).toBe(before.revision)
    }
    return { src, pkg, dest, before, unchanged }
  }

  it('a write that fails part-way (interrupted, disk full) rolls back every record and file', async () => {
    const { pkg, dest, unchanged } = await setup()
    const original = IDBObjectStore.prototype.add
    // Simulated: the browser rejects one write in the middle of the import transaction.
    for (const failAt of [1, 7, 30]) {
      let calls = 0
      IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
        if (++calls === failAt) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        return original.apply(this, args)
      }
      try {
        await expect(importProjectPackage(dest.store, pkg)).rejects.toMatchObject({ name: 'QuotaExceededError' })
        expect(calls).toBeGreaterThanOrEqual(failAt)
      } finally {
        IDBObjectStore.prototype.add = original
      }
      await unchanged()
    }
    // The same package imports normally afterwards.
    const ok = await importProjectPackage(dest.store, pkg)
    expect(dest.store.getState().data.projects[ok.projectId].name).toBe('Lift Station 7 upgrade (imported)')
  })

  it('an asynchronous storage error on one record aborts the whole transaction', async () => {
    const { pkg, dest, unchanged } = await setup()
    // Simulated: one imported record gets a key that already exists, as if another writer had used it.
    const plan = planProjectImport(pkg, dest.store.getState().data)
    const victim = [...plan.batch.changes.objects.values()][5]!
    const clash = { ...victim, id: (await dest.repo.loadPageObjects(dest.existingNote.id))[0].id }
    plan.batch.changes.objects.delete(victim.id)
    plan.batch.changes.objects.set(clash.id, clash)
    await expect(dest.repo.importRecords(plan.batch, new Date().toISOString(), (await dest.repo.getSetting<{ token: string }>('editorOwner'))?.token ?? null)).rejects.toBeInstanceOf(ImportConflictError)
    await unchanged()
  })

  it('even without the advance check, the browser refuses to overwrite: an existing key aborts the transaction', async () => {
    const { pkg, dest, unchanged } = await setup()
    const token = (await dest.repo.getSetting<{ token: string }>('editorOwner'))?.token ?? null
    const plan = planProjectImport(pkg, dest.store.getState().data)
    const last = [...plan.batch.changes.objects.values()].at(-1)!
    const existingId = (await dest.repo.loadPageObjects(dest.existingNote.id))[0].id
    plan.batch.changes.objects.delete(last.id)
    plan.batch.changes.objects.set(existingId, { ...last, id: existingId })
    plan.batch.mustExist = []
    // Simulated: the advance "is this ID free?" lookups all answer yes.
    const original = IDBObjectStore.prototype.getKey
    IDBObjectStore.prototype.getKey = function (this: IDBObjectStore) {
      return original.call(this, 'no-such-key')
    }
    try {
      await expect(dest.repo.importRecords(plan.batch, new Date().toISOString(), token)).rejects.toMatchObject({ name: 'ConstraintError' })
    } finally {
      IDBObjectStore.prototype.getKey = original
    }
    await unchanged()
    expect((await dest.repo.loadPageObjects(dest.existingNote.id))[0]).not.toMatchObject({ pageId: last.pageId })
  })

  it('storage refuses a batch that would replace a record or a file, or whose linked records are gone', async () => {
    const { pkg, dest, unchanged } = await setup()
    const token = (await dest.repo.getSetting<{ token: string }>('editorOwner'))?.token ?? null
    const at = new Date().toISOString()
    const fresh = () => planProjectImport(pkg, dest.store.getState().data).batch

    // An existing page ID among the new records.
    let batch = fresh()
    batch.changes.pages.set(dest.inbox.id, { ...[...batch.changes.pages.values()][0]!, id: dest.inbox.id })
    await expect(dest.repo.importRecords(batch, at, token)).rejects.toThrow(/would replace something that is already in this workspace/)
    await unchanged()

    // An existing attachment ID among the new files.
    batch = fresh()
    batch.attachments[0] = { ...batch.attachments[0], meta: { ...batch.attachments[0].meta, id: dest.image.attachmentId } }
    await expect(dest.repo.importRecords(batch, at, token)).rejects.toBeInstanceOf(ImportConflictError)
    await unchanged()

    // A deletion smuggled into an import.
    batch = fresh()
    batch.changes.pages.set(dest.inbox.id, null)
    await expect(dest.repo.importRecords(batch, at, token)).rejects.toThrow(/invalid record/)
    await unchanged()

    // A category the plan relies on no longer exists.
    batch = fresh()
    batch.mustExist.push({ store: 'categories', id: 'gone' })
    await expect(dest.repo.importRecords(batch, at, token)).rejects.toThrow(/no longer in this workspace/)
    await unchanged()

    // The final check of the plan catches the same before storage is even asked.
    const plan = planProjectImport(pkg, dest.store.getState().data)
    plan.batch.changes.pages.set(dest.inbox.id, { ...[...plan.batch.changes.pages.values()][0]!, id: dest.inbox.id })
    expect(() => verifyImportPlan(plan, dest.store.getState().data)).toThrow(/would replace a record that is already in this workspace/)
    const dangling = planProjectImport(pkg, dest.store.getState().data)
    const task = [...dangling.batch.changes.tasks.values()][0]!
    dangling.batch.changes.tasks.set(task.id, { ...task, linkedPageIds: [dest.libraryPage.id] })
    expect(() => verifyImportPlan(dangling, dest.store.getState().data)).toThrow(/links to a page outside the import/)
    await unchanged()
  })

  it('a read-only window cannot import', async () => {
    const { pkg, dest, unchanged } = await setup()
    dest.store.setReadOnly(true)
    await expect(importProjectPackage(dest.store, pkg)).rejects.toThrow(/only possible in the window that is editing/)
    await expect(dest.store.addImportedRecords(() => ({ changes: emptyChangeSet(), attachments: [], mustExist: [] }))).rejects.toBeInstanceOf(ReadOnlyError)
    await unchanged()
    dest.store.setReadOnly(false)
    dest.store.revokeOwnership() // editing was taken by another window
    await expect(importProjectPackage(dest.store, pkg)).rejects.toThrow(/only possible in the window that is editing/)
    await unchanged()
  })

  it('a window whose editing ownership is stale is fenced out by storage, and becomes read-only', async () => {
    const { pkg, dest, before } = await setup()
    // Another window claims ownership behind this window's back (as after a stolen lock).
    const other = new WorkspaceStore(await IdbRepository.open((dest.repo as unknown as { db: { name: string } }).db.name))
    await other.load()
    await other.becomeEditor()
    const theirs = other.createPage({ kind: 'inbox' }, 'Written by the new editor')
    await other.flush()

    await expect(importProjectPackage(dest.store, pkg)).rejects.toBeInstanceOf(OwnershipError)
    expect(dest.store.getState().readOnly).toBe(true)
    expect(dest.store.getState().owner).toBe(false)
    const now = await dest.repo.readAll()
    expect(now.records.projects).toEqual(before.records.projects)
    expect(now.records.pages.map((p) => p.id).sort()).toEqual([...before.records.pages.map((p) => p.id), theirs.id].sort())
    expect(now.records.attachments).toEqual(before.records.attachments)
    // The window that owns editing can import.
    await other.load()
    const ok = await importProjectPackage(other, pkg)
    expect(other.getState().data.projects[ok.projectId]).toBeDefined()
  })

  it('unsaved edits are saved first; if they cannot be saved, nothing is imported and the edits are kept', async () => {
    const { pkg, dest } = await setup()
    dest.store.renamePage(dest.inbox.id, 'Renamed just before importing')
    // Simulated storage failure for ordinary saves.
    const commit = vi.spyOn(dest.repo, 'commit').mockRejectedValue(new DOMException('full', 'QuotaExceededError'))
    const imported = vi.spyOn(dest.repo, 'importRecords')
    await expect(importProjectPackage(dest.store, pkg)).rejects.toThrow(/could not be saved, so nothing was imported/)
    expect(imported).not.toHaveBeenCalled()
    expect(Object.keys(dest.store.getState().data.projects)).toHaveLength(1)
    expect(dest.store.getState().data.pages[dest.inbox.id].title).toBe('Renamed just before importing')
    expect(dest.store.hasUnsavedChanges).toBe(true)

    // Once saving works again, the pending edit is saved first and then the import lands on top of it.
    commit.mockRestore()
    const ok = await importProjectPackage(dest.store, pkg)
    const after = await dest.repo.readAll()
    expect(after.records.pages.find((p) => p.id === dest.inbox.id)!.title).toBe('Renamed just before importing')
    expect(after.records.projects.some((p) => p.id === ok.projectId)).toBe(true)
    expect(dest.store.hasUnsavedChanges).toBe(false)
  })

  it('refuses early when the browser reports too little free storage', async () => {
    const { pkg, dest, unchanged } = await setup()
    await expect(importProjectPackage(dest.store, pkg, undefined, { freeBytes: async () => 10 })).rejects.toThrow(/not enough free browser storage/)
    await unchanged()
    // Unknown free space does not block; storage itself is the judge.
    const ok = await importProjectPackage(dest.store, pkg, undefined, { freeBytes: async () => null })
    expect(ok.counts.attachments).toBe(4)
  })

  it('edits made just before an import are saved first, and the undo history of open pages survives it', async () => {
    const { pkg, dest } = await setup()
    await dest.store.ensurePageObjects(dest.inbox.id)
    const box = textBox(dest.inbox.id, 'typed before the import')
    dest.store.addObjects(dest.inbox.id, [box])
    const result = await importProjectPackage(dest.store, pkg)
    expect(dest.store.canUndo(dest.inbox.id)).toBe(true)
    expect(dest.store.getObject(dest.inbox.id, box.id)).toBeDefined()
    dest.store.renamePage(dest.inbox.id, 'Edited after the import')
    await dest.store.flush()
    const after = await dest.repo.readAll()
    expect(after.records.pages.find((p) => p.id === dest.inbox.id)!.title).toBe('Edited after the import')
    expect(after.records.objects.some((o) => o.id === box.id)).toBe(true)
    expect(after.records.projects.some((p) => p.id === result.projectId)).toBe(true)
  })
})

describe('while an import is in progress', () => {
  /**
   * A barrier inside the import: from the import's first write on, its storage
   * transaction is kept open (by reading in it again and again) until the test
   * lets go. Everything the import wrote is in the transaction but not yet
   * committed, and every other write to the database has to wait behind it —
   * which is exactly the state "an import is in progress".
   *
   * Nothing here waits for time to pass: `turns` resolves after a number of
   * further reads have completed inside the held transaction.
   */
  function holdImportOpen() {
    const original = IDBObjectStore.prototype.add
    let mode: 'hold' | 'commit' | 'abort' = 'hold'
    let reads = 0
    let waiters: { at: number; go: () => void }[] = []
    let reached!: () => void
    const atBarrier = new Promise<void>((resolve) => (reached = resolve))
    let first = true
    IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
      if (first) {
        first = false
        const tx = this.transaction
        const spin = () => {
          reads++
          waiters = waiters.filter((w) => (w.at <= reads ? (w.go(), false) : true))
          if (mode === 'abort') return tx.abort()
          if (mode === 'commit') return // no further request: the transaction commits
          tx.objectStore('settings').get('held-open').onsuccess = spin
        }
        tx.objectStore('settings').get('held-open').onsuccess = spin
        reached()
      }
      return original.apply(this, args)
    }
    const stop = (how: 'commit' | 'abort') => {
      mode = how
      IDBObjectStore.prototype.add = original
    }
    return {
      atBarrier,
      /** Resolves after `n` more reads have completed in the held transaction (other work gets its turn meanwhile). */
      turns: (n: number) => new Promise<void>((go) => waiters.push({ at: reads + n, go })),
      /** Let the import commit. */
      release: () => stop('commit'),
      /** Make the import fail at this point (as when the browser aborts the transaction). */
      abort: () => stop('abort'),
      restore: () => void (IDBObjectStore.prototype.add = original),
    }
  }

  const settledFlag = (promise: Promise<unknown>) => {
    const state = { settled: false }
    promise.then(
      () => (state.settled = true),
      () => (state.settled = true),
    )
    return state
  }

  async function setup() {
    const src = await sourceWorkspace()
    const { pkg } = await packageOf(src)
    const dest = await destinationWorkspace()
    await dest.store.ensurePageObjects(dest.inbox.id)
    const before = await dest.repo.readAll()
    return { pkg, dest, before }
  }

  it('an unrelated edit made during the import is kept, saved right after it, and can still be undone', async () => {
    const { pkg, dest, before } = await setup()
    const hold = holdImportOpen()
    try {
      const importing = importProjectPackage(dest.store, pkg)
      const imported = settledFlag(importing)
      await hold.atBarrier

      // ---- the import is in progress: its records are written but not committed
      expect(Object.keys(dest.store.getState().data.projects)).toHaveLength(1)
      const box = textBox(dest.inbox.id, 'typed while the import was running')
      dest.store.addObjects(dest.inbox.id, [box])
      dest.store.renamePage(dest.inbox.id, 'Renamed while the import was running')
      const saving = dest.store.flush()
      const saved = settledFlag(saving)
      await hold.turns(25)
      // Neither has finished: the save is waiting behind the import, and the window says so.
      expect(imported.settled).toBe(false)
      expect(saved.settled).toBe(false)
      expect(dest.store.getState().save.status).toBe('saving')
      expect(dest.store.hasUnsavedChanges).toBe(true)
      expect(Object.keys(dest.store.getState().data.projects)).toHaveLength(1)

      // ---- let the import finish
      hold.release()
      const result = await importing
      // The edit's save is still under way at this moment; the window must not claim that everything is saved.
      expect(saved.settled).toBe(false)
      expect(dest.store.getState().save.status).toBe('saving')
      expect(dest.store.hasUnsavedChanges).toBe(true)
      // The imported project is shown, and the edit is still there.
      const live = dest.store.getState().data
      expect(live.projects[result.projectId].name).toBe('Lift Station 7 upgrade (imported)')
      expect(live.pages[dest.inbox.id].title).toBe('Renamed while the import was running')
      expect(dest.store.getObject(dest.inbox.id, box.id)).toBeDefined()
      expect(live.revision).toBe(before.revision + 1)

      expect(await saving).toBe(true)
      expect(dest.store.getState().save).toMatchObject({ status: 'saved', error: null })
      expect(dest.store.hasUnsavedChanges).toBe(false)

      // ---- stored: the import and the edit, in that order, each as one revision
      const after = await dest.repo.readAll()
      expect(after.revision).toBe(before.revision + 2)
      expect(dest.store.getState().data.revision).toBe(after.revision)
      expect(after.records.pages.find((p) => p.id === dest.inbox.id)!.title).toBe('Renamed while the import was running')
      expect(after.records.objects.find((o) => o.id === box.id)).toMatchObject({ pageId: dest.inbox.id })
      const got = inProject(after.records, result.projectId)
      expect(got.pages).toHaveLength(result.counts.notes + result.counts.snapshots)
      expect(after.records.objects.filter((o) => got.pages.some((p) => p.id === o.pageId))).toHaveLength(result.counts.objects)
      expect(got.tasks).toHaveLength(result.counts.tasks)
      // Everything else that was there is exactly as it was.
      const untouched = (r: WorkspaceRecords): WorkspaceRecords => ({ ...r, pages: r.pages.filter((p) => p.id !== dest.inbox.id) })
      const added = expectOnlyAdded(untouched(before.records), untouched(after.records))
      expect(added.has(box.id)).toBe(true)
      expect(await hashes(new Map([...after.blobs].filter(([id]) => before.blobs.has(id))))).toEqual(await hashes(before.blobs))

      // ---- undo history of the open page survived the import, and undoing does not touch the imported project
      expect(dest.store.canUndo(dest.inbox.id)).toBe(true)
      expect(dest.store.undo(dest.inbox.id)).toBe(true)
      expect(dest.store.getObject(dest.inbox.id, box.id)).toBeUndefined()
      expect(await dest.store.flush()).toBe(true)
      const undone = await dest.repo.readAll()
      expect(undone.revision).toBe(before.revision + 3)
      expect(undone.records.objects.some((o) => o.id === box.id)).toBe(false)
      expect(inProject(undone.records, result.projectId).pages).toHaveLength(got.pages.length)
      expect(undone.records.pages.find((p) => p.id === dest.inbox.id)!.title).toBe('Renamed while the import was running')
      // A fresh window reads the same from storage.
      const reopened = new WorkspaceStore(dest.repo)
      await reopened.load()
      expect(reopened.getState().data.projects[result.projectId].name).toBe('Lift Station 7 upgrade (imported)')
      expect(reopened.getState().data.revision).toBe(undone.revision)
    } finally {
      hold.restore()
    }
  })

  it('if the import fails while an edit is waiting behind it, nothing is imported and the edit is still saved', async () => {
    const { pkg, dest, before } = await setup()
    const hold = holdImportOpen()
    try {
      const importing = importProjectPackage(dest.store, pkg)
      const failed = importing.then(
        () => null,
        (err: unknown) => err,
      )
      await hold.atBarrier
      dest.store.renamePage(dest.inbox.id, 'Renamed while the import was failing')
      const saving = dest.store.flush()
      await hold.turns(25)
      hold.abort() // simulated: the browser aborts the import transaction (as on a full disk at commit)
      expect(await failed).toBeInstanceOf(Error)
      expect(await saving).toBe(true)

      const after = await dest.repo.readAll()
      expect(after.revision).toBe(before.revision + 1) // only the edit
      expect(dest.store.getState().data.revision).toBe(after.revision)
      expect(after.records.projects).toEqual(before.records.projects)
      expect(after.records.tasks).toEqual(before.records.tasks)
      expect(after.records.objects).toEqual(before.records.objects)
      expect(after.records.attachments).toEqual(before.records.attachments)
      expect(after.records.categories).toEqual(before.records.categories)
      expect([...after.blobs.keys()].sort()).toEqual([...before.blobs.keys()].sort())
      expect(after.records.pages.map((p) => (p.id === dest.inbox.id ? { ...p, title: '', updatedAt: '' } : p))).toEqual(before.records.pages.map((p) => (p.id === dest.inbox.id ? { ...p, title: '', updatedAt: '' } : p)))
      expect(after.records.pages.find((p) => p.id === dest.inbox.id)!.title).toBe('Renamed while the import was failing')
      // The window shows what is stored: one project, the renamed note, and it is still the editor.
      expect(Object.keys(dest.store.getState().data.projects)).toHaveLength(1)
      expect(dest.store.getState()).toMatchObject({ readOnly: false, owner: true })
      expect(dest.store.getState().save).toMatchObject({ status: 'saved', error: null })
      // The same package imports normally afterwards.
      const ok = await importProjectPackage(dest.store, pkg)
      expect((await dest.repo.readAll()).records.projects.some((p) => p.id === ok.projectId)).toBe(true)
    } finally {
      hold.restore()
    }
  })

  it('editing is taken over by another window during the import: the import lands whole, the old window is fenced out, and its late edit is held, not lost', async () => {
    const { pkg, dest, before } = await setup()
    const other = new WorkspaceStore(await IdbRepository.open((dest.repo as unknown as { db: { name: string } }).db.name), { debounceMs: 5, maxWaitMs: 20, retryDelaysMs: [10] })
    await other.load()
    const hold = holdImportOpen()
    try {
      const importing = importProjectPackage(dest.store, pkg)
      await hold.atBarrier

      // ---- during the import: the other window takes over editing, then this window edits
      const takingOver = other.becomeEditor()
      const tookOver = settledFlag(takingOver)
      dest.store.renamePage(dest.inbox.id, 'Renamed by the old editor')
      const saving = dest.store.flush()
      const saved = settledFlag(saving)
      await hold.turns(25)
      expect(tookOver.settled).toBe(false) // the takeover waits for the import's transaction
      expect(saved.settled).toBe(false)

      hold.release()
      // The import began as the editor and completes as one unit.
      const result = await importing
      await takingOver
      expect(await saving).toBe(false)

      // ---- storage: the whole import, and nothing of the old editor's late edit
      const after = await dest.repo.readAll()
      expect(after.revision).toBe(before.revision + 1)
      const added = expectOnlyAdded(before.records, after.records)
      const got = inProject(after.records, result.projectId)
      expect(got.pages).toHaveLength(result.counts.notes + result.counts.snapshots)
      expect(got.tasks).toHaveLength(result.counts.tasks)
      expect(after.records.attachments.filter((a) => added.has(a.id))).toHaveLength(result.counts.attachments)
      for (const a of after.records.attachments) expect(after.blobs.has(a.id), a.fileName).toBe(true)
      expect(after.records.pages.find((p) => p.id === dest.inbox.id)!.title).toBe('Destination inbox note')

      // ---- the old window: read-only, with its edit held for later
      expect(dest.store.getState()).toMatchObject({ readOnly: true, owner: false, heldChanges: 1 })
      expect(dest.store.getState().save.status).toBe('error')
      expect(dest.store.getState().data.pages[dest.inbox.id].title).toBe('Renamed by the old editor')
      expect(dest.store.hasUnsavedChanges).toBe(true)
      await expect(importProjectPackage(dest.store, pkg)).rejects.toThrow(/only possible in the window that is editing/)

      // ---- the new editor sees the imported project and can work on it
      expect(other.getState()).toMatchObject({ readOnly: false, owner: true })
      expect(other.getState().data.projects[result.projectId].name).toBe('Lift Station 7 upgrade (imported)')
      expect(other.getState().data.revision).toBe(after.revision)
      other.updateProject(result.projectId, { customer: 'Edited by the new editor' })
      expect(await other.flush()).toBe(true)

      // ---- handing editing back: the held edit is applied on top of the latest stored data
      await dest.store.becomeEditor()
      expect(dest.store.getState()).toMatchObject({ readOnly: false, owner: true, heldChanges: 0 })
      const final = await dest.repo.readAll()
      expect(final.records.pages.find((p) => p.id === dest.inbox.id)!.title).toBe('Renamed by the old editor')
      expect(final.records.projects.find((p) => p.id === result.projectId)!.customer).toBe('Edited by the new editor')
      expect(inProject(final.records, result.projectId).pages).toHaveLength(got.pages.length)
      expect(dest.store.getState().data.revision).toBe(final.revision)
      // Everything that was there before the import is still there.
      const ids = new Set(KINDS.flatMap((kind) => (final.records[kind] as { id: string }[]).map((r) => r.id)))
      for (const id of allIds(before.records)) expect(ids.has(id)).toBe(true)
    } finally {
      hold.restore()
    }
  })
})

describe('note order in the project sidebar', () => {
  const sidebar = (store: WorkspaceStore, projectId: string) => projectNotes(projectId, store.getState().data.pages).map((p) => p.title)
  async function reopened(repo: IdbRepository) {
    const store = new WorkspaceStore(repo)
    await store.load()
    return store
  }
  async function roundTrip(store: WorkspaceStore, projectId: string) {
    const out = await buildProjectExport(await loadExportSnapshot(store), projectId, DEFAULT_EXPORT_OPTIONS, 'test')
    const pkg = await readProjectPackage(out.bytes)
    if (!pkg.ok) throw new Error(pkg.errors.join('\n'))
    const dest = await destinationWorkspace()
    const result = await importProjectPackage(dest.store, pkg)
    return { dest, projectId: result.projectId }
  }

  it('notes with the same last-edited time (a project made from a template) are listed alike in the original and in the imported copy, before and after a reload', async () => {
    const { store, repo } = await freshStore()
    const first = store.createProject({ name: 'Template source' })
    const titles = ['Scope', 'I/O list', 'Network', 'Alarms', 'FAT checklist', 'SAT checklist', 'Punch list']
    for (const title of titles) {
      const page = store.createPage({ kind: 'project', projectId: first.id }, title)
      store.addObjects(page.id, [textBox(page.id, `${title} notes`)])
    }
    await store.flush()
    const template = await store.createTemplateFromProject(first.id, 'Commissioning job')
    const project = store.createProjectFromTemplate(template.id, 'Pump station 4')
    await store.flush()
    // The situation under test: every note carries the same timestamp, so only a tie-break can order them.
    const notes = projectNotes(project.id, store.getState().data.pages)
    expect(new Set(notes.map((p) => p.updatedAt)).size).toBe(1)

    const original = sidebar(store, project.id)
    expect(original).toEqual(titles)
    // Stable across a reload (records come back from storage in ID order, not creation order).
    expect(sidebar(await reopened(repo), project.id)).toEqual(titles)

    const { dest, projectId } = await roundTrip(store, project.id)
    expect(sidebar(dest.store, projectId)).toEqual(titles)
    expect(sidebar(await reopened(dest.repo), projectId)).toEqual(titles)
    // A second import (other new IDs again) shows the same sequence.
    const again = await roundTrip(store, project.id)
    expect(sidebar(await reopened(again.dest.repo), again.projectId)).toEqual(titles)
  })

  it('notes edited at different times keep “most recently edited first” through export and import', async () => {
    const { store, repo } = await freshStore()
    const project = store.createProject({ name: 'Edited over time' })
    const at = (minute: number) => `2026-10-01T08:${String(minute).padStart(2, '0')}:00.000Z`
    const made = ['Oldest', 'Middle', 'Newest', 'Tied A', 'Tied B'].map((title) => store.createPage({ kind: 'project', projectId: project.id }, title))
    await store.flush()
    // Give the stored notes known edit times (synthetic data; two of them share one).
    const { records, blobs } = await repo.readAll()
    const stamps: Record<string, string> = { Oldest: at(1), Middle: at(20), Newest: at(40), 'Tied A': at(10), 'Tied B': at(10) }
    for (const page of records.pages) if (stamps[page.title]) page.updatedAt = stamps[page.title]
    await store.replaceWorkspace(records, blobs)
    const expected = ['Newest', 'Middle', 'Tied A', 'Tied B', 'Oldest']
    expect(sidebar(store, project.id)).toEqual(expected)
    expect(sidebar(await reopened(repo), project.id)).toEqual(expected)

    const { dest, projectId } = await roundTrip(store, project.id)
    expect(sidebar(dest.store, projectId)).toEqual(expected)
    const stored = await reopened(dest.repo)
    expect(sidebar(stored, projectId)).toEqual(expected)
    // The times that decide the order are carried over unchanged.
    const imported = projectNotes(projectId, stored.getState().data.pages)
    expect(imported.map((p) => p.updatedAt)).toEqual(expected.map((t) => stamps[t]))
    expect(made).toHaveLength(5)

    // By design the list follows edits: editing a note in the copy moves it to the top there — and only there.
    const tiedB = imported.find((p) => p.title === 'Tied B')!
    dest.store.renamePage(tiedB.id, 'Tied B (edited in the copy)')
    expect(sidebar(dest.store, projectId)[0]).toBe('Tied B (edited in the copy)')
    expect(sidebar(store, project.id)).toEqual(expected)
  })

  it('reference copies become notes of the imported project and take their place by edit time, after the project’s own notes when times are equal', async () => {
    const { store } = await freshStore()
    const project = store.createProject({ name: 'With a reference' })
    const reference = store.createPage({ kind: 'standalone' }, 'Wiring standard')
    const note = store.createPage({ kind: 'project', projectId: project.id }, 'Site notes')
    store.pinReference(project.id, reference.id)
    await store.flush()
    const { records, blobs } = await store.repository.readAll()
    for (const page of records.pages) page.updatedAt = '2026-10-01T08:00:00.000Z'
    await store.replaceWorkspace(records, blobs)
    expect(sidebar(store, project.id)).toEqual(['Site notes'])
    const { dest, projectId } = await roundTrip(store, project.id)
    expect(sidebar(await reopened(dest.repo), projectId)).toEqual(['Site notes', 'Wiring standard'])
    expect(note.id).not.toBe(reference.id)
  })
})
