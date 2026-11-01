import { describe, expect, it } from 'vitest'
import { buildArchive, readArchive, sha256Hex } from '../backup/archive'
import { BackupService } from '../backup/backupService'
import { docFromPlainText, docToPlainText } from '../domain/richtext'
import { linkedProjects, projectNotes, projectReferences, type LibraryData } from '../domain/references'
import { newId, nowIso, type ImageObject, type TextObject, type WorkspaceRecords } from '../domain/types'
import { freshStore, PNG_1x1 } from '../test/fixtures'
import { buildStage1Archive, toStage1Records } from '../test/legacy'
import type { WorkspaceStore } from './workspaceStore'

function textBox(pageId: string, text: string, y = 48): TextObject {
  const at = nowIso()
  return { id: newId(), pageId, type: 'text', x: 48, y, w: 480, h: 60, z: 1, doc: docFromPlainText(text), createdAt: at, updatedAt: at }
}

async function bodyOf(store: WorkspaceStore, pageId: string): Promise<string> {
  const objects = await store.ensurePageObjects(pageId)
  return Object.values(objects)
    .filter((o): o is TextObject => o.type === 'text')
    .map((o) => docToPlainText(o.doc))
    .join('\n')
}

const lib = (store: WorkspaceStore): LibraryData => store.getState().data

/** Two VTScada projects, a VTScada library notebook with a page and a screenshot. */
async function library() {
  const { store, repo } = await freshStore()
  const vt = store.createCategory('VTScada')
  const studio = store.createCategory('Studio 5000')
  const { notebook, section } = store.createNotebook('VTScada reference', [vt.id])
  const ref = store.createPage({ kind: 'section', sectionId: section.id }, 'Alarm setup')
  const body = textBox(ref.id, 'Use the alarm priority list')
  const at = nowIso()
  const attachmentId = newId()
  await store.addAttachment(
    { id: attachmentId, fileName: 'alarm-dialog.png', mimeType: 'image/png', size: PNG_1x1.byteLength, sha256: await sha256Hex(PNG_1x1), width: 1, height: 1, source: 'paste', createdAt: at },
    new Blob([PNG_1x1], { type: 'image/png' }),
  )
  const image: ImageObject = { id: newId(), pageId: ref.id, type: 'image', attachmentId, alt: '', x: 48, y: 160, w: 300, h: 200, z: 2, createdAt: at, updatedAt: at }
  store.addObjects(ref.id, [body, image])
  const other = store.createPage({ kind: 'standalone' }, 'Ladder tips')
  store.setCategories('pages', other.id, [studio.id])
  const north = store.createProject({ name: 'North pump station', customer: 'City of Example', site: 'North', jobNumber: 'J-1001', categoryIds: [vt.id] })
  const south = store.createProject({ name: 'South lift station', customer: 'City of Example', site: 'South', jobNumber: 'J-1002', categoryIds: [vt.id] })
  await store.flush()
  return { store, repo, vt, studio, notebook, section, ref, body, image, attachmentId, other, north, south }
}

describe('reference suggestions and links', () => {
  it('suggests library pages by category (own, section, or notebook) and lets a project pin and hide', async () => {
    const { store, ref, other, north, studio, section } = await library()
    let refs = projectReferences(store.getState().data.projects[north.id], lib(store))
    expect(refs.suggested.map((p) => p.id)).toEqual([ref.id]) // inherited from the notebook
    expect(refs.pinned).toEqual([])

    store.pinReference(north.id, other.id)
    store.hideReference(north.id, ref.id)
    refs = projectReferences(store.getState().data.projects[north.id], lib(store))
    expect(refs.pinned.map((p) => p.id)).toEqual([other.id])
    expect(refs.suggested).toEqual([])
    expect(refs.hidden.map((p) => p.id)).toEqual([ref.id])
    // Hiding never touches the page.
    expect(store.getState().data.pages[ref.id].trashedAt).toBeNull()

    store.unhideReference(north.id, ref.id)
    store.setCategories('sections', section.id, [studio.id])
    store.setCategories('notebooks', store.getState().data.sections[section.id].notebookId, [])
    refs = projectReferences(store.getState().data.projects[north.id], lib(store))
    expect(refs.suggested).toEqual([]) // no shared category any more
  })

  it('one shared reference: an edit to the original shows in both projects', async () => {
    const { store, ref, body, north, south } = await library()
    const data = () => store.getState().data
    // Both projects link the same page (same ID), not a copy.
    expect(projectReferences(data().projects[north.id], lib(store)).suggested.map((p) => p.id)).toEqual([ref.id])
    store.pinReference(south.id, ref.id)
    expect(projectReferences(data().projects[south.id], lib(store)).pinned.map((p) => p.id)).toEqual([ref.id])
    expect(linkedProjects(data().pages[ref.id], lib(store)).map((p) => p.id)).toEqual([north.id, south.id])

    // Edit the original once (as if opened from the North project).
    store.updateObjects(ref.id, [{ id: body.id, patch: { doc: docFromPlainText('Alarm priorities: 1 critical, 2 high') } }], 'Edit')
    store.renamePage(ref.id, 'Alarm setup (rev B)')
    await store.flush()

    // Reload from storage, then read the page through each project's links.
    await store.load()
    for (const projectId of [north.id, south.id]) {
      const refs = projectReferences(data().projects[projectId], lib(store))
      const linked = [...refs.pinned, ...refs.suggested]
      expect(linked.map((p) => p.id)).toEqual([ref.id])
      expect(linked[0].title).toBe('Alarm setup (rev B)')
      expect(await bodyOf(store, linked[0].id)).toBe('Alarm priorities: 1 critical, 2 high')
    }
  })

  it('a project copy is independent: editing the original never changes it, and vice versa', async () => {
    const { store, ref, body, image, north, south, attachmentId } = await library()
    const copy = await store.makeProjectCopy(north.id, ref.id)
    const data = () => store.getState().data
    expect(copy.id).not.toBe(ref.id)
    expect(copy).toMatchObject({ location: { kind: 'project', projectId: north.id }, title: 'Alarm setup', copiedFrom: { pageId: ref.id, title: 'Alarm setup' } })
    const copied = Object.values(await store.ensurePageObjects(copy.id))
    expect(copied).toHaveLength(2)
    expect(copied.every((o) => o.pageId === copy.id && o.id !== body.id && o.id !== image.id)).toBe(true)
    expect(copied.find((o) => o.type === 'image')).toMatchObject({ attachmentId, x: 48, y: 160, w: 300, h: 200 })
    // North now shows its copy instead of the original; South still links the original.
    expect(projectNotes(north.id, data().pages).map((p) => p.id)).toEqual([copy.id])
    expect(projectReferences(data().projects[north.id], lib(store)).suggested).toEqual([])
    expect(linkedProjects(data().pages[ref.id], lib(store)).map((p) => p.id)).toEqual([south.id])

    // Edit the original: the copy keeps its text.
    store.updateObjects(ref.id, [{ id: body.id, patch: { doc: docFromPlainText('Original changed later') } }], 'Edit')
    // Edit the copy: the original keeps its text.
    const copyText = copied.find((o) => o.type === 'text')!
    store.updateObjects(copy.id, [{ id: copyText.id, patch: { doc: docFromPlainText('North-specific alarm list') } }], 'Edit')
    await store.flush()
    await store.load()
    expect(await bodyOf(store, ref.id)).toBe('Original changed later')
    expect(await bodyOf(store, copy.id)).toBe('North-specific alarm list')
  })
})

describe('archive, trash, and deletion', () => {
  it('archives and trashes projects recoverably; deleting forever keeps notes in the Trash and library pages intact', async () => {
    const { store, ref, north, south } = await library()
    const note = store.createPage({ kind: 'project', projectId: north.id })
    store.addObjects(note.id, [textBox(note.id, 'Commissioning notes')])
    store.pinReference(north.id, ref.id)
    store.setProjectArchived(north.id, true)
    expect(store.getState().data.projects[north.id].archivedAt).not.toBeNull()
    store.setProjectArchived(north.id, false)

    store.trashProject(north.id)
    expect(store.getState().data.projects[north.id].trashedAt).not.toBeNull()
    expect(store.getState().data.pages[note.id].trashedAt).toBeNull() // still owned, hidden with the project
    store.restoreProject(north.id)
    expect(store.getState().data.projects[north.id].trashedAt).toBeNull()

    store.trashProject(north.id)
    expect(store.deleteProjectForever(north.id)).toBe(1)
    await store.flush()
    await store.load()
    const data = store.getState().data
    expect(data.projects[north.id]).toBeUndefined()
    expect(data.pages[note.id]).toMatchObject({ location: { kind: 'inbox' }, trashedAt: expect.any(String) })
    expect(await bodyOf(store, note.id)).toBe('Commissioning notes')
    // The shared library page survives and is still linked from the other project.
    expect(data.pages[ref.id]).toMatchObject({ trashedAt: null, location: { kind: 'section' } })
    expect(linkedProjects(data.pages[ref.id], data).map((p) => p.id)).toEqual([south.id])
    store.restorePage(note.id)
    expect(store.getState().data.pages[note.id]).toMatchObject({ location: { kind: 'inbox' }, trashedAt: null })
  })

  it('trashed and deleted reference sources leave no dangling links', async () => {
    const { store, ref, other, north, south } = await library()
    store.pinReference(north.id, other.id)
    store.hideReference(south.id, ref.id)
    const copy = await store.makeProjectCopy(north.id, ref.id)

    store.trashPage(other.id)
    let refs = projectReferences(store.getState().data.projects[north.id], lib(store))
    expect(refs.pinned).toEqual([])
    expect(refs.trashedPinned.map((p) => p.id)).toEqual([other.id]) // comes back if restored
    store.restorePage(other.id)
    expect(projectReferences(store.getState().data.projects[north.id], lib(store)).pinned.map((p) => p.id)).toEqual([other.id])

    for (const id of [other.id, ref.id]) {
      store.trashPage(id)
      await store.deletePageForever(id)
    }
    const data = store.getState().data
    expect(data.projects[north.id].pinnedPageIds).toEqual([])
    expect(data.projects[north.id].hiddenPageIds).toEqual([])
    expect(data.projects[south.id].hiddenPageIds).toEqual([])
    expect(data.pages[copy.id].copiedFrom).toMatchObject({ pageId: null, title: 'Alarm setup' })
    refs = projectReferences(data.projects[north.id], lib(store))
    expect(refs.trashedPinned).toEqual([])
    // The workspace still passes full backup validation.
    const { bytes } = await new BackupService(store, { appVersion: 'test', folderSupported: false }).createArchive()
    expect((await readArchive(bytes)).ok).toBe(true)
  })

  it('restoring a note whose project is in the Trash puts it in the Inbox', async () => {
    const { store, north } = await library()
    const note = store.createPage({ kind: 'project', projectId: north.id })
    store.trashPage(note.id)
    store.trashProject(north.id)
    store.restorePage(note.id)
    expect(store.getState().data.pages[note.id].location).toEqual({ kind: 'inbox' })
  })

  it('deleting a category or tag removes it everywhere', async () => {
    const { store, vt, ref, north, notebook } = await library()
    const tag = store.createTag('#alarms')
    expect(tag.name).toBe('alarms')
    expect(store.createTag('Alarms').id).toBe(tag.id) // same name, same tag
    store.setPageTags(ref.id, [tag.id])
    store.setCategories('pages', ref.id, [vt.id])
    store.deleteCategory(vt.id)
    store.deleteTag(tag.id)
    const data = store.getState().data
    expect(data.projects[north.id].categoryIds).toEqual([])
    expect(data.notebooks[notebook.id].categoryIds).toEqual([])
    expect(data.pages[ref.id]).toMatchObject({ categoryIds: [], tagIds: [] })
  })
})

describe('backup and restore of Stage 2 records', () => {
  it('projects, details, links, copies, categories, tags, and attachments survive a full backup into a clean workspace', async () => {
    const src = await library()
    const { store } = src
    const tag = store.createTag('commissioning')
    store.setPageTags(src.ref.id, [tag.id])
    store.updateProject(src.north.id, {
      status: 'on-hold',
      dueDate: '2026-12-15',
      description: 'Pump replacement',
      contacts: [{ id: newId(), name: 'Dana Example', role: 'Operator', phone: '555-0100', email: 'dana@example.com' }],
      equipment: [{ id: newId(), name: 'PLC', detail: '1756-L83E' }],
      software: [{ id: newId(), name: 'VTScada', detail: '12.1.40' }],
      fileLocations: [
        { id: newId(), label: 'Project folder', kind: 'path', value: 'C:\\Dropbox\\Jobs\\J-1001' },
        { id: newId(), label: 'Dropbox link', kind: 'url', value: 'https://www.dropbox.com/home/Jobs/J-1001' },
      ],
    })
    store.pinReference(src.south.id, src.other.id)
    store.hideReference(src.south.id, src.ref.id)
    const copy = await store.makeProjectCopy(src.north.id, src.ref.id)
    store.setProjectArchived(src.south.id, true)
    await store.flush()
    const before = await src.repo.readAll()

    const service = new BackupService(store, { appVersion: 'test', folderSupported: false })
    const validated = await readArchive((await service.createArchive()).bytes)
    if (!validated.ok) throw new Error(validated.errors.join('\n'))
    expect(validated.summary.counts).toMatchObject({ projects: 2, categories: 2, tags: 1, pages: 3, attachments: 1 })
    expect(validated.summary.archivedProjects).toBe(1)

    const clean = await freshStore()
    await clean.store.becomeEditor()
    await new BackupService(clean.store, { appVersion: 'test', folderSupported: false }).restore(validated)
    const after = await clean.repo.readAll()
    const sortById = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => a.id.localeCompare(b.id))
    for (const key of ['projects', 'categories', 'tags', 'notebooks', 'sections', 'pages', 'objects', 'attachments'] as const) {
      expect(sortById(after.records[key] as { id: string }[])).toEqual(sortById(before.records[key] as { id: string }[]))
    }
    const blob = await clean.store.getBlob(src.attachmentId)
    expect(await sha256Hex(new Uint8Array(await blob!.arrayBuffer()))).toBe(await sha256Hex(PNG_1x1))
    const data = clean.store.getState().data
    expect(data.pages[copy.id].copiedFrom?.pageId).toBe(src.ref.id)
    expect(await bodyOf(clean.store, copy.id)).toBe('Use the alarm priority list')
  })

  it('rejects broken Stage 2 relationships without changing anything', async () => {
    const { repo, ref, north } = await library()
    const { records, blobs } = await repo.readAll()
    const variants: [string, (r: WorkspaceRecords) => WorkspaceRecords, RegExp][] = [
      ['page in a missing project', (r) => ({ ...r, pages: r.pages.map((p) => (p.id === ref.id ? { ...p, location: { kind: 'project', projectId: 'gone' } } : p)) }), /missing project/],
      ['pin to a missing page', (r) => ({ ...r, projects: r.projects.map((p) => (p.id === north.id ? { ...p, pinnedPageIds: ['gone'] } : p)) }), /links to a missing page/],
      ['missing category', (r) => ({ ...r, notebooks: r.notebooks.map((n) => ({ ...n, categoryIds: ['gone'] })) }), /missing category/],
      ['missing tag', (r) => ({ ...r, pages: r.pages.map((p) => ({ ...p, tagIds: ['gone'] })) }), /missing tag/],
      ['bad due date', (r) => ({ ...r, projects: r.projects.map((p) => ({ ...p, dueDate: '2026-02-30' })) }), /Project #1 is invalid/],
    ]
    for (const [, mutate, error] of variants) {
      const result = await readArchive(await buildArchive(mutate(records), blobs, 'test'))
      expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringMatching(error)]) })
    }
  })

  it('accepts a Stage 1 (format 1) backup and upgrades its records', async () => {
    const { repo, ref } = await library()
    const { records, blobs } = await repo.readAll()
    const stage1 = toStage1Records({ ...records, projects: [], categories: [], tags: [], notebooks: records.notebooks, sections: records.sections })
    const validated = await readArchive(await buildStage1Archive(stage1, blobs))
    if (!validated.ok) throw new Error(validated.errors.join('\n'))
    expect(validated.summary.formatVersion).toBe(1)
    expect(validated.records.workspace.formatVersion).toBe(2)
    expect(validated.records.pages.find((p) => p.id === ref.id)).toMatchObject({ categoryIds: [], tagIds: [], copiedFrom: null, title: 'Alarm setup' })
    expect(validated.records.projects).toEqual([])
  })
})
